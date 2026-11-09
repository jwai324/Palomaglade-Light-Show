/**
 * main.js — boot: load the neighborhood layout, build the model, start the 3D scene and the
 * UI, then keep tracker state fresh by polling (paused while the tab is hidden, backing off
 * exponentially on failures, never overlapping requests).
 *
 * The 3D layer (scene.js + the ~700 KB three.js bundle) is imported dynamically, so if it
 * fails to load the panel, list and checklist still work over a static fallback message.
 */
import { POLL_MS } from './config.js';
import * as api from './api.js';
import { buildModel } from './model.js';
import { createSceneFallback, LOAD_FAILED_MESSAGE } from './fallback.js';
import { createUI } from './ui.js';

const RETRY_MIN_MS = 5000;
const RETRY_MAX_MS = 5 * 60 * 1000;
const LAYOUT_TIMEOUT_MS = 20000;   // a static ~40 KB file; generous for slow phone networks

async function loadLayout() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LAYOUT_TIMEOUT_MS);
  try {
    const res = await fetch('data/neighborhood.json', { signal: controller.signal });
    if (!res.ok) throw new Error(`layout HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calls `load` now and then every `interval` ms while the page is visible.
 * `refreshNow()` fetches immediately, or right after the request already in flight.
 * After a success the next poll is due `interval` after that request started; after a
 * failure the backoff delay counts from when the request failed (a timeout can take 12 s).
 */
function createPoller(load, { interval, onResult, onError }) {
  let timer = 0;
  let inFlight = false;
  let queued = false;
  let failures = 0;
  let lastAttempt = 0;

  async function tick() {
    clearTimeout(timer);
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    const startedAt = Date.now();
    lastAttempt = startedAt;
    try {
      onResult(await load(), startedAt);
      failures = 0;
    } catch (err) {
      failures += 1;
      lastAttempt = Date.now();
      onError(err);
    } finally {
      inFlight = false;
    }
    if (queued) {
      queued = false;
      tick();
    } else {
      schedule();
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (document.hidden) return;
    const delay = failures
      ? Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (failures - 1))
      : interval;
    timer = setTimeout(tick, Math.max(0, delay - (Date.now() - lastAttempt)));
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(timer);
    else if (!inFlight) schedule();
  });

  return { start: tick, refreshNow: tick };
}

/** Layout couldn't load: nothing else can run, so say so everywhere and offer a reload. */
function showFatal(message) {
  const note = document.createElement('p');
  note.className = 'fatal';
  note.setAttribute('role', 'alert');
  note.textContent = message;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'btn btn-gold';
  retry.textContent = 'Reload';
  retry.addEventListener('click', () => window.location.reload());
  document.getElementById('panel-body').replaceChildren(note, retry);

  const fresh = document.getElementById('freshness');
  fresh.textContent = 'Couldn’t load the map';
  fresh.dataset.state = 'error';
  for (const el of document.querySelectorAll('.scene-tools, .topbar-actions')) el.hidden = true;
}

async function boot() {
  // Start fetching the 3D layer right away, in parallel with the layout.
  const sceneModule = import('./scene.js').catch((err) => {
    console.error('3D map failed to load:', err);
    return null;
  });

  let data;
  try {
    data = await loadLayout();
  } catch {
    showFatal('The neighborhood layout could not be loaded. Check your connection and reload the page.');
    return;
  }
  const model = buildModel(data);

  let ui = null;
  const container = document.getElementById('scene');
  const sceneLib = await sceneModule;
  const scene = sceneLib
    ? sceneLib.createScene(container, data, { onSelect: (id) => ui?.select(id) })
    : createSceneFallback(container, LOAD_FAILED_MESSAGE);
  const poller = createPoller(api.getState, {
    interval: POLL_MS,
    onResult: (state, startedAt) => ui.setState(state, startedAt),
    onError: (err) => ui.setLoadError(err),
  });
  ui = createUI({ model, scene, api, refresh: () => poller.refreshNow() });
  poller.start();
}

boot();
