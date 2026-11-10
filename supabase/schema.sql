-- Palomaglade Light Show tracker — Supabase schema
--
-- Lives inside an existing Supabase project, isolated in its own schema:
--   * Tables sit in schema `lightshow`, which the Data API does NOT expose.
--   * The browser can only call the public.lightshow_* functions below (SECURITY DEFINER).
--   * Every write function checks the edit code server-side; the code is stored only as a
--     bcrypt hash in lightshow.settings and never ships to the browser.
--
-- Set or change the edit code (run in the Supabase SQL editor; do not commit the code):
--   insert into lightshow.settings(key, value)
--   values ('edit_code_hash', extensions.crypt('NEW-CODE', extensions.gen_salt('bf', 8)))
--   on conflict (key) do update set value = excluded.value;
--
-- Brute-force protection: 8 wrong codes per client per 15 min, and 60 wrong codes total
-- per 15 min across everyone, lock editing until the window passes.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists lightshow;
revoke all on schema lightshow from public;
revoke all on schema lightshow from anon, authenticated;

create table if not exists lightshow.nodes (
  id            text primary key check (id ~ '^(G[0-9]{4}|P[0-9]{5}|I-(front|glade|park))$'),
  kind          text not null check (kind in ('house', 'island')),
  participating boolean not null default true,
  cable_run     boolean not null default false,
  box_connected boolean not null default false,
  lights_up     boolean not null default false,
  note          text not null default '' check (char_length(note) <= 280),
  updated_at    timestamptz not null default now(),
  updated_by    text not null default '' check (char_length(updated_by) <= 40)
);

-- A task with parent_id set is a sub-item of that task. Sub-items go one level deep
-- (lightshow_add_task enforces it); deleting a task deletes its sub-items.
create table if not exists lightshow.tasks (
  id         uuid primary key default gen_random_uuid(),
  label      text not null check (char_length(label) between 1 and 120),
  done       boolean not null default false,
  sort       integer not null default 0,
  parent_id  uuid references lightshow.tasks (id) on delete cascade,
  updated_at timestamptz not null default now(),
  updated_by text not null default '' check (char_length(updated_by) <= 40)
);
-- For databases created before sub-items existed.
alter table lightshow.tasks add column if not exists parent_id uuid references lightshow.tasks (id) on delete cascade;

create table if not exists lightshow.edit_log (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  target    text not null,
  field     text not null,
  old_value text,
  new_value text,
  by_name   text not null default ''
);
create index if not exists edit_log_at_idx on lightshow.edit_log (at desc);

create table if not exists lightshow.auth_failures (
  id     bigint generated always as identity primary key,
  at     timestamptz not null default now(),
  client text not null
);
create index if not exists auth_failures_client_at_idx on lightshow.auth_failures (client, at);
create index if not exists auth_failures_at_idx on lightshow.auth_failures (at);

create table if not exists lightshow.settings (
  key   text primary key,
  value text not null
);

-- Defense in depth: RLS on with no policies, so API roles get nothing even if the schema
-- were ever exposed by mistake.
alter table lightshow.nodes         enable row level security;
alter table lightshow.tasks         enable row level security;
alter table lightshow.edit_log      enable row level security;
alter table lightshow.auth_failures enable row level security;
alter table lightshow.settings      enable row level security;

-- ---------------------------------------------------------------- internal helpers

-- Hashed client identifier (IP from the API gateway headers). Never stores the raw IP.
create or replace function lightshow._client()
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  h  json;
  ip text;
begin
  begin
    h := current_setting('request.headers', true)::json;
  exception when others then
    h := null;
  end;
  ip := coalesce(h ->> 'cf-connecting-ip',
                 nullif(trim(split_part(coalesce(h ->> 'x-forwarded-for', ''), ',', 1)), ''),
                 h ->> 'x-real-ip',
                 'unknown');
  return encode(extensions.digest(ip, 'sha256'), 'hex');
end;
$$;

-- Returns 'ok', 'bad_code' or 'locked'. Never raises, so the failure row always commits.
create or replace function lightshow._check(p_code text)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_client text := lightshow._client();
  v_hash   text;
begin
  delete from lightshow.auth_failures where at < now() - interval '1 day';
  if (select count(*) from lightshow.auth_failures
        where client = v_client and at > now() - interval '15 minutes') >= 8
     or (select count(*) from lightshow.auth_failures
        where at > now() - interval '15 minutes') >= 60 then
    return 'locked';
  end if;
  select value into v_hash from lightshow.settings where key = 'edit_code_hash';
  if v_hash is null or p_code is null or char_length(p_code) > 64
     or extensions.crypt(p_code, v_hash) <> v_hash then
    insert into lightshow.auth_failures (client) values (v_client);
    return 'bad_code';
  end if;
  return 'ok';
end;
$$;

create or replace function lightshow._by(p_by text)
returns text
language sql
immutable
set search_path = ''
as $$ select left(trim(coalesce(p_by, '')), 40) $$;

create or replace function lightshow._node_json(n lightshow.nodes)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', n.id, 'kind', n.kind, 'participating', n.participating,
    'cable_run', n.cable_run, 'box_connected', n.box_connected, 'lights_up', n.lights_up,
    'note', n.note, 'updated_at', n.updated_at, 'updated_by', n.updated_by)
$$;

-- Activity-log target for a task: "task:<label>", or "task:<parent> › <label>" for a sub-item.
create or replace function lightshow._task_target(t lightshow.tasks)
returns text
language sql
stable
set search_path = ''
as $$
  select 'task:' || coalesce((select p.label || ' › ' from lightshow.tasks p where p.id = t.parent_id), '') || t.label
$$;

revoke all on function lightshow._client()        from public, anon, authenticated;
revoke all on function lightshow._check(text)     from public, anon, authenticated;
revoke all on function lightshow._by(text)        from public, anon, authenticated;
revoke all on function lightshow._node_json(lightshow.nodes) from public, anon, authenticated;
revoke all on function lightshow._task_target(lightshow.tasks) from public, anon, authenticated;

-- ---------------------------------------------------------------- public API (RPC)

-- Read everything the page needs in one call.
create or replace function public.lightshow_state()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'server_time', now(),
    'nodes', coalesce((select jsonb_agg(lightshow._node_json(n) order by n.id) from lightshow.nodes n), '[]'::jsonb),
    'tasks', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', t.id, 'label', t.label, 'done', t.done, 'sort', t.sort, 'parent_id', t.parent_id,
                 'updated_at', t.updated_at, 'updated_by', t.updated_by) order by t.sort, t.updated_at)
               from lightshow.tasks t), '[]'::jsonb),
    'log', coalesce((select jsonb_agg(x order by x ->> 'at' desc) from (
               select jsonb_build_object('at', l.at, 'target', l.target, 'field', l.field,
                        'old', l.old_value, 'new', l.new_value, 'by', l.by_name) as x
               from lightshow.edit_log l order by l.at desc limit 30) s), '[]'::jsonb)
  )
$$;

-- Unlock check for the edit UI.
create or replace function public.lightshow_check_code(p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v text := lightshow._check(p_code);
begin
  if v = 'ok' then return jsonb_build_object('ok', true); end if;
  return jsonb_build_object('ok', false, 'error', v);
end;
$$;

-- Toggle one stage flag (or participation) on a house or island.
create or replace function public.lightshow_set_stage(p_code text, p_id text, p_field text, p_value boolean, p_by text default '')
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v   text := lightshow._check(p_code);
  old lightshow.nodes;
  cur lightshow.nodes;
begin
  if v <> 'ok' then return jsonb_build_object('ok', false, 'error', v); end if;
  if p_field not in ('participating', 'cable_run', 'box_connected', 'lights_up') or p_value is null then
    return jsonb_build_object('ok', false, 'error', 'bad_field');
  end if;
  select * into old from lightshow.nodes where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  update lightshow.nodes set
    participating = case when p_field = 'participating' then p_value else participating end,
    cable_run     = case when p_field = 'cable_run'     then p_value else cable_run end,
    box_connected = case when p_field = 'box_connected' then p_value else box_connected end,
    lights_up     = case when p_field = 'lights_up'     then p_value else lights_up end,
    updated_at = now(), updated_by = lightshow._by(p_by)
  where id = p_id
  returning * into cur;
  insert into lightshow.edit_log (target, field, old_value, new_value, by_name)
  values (p_id, p_field,
          (to_jsonb(old) ->> p_field), (to_jsonb(cur) ->> p_field), lightshow._by(p_by));
  return jsonb_build_object('ok', true, 'node', lightshow._node_json(cur));
end;
$$;

create or replace function public.lightshow_set_note(p_code text, p_id text, p_note text, p_by text default '')
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v   text := lightshow._check(p_code);
  old lightshow.nodes;
  cur lightshow.nodes;
  n   text := left(trim(coalesce(p_note, '')), 280);
begin
  if v <> 'ok' then return jsonb_build_object('ok', false, 'error', v); end if;
  select * into old from lightshow.nodes where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  update lightshow.nodes set note = n, updated_at = now(), updated_by = lightshow._by(p_by)
  where id = p_id returning * into cur;
  insert into lightshow.edit_log (target, field, old_value, new_value, by_name)
  values (p_id, 'note', old.note, cur.note, lightshow._by(p_by));
  return jsonb_build_object('ok', true, 'node', lightshow._node_json(cur));
end;
$$;

-- p_parent: add as a sub-item of that top-level task. Errors: not_found (no such parent),
-- bad_parent (the parent is itself a sub-item).
drop function if exists public.lightshow_add_task(text, text, text);
create or replace function public.lightshow_add_task(p_code text, p_label text, p_by text default '', p_parent uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v   text := lightshow._check(p_code);
  lbl text := left(trim(coalesce(p_label, '')), 120);
  t   lightshow.tasks;
begin
  if v <> 'ok' then return jsonb_build_object('ok', false, 'error', v); end if;
  if lbl = '' then return jsonb_build_object('ok', false, 'error', 'empty_label'); end if;
  if p_parent is not null then
    -- Lock the parent so it can't be deleted between this check and the insert.
    perform 1 from lightshow.tasks where id = p_parent and parent_id is null for key share;
    if not found then
      return jsonb_build_object('ok', false, 'error',
        case when exists (select 1 from lightshow.tasks where id = p_parent) then 'bad_parent' else 'not_found' end);
    end if;
  end if;
  if (select count(*) from lightshow.tasks) >= 60 then
    return jsonb_build_object('ok', false, 'error', 'too_many_tasks');
  end if;
  insert into lightshow.tasks (label, sort, parent_id, updated_by)
  values (lbl, coalesce((select max(sort) + 1 from lightshow.tasks), 0), p_parent, lightshow._by(p_by))
  returning * into t;
  insert into lightshow.edit_log (target, field, old_value, new_value, by_name)
  values (lightshow._task_target(t), 'added', null, 'true', lightshow._by(p_by));
  return jsonb_build_object('ok', true, 'task', to_jsonb(t));
end;
$$;

create or replace function public.lightshow_set_task(p_code text, p_task uuid, p_done boolean, p_by text default '')
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v   text := lightshow._check(p_code);
  old lightshow.tasks;
  t   lightshow.tasks;
begin
  if v <> 'ok' then return jsonb_build_object('ok', false, 'error', v); end if;
  if p_done is null then return jsonb_build_object('ok', false, 'error', 'bad_value'); end if;
  select * into old from lightshow.tasks where id = p_task for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  update lightshow.tasks set done = p_done, updated_at = now(), updated_by = lightshow._by(p_by)
  where id = p_task returning * into t;
  insert into lightshow.edit_log (target, field, old_value, new_value, by_name)
  values (lightshow._task_target(t), 'done', old.done::text, t.done::text, lightshow._by(p_by));
  return jsonb_build_object('ok', true, 'task', to_jsonb(t));
end;
$$;

-- Deleting a top-level task also deletes its sub-items (on delete cascade).
create or replace function public.lightshow_delete_task(p_code text, p_task uuid, p_by text default '')
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v text := lightshow._check(p_code);
  t lightshow.tasks;
begin
  if v <> 'ok' then return jsonb_build_object('ok', false, 'error', v); end if;
  delete from lightshow.tasks where id = p_task returning * into t;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  insert into lightshow.edit_log (target, field, old_value, new_value, by_name)
  values (lightshow._task_target(t), 'deleted', 'true', null, lightshow._by(p_by));
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.lightshow_state()                                   from public;
revoke all on function public.lightshow_check_code(text)                          from public;
revoke all on function public.lightshow_set_stage(text, text, text, boolean, text) from public;
revoke all on function public.lightshow_set_note(text, text, text, text)          from public;
revoke all on function public.lightshow_add_task(text, text, text, uuid)          from public;
revoke all on function public.lightshow_set_task(text, uuid, boolean, text)       from public;
revoke all on function public.lightshow_delete_task(text, uuid, text)             from public;

grant execute on function public.lightshow_state()                                   to anon, authenticated;
grant execute on function public.lightshow_check_code(text)                          to anon, authenticated;
grant execute on function public.lightshow_set_stage(text, text, text, boolean, text) to anon, authenticated;
grant execute on function public.lightshow_set_note(text, text, text, text)          to anon, authenticated;
grant execute on function public.lightshow_add_task(text, text, text, uuid)          to anon, authenticated;
grant execute on function public.lightshow_set_task(text, uuid, boolean, text)       to anon, authenticated;
grant execute on function public.lightshow_delete_task(text, uuid, text)             to anon, authenticated;

-- Tell PostgREST about changed function signatures right away.
notify pgrst, 'reload schema';
