/* global localStorage:false, sessionStorage:false, window:false */
/**
 * Crash monitor for HuggingFace Transformers operations.
 *
 * Tracks risky operations (model download, compile, inference, embeddings)
 * via localStorage checkpoints. If a checkpoint is "in-progress" on the
 * next page load, the previous session crashed during that phase.
 *
 * Detection layers:
 *  1. **Checkpoints** — written BEFORE each risky phase, cleared AFTER.
 *     Incomplete checkpoints on next load = crash during that phase.
 *  2. **beforeunload** — marks clean exits so we can distinguish a crash
 *     (no clean-exit flag) from normal navigation.
 *  3. **sessionStorage session flag** — persists across same-tab reloads
 *     but not tab close. Detects "tab crashed and auto-reloaded" on iOS.
 */

const CHECKPOINT_KEY = "tjs_checkpoints";
const CLEAN_EXIT_KEY = "tjs_clean_exit";
const SESSION_KEY = "tjs_session_active";
const CRASH_LOG_KEY = "tjs_crash_log";

// -----------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------

const readJSON = (storage, key) => {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const writeJSON = (storage, key, value) => {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    /* best-effort — storage may be full or unavailable */
  }
};

const removeKey = (storage, key) => {
  try {
    storage.removeItem(key);
  } catch {
    /* best-effort */
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
  const checkpoints = readJSON(localStorage, CHECKPOINT_KEY) ?? {};
  checkpoints[id] = {
    ...meta,
    startedAt: new Date().toISOString(),
    status: "in-progress",
  };
  writeJSON(localStorage, CHECKPOINT_KEY, checkpoints);
};

/**
 * End a checkpoint (operation completed successfully).
 * @param {string} id - Same id passed to beginCheckpoint
 */
export const endCheckpoint = (id) => {
  const checkpoints = readJSON(localStorage, CHECKPOINT_KEY) ?? {};
  delete checkpoints[id];
  writeJSON(localStorage, CHECKPOINT_KEY, checkpoints);
};

/**
 * Fail a checkpoint (operation threw a catchable error).
 * @param {string} id - Same id passed to beginCheckpoint
 * @param {string} error - Error message
 */
export const failCheckpoint = (id, error) => {
  const checkpoints = readJSON(localStorage, CHECKPOINT_KEY) ?? {};
  if (checkpoints[id]) {
    checkpoints[id].status = "error";
    checkpoints[id].error = error;
    checkpoints[id].failedAt = new Date().toISOString();
  }
  writeJSON(localStorage, CHECKPOINT_KEY, checkpoints);
};

// -----------------------------------------------------------------------
// Crash detection (run once on page load)
// -----------------------------------------------------------------------

/**
 * Detect crashes from the previous session.
 * Call once at app startup. Returns an array of crash records
 * (incomplete checkpoints from the previous session) and archives
 * them to crash history.
 *
 * @returns {Array<{ id: string, model?: string, phase?: string, startedAt: string, cleanExit: boolean, sessionCrash: boolean }>}
 */
export const detectCrashes = () => {
  const crashes = [];
  const hadCleanExit = readJSON(localStorage, CLEAN_EXIT_KEY) === true;
  const sessionWasActive = readJSON(sessionStorage, SESSION_KEY) === true;

  // Check for incomplete checkpoints
  const checkpoints = readJSON(localStorage, CHECKPOINT_KEY) ?? {};
  for (const [id, cp] of Object.entries(checkpoints)) {
    if (cp.status === "in-progress") {
      crashes.push({
        id,
        ...cp,
        cleanExit: hadCleanExit,
        // sessionStorage survives same-tab reload but not close+reopen.
        // If session was active AND we have an incomplete checkpoint,
        // the tab crashed and was reloaded (common on iOS).
        sessionCrash: sessionWasActive,
      });
    }
  }

  if (crashes.length > 0) {
    // Archive to crash log (keep last 5)
    const log = readJSON(localStorage, CRASH_LOG_KEY) ?? [];
    log.unshift(
      ...crashes.map((c) => ({ ...c, detectedAt: new Date().toISOString() })),
    );
    writeJSON(localStorage, CRASH_LOG_KEY, log.slice(0, 5));
  }

  // Reset state for this session
  writeJSON(localStorage, CHECKPOINT_KEY, {});
  removeKey(localStorage, CLEAN_EXIT_KEY);
  writeJSON(sessionStorage, SESSION_KEY, true);

  return crashes;
};

/**
 * Get the crash log (previous crashes, most recent first).
 * @returns {Array<Object>}
 */
export const getCrashLog = () => readJSON(localStorage, CRASH_LOG_KEY) ?? [];

/**
 * Clear the crash log.
 */
export const clearCrashLog = () => removeKey(localStorage, CRASH_LOG_KEY);

// -----------------------------------------------------------------------
// Clean-exit tracking
// -----------------------------------------------------------------------

/**
 * Install the beforeunload handler that marks clean navigation.
 * Call once at app startup. When the page unloads normally
 * (navigation, refresh, tab close) this fires and sets the flag.
 * On a true crash, beforeunload never fires — so the flag stays unset.
 */
export const installCleanExitHandler = () => {
  if (typeof window === "undefined") return;
  window.addEventListener("beforeunload", () => {
    writeJSON(localStorage, CLEAN_EXIT_KEY, true);
    // Also clear any in-progress checkpoints on clean exit so they
    // don't show as false-positive crashes on next load.
    writeJSON(localStorage, CHECKPOINT_KEY, {});
  });
};
