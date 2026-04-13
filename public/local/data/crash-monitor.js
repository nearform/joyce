/* global localStorage:false */
/**
 * Crash monitor for HuggingFace Transformers operations.
 *
 * Tracks risky operations (model download, compile, inference, embeddings)
 * via localStorage checkpoints. If a checkpoint is "in-progress" on the
 * next page load, the previous session crashed during that phase.
 *
 * Detection layers (see inline script in index.html):
 *  1. **Checkpoints** — written BEFORE each risky phase, cleared AFTER.
 *     Incomplete checkpoints on next load = crash during that phase.
 *  2. **beforeunload** — marks clean exits so we can distinguish a crash
 *     from normal navigation (no clean-exit flag = crash).
 *  3. **sessionStorage session flag** — persists across same-tab reloads
 *     but not tab close. Detects "tab crashed and auto-reloaded" on iOS.
 *  4. **app:module-init checkpoint** — set by the inline script BEFORE
 *     ES module resolution. If the tab dies during @huggingface/transformers
 *     import (WebGPU probe, WASM compile), this checkpoint remains.
 *
 * Crash detection + clean-exit handler + session flag are all handled
 * by a plain <script> in index.html that runs BEFORE module imports.
 * This module only provides the checkpoint API and crash-log readers.
 */

const CHECKPOINT_KEY = "tjs_checkpoints";
const CRASH_LOG_KEY = "tjs_crash_log";

// -----------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------

const readJSON = (key) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const writeJSON = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* best-effort — storage may be full or unavailable */
  }
};

// -----------------------------------------------------------------------
// Checkpoint API
// -----------------------------------------------------------------------

/**
 * Begin a checkpoint for a risky operation.
 * Call this BEFORE the operation starts. If the tab dies before
 * `endCheckpoint` is called, this checkpoint will be detected as
 * incomplete on the next page load.
 *
 * @param {string} id - Unique operation id, e.g. "chat:load:modelName"
 * @param {Object} [meta] - Optional metadata (model, phase, etc.)
 */
export const beginCheckpoint = (id, meta = {}) => {
  const checkpoints = readJSON(CHECKPOINT_KEY) ?? {};
  checkpoints[id] = {
    ...meta,
    startedAt: new Date().toISOString(),
    status: "in-progress",
  };
  writeJSON(CHECKPOINT_KEY, checkpoints);
};

/**
 * End a checkpoint (operation completed successfully).
 * @param {string} id - Same id passed to beginCheckpoint
 */
export const endCheckpoint = (id) => {
  const checkpoints = readJSON(CHECKPOINT_KEY) ?? {};
  delete checkpoints[id];
  writeJSON(CHECKPOINT_KEY, checkpoints);
};

/**
 * Fail a checkpoint (operation threw a catchable error).
 * @param {string} id - Same id passed to beginCheckpoint
 * @param {string} error - Error message
 */
export const failCheckpoint = (id, error) => {
  const checkpoints = readJSON(CHECKPOINT_KEY) ?? {};
  if (checkpoints[id]) {
    checkpoints[id].status = "error";
    checkpoints[id].error = error;
    checkpoints[id].failedAt = new Date().toISOString();
  }
  writeJSON(CHECKPOINT_KEY, checkpoints);
};

// -----------------------------------------------------------------------
// Crash log (populated by inline script in index.html)
// -----------------------------------------------------------------------

/**
 * Get the crash log (previous crashes, most recent first).
 * @returns {Array<Object>}
 */
export const getCrashLog = () => readJSON(CRASH_LOG_KEY) ?? [];

/**
 * Clear the crash log.
 */
export const clearCrashLog = () => {
  try {
    localStorage.removeItem(CRASH_LOG_KEY);
  } catch {
    /* best-effort */
  }
};
