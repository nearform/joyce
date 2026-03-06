/* global localStorage:false, navigator:false, document:false, setTimeout:false, clearTimeout:false */

const SESSION_KEY = "joyce_crash_session";
const LAST_CRASH_KEY = "joyce_crash_last";
const THROTTLE_MS = 500;
const MAX_ERRORS = 10;
const MAX_MESSAGE_LENGTH = 200;

// Safe localStorage helpers (Safari private browsing throws on access)
const safeGet = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const safeSet = (key, val) => {
  try {
    localStorage.setItem(key, val);
  } catch {
    /* silent — quota exceeded or private browsing */
  }
};
const safeRemove = (key) => {
  try {
    localStorage.removeItem(key);
  } catch {
    /* silent */
  }
};

// In-memory session state
let session = null;
let pendingMilestones = [];
let throttleTimer = null;

const readSession = () => {
  const raw = safeGet(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const writeSession = () => {
  if (!session) return;
  safeSet(SESSION_KEY, JSON.stringify(session));
};

const flushMilestones = () => {
  if (!session || pendingMilestones.length === 0) return;
  session.milestones.push(...pendingMilestones);
  pendingMilestones = [];
  if (throttleTimer) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
  writeSession();
};

const scheduleFlush = () => {
  if (throttleTimer) return;
  throttleTimer = setTimeout(() => {
    throttleTimer = null;
    flushMilestones();
  }, THROTTLE_MS);
};

const markCleanExit = () => {
  if (!session) return;
  flushMilestones();
  session.cleanExit = true;
  writeSession();
};

const markUnclean = () => {
  if (!session) return;
  session.cleanExit = false;
  writeSession();
};

/**
 * Initialize crash detection. Call once on page load.
 * @returns {{ previousCrash: object|null }}
 */
export const initCrashDetection = () => {
  // 1. Check previous session
  let previousCrash = null;
  const prev = readSession();
  if (prev && prev.cleanExit === false) {
    previousCrash = prev;
    safeSet(LAST_CRASH_KEY, JSON.stringify(prev));
  }

  // 2. Start fresh session
  session = {
    startedAt: Date.now(),
    url: globalThis.location?.href ?? null,
    userAgent: navigator?.userAgent ?? null,
    platform: navigator?.platform ?? null,
    deviceMemory: navigator?.deviceMemory ?? null,
    hardwareConcurrency: navigator?.hardwareConcurrency ?? null,
    milestones: [],
    errors: [],
    dataSizes: null,
    cleanExit: false,
  };
  writeSession();

  // 3. Register lifecycle events
  globalThis.addEventListener("pagehide", () => {
    markCleanExit();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      markCleanExit();
    } else {
      markUnclean();
    }
  });

  globalThis.addEventListener("pageshow", (e) => {
    if (e.persisted) {
      markUnclean();
    }
  });

  return { previousCrash };
};

/**
 * Record a loading milestone. Throttled writes to localStorage.
 * @param {{ resource: string, status: string, elapsed?: number }} milestone
 */
export const recordMilestone = ({ resource, status, elapsed }) => {
  if (!session) return;
  pendingMilestones.push({
    resource,
    status,
    elapsed: elapsed != null ? Math.round(elapsed) : null,
    timestamp: Date.now(),
  });
  scheduleFlush();
};

/**
 * Record an error. Written immediately (errors are rare).
 * @param {{ message: string, source?: string, lineno?: number, colno?: number }} err
 */
export const recordError = ({ message, source, lineno, colno }) => {
  if (!session) return;
  if (session.errors.length >= MAX_ERRORS) return;
  session.errors.push({
    message: String(message || "").slice(0, MAX_MESSAGE_LENGTH),
    source: source || null,
    lineno: lineno ?? null,
    colno: colno ?? null,
    timestamp: Date.now(),
  });
  flushMilestones(); // flush everything together
};

/**
 * Record data sizes (post count, chunk count). Written immediately.
 * @param {{ postCount: number, chunkCount: number }} sizes
 */
export const recordDataSizes = ({ postCount, chunkCount }) => {
  if (!session) return;
  session.dataSizes = { postCount, chunkCount };
  writeSession();
};

/**
 * Get the last crash session data.
 * @returns {object|null}
 */
export const getLastCrash = () => {
  const raw = safeGet(LAST_CRASH_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/**
 * Clear the last crash data.
 */
export const clearLastCrash = () => {
  safeRemove(LAST_CRASH_KEY);
};
