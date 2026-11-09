/**
 * fallback.js — stand-in for the 3D scene when it can't run (no WebGL, or the three.js
 * bundle failed to load). Shows a message in the scene area and offers the same API as
 * createScene() as no-ops, so the panel, list and checklist keep working. No three.js import.
 */

export const NO_WEBGL_MESSAGE = 'The 3D map needs WebGL, which this browser or device can’t provide. '
  + 'The house list, details and checklist still work.';

export const LOAD_FAILED_MESSAGE = 'The 3D map couldn’t be loaded. Check your connection and reload the page. '
  + 'The house list, details and checklist still work.';

export function createSceneFallback(container, message = NO_WEBGL_MESSAGE) {
  const msg = document.createElement('div');
  msg.className = 'scene-fallback';
  msg.setAttribute('role', 'note');
  msg.textContent = message;
  container.append(msg);
  const noop = () => {};
  return {
    available: false, applyState: noop, select: noop, focus: noop, setMode: noop,
    resetView: noop, topView: noop, setViewInset: noop, dispose: () => msg.remove(),
  };
}
