/**
 * api.js — client for the tracker's Supabase RPC functions (see supabase/schema.sql).
 * Every call is a JSON POST with a timeout. Failures surface as ApiError with a `code`:
 * transport problems ('network' | 'timeout' | 'http' | 'bad_response') or the server's
 * own error ('bad_code' | 'locked' | 'not_found' | 'empty_label' | …).
 */
import { SUPABASE_URL, SUPABASE_KEY, REQUEST_TIMEOUT_MS } from './config.js';

export class ApiError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ApiError';
    this.code = code;
  }
}

/**
 * The timeout covers the whole exchange, body included: a response whose headers arrive but
 * whose body stalls is aborted too, so every call settles within REQUEST_TIMEOUT_MS.
 */
async function rpc(fn, params = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const failure = (code) => new ApiError(controller.signal.aborted ? 'timeout' : code);
  try {
    let res;
    try {
      res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch {
      throw failure('network');
    }
    if (!res.ok) throw new ApiError('http', String(res.status));
    try {
      return await res.json();
    } catch {
      throw failure('bad_response');
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Calls a function that answers `{ok:true, …}` or `{ok:false, error}`; throws on the latter. */
async function command(fn, params) {
  const out = await rpc(fn, params);
  if (!out || typeof out !== 'object') throw new ApiError('bad_response');
  if (out.ok !== true) throw new ApiError(typeof out.error === 'string' ? out.error : 'bad_response');
  return out;
}

/** Full tracker state: `{server_time, nodes, tasks, log}`. */
export async function getState() {
  const out = await rpc('lightshow_state');
  if (!out || !Array.isArray(out.nodes) || !Array.isArray(out.tasks) || !Array.isArray(out.log)) {
    throw new ApiError('bad_response');
  }
  return out;
}

export async function checkCode(code) {
  await command('lightshow_check_code', { p_code: code });
}

export async function setStage(code, id, field, value, by) {
  const out = await command('lightshow_set_stage', {
    p_code: code, p_id: id, p_field: field, p_value: value, p_by: by,
  });
  return out.node;
}

export async function setNote(code, id, note, by) {
  const out = await command('lightshow_set_note', { p_code: code, p_id: id, p_note: note, p_by: by });
  return out.node;
}

export async function addTask(code, label, by) {
  const out = await command('lightshow_add_task', { p_code: code, p_label: label, p_by: by });
  return out.task;
}

export async function setTask(code, taskId, done, by) {
  const out = await command('lightshow_set_task', { p_code: code, p_task: taskId, p_done: done, p_by: by });
  return out.task;
}

export async function deleteTask(code, taskId, by) {
  await command('lightshow_delete_task', { p_code: code, p_task: taskId, p_by: by });
}
