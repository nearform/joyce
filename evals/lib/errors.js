// Failure taxonomy for the eval harness.
//
// The central idea: only the `ok` outcome carries a quality signal. Everything else means the
// harness, the server, the CDN, the browser, the model loader, or the judge failed — and reporting
// any of those as "the model got worse" would destroy trust in the suite. classify() is the single
// place that maps a thrown error plus the page capture into an outcome.

/**
 * Every case run resolves to exactly one of these.
 *
 * - harness_error        the harness or CDP broke
 * - server_error         dev server / app assets unavailable
 * - cdn_error            runtime deps (jsdelivr) unreachable
 * - model_load_error     the model never became usable
 * - timeout              a phase deadline was exceeded
 * - sut_error            the app threw during generation
 * - skipped              deliberately not run (predicate, unsupported provider)
 * - skipped_unavailable  the signal can't be obtained on this driver
 * - judge_error          the judge failed; deterministic scores remain valid
 * - ok                   ran clean; scores decide pass/fail
 */
export const OUTCOMES = {
  HARNESS_ERROR: "harness_error",
  SERVER_ERROR: "server_error",
  CDN_ERROR: "cdn_error",
  MODEL_LOAD_ERROR: "model_load_error",
  TIMEOUT: "timeout",
  SUT_ERROR: "sut_error",
  SKIPPED: "skipped",
  SKIPPED_UNAVAILABLE: "skipped_unavailable",
  JUDGE_ERROR: "judge_error",
  OK: "ok",
};

/** Outcomes that must never be reported as a quality regression. */
const NON_QUALITY = new Set([
  OUTCOMES.HARNESS_ERROR,
  OUTCOMES.SERVER_ERROR,
  OUTCOMES.CDN_ERROR,
  OUTCOMES.MODEL_LOAD_ERROR,
  OUTCOMES.TIMEOUT,
  OUTCOMES.SUT_ERROR,
  OUTCOMES.SKIPPED,
  OUTCOMES.SKIPPED_UNAVAILABLE,
  OUTCOMES.JUDGE_ERROR,
]);

/**
 * Outcomes severe enough that a baseline must not be written or compared from this run.
 * `sut_error` and `judge_error` are excluded: they're tracked as their own rates, and a handful of
 * them shouldn't invalidate an otherwise healthy run.
 */
const BLOCKS_BASELINE = new Set([
  OUTCOMES.HARNESS_ERROR,
  OUTCOMES.SERVER_ERROR,
  OUTCOMES.CDN_ERROR,
  OUTCOMES.MODEL_LOAD_ERROR,
  OUTCOMES.TIMEOUT,
]);

/**
 * @param {string} outcome
 * @returns {boolean} whether the outcome reflects answer quality rather than infrastructure
 */
export const isQualitySignal = (outcome) => !NON_QUALITY.has(outcome);

/**
 * @param {string} outcome
 * @returns {boolean}
 */
export const blocksBaseline = (outcome) => BLOCKS_BASELINE.has(outcome);

/** Base error carrying a stable machine-readable `code` plus arbitrary `details`. */
export class EvalError extends Error {
  /**
   * @param {string} code - dotted taxonomy code, e.g. "cdp.timeout"
   * @param {string} message
   * @param {Object} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

/** The harness itself, Chrome launching, or CDP plumbing failed. */
export class HarnessError extends EvalError {}

/** A CDP command failed or the DevTools socket dropped. */
export class CdpError extends EvalError {}

/** An exception was thrown inside the browser page. */
export class PageError extends EvalError {}

/** A phase deadline was exceeded. */
export class TimeoutError extends EvalError {}

/** The app threw during retrieval or generation. */
export class SutError extends EvalError {}

/** The judge was unreachable, refused, or returned something unparseable. */
export class JudgeError extends EvalError {}

/** Explicit, non-failing skip. */
export class SkipError extends EvalError {}

const CDN_HOSTS = new Set(["cdn.jsdelivr.net"]);

/** Matched against a page exception message to spot GPU/memory death. */
const OOM_RE =
  /out of memory|device.*lost|webgpu.*(lost|error)|allocation failed/i;
const MODEL_LOAD_RE = /model|shard|wasm|mlc|engine|reload|cache/i;

/**
 * Map a code prefix onto an outcome. Ordered most- to least-specific.
 * @type {Array<[RegExp, string]>}
 */
const CODE_RULES = [
  [/^skip\./, OUTCOMES.SKIPPED],
  [/^unavailable\./, OUTCOMES.SKIPPED_UNAVAILABLE],
  [/^timeout\./, OUTCOMES.TIMEOUT],
  [/^judge\./, OUTCOMES.JUDGE_ERROR],
  [/^server\.|^app\.module_fetch_failed$/, OUTCOMES.SERVER_ERROR],
  [/^cdn\./, OUTCOMES.CDN_ERROR],
  [/^llm\./, OUTCOMES.MODEL_LOAD_ERROR],
  [/^sut\./, OUTCOMES.SUT_ERROR],
  [/^chrome\.|^cdp\.|^page\.|^ui\.|^harness\./, OUTCOMES.HARNESS_ERROR],
];

/**
 * Resolve a thrown error, plus whatever the page capture observed, into a single outcome.
 *
 * The capture is consulted even when the error itself looks generic: a failed jsdelivr request or a
 * crashed renderer explains an otherwise-mysterious timeout, and misattributing either one would
 * show up as a phantom quality regression.
 *
 * @param {Error|EvalError|null} err
 * @param {{failedRequests?: Array<{url: string, errorText: string}>,
 *          exceptions?: Array<{message: string}>,
 *          rendererCrashed?: boolean,
 *          appOrigin?: string}} [capture]
 * @returns {{outcome: string, code: string|null, message: string, retryable: boolean,
 *            details: Object}}
 */
export const classify = (err, capture = {}) => {
  const failed = capture.failedRequests ?? [];
  const cdnFailure = failed.find((r) => {
    try {
      return CDN_HOSTS.has(new URL(r.url).hostname);
    } catch {
      return false;
    }
  });

  // A crashed renderer or a dead CDN outranks whatever error surfaced downstream of it: the
  // downstream error is a symptom, and reporting the symptom sends people to the wrong place.
  if (capture.rendererCrashed) {
    return result(
      OUTCOMES.HARNESS_ERROR,
      "renderer.crashed",
      "Chrome renderer crashed",
      false,
      {
        cause: err?.message ?? null,
      },
    );
  }
  if (cdnFailure) {
    return result(
      OUTCOMES.CDN_ERROR,
      "cdn.loading_failed",
      `Runtime dependency failed to load: ${cdnFailure.url} (${cdnFailure.errorText})`,
      true,
      {
        url: cdnFailure.url,
        errorText: cdnFailure.errorText,
        cause: err?.message ?? null,
      },
    );
  }

  if (!err) {
    return result(OUTCOMES.OK, null, "", false, {});
  }

  if (err.code) {
    for (const [re, outcome] of CODE_RULES) {
      if (re.test(err.code)) {
        return result(
          outcome,
          err.code,
          err.message,
          isRetryable(outcome),
          err.details ?? {},
        );
      }
    }
  }

  // An app-origin request failure means the dev server went away mid-run.
  if (capture.appOrigin) {
    const appFailure = failed.find((r) => r.url.startsWith(capture.appOrigin));
    if (appFailure) {
      return result(
        OUTCOMES.SERVER_ERROR,
        "server.request_failed",
        `App request failed: ${appFailure.url} (${appFailure.errorText})`,
        true,
        { url: appFailure.url, errorText: appFailure.errorText },
      );
    }
  }

  const message = err.message ?? String(err);
  if (OOM_RE.test(message)) {
    const code = MODEL_LOAD_RE.test(message) ? "llm.oom" : "sut.gpu_lost";
    const outcome =
      code === "llm.oom" ? OUTCOMES.MODEL_LOAD_ERROR : OUTCOMES.SUT_ERROR;
    return result(outcome, code, message, true, err.details ?? {});
  }

  return result(
    OUTCOMES.HARNESS_ERROR,
    "harness.unclassified",
    message,
    false,
    {
      name: err.name ?? null,
      stack: err.stack ?? null,
    },
  );
};

const isRetryable = (outcome) =>
  outcome === OUTCOMES.CDN_ERROR ||
  outcome === OUTCOMES.SERVER_ERROR ||
  outcome === OUTCOMES.TIMEOUT;

const result = (outcome, code, message, retryable, details) => ({
  outcome,
  code,
  message,
  retryable,
  details,
});
