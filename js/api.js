/**
 * api.js — client for the tracker's RPC functions (see db/schema.sql), served by the Neon
 * Data API. Every call is a JSON POST with a timeout. Failures surface as ApiError with a
 * `code`: transport problems ('network' | 'timeout' | 'http' | 'bad_response') or the
 * server's own error ('bad_code' | 'locked' | 'not_found' | 'empty_label' | …).
 */
import { DATA_API_URL, AUTH_URL, REQUEST_TIMEOUT_MS } from './config.js';

export class ApiError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ApiError';
    this.code = code;
  }
}

/**
 * A random id per browser, sent as X-Client-Id. The Data API passes no client IP through,
 * so this is what the server's per-client lockout counts wrong codes against. Falls back
 * to a per-page id when storage is unavailable.
 */
const CLIENT_ID = (() => {
  const fresh = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
  try {
    let id = localStorage.getItem('lightshow.clientId');
    if (!id) {
      id = fresh();
      localStorage.setItem('lightshow.clientId', id);
    }
    return id;
  } catch {
    return fresh();
  }
})();

/**
 * The Data API only accepts requests carrying a JWT, so the page uses Neon Auth's anonymous
 * token (role `anonymous`, about an hour long). It is cached and replaced a few minutes
 * before it expires, or straight away if the API rejects it.
 */
let token = null; // { value, expiresAt }

async function anonymousToken(signal) {
  if (token && Date.now() < token.expiresAt) return token.value;
  const res = await fetch(`${AUTH_URL}/token/anonymous`, { cache: 'no-store', signal });
  if (!res.ok) throw new ApiError('http', `token ${res.status}`);
  const { token: value } = await res.json();
  if (typeof value !== 'string') throw new ApiError('bad_response');
  let exp = 0;
  try {
    exp = JSON.parse(atob(value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000;
  } catch {
    /* unreadable payload: fall back to a short cache */
  }
  token = { value, expiresAt: (exp || Date.now() + 10 * 60 * 1000) - 5 * 60 * 1000 };
  return value;
}

/**
 * The timeout covers the whole exchange, token and body included: a response whose headers
 * arrive but whose body stalls is aborted too, so every call settles within
 * REQUEST_TIMEOUT_MS.
 */
async function rpc(fn, params = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const failure = (code) => new ApiError(controller.signal.aborted ? 'timeout' : code);
  const send = async () => {
    let jwt;
    try {
      jwt = await anonymousToken(controller.signal);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw failure('network');
    }
    try {
      return await fetch(`${DATA_API_URL}/rpc/${fn}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json',
          'X-Client-Id': CLIENT_ID,
        },
        body: JSON.stringify(params),
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch {
      throw failure('network');
    }
  };
  try {
    let res = await send();
    // The Data API answers a rejected token with 401 or 400. Commands report their own
    // failures in a 200 body, so either status here means: fetch a new token, try once more.
    if (res.status === 401 || res.status === 400) {
      token = null;
      res = await send();
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

/** Adds a checklist item; with `parentId`, as a sub-item of that top-level item. */
export async function addTask(code, label, by, parentId = null) {
  const params = { p_code: code, p_label: label, p_by: by };
  if (parentId) params.p_parent = parentId;
  const out = await command('lightshow_add_task', params);
  return out.task;
}

export async function setTask(code, taskId, done, by) {
  const out = await command('lightshow_set_task', { p_code: code, p_task: taskId, p_done: done, p_by: by });
  return out.task;
}

export async function deleteTask(code, taskId, by) {
  await command('lightshow_delete_task', { p_code: code, p_task: taskId, p_by: by });
}
