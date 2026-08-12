// Zero-dependency Chrome DevTools Protocol client.
//
// Node 24 ships a global WebSocket, and this harness only needs a small slice of CDP (Target,
// Runtime, Page, Log, Network), so a hand-rolled client is ~250 lines and avoids adding
// puppeteer-core's dependency tree. The deciding factor is control rather than size: the pipeline
// driver depends on evaluating in the page's MAIN world so that `await import(...)` resolves
// through public/index.html's import map and returns the same module instances the app is using.
// That requirement is easy to break accidentally through a higher-level abstraction, so it stays
// explicit here.

import { CdpError, HarnessError, TimeoutError } from "./errors.js";

/** Name of the function installed in the page for page -> Node streaming. */
export const BINDING_NAME = "__joyceEvalEmit";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @typedef {Object} CdpSession
 * @property {string} sessionId
 * @property {string} targetId
 * @property {(method: string, params?: Object, opts?: Object) => Promise<Object>} send
 */

/**
 * Connect to a browser-level DevTools WebSocket.
 *
 * A single socket to the browser target is used, with per-tab "flat" sessions multiplexed over it.
 * That keeps every event on one demultiplexer rather than opening a socket per tab.
 *
 * @param {string} wsUrl - webSocketDebuggerUrl from /json/version
 * @param {{timeoutMs?: number, onEvent?: (evt: Object) => void}} [options]
 * @returns {Promise<Object>} connection
 */
export const connectCdp = async (
  wsUrl,
  { timeoutMs = 30_000, onEvent } = {},
) => {
  const ws = new WebSocket(wsUrl);
  /** @type {Map<number, {resolve: Function, reject: Function, timer: any, method: string}>} */
  const pending = new Map();
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();
  /** @type {Map<string, Set<Function>>} */
  const bindingHandlers = new Map();
  let nextId = 1;
  let closeErr = null;
  let closedResolve;
  const closed = new Promise((r) => {
    closedResolve = r;
  });

  await new Promise((resolve, reject) => {
    const onOpen = () => {
      ws.removeEventListener("error", onErr);
      resolve();
    };
    const onErr = () => {
      ws.removeEventListener("open", onOpen);
      reject(
        new HarnessError(
          "cdp.connect_failed",
          `Could not open DevTools socket: ${wsUrl}`,
        ),
      );
    };
    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("error", onErr, { once: true });
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return; // A frame we can't parse is not worth crashing the run over.
    }

    if (msg.id == null) {
      // Runtime.bindingCalled is the page -> Node stream; route it before generic listeners so
      // hot-path streaming doesn't walk the listener map twice.
      if (
        msg.method === "Runtime.bindingCalled" &&
        msg.params?.name === BINDING_NAME
      ) {
        for (const fn of bindingHandlers.get(msg.sessionId) ?? []) {
          fn(msg.params.payload, msg.sessionId);
        }
      }
      for (const fn of listeners.get(msg.method) ?? [])
        fn(msg.params ?? {}, msg.sessionId);
      onEvent?.(msg);
      return;
    }

    const entry = pending.get(msg.id);
    // A late reply to a command we already timed out on: drop it rather than throwing.
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) {
      entry.reject(
        new CdpError(
          "cdp.command_failed",
          `${entry.method}: ${msg.error.message}`,
          {
            method: entry.method,
            cdpError: msg.error,
          },
        ),
      );
      return;
    }
    entry.resolve(msg.result ?? {});
  });

  const fail = (err) => {
    closeErr = closeErr ?? err;
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(closeErr);
    }
    pending.clear();
    closedResolve();
  };

  ws.addEventListener("close", () => {
    fail(new HarnessError("cdp.disconnected", "DevTools socket closed"));
  });
  ws.addEventListener("error", () => {
    fail(new HarnessError("cdp.socket_error", "DevTools socket error"));
  });

  /**
   * Issue a CDP command.
   * @param {string} method
   * @param {Object} [params]
   * @param {{sessionId?: string, timeoutMs?: number}} [opts]
   * @returns {Promise<Object>}
   */
  const send = (
    method,
    params = {},
    { sessionId, timeoutMs: ms = timeoutMs } = {},
  ) =>
    new Promise((resolve, reject) => {
      if (closeErr) {
        reject(closeErr);
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new TimeoutError(
            "timeout.cdp_command",
            `${method} timed out after ${ms}ms`,
            { method },
          ),
        );
      }, ms);
      pending.set(id, { resolve, reject, timer, method });
      ws.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });

  /**
   * Subscribe to a CDP event across all sessions. Returns an unsubscribe function.
   * @param {string} method
   * @param {(params: Object, sessionId: string) => void} handler
   * @returns {() => void}
   */
  const on = (method, handler) => {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(handler);
    return () => listeners.get(method)?.delete(handler);
  };

  /**
   * Subscribe to binding calls from one session. Returns an unsubscribe function.
   * @param {string} sessionId
   * @param {(payload: string, sessionId: string) => void} handler
   * @returns {() => void}
   */
  const onBinding = (sessionId, handler) => {
    if (!bindingHandlers.has(sessionId))
      bindingHandlers.set(sessionId, new Set());
    bindingHandlers.get(sessionId).add(handler);
    return () => bindingHandlers.get(sessionId)?.delete(handler);
  };

  /**
   * Create a fresh tab and attach a flat session to it, enabling the domains the harness needs.
   * @returns {Promise<CdpSession>}
   */
  const attach = async () => {
    const { targetId } = await send("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const sessionSend = (method, params, opts) =>
      send(method, params, { ...opts, sessionId });

    // Order matters: Runtime must be enabled before addBinding, and the binding must exist before
    // the first navigation so it survives into the app's execution context.
    await sessionSend("Runtime.enable");
    await sessionSend("Page.enable");
    await sessionSend("Log.enable");
    await sessionSend("Network.enable");
    await sessionSend("Runtime.addBinding", { name: BINDING_NAME });

    return { sessionId, targetId, send: sessionSend };
  };

  /**
   * Close a tab. Safe to call on an already-dead session.
   * @param {CdpSession} session
   */
  const closeTarget = async (session) => {
    try {
      await send("Target.closeTarget", { targetId: session.targetId });
    } catch {
      // The tab may already be gone; teardown must never throw.
    }
    bindingHandlers.delete(session.sessionId);
  };

  const close = async () => {
    try {
      ws.close();
    } catch {
      // Already closing.
    }
    await Promise.race([closed, delay(2_000)]);
  };

  return {
    send,
    on,
    onBinding,
    attach,
    closeTarget,
    close,
    closed,
    get error() {
      return closeErr;
    },
  };
};

/**
 * Poll Chrome's HTTP endpoint for the browser WebSocket URL.
 *
 * The HTTP endpoint is authoritative and doubles as a liveness check, which is why it's preferred
 * over assembling a ws:// URL from the DevToolsActivePort file's path line.
 *
 * @param {number} port
 * @param {{timeoutMs?: number, isAlive?: () => boolean}} [options]
 * @returns {Promise<{wsUrl: string, version: Object}>}
 */
export const resolveBrowserWsUrl = async (
  port,
  { timeoutMs = 30_000, isAlive } = {},
) => {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    if (isAlive && !isAlive()) {
      throw new HarnessError(
        "chrome.exited",
        "Chrome exited before its DevTools endpoint became reachable",
        { lastErr: lastErr?.message ?? null },
      );
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (res.ok) {
        const version = await res.json();
        if (version.webSocketDebuggerUrl) {
          return { wsUrl: version.webSocketDebuggerUrl, version };
        }
      }
    } catch (err) {
      lastErr = err;
    }
    await delay(100);
  }
  throw new HarnessError(
    "chrome.http_probe_failed",
    `No DevTools /json/version response on port ${port} within ${timeoutMs}ms`,
    { lastErr: lastErr?.message ?? null },
  );
};
