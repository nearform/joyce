/* global navigator */
// Dynamic memory-headroom estimation for web-llm, feeding crashbox.
//
// WebGPU exposes NO "free VRAM" query and performance.memory only sees the JS heap — neither sees an
// LLM's weights/KV-cache (GPU buffers + WASM linear memory). So we can't MEASURE remaining memory;
// we estimate usage against the device budget (owned by telemetry.deviceMemoryBudgetBytes) and hand
// the ratio to crashbox, which levels it nominal/fair/serious/critical. Two signals do the work:
//
//   1. Pre-flight (deterministic-ish): a model's required single-buffer size vs the GPU's hard
//      maxStorageBufferBindingSize (a true ceiling — the common iOS-Safari failure), plus the
//      CUMULATIVE vram of already-resident models + the new one vs the device budget.
//   2. During-load (estimated): web-llm's initProgressCallback gives progress 0..1, so committed
//      bytes ≈ Σ(vram_required × progress) across loaded models — the only heap-like ratio available
//      on iOS, climbing toward the ceiling AS each model loads.
//
// CUMULATIVE is the point: joyce caches engines and a 2nd model load does NOT free the 1st, so the
// real footprint is the SUM. A per-model check passes each model individually yet still OOMs on the
// total — exactly the case that hard-killed the tab in testing.
//
// Provider-agnostic budget: the device budget lives in telemetry (not web-llm-specific) so init's
// memoryBudgetBytes and this estimator share one number. This module imports only that + the
// estimator registration, so it stays cheap to load and never pulls in the web-llm bundle.

import {
  setMemoryEstimator,
  deviceMemoryBudgetBytes,
} from "../../telemetry.js";

const MB = 1048576;
// At/above this fraction of budget a (cumulative) load is "risky" — likely to OOM.
const RISKY_RATIO = 0.9;

// model_id -> { vramBytes, progress }. All entries count: resident models stay committed until the
// page reloads. Cleared per-model on a failed load (clearLoad).
/** @type {Map<string, { vramBytes: number, progress: number }>} */
const loaded = new Map();

// Two notions of footprint:
//  - committed: vram × progress, summed — what's ACTUALLY allocated right now (for the live gauge).
//  - intended (excluding a given model): the full vram of every OTHER tracked model regardless of
//    progress — what WILL be allocated once in-flight loads finish (for the pre-flight, so two
//    near-concurrent loads each at ~0 progress still project their full combined footprint).

/** Total committed-so-far bytes across every tracked model (vram × load progress). */
const committedBytes = () => {
  let sum = 0;
  for (const m of loaded.values()) {
    sum += m.vramBytes * m.progress;
  }
  return sum;
};

/** Full intended vram of every tracked model except `exceptModel` (progress-independent). */
const residentIntendedBytes = (exceptModel) => {
  let sum = 0;
  for (const [id, m] of loaded) {
    if (id !== exceptModel) {
      sum += m.vramBytes;
    }
  }
  return sum;
};

/**
 * Read the GPU's hard per-buffer cap (a deterministic ceiling). Null where unavailable.
 * @returns {Promise<number | null>}
 */
const readMaxStorageBufferBindingSize = async () => {
  try {
    const adapter = await navigator.gpu?.requestAdapter?.();
    return adapter?.limits?.maxStorageBufferBindingSize ?? null;
  } catch {
    return null;
  }
};

/**
 * Predict whether a model will fit BEFORE loading it — accounting for models already resident.
 * @param {{ model: string, vramRequiredMB?: number, bufferSizeRequiredBytes?: number, lowResource?: boolean }} rec
 * @returns {Promise<{ model: string, verdict: "ok" | "risky" | "wont-fit", vramBytes: number, residentBytes: number, projectedBytes: number, budgetBytes: number, ratio: number | null, exceedsBufferCap: boolean, maxStorageBufferBindingSize: number | null }>}
 */
export const preflightModel = async (rec) => {
  const vramBytes = (rec.vramRequiredMB ?? 0) * MB;
  const bufReq = rec.bufferSizeRequiredBytes ?? 0;
  const budgetBytes = deviceMemoryBudgetBytes();
  const maxBind = await readMaxStorageBufferBindingSize();
  // The deterministic check: a single required buffer larger than the device's binding cap can't be
  // allocated, so the model won't load at all (the classic iOS-Safari failure mode).
  const exceedsBufferCap = !!(bufReq && maxBind && bufReq > maxBind);
  // Project the TOTAL footprint at full intent: other tracked models' full vram + this model. Using
  // full vram (not progress) means two near-simultaneous loads each at ~0 progress still project
  // their combined footprint — the case the live (progress-weighted) sum misses at load start.
  const residentBytes = residentIntendedBytes(rec.model);
  const projected = residentBytes + vramBytes;
  const ratio = budgetBytes ? projected / budgetBytes : null;
  // "wont-fit" (→ critical): a single buffer exceeds the hard GPU cap, OR the projected total is at
  // or over budget (it literally won't fit). "risky" (→ serious): approaching the budget.
  const verdict =
    exceedsBufferCap || (ratio != null && ratio >= 1)
      ? "wont-fit"
      : ratio != null && ratio >= RISKY_RATIO
        ? "risky"
        : "ok";
  return {
    model: rec.model,
    verdict,
    vramBytes,
    residentBytes,
    projectedBytes: projected,
    budgetBytes,
    ratio,
    exceedsBufferCap,
    maxStorageBufferBindingSize: maxBind,
  };
};

/**
 * Track a model as loading so the pull source includes its committed-so-far ≈ vram × progress.
 * @param {{ model: string, vramRequiredMB?: number }} rec
 */
export const beginLoad = (rec) => {
  loaded.set(rec.model, {
    vramBytes: (rec.vramRequiredMB ?? 0) * MB,
    progress: 0,
  });
};

/** @param {string} model @param {number} [progress] 0..1 from web-llm's initProgressCallback */
export const setLoadProgress = (model, progress) => {
  const entry = loaded.get(model);
  if (entry && typeof progress === "number") {
    entry.progress = Math.min(1, Math.max(entry.progress, progress));
  }
};

/** Weights committed once loaded; pin this model's estimate at 100%. @param {string} model */
export const finishLoad = (model) => {
  const entry = loaded.get(model);
  if (entry) {
    entry.progress = 1;
  }
};

/** A failed load frees what it committed — drop this model from the estimate. @param {string} model */
export const clearLoad = (model) => {
  loaded.delete(model);
};

/**
 * crashbox getMemoryEstimate pull source (MUST be synchronous). Cumulative committed VRAM across all
 * resident models vs the device budget; crashbox turns the used/limit ratio into a level. Null until
 * a model starts loading.
 * @returns {{ usedBytes: number, limitBytes: number } | null}
 */
export const getWebllmMemoryEstimate = () => {
  const used = committedBytes();
  if (loaded.size === 0 || used <= 0) {
    return null;
  }
  return { usedBytes: Math.round(used), limitBytes: deviceMemoryBudgetBytes() };
};

// Register the pull source the moment this module loads (i.e. when the web-llm provider is first
// used). Until then crashbox's getMemoryEstimate simply returns null.
setMemoryEstimator(getWebllmMemoryEstimate);
