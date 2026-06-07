// Joyce-side shim over the crashbox library. Centralizes the import so the rest of the app
// uses one module — easier to swap or stub, and the place we add Joyce-specific helpers (a
// `subscribe()` + `getCrashboxSnapshot()` external store for the UI, consumed via the `useCrashbox`
// hook) on top of crashbox's primitives.

import {
  init as cbInit,
  teardown as cbTeardown,
  breadcrumb,
  setSnapshot as cbSetSnapshot,
  clearRecovered as cbClearRecovered,
  attachGPUDevice,
  getStatus,
  wrap,
} from "crashbox";
import { getSettings } from "../../app/hooks/use-settings.js";

let recovered = null;
// Whether bootstrap() has run. crashbox.init() intentionally supports re-init, so the "boot once"
// policy lives here in the wrapper; shutdown() resets it so a later bootstrap() can run again.
let booted = false;
/** @type {Set<() => void>} */
const listeners = new Set();
// Merged snapshot maintained across multiple owners (loading layer, route updater, chat
// session). crashbox.setSnapshot itself is whole-replace; mergeSnapshot keeps the union so
// owners don't clobber each other.
/** @type {Record<string, unknown>} */
const snapshotState = {};

// External-store version + cached snapshot for `useSyncExternalStore`. A fresh `{ recovered, status }`
// object every call would break `useSyncExternalStore` (it compares by identity and would loop), so
// we hand out one cached object per `version` and only rebuild it when notify() bumps the version.
let version = 0;
let snapshotVersion = -1;
/** @type {{ recovered: typeof recovered, status: ReturnType<typeof getStatus> } | null} */
let snapshot = null;

const notify = () => {
  version += 1;
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // a throwing subscriber must not break the others
    }
  }
};

export const bootstrap = () => {
  if (booted) {
    return;
  }
  booted = true;
  cbInit({
    detectors: ["js", "webgpu", "wasm"],
    namespace: "joyce",
    // window.__crashbox exposes diagnostics including clear() (wipes crashbox's localStorage). The
    // Crashes UI reads the getCrashboxSnapshot() store, not the global handle, so gate the handle to
    // developer mode — matching the Crashes panel's own gating.
    debug: getSettings().isDeveloperMode,
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

/**
 * Tear crashbox fully down (restores patched natives, marks a clean shutdown) and reset the wrapper's
 * own state so a later bootstrap() can start fresh. Subscribed UI stays mounted; notify() re-renders
 * it to the inactive state. Lets the settings toggle take effect without a reload.
 */
export const shutdown = () => {
  cbTeardown();
  recovered = null;
  for (const key of Object.keys(snapshotState)) {
    delete snapshotState[key];
  }
  booted = false;
  notify();
};

export const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/**
 * Stable snapshot for `useSyncExternalStore` (see `useCrashbox`): the recovered crash plus the live
 * session status. Returns the same reference until notify() fires, then rebuilds once.
 */
export const getCrashboxSnapshot = () => {
  if (snapshotVersion !== version) {
    snapshot = { recovered, status: getStatus() };
    snapshotVersion = version;
  }
  return snapshot;
};

export const dismissRecovered = () => {
  recovered = null;
  // Also clear crashbox's own copy so window.__crashbox.recovered() stops reporting the dismissed
  // crash — keeps the debug handle in sync with the UI.
  cbClearRecovered();
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
