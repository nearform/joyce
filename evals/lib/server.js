// Dev-server lifecycle for the eval harness.
//
// Rules, in priority order:
//  1. If Joyce is already being served at the target URL, reuse it and never touch it. A developer
//     running `npm run dev` must survive a Ctrl-C'd eval run.
//  2. If something else owns the port, fail with an explanation rather than killing it.
//  3. If we start a server, we own it: spawn detached so the whole process group can be reaped.
//     Killing only the `npx` pid orphans the `serve` child still holding the port, which the next
//     run would then mistake for a server it didn't start.

import { spawn } from "node:child_process";
import { HarnessError } from "./errors.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Present in public/index.html's import map. Distinguishes Joyce from any other static server that
// happens to be on the port.
const APP_MARKERS = ["@mlc-ai/web-llm", 'id="root"'];

/**
 * Probe a base URL for a live Joyce instance.
 * @param {string} baseUrl
 * @returns {Promise<{live: boolean, isJoyce: boolean, status?: number}>}
 */
export const probeServer = async (baseUrl) => {
  try {
    const res = await fetch(new URL("index.html", baseUrl), {
      signal: AbortSignal.timeout(2_500),
    });
    if (!res.ok) return { live: true, isJoyce: false, status: res.status };
    const body = await res.text();
    return {
      live: true,
      isJoyce: APP_MARKERS.every((m) => body.includes(m)),
      status: res.status,
    };
  } catch {
    return { live: false, isJoyce: false };
  }
};

const waitUntil = async (predicate, timeoutMs, intervalMs = 200) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await delay(intervalMs);
  }
  return false;
};

/**
 * Ensure a Joyce dev server is reachable at `baseUrl`, starting one if needed.
 *
 * @param {Object} options
 * @param {string} options.baseUrl
 * @param {boolean} options.autoStart
 * @param {number} options.port
 * @param {string} options.cwd - repo root (where serve.json lives)
 * @param {number} options.startupTimeoutMs
 * @param {Object} [options.log]
 * @returns {Promise<{baseUrl: string, startedByUs: boolean, stop: () => Promise<void>}>}
 */
export const ensureServer = async ({
  baseUrl,
  autoStart,
  port,
  cwd,
  startupTimeoutMs,
  log = console,
}) => {
  const initial = await probeServer(baseUrl);

  if (initial.live && initial.isJoyce) {
    log.info?.(`Reusing dev server already listening at ${baseUrl}`);
    return { baseUrl, startedByUs: false, stop: async () => {} };
  }

  if (initial.live && !initial.isJoyce) {
    throw new HarnessError(
      "server.foreign",
      `${baseUrl} is serving something that is not Joyce (HTTP ${initial.status}). ` +
        `Refusing to touch a server this harness did not start. Stop it, or pass ` +
        `--app-url with a different port.`,
    );
  }

  if (!autoStart) {
    throw new HarnessError(
      "server.unavailable",
      `Nothing is listening at ${baseUrl} and --no-server was passed. ` +
        `Start one with \`npm run dev\`, or drop --no-server to let the harness spawn it.`,
    );
  }

  log.info?.(`Starting dev server: npx serve -p ${port}`);
  // detached so `process.kill(-pid)` reaps npx AND the serve process it spawns.
  const child = spawn("npx", ["--yes", "serve", "-p", String(port)], {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) =>
    log.debug?.(`[serve] ${String(d).trimEnd()}`),
  );
  child.stderr?.on("data", (d) =>
    log.debug?.(`[serve] ${String(d).trimEnd()}`),
  );

  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (exited) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Group already gone.
    }
    const gone = await waitUntil(
      async () => !(await probeServer(baseUrl)).live,
      3_000,
    );
    if (!gone) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Ignore.
      }
      if ((await probeServer(baseUrl)).live) {
        log.warn?.(
          `Dev server on ${baseUrl} survived teardown; you may need to free the port manually.`,
        );
      }
    }
  };

  const ready = await waitUntil(async () => {
    if (exited) {
      throw new HarnessError(
        "server.start_failed",
        `\`npx serve\` exited before becoming ready. Run it manually to see why.`,
      );
    }
    const p = await probeServer(baseUrl);
    return p.live && p.isJoyce;
  }, startupTimeoutMs);

  if (!ready) {
    await stop();
    throw new HarnessError(
      "server.start_timeout",
      `Dev server did not become ready at ${baseUrl} within ${startupTimeoutMs}ms. ` +
        `On a cold npx cache the first run downloads \`serve\`, which can be slow.`,
    );
  }

  log.info?.(`Dev server ready at ${baseUrl}`);
  return { baseUrl, startedByUs: true, stop };
};
