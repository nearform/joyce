// Joyce-side shim over the crashbox library. Centralizes the import so the rest of the app
// uses one module — easier to swap or stub, and the place we add Joyce-specific helpers
// (a `subscribe()` event bus for UI, in-session `recoveredCrash()` accessor) on top of
// crashbox's primitives.

import {
  init as cbInit,
  breadcrumb,
  setSnapshot as cbSetSnapshot,
  attachGPUDevice,
  getStatus,
  wrap,
} from "crashbox";

/** @type {import("../../vendor/crashbox/src/types.js").CrashRecord | null} */
let recovered = null;
/** @type {Set<() => void>} */
const listeners = new Set();
// Merged snapshot maintained across multiple owners (loading layer, route updater, chat
// session). crashbox.setSnapshot itself is whole-replace; mergeSnapshot keeps the union so
// owners don't clobber each other.
/** @type {Record<string, unknown>} */
const snapshotState = {};

const notify = () => {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // a throwing subscriber must not break the others
    }
  }
};

export const bootstrap = () => {
  cbInit({
    detectors: ["js", "webgpu", "wasm"],
    namespace: "joyce",
    // Safe to leave on — only attaches window.__crashbox for diagnostics. The Crashes UI uses
    // the regular getStatus()/recoveredCrash() exports rather than the debug handle.
    debug: true,
    onCrashRecovered: (record) => {
      recovered = record;
      notify();
    },
    // The crashbox warnings buffer is the source of truth; we re-notify so the UI can poll
    // getStatus() afresh without subscribing to crashbox internals.
    onMemoryPressure: notify,
    onDeviceLossImminent: notify,
  });
};

export const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const recoveredCrash = () => recovered;

export const dismissRecovered = () => {
  recovered = null;
  notify();
};

/**
 * Merge a partial into the running snapshot and push the union to crashbox. Lets multiple
 * owners contribute disjoint keys without clobbering each other.
 * @param {Record<string, unknown>} partial
 */
export const mergeSnapshot = (partial) => {
  Object.assign(snapshotState, partial);
  cbSetSnapshot({ ...snapshotState });
};

export { breadcrumb, attachGPUDevice, getStatus, wrap };
