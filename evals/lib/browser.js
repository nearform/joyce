// BrowserSession facade: the only browser surface the drivers use.
//
// Wraps Chrome launch, a CDP tab, settings seeding, navigation, resource waiting, page-function
// evaluation, and console/exception/network capture. Drivers should never reach for raw CDP.

import { BINDING_NAME, connectCdp } from "./cdp.js";
import { attachToChrome, launchChrome } from "./chrome.js";
import { addInitScript, evaluateFn } from "./inject.js";
import { createBindingStream } from "./binding.js";
import { HarnessError, TimeoutError } from "./errors.js";
import { EVAL_SETTINGS, seedSettings } from "../page/settings.js";
import { probeEnvironment, probeModuleSharing } from "../page/probe.js";
import {
  readResourceStatuses,
  registerModel,
  waitForResource,
} from "../page/resources.js";

/** Core app resources that must be loaded before any chat case can run. */
export const CORE_RESOURCES = [
  "posts_data",
  "posts_embeddings",
  "db",
  "extractor",
];

/**
 * Derive the module base path (with trailing slash) from the app base URL.
 *
 * `/` under `npm run dev` (web root is public/), `/public/` under `npm run dev:root`.
 * @param {string} baseUrl
 * @returns {string}
 */
export const moduleBase = (baseUrl) => {
  const { pathname } = new URL(baseUrl);
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
};

/**
 * Launch Chrome and open an instrumented tab.
 *
 * @param {Object} config - resolved harness config
 * @param {Object} log
 * @returns {Promise<Object>} browser session
 */
export const openBrowser = async (config, log) => {
  // Attaching is the escape hatch for an already-open browser on the eval profile, since
  // --user-data-dir is exclusive. An attached browser is never stopped by teardown.
  const chrome = config.chrome.endpoint
    ? await attachToChrome({
        endpoint: config.chrome.endpoint,
        timeoutMs: config.chrome.launchTimeoutMs,
        log,
      })
    : await launchChrome({
        binary: config.chrome.binary,
        userDataDir: config.chrome.userDataDir,
        headless: config.chrome.headless,
        allowSwiftshader: config.chrome.allowSwiftshader,
        extraArgs: config.chrome.extraArgs,
        timeoutMs: config.chrome.launchTimeoutMs,
        log,
      });

  const conn = await connectCdp(chrome.wsUrl, { timeoutMs: 30_000 });
  const session = await conn.attach();
  const base = moduleBase(config.app.baseUrl);
  const appOrigin = new URL(config.app.baseUrl).origin;

  // ---- capture -----------------------------------------------------------
  let capture = emptyCapture();
  /** @type {Map<string, string>} requestId -> url, so loadingFailed can name the resource */
  const requestUrls = new Map();

  conn.on("Network.requestWillBeSent", (p, sid) => {
    if (sid !== session.sessionId) return;
    requestUrls.set(p.requestId, p.request?.url ?? "");
    if (requestUrls.size > 4_000) requestUrls.clear(); // bound memory on long runs
  });
  conn.on("Network.loadingFailed", (p, sid) => {
    if (sid !== session.sessionId) return;
    // Cancellations are normal (aborted fetches, navigations) and are not failures.
    if (p.canceled) return;
    capture.failedRequests.push({
      url: requestUrls.get(p.requestId) ?? "",
      errorText: p.errorText ?? "",
      type: p.type ?? null,
    });
  });
  conn.on("Runtime.consoleAPICalled", (p, sid) => {
    if (sid !== session.sessionId) return;
    capture.console.push({
      level: p.type,
      text: (p.args ?? [])
        .map((a) => a.value ?? a.description ?? a.unserializableValue ?? "")
        .join(" ")
        .slice(0, 2_000),
    });
  });
  conn.on("Runtime.exceptionThrown", (p, sid) => {
    if (sid !== session.sessionId) return;
    const d = p.exceptionDetails ?? {};
    capture.exceptions.push({
      message: d.exception?.description ?? d.text ?? "unknown",
      url: d.url ?? null,
    });
  });
  conn.on("Log.entryAdded", (p, sid) => {
    if (sid !== session.sessionId) return;
    if (p.entry?.level === "error") {
      capture.log.push({ source: p.entry.source, text: p.entry.text });
    }
  });
  conn.on("Inspector.targetCrashed", (_p, sid) => {
    if (sid !== session.sessionId) return;
    capture.rendererCrashed = true;
  });

  // ---- api ---------------------------------------------------------------

  /**
   * Seed settings for every subsequent navigation.
   * @param {{settings?: Object, redirectPath?: string|null}} [options]
   */
  const seed = async ({ settings = {}, redirectPath = null } = {}) =>
    addInitScript(session, seedSettings, {
      settings: { ...EVAL_SETTINGS, ...settings },
      redirectPath,
    });

  /**
   * Navigate and wait for the load event.
   * @param {string} url
   * @param {{timeoutMs?: number}} [options]
   */
  const goto = async (url, { timeoutMs = 60_000 } = {}) => {
    const loaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(
          new TimeoutError(
            "timeout.page_load",
            `Page load timed out after ${timeoutMs}ms: ${url}`,
          ),
        );
      }, timeoutMs);
      const off = conn.on("Page.loadEventFired", (_p, sid) => {
        if (sid !== session.sessionId) return;
        clearTimeout(timer);
        off();
        resolve();
      });
    });
    const nav = await session.send("Page.navigate", { url }, { timeoutMs });
    if (nav.errorText) {
      throw new HarnessError(
        "app.module_fetch_failed",
        `Navigation to ${url} failed: ${nav.errorText}`,
      );
    }
    await loaded;
  };

  /**
   * Evaluate a page function (main world).
   * @param {Function} fn
   * @param {*} [arg]
   * @param {Object} [options]
   */
  const evaluate = (fn, arg, options) => evaluateFn(session, fn, arg, options);

  /** Evaluate a page function that returns a JSON string, and parse it. */
  const evaluateJson = async (fn, arg, options) => {
    const raw = await evaluateFn(session, fn, arg, options);
    if (typeof raw !== "string") {
      throw new HarnessError(
        "page.bad_return",
        `Expected a JSON string from ${fn.name || "page function"}, got ${typeof raw}`,
      );
    }
    return JSON.parse(raw);
  };

  /**
   * Evaluate a page function while consuming its binding events.
   * @param {Function} fn
   * @param {*} arg
   * @param {{onEvent: Function, stallMs?: number, timeoutMs?: number}} options
   */
  const streamJson = async (fn, arg, { onEvent, stallMs, timeoutMs }) => {
    const stream = createBindingStream(conn, session, { onEvent, stallMs });
    try {
      return await evaluateJson(
        fn,
        { ...arg, bindingName: BINDING_NAME },
        { timeoutMs },
      );
    } finally {
      stream.stop();
    }
  };

  /** Probe GPU / Chrome AI / app boot state. */
  const probe = () =>
    evaluateJson(probeEnvironment, { base, bindingName: BINDING_NAME });

  /** Assert we share the app's module registry (the harness's central invariant). */
  const checkModuleSharing = () => evaluateJson(probeModuleSharing, { base });

  /** Read resource statuses without triggering loads. */
  const resourceStatuses = (resourceIds = CORE_RESOURCES) =>
    evaluateJson(readResourceStatuses, { base, resourceIds });

  /**
   * Wait for one resource, forwarding progress to a callback.
   * @param {string} resourceId
   * @param {{timeoutMs: number, onProgress?: Function}} options
   */
  const awaitResource = async (resourceId, { timeoutMs, onProgress }) =>
    streamJson(
      waitForResource,
      { base, resourceId, timeoutMs },
      {
        onEvent: (evt) => {
          if (evt.type === "progress") onProgress?.(evt);
        },
        // The evaluate itself enforces the real deadline; pad the CDP timeout so the page's own
        // timeout wins and we get a structured "timeout" status rather than a CDP error.
        timeoutMs: timeoutMs + 30_000,
        stallMs: timeoutMs + 30_000,
      },
    );

  /** Register an uncurated model for this session. */
  const register = (provider, model) =>
    evaluateJson(registerModel, { base, provider, model });

  /**
   * Wait for all core app resources.
   * @param {{timeoutMs: number, onProgress?: Function}} options
   */
  const awaitCoreResources = async ({ timeoutMs, onProgress }) => {
    const results = {};
    for (const id of CORE_RESOURCES) {
      results[id] = await awaitResource(id, { timeoutMs, onProgress });
      if (results[id].status !== "loaded") {
        throw new HarnessError(
          "app.resource_not_loaded",
          `App resource "${id}" ended in status "${results[id].status}" ` +
            `after ${results[id].elapsedMs ?? "?"}ms`,
          { resource: id, results },
        );
      }
    }
    return results;
  };

  const teardown = async () => {
    try {
      await conn.closeTarget(session);
    } catch {
      // Best effort.
    }
    await conn.close();
    await chrome.stop();
  };

  return {
    chrome,
    conn,
    session,
    base,
    appOrigin,
    seed,
    goto,
    evaluate,
    evaluateJson,
    streamJson,
    probe,
    checkModuleSharing,
    resourceStatuses,
    awaitResource,
    awaitCoreResources,
    register,
    /** Snapshot of what the page reported since the last reset. */
    capture: () => ({ ...capture, appOrigin }),
    resetCapture: () => {
      capture = emptyCapture();
    },
    teardown,
  };
};

const emptyCapture = () => ({
  console: [],
  exceptions: [],
  failedRequests: [],
  log: [],
  rendererCrashed: false,
});
