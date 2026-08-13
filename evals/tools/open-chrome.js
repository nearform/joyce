/**
 * Open the eval Chrome, or report the one that's already open.
 *
 * Idempotent: if a DevTools endpoint is already listening on the port it reuses it, otherwise it
 * launches Chrome on the eval profile and waits for the port. Either way it prints the endpoint,
 * the WebGPU adapter, Chrome's built-in AI status, and the command to run evals against it.
 *
 * The browser is launched detached, so it outlives this process — that's the point. The eval
 * harness never tears down a browser it did not start.
 *
 * Usage:
 *   npm run evals:chrome
 *   npm run evals:chrome -- --port=9223
 *   npm run evals:chrome -- --download-ai      # also trigger the Gemini Nano download
 *   npm run evals:chrome -- --quit             # close it again
 *
 * Options:
 *   --port=N          DevTools port. Default: 9223
 *   --profile=DIR     Profile directory. Default: .data/evals/chrome-profile
 *   --app-url=URL     Page to probe capabilities on. Default: http://127.0.0.1:4300/
 *   --download-ai     Kick off Chrome's on-device model download if it isn't present
 *   --quit            Close the browser running on --port instead of opening one
 */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { BASE_ARGS, findChromeBinary } from "../lib/chrome.js";
import { connectCdp, BINDING_NAME } from "../lib/cdp.js";
import { evaluateExpression, evaluateFn } from "../lib/inject.js";
import { probeEnvironment } from "../page/probe.js";
import { readAiProgress, startAiDownload } from "../page/chrome-ai.js";
import { probeServer } from "../lib/server.js";

const { dirname } = import.meta;
const REPO_ROOT = resolve(dirname, "../..");
const DEFAULT_PORT = 9223;
const DEFAULT_PROFILE = ".data/evals/chrome-profile";
const DEFAULT_APP_URL = "http://127.0.0.1:4300/";
const PROGRESS_KEY = "__joyceAiProgress";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is a DevTools endpoint listening? */
const probeEndpoint = async (port) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1_500),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
};

/** Navigate a session and wait for the document to finish loading. */
const navigate = async (session, url) => {
  await session.send("Page.navigate", { url });
  for (let i = 0; i < 100; i += 1) {
    await delay(100);
    // An expression, not a page function: this file is Node-scoped, so a bare `document`
    // reference here would be a lint error (see evals/page/README.md).
    const state = await evaluateExpression(
      session,
      "document.readyState",
    ).catch(() => null);
    if (state === "complete" || state === "interactive") return true;
  }
  return false;
};

/**
 * Start the model download and sample progress briefly.
 *
 * We deliberately don't block until completion: the download runs at browser level and survives
 * this process exiting, so waiting minutes here would buy nothing.
 */
const downloadAi = async (session, log) => {
  const result = JSON.parse(
    await evaluateFn(
      session,
      startAiDownload,
      { progressKey: PROGRESS_KEY },
      { userGesture: true, timeoutMs: 30_000 },
    ),
  );

  if (!result.ok) {
    log(`  ! Could not start the download: ${result.reason}`);
    return;
  }
  if (result.already) {
    log(`  Model is already downloaded and ready.`);
    return;
  }

  log(`  Download started (was "${result.availability}"). Sampling for 20s...`);
  for (let i = 0; i < 10; i += 1) {
    await delay(2_000);
    const p = JSON.parse(
      await evaluateFn(session, readAiProgress, { progressKey: PROGRESS_KEY }),
    );
    if (p.error) {
      log(`  ! Download failed: ${p.error}`);
      return;
    }
    if (p.done) {
      log(`  ✓ Model downloaded and ready.`);
      return;
    }
    if (p.loaded) log(`    ${Math.round(p.loaded * 100)}%`);
  }
  log(
    `  Still downloading — it continues in the background after this command exits.`,
  );
  log(
    `  Watch chrome://on-device-internals, then re-run this command to confirm.`,
  );
};

const main = async () => {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      profile: { type: "string" },
      "app-url": { type: "string" },
      "download-ai": { type: "boolean" },
      quit: { type: "boolean" },
    },
    strict: true,
  });

  const port = Number.parseInt(values.port ?? String(DEFAULT_PORT), 10);
  const profile = resolve(REPO_ROOT, values.profile ?? DEFAULT_PROFILE);
  const appUrl = values["app-url"] ?? DEFAULT_APP_URL;
  const log = (...args) => console.log(...args);

  let version = await probeEndpoint(port);

  if (values.quit) {
    if (!version) {
      log(`Nothing listening on port ${port}.`);
      return 0;
    }
    const conn = await connectCdp(version.webSocketDebuggerUrl);
    await conn.send("Browser.close").catch(() => {});
    await conn.close();
    log(`Closed the Chrome on port ${port}.`);
    return 0;
  }

  if (version) {
    log(
      `Reusing the Chrome already open on port ${port} (${version.Browser}).`,
    );
  } else {
    const binary = await findChromeBinary(null);
    await mkdir(profile, { recursive: true });
    log(`Launching Chrome on port ${port}`);
    log(`  profile: ${profile}`);

    // detached + unref so the browser outlives this process. Two Chrome instances coexist fine as
    // long as each has its own --user-data-dir; the lock is per-profile, not global.
    const child = spawn(
      binary,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        ...BASE_ARGS,
        "about:blank",
      ],
      { detached: true, stdio: "ignore" },
    );
    child.unref();

    for (let i = 0; i < 100 && !version; i += 1) {
      await delay(200);
      version = await probeEndpoint(port);
    }
    if (!version) {
      console.error(
        `Chrome did not expose a DevTools endpoint on port ${port}.\n` +
          `If a browser is already open on this profile, quit it first — --user-data-dir is ` +
          `exclusive, so a second launch hands off to the first and exits without writing a port.`,
      );
      return 1;
    }
    log(`  ready (${version.Browser})`);
  }

  const conn = await connectCdp(version.webSocketDebuggerUrl);
  const session = await conn.attach();
  try {
    // WebGPU and the built-in AI APIs are gated on a SECURE CONTEXT. Probing `about:blank` reports
    // both as unavailable even when they work perfectly on the app origin — a false negative that
    // would send you chasing a problem you don't have. So probe on the app URL, and say plainly
    // when we can't.
    const app = await probeServer(appUrl);
    if (!app.live) {
      log(`\n  Capability probe skipped: nothing serving ${appUrl}.`);
      log(
        `  WebGPU and Chrome's built-in AI need a secure context, so about:blank can't be used.`,
      );
      log(
        `  Start the app (\`npm run dev\`) and re-run to see GPU and AI status.`,
      );
    } else {
      await navigate(session, appUrl);
      const env = JSON.parse(
        await evaluateFn(session, probeEnvironment, {
          base: "/",
          bindingName: BINDING_NAME,
        }),
      );
      const gpu = env.gpu.available
        ? [env.gpu.info?.vendor, env.gpu.info?.architecture]
            .filter(Boolean)
            .join(" ") || "available"
        : `UNAVAILABLE (${env.gpu.error ?? "no adapter"})`;
      log(`\n  probed on: ${appUrl}`);
      log(
        `  WebGPU:    ${gpu}${env.gpu.isFallback ? " [software fallback]" : ""}`,
      );
      log(
        `  Chrome AI: LanguageModel=${env.chromeAi.languageModel} ` +
          `Writer=${env.chromeAi.writer} ` +
          `availability=${env.chromeAi.languageModelAvailability ?? "n/a"}`,
      );

      if (values["download-ai"]) {
        log("");
        await downloadAi(session, log);
      } else if (env.chromeAi.languageModelAvailability === "downloadable") {
        log(
          `  -> Model not downloaded yet. Re-run with --download-ai to fetch it.`,
        );
        log(`     Until then, chrome:: cases are skipped rather than failed.`);
      }
    }

    log(`\nRun evals against it:`);
    log(
      `  npm run evals -- --suite smoke --chrome-endpoint=http://127.0.0.1:${port}`,
    );
    log(`\nClose it later with:`);
    log(
      `  npm run evals:chrome -- --quit${port === DEFAULT_PORT ? "" : ` --port=${port}`}`,
    );
  } finally {
    await conn.closeTarget(session);
    await conn.close();
  }
  return 0;
};

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err.message ?? err);
      process.exit(1);
    });
}
