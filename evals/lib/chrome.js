// Chrome discovery, launch, and teardown for the eval harness.
//
// Uses a dedicated persistent --user-data-dir so web-llm's multi-GB model downloads (stored in the
// Cache API / IndexedDB) survive between runs, and so Chrome's built-in AI model stays downloaded
// once enabled. Headful by default: on macOS, headless Chrome may not get a Metal-backed WebGPU
// adapter, and silently landing on SwiftShader (CPU) would make latency numbers meaningless.

import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { HarnessError } from "./errors.js";
import { resolveBrowserWsUrl } from "./cdp.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const MACOS_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

const LINUX_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

/**
 * Base launch flags.
 *
 * The backgrounding flags matter for measurement rather than correctness: an occluded or
 * backgrounded window gets its timers throttled, which corrupts token-streaming timings.
 *
 * Deliberately NOT passed:
 *   --disable-gpu           would kill WebGPU, which web-llm requires
 *   --incognito             would discard the model cache the persistent profile exists to keep
 *   --disable-extensions    harmless but unnecessary on a dedicated profile
 * and nothing that disables OptimizationGuideModelDownloading, which Chrome's built-in AI needs.
 */
export const BASE_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--hide-crash-restore-bubble",
  "--disable-session-crashed-bubble",
  "--restore-last-session=false",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-features=Translate,MediaRouter,AutofillServerCommunication",
  "--window-size=1280,900",
  "--window-position=40,40",
];

/**
 * Locate a Chrome binary.
 * @param {string|null} explicit - configured override
 * @returns {Promise<string>}
 */
export const findChromeBinary = async (explicit) => {
  const { access } = await import("node:fs/promises");
  const exists = async (p) => {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  };

  if (explicit) {
    if (await exists(explicit)) return explicit;
    throw new HarnessError(
      "chrome.not_found",
      `Configured Chrome binary does not exist: ${explicit}`,
    );
  }
  if (process.env.CHROME_PATH && (await exists(process.env.CHROME_PATH))) {
    return process.env.CHROME_PATH;
  }

  const candidates =
    process.platform === "darwin" ? MACOS_CANDIDATES : LINUX_CANDIDATES;
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new HarnessError(
    "chrome.not_found",
    `Could not find Chrome. Tried:\n  ${candidates.join("\n  ")}\n` +
      `Set JOYCE_EVAL_CHROME_BINARY or pass --chrome-binary.`,
  );
};

/**
 * Read the ephemeral debugging port Chrome wrote into its profile directory.
 *
 * Two subtleties, both of which produce confusing hangs if missed:
 *  - the file must be deleted before launch, or a stale port from a previous run is read and the
 *    harness connects to nothing;
 *  - if another Chrome instance already owns this profile, the new process hands off to it and
 *    exits without writing the file at all — hence the liveness check while polling.
 *
 * @param {string} userDataDir
 * @param {{timeoutMs: number, isAlive: () => boolean}} options
 * @returns {Promise<number>}
 */
const readDevToolsPort = async (userDataDir, { timeoutMs, isAlive }) => {
  const file = join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive()) {
      throw new HarnessError(
        "chrome.exited",
        `Chrome exited before writing DevToolsActivePort. This usually means another Chrome ` +
          `instance already owns the profile at ${userDataDir}. Quit it, or point ` +
          `--chrome-profile somewhere else.`,
      );
    }
    try {
      const [portLine] = (await readFile(file, "utf8")).split("\n");
      const port = Number.parseInt(portLine, 10);
      if (Number.isInteger(port) && port > 0) return port;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    await delay(100);
  }
  throw new HarnessError(
    "chrome.port_timeout",
    `Chrome did not write DevToolsActivePort within ${timeoutMs}ms`,
  );
};

/**
 * Attach to a Chrome that is already running with --remote-debugging-port.
 *
 * Exists because `--user-data-dir` is exclusive: if you keep a browser open on the eval profile
 * (to download Chrome's built-in AI model, or just to watch runs), the harness cannot launch its
 * own on that same profile — the second process hands off to the first and exits without ever
 * writing a DevToolsActivePort. Attaching sidesteps that entirely.
 *
 * `stop` is deliberately a no-op: we did not start this browser, so we must never kill it. The
 * caller still closes the tab it created.
 *
 * @param {{endpoint: string, timeoutMs?: number, log?: Object}} options
 * @returns {Promise<{wsUrl: string, port: number, pid: null, version: Object,
 *                    binary: null, attached: true, stop: () => Promise<void>}>}
 */
export const attachToChrome = async ({
  endpoint,
  timeoutMs = 10_000,
  log = console,
}) => {
  let port;
  try {
    const url = new URL(
      endpoint.includes("://") ? endpoint : `http://${endpoint}`,
    );
    port = Number.parseInt(url.port, 10);
  } catch {
    throw new HarnessError(
      "chrome.bad_endpoint",
      `--chrome-endpoint must be a URL or host:port, got "${endpoint}"`,
    );
  }
  if (!Number.isInteger(port) || port <= 0) {
    throw new HarnessError(
      "chrome.bad_endpoint",
      `--chrome-endpoint must include a port, got "${endpoint}"`,
    );
  }

  let wsUrl;
  let version;
  try {
    ({ wsUrl, version } = await resolveBrowserWsUrl(port, { timeoutMs }));
  } catch (err) {
    throw new HarnessError(
      "chrome.attach_failed",
      `Could not reach a Chrome DevTools endpoint on port ${port}. Start one with:\n` +
        `  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\\n` +
        `    --user-data-dir=<profile> --remote-debugging-port=${port}`,
      { cause: err.message },
    );
  }

  log.debug?.(
    `Attached to running ${version.Browser ?? "Chrome"} on port ${port}`,
  );
  return {
    wsUrl,
    port,
    pid: null,
    version,
    binary: null,
    attached: true,
    stop: async () => {},
  };
};

/**
 * Launch Chrome with remote debugging and resolve its browser WebSocket URL.
 *
 * @param {Object} options
 * @param {string} [options.binary]
 * @param {string} options.userDataDir
 * @param {boolean} [options.headless]
 * @param {boolean} [options.allowSwiftshader]
 * @param {string[]} [options.extraArgs]
 * @param {number} [options.timeoutMs]
 * @param {Object} [options.log]
 * @returns {Promise<{wsUrl: string, port: number, pid: number, version: Object,
 *                    binary: string, stop: () => Promise<void>}>}
 */
export const launchChrome = async ({
  binary,
  userDataDir,
  headless = false,
  allowSwiftshader = false,
  extraArgs = [],
  timeoutMs = 60_000,
  log = console,
}) => {
  const resolvedBinary = await findChromeBinary(binary);
  await mkdir(userDataDir, { recursive: true });
  // Remove the stale port file so we never read a previous run's port.
  await rm(join(userDataDir, "DevToolsActivePort"), { force: true });

  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    ...BASE_ARGS,
    ...(headless ? ["--headless=new"] : []),
    ...(headless && allowSwiftshader ? ["--enable-unsafe-swiftshader"] : []),
    ...extraArgs,
    "about:blank",
  ];

  log.debug?.(`Launching Chrome: ${resolvedBinary} ${args.join(" ")}`);
  const child = spawn(resolvedBinary, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let exited = false;
  let exitInfo = null;
  child.on("exit", (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
  });
  child.stderr?.on("data", (d) =>
    log.debug?.(`[chrome] ${String(d).trimEnd()}`),
  );

  const isAlive = () => !exited;
  let stopped = false;

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (exited) return;
    child.kill("SIGTERM");
    for (let i = 0; i < 30 && !exited; i += 1) await delay(100);
    if (!exited) child.kill("SIGKILL");
  };

  try {
    const port = await readDevToolsPort(userDataDir, { timeoutMs, isAlive });
    const { wsUrl, version } = await resolveBrowserWsUrl(port, {
      timeoutMs,
      isAlive,
    });
    log.debug?.(
      `Chrome ${version.Browser ?? "?"} on port ${port} (pid ${child.pid})`,
    );
    return {
      wsUrl,
      port,
      pid: child.pid,
      version,
      binary: resolvedBinary,
      stop,
    };
  } catch (err) {
    await stop();
    if (exitInfo && exitInfo.code !== 0) {
      err.details = { ...(err.details ?? {}), chromeExit: exitInfo };
    }
    throw err;
  }
};
