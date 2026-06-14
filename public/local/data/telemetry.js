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
  reportMemoryPressure,
  getStatus,
  wrap,
} from "crashbox";
import { getSettings } from "../../app/hooks/use-settings.js";

/**
 * Normalize an error into a short, breadcrumb-safe string: its `.message` (or the value stringified)
 * truncated to `max` chars so telemetry payloads stay small. Shared by every breadcrumb that logs an
 * error so the cap and shape live in one place.
 * @param {unknown} err
 * @param {number} [max=200]
 * @returns {string}
 */
export const errMessage = (err, max = 200) =>
  String(/** @type {any} */ (err)?.message ?? err).slice(0, max);

// Device memory budget for crashbox: a fraction of navigator.deviceMemory on Chromium, else a
// conservative iOS constant (~1.5 GB — the iPhone 15 Pro hard-kill point, crashbox research §6).
// Passed as `memoryBudgetBytes` (so the wasm/webgpu thresholds scale up and a routine ~100 MB WASM
// load on iOS no longer trips the fixed 64 MB floor) and reused as the denominator for the web-llm
// pull source, so init and the estimator agree on one budget.
//
// navigator.deviceMemory is spec-capped at 8, so a `dm === 8` reading means "≥8 GB" — on a real
// desktop that's often far more. Trust more headroom when capped (×0.9) so a genuinely large model
// (>~4.3 GB) doesn't read "risky" on a big machine; keep the conservative ×0.6 for honest low
// readings (e.g. a 4 GB Chromebook). An optional `memoryBudgetMb` setting overrides everything for
// the long tail (a 64 GB workstation still reports dm=8).
const GB = 1024 * 1024 * 1024;
const DEVICE_MEMORY_CAP_GB = 8; // navigator.deviceMemory spec cap
export const deviceMemoryBudgetBytes = () => {
  const overrideMb = getSettings().memoryBudgetMb;
  if (typeof overrideMb === "number" && overrideMb > 0) {
    return Math.round(overrideMb * 1024 * 1024);
  }
  const dm = globalThis.navigator?.deviceMemory;
  if (typeof dm !== "number" || dm <= 0) {
    return Math.round(1.5 * GB); // iOS / no signal — conservative const
  }
  const fraction = dm >= DEVICE_MEMORY_CAP_GB ? 0.9 : 0.6;
  return Math.round(dm * GB * fraction);
};

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

// Optional pull source for crashbox's memory sampler, registered by a provider (e.g. web-llm) via
// setMemoryEstimator. Returns the current { usedBytes, limitBytes } (or a plain number / null).
// Kept provider-agnostic so telemetry never imports a provider module (and never eagerly loads it).
/** @type {null | (() => { usedBytes: number, limitBytes?: number } | number | null | undefined)} */
let memoryEstimator = null;
export const setMemoryEstimator = (fn) => {
  memoryEstimator = typeof fn === "function" ? fn : null;
};

export const bootstrap = () => {
  if (booted) {
    return;
  }
  booted = true;
  cbInit({
    // "memory" polls performance.memory (Chromium only — a no-op on iOS Safari) and reports a
    // budget-relative pressure level; wasm/webgpu thresholds auto-scale to the JS-heap/device budget
    // on Chromium and keep their fixed iOS bytes where no budget signal exists.
    detectors: ["js", "webgpu", "wasm", "memory"],
    namespace: "joyce",
    // Device-relative budget: scales the wasm/webgpu thresholds (so iOS doesn't trip its fixed
    // 64 MB floor on a routine ~100 MB embeddings load) and is the denominator for getMemoryEstimate.
    memoryBudgetBytes: deviceMemoryBudgetBytes(),
    // Polled each heartbeat. No-op until a provider registers an estimator (web-llm does on load),
    // then reports committed VRAM vs the device budget so crashbox can level it before an OOM.
    getMemoryEstimate: () => (memoryEstimator ? memoryEstimator() : null),
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
 * Wipe crashbox's persisted state (snapshot, breadcrumbs, recovered record, session marker) via the
 * debug handle's clear(), drop the wrapper's recovered copy, and re-notify so the Crashes panel
 * reflects the reset. The handle only exists in developer mode — the empty fallback keeps this a
 * no-op otherwise. Returns the localStorage keys removed.
 * @returns {string[]}
 */
export const resetCrashbox = () => {
  const removed = globalThis.__crashbox?.clear?.() ?? [];
  recovered = null;
  notify();
  return removed;
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

export { breadcrumb, attachGPUDevice, reportMemoryPressure, getStatus, wrap };
