/**
 * Run the Joyce chat eval harness.
 *
 * Usage:
 *   node evals/run.js [options]
 *   npm run evals -- --suite smoke
 *
 * Run `node evals/run.js --help` for the full option list.
 *
 * Phase 1 scope: preflight (dev server, Chrome, settings seeding, GPU/Chrome-AI probe, module
 * sharing assertion, core resource load) plus a retrieval-only pass over the selected cases. No
 * generation and no judge yet — that keeps this runnable in seconds and makes it the thing you
 * check when a later, slower run behaves strangely.
 *
 * Examples:
 *   node evals/run.js --dry-run
 *   node evals/run.js --suite smoke
 *   node evals/run.js --case smoke-retrieval-puma --log-level debug
 */

import { HELP, describeConfig, loadConfig } from "./config.js";
import { selectCases } from "./cases/index.js";
import { createLogger } from "./lib/logger.js";
import { createRunDir, gitState, makeRunId } from "./lib/fs-out.js";
import { ensureServer } from "./lib/server.js";
import { openBrowser } from "./lib/browser.js";
import { classify, OUTCOMES, blocksBaseline } from "./lib/errors.js";
import { createJsonlReporter } from "./reporters/jsonl.js";
import { runSearch } from "./page/retrieval.js";
import { scoreRetrievalRecall } from "./scorers/retrieval.js";
import { createPipelineDriver } from "./drivers/pipeline.js";
import { getTier } from "./tiers.js";
import { formatElapsed } from "../public/shared-util.js";

/** Ordered teardown stack. Reverse order, idempotent, safe to run from a signal handler. */
const createDisposers = (log) => {
  const stack = [];
  let running = false;
  return {
    push: (label, fn) => stack.push({ label, fn }),
    run: async () => {
      if (running) return;
      running = true;
      while (stack.length) {
        const { label, fn } = stack.pop();
        try {
          await fn();
        } catch (err) {
          log.warn(`Teardown step "${label}" failed: ${err.message}`);
        }
      }
    },
  };
};

const preflight = async ({ config, log, disposers }) => {
  const server = await ensureServer({
    baseUrl: config.app.baseUrl,
    autoStart: config.app.autoStartServer,
    port: config.app.port,
    cwd: config.repoRoot,
    startupTimeoutMs: config.app.startupTimeoutMs,
    log,
  });
  // Only ever stops a server this process started; a developer's own `npm run dev` survives.
  disposers.push("dev server", server.stop);

  log.info(
    config.chrome.endpoint
      ? `Attaching to running Chrome at ${config.chrome.endpoint}`
      : `Launching Chrome (${config.chrome.headless ? "headless" : "headful"})`,
  );
  const browser = await openBrowser(config, log);
  disposers.push("browser", browser.teardown);

  await browser.seed({
    settings: { enableThinking: config.sut.enableThinking },
    // Land on /chat so the app's own init() has kicked off resource loading, and so the ui driver
    // shares the pipeline driver's page state. /chat 404s directly under `npx serve`, hence the
    // redirect shim rather than a direct navigation.
    redirectPath: "/chat",
  });

  log.info(`Navigating to ${config.app.baseUrl}`);
  await browser.goto(config.app.baseUrl, { timeoutMs: 60_000 });

  const env = await browser.probe();
  reportEnvironment({ env, config, log });

  const sharing = await browser.checkModuleSharing();
  if (!sharing.imported) {
    throw Object.assign(
      new Error(`Could not import app modules in the page: ${sharing.error}`),
      {
        code: "app.module_fetch_failed",
      },
    );
  }
  if (!sharing.sharedWithApp) {
    // Every resource reading not_loaded means we built a second module graph rather than sharing
    // the app's. The pipeline driver would then be measuring a pipeline nobody uses.
    throw Object.assign(
      new Error(
        "Imported app modules but they are NOT the app's own instances " +
          `(statuses: ${JSON.stringify(sharing.statuses)}). The evaluate must run in the page's ` +
          "MAIN world — see evals/lib/inject.js.",
      ),
      { code: "harness.module_not_shared" },
    );
  }
  log.debug(`Module sharing confirmed: ${JSON.stringify(sharing.statuses)}`);

  log.info(
    "Waiting for app resources (posts, embeddings, database, extractor)",
  );
  const resources = await browser.awaitCoreResources({
    timeoutMs: config.app.readyTimeoutMs,
    onProgress: (p) => {
      const pct = p.progress ? ` ${Math.round(p.progress * 100)}%` : "";
      log.status(`  ${p.resourceId}${pct} ${p.text ?? ""}`.slice(0, 110));
    },
  });
  log.clearStatus();
  log.success(
    `App ready: ${Object.entries(resources)
      .map(([id, r]) => `${id} ${formatElapsed(r.elapsedMs ?? 0)}`)
      .join(", ")}`,
  );

  return { server, browser, env, sharing, resources };
};

const reportEnvironment = ({ env, config, log }) => {
  const gpu = env.gpu;
  if (!gpu.available) {
    log.warn(
      `No WebGPU adapter: ${gpu.error ?? "navigator.gpu unavailable"}. ` +
        `web-llm cases will fail to load a model.`,
    );
  } else {
    const desc =
      [
        gpu.info?.vendor,
        gpu.info?.architecture,
        gpu.info?.device,
        gpu.info?.description,
      ]
        .filter(Boolean)
        .join(" ") || "unknown adapter";
    if (gpu.isFallback) {
      log.warn(
        `WebGPU is a FALLBACK (software) adapter: ${desc}. Latency numbers are not comparable ` +
          `to a real GPU run and this run cannot write a baseline.`,
      );
    } else {
      log.debug(`WebGPU adapter: ${desc}`);
    }
  }

  const ai = env.chromeAi;
  const wantsChrome = config.sut.modelSpecs.some(
    (m) => m.provider === "chrome",
  );
  if (wantsChrome && !ai.languageModel && !ai.writer) {
    log.warn(
      `Chrome built-in AI is unavailable in this profile, so chrome:: cases will be skipped. ` +
        `Enabling it is a one-time manual step in the eval profile — see evals/README.md.`,
    );
  } else {
    log.debug(
      `Chrome AI: LanguageModel=${ai.languageModel} Writer=${ai.writer} ` +
        `availability=${ai.languageModelAvailability ?? "n/a"}`,
    );
  }
};

/** Phase 1 case execution: retrieval only. */
const runRetrievalCase = async ({ browser, evalCase, config }) => {
  const startedAt = Date.now();
  browser.resetCapture();

  const search = await browser.evaluateJson(
    runSearch,
    { base: browser.base, query: evalCase.query, filters: evalCase.filters },
    { timeoutMs: config.timeouts.searchMs },
  );

  const recall = scoreRetrievalRecall({
    rankedSlugs: search.rankedSlugs,
    gold: evalCase.gold,
  });

  return {
    scores: { retrievalRecall: recall },
    turn: {
      turn: 1,
      query: evalCase.query,
      searchData: search,
      retrieval: {
        chunkCount: search.chunkCount,
        postCount: search.postCount,
        rankedSlugs: search.rankedSlugs.slice(0, 20),
        similarity: search.metadata?.chunks?.similarity ?? null,
      },
      timings: {
        searchMs: search.elapsedMs,
        totalMs: Date.now() - startedAt,
      },
      provenance: { retrieval: "observed" },
      unavailable: {
        answer: "phase:1-retrieval-only",
        context: "phase:1-retrieval-only",
        prompt: "phase:1-retrieval-only",
      },
    },
  };
};

/** Record one turn plus its scores, and report it on the console. */
const reportTurn = async ({
  reporter,
  log,
  counts,
  evalCase,
  sut,
  sample,
  turn,
  scores,
  label,
}) => {
  const blocking = Object.values(scores).filter((s) => !s.notApplicable);
  const pass = blocking.every((s) => s.pass);
  if (blocking.length === 0) {
    // Nothing gradeable (e.g. an out-of-domain case with no gold): report, don't score.
    log.info(`  ${evalCase.id}  — ${label}`);
  } else if (pass) {
    counts.ok += 1;
    log.success(`${evalCase.id}  ${label}`);
  } else {
    counts.failed += 1;
    log.error(`${evalCase.id}  ${label}`);
    for (const [name, s] of Object.entries(scores)) {
      if (!s.pass && !s.notApplicable && s.message)
        log.error(`    ${name}: ${s.message}`);
    }
  }

  await reporter.onTurn({
    evalCase,
    sut,
    sample,
    turn,
    outcome: OUTCOMES.OK,
    code: null,
    scores: Object.fromEntries(
      Object.entries(scores).map(([name, s]) => [
        name,
        {
          score: s.score,
          pass: s.pass,
          notApplicable: Boolean(s.notApplicable),
          details: s.details,
        },
      ]),
    ),
  });

  return pass;
};

/** Record a non-quality failure (harness, server, model, timeout, SUT error). */
const reportFailure = async ({
  reporter,
  log,
  counts,
  evalCase,
  sut,
  sample,
  err,
  context,
}) => {
  const capture = context.browser.capture();
  const classified = classify(err, capture);
  counts.error += 1;
  log.error(
    `${evalCase?.id ?? "run"}  [${classified.outcome}/${classified.code}] ${classified.message}`,
  );
  await reporter.onError({
    evalCase,
    sut,
    sample,
    outcome: classified.outcome,
    code: classified.code,
    message: classified.message,
    details: classified.details,
    capture,
  });
  return classified;
};

/** Retrieval-only execution: no model, no judge. Cheap enough to run on every commit. */
const executeRetrieval = async ({
  config,
  log,
  cases,
  reporter,
  counts,
  context,
}) => {
  let infraFailure = false;
  const sut = {
    provider: null,
    model: null,
    driver: "retrieval",
    temperature: null,
    tier: null,
  };

  for (const evalCase of cases) {
    try {
      const { turn, scores } = await runRetrievalCase({
        browser: context.browser,
        evalCase,
        config,
      });
      const label =
        `${turn.retrieval.chunkCount} chunks, ${turn.retrieval.postCount} posts, ` +
        `${formatElapsed(turn.timings.searchMs)}` +
        (scores.retrievalRecall.notApplicable
          ? " (no gold slugs; recall n/a)"
          : "");
      const pass = await reportTurn({
        reporter,
        log,
        counts,
        evalCase,
        sut,
        sample: 1,
        turn,
        scores,
        label,
      });
      if (!pass && config.run.bail) {
        log.warn("--bail: stopping after first failure");
        break;
      }
    } catch (err) {
      const classified = await reportFailure({
        reporter,
        log,
        counts,
        evalCase,
        sut,
        sample: 1,
        err,
        context,
      });
      if (blocksBaseline(classified.outcome)) infraFailure = true;
      if (config.run.bail) break;
    }
  }
  return { infraFailure };
};

/**
 * Generation execution, model-outermost.
 *
 * Ordering matters more than it looks: SINGLE_MODEL_PROVIDERS means loading model B evicts model A,
 * and a cold web-llm load is a multi-GB download. Case-outermost would evict and re-download on
 * every case, turning a 20-minute run into hours.
 */
const executeGeneration = async ({
  config,
  log,
  cases,
  reporter,
  counts,
  context,
}) => {
  let infraFailure = false;
  const driver = createPipelineDriver(context.browser, log);

  for (const spec of config.sut.modelSpecs) {
    const sut = {
      provider: spec.provider,
      model: spec.model,
      driver: driver.name,
      temperature: config.sut.temperature,
      tier: getTier({ model: spec.model }),
    };

    // Chrome's built-in AI only exists once the on-device model is downloaded in this profile.
    // Skip rather than fail: an absent model is a setup gap, not a quality regression.
    if (spec.provider === "chrome" && !context.env.chromeAi.languageModel) {
      log.warn(
        `Skipping ${spec.spec}: Chrome built-in AI is unavailable in this profile ` +
          `(run \`npm run evals:chrome -- --download-ai\`).`,
      );
      continue;
    }

    log.info(`Model ${spec.spec} (tier ${sut.tier})`);
    try {
      const loaded = await driver.ensureModel(spec, {
        timeoutMs: config.timeouts.modelLoadMs,
        onProgress: (p) => {
          const pct = p.progress ? ` ${Math.round(p.progress * 100)}%` : "";
          log.status(`    loading${pct} ${p.text ?? ""}`.slice(0, 110));
        },
      });
      log.clearStatus();
      log.success(
        `loaded in ${formatElapsed(loaded.loadMs)}${loaded.cached ? " (cached)" : ""}`,
      );
    } catch (err) {
      const classified = await reportFailure({
        reporter,
        log,
        counts,
        evalCase: null,
        sut,
        sample: null,
        err,
        context,
      });
      if (blocksBaseline(classified.outcome)) infraFailure = true;
      // One model failing to load must not abort the other models in the matrix.
      continue;
    }

    for (const evalCase of cases) {
      for (
        let sample = 1;
        sample <= (evalCase.samples ?? config.sut.samples);
        sample += 1
      ) {
        try {
          const { turns } = await driver.runCase({
            evalCase,
            provider: spec.provider,
            model: spec.model,
            temperature: config.sut.temperature,
            enableThinking: config.sut.enableThinking,
            sample,
            timeouts: config.timeouts,
          });
          log.clearStatus();

          for (const turn of turns) {
            const scores = scoreTurn({ evalCase, turn });
            const label =
              `${turn.answer.length} chars, ` +
              `${turn.retrieval.usedSlugs.length}/${turn.retrieval.rankedSlugs.length} posts used, ` +
              `${formatElapsed(turn.timings.lastTokenMs ?? 0)}` +
              (turn.finishReason && turn.finishReason !== "stop"
                ? ` [finish=${turn.finishReason}]`
                : "");
            await reportTurn({
              reporter,
              log,
              counts,
              evalCase,
              sut,
              sample,
              turn,
              scores,
              label,
            });
          }
        } catch (err) {
          const classified = await reportFailure({
            reporter,
            log,
            counts,
            evalCase,
            sut,
            sample,
            err,
            context,
          });
          if (blocksBaseline(classified.outcome)) infraFailure = true;
          if (config.run.bail) return { infraFailure };
        }
      }
    }
  }
  return { infraFailure };
};

/** Score one generated turn. Citation scorers land next; retrieval already applies. */
const scoreTurn = ({ evalCase, turn }) => ({
  retrievalRecall: scoreRetrievalRecall({
    rankedSlugs: turn.retrieval.rankedSlugs,
    usedSlugs: turn.retrieval.usedSlugs,
    gold: evalCase.gold,
  }),
});

const main = async () => {
  const config = loadConfig();
  if (config.showHelp) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  const log = createLogger({ level: config.run.logLevel });
  const disposers = createDisposers(log);

  // Signals must tear down before exiting, or a killed run orphans Chrome and `serve`.
  let signalled = false;
  const onSignal = (sig) => async () => {
    if (signalled) return;
    signalled = true;
    log.warn(`Received ${sig}, tearing down...`);
    await disposers.run();
    process.exit(130);
  };
  process.on("SIGINT", onSignal("SIGINT"));
  process.on("SIGTERM", onSignal("SIGTERM"));

  const cases = selectCases({
    suites: config.run.suites,
    cases: config.run.cases,
    tags: config.run.tags,
    includeHoldout: config.run.includeHoldout,
    allowInbox: config.run.allowInbox,
  });

  const runId = config.run.runId ?? makeRunId();
  const git = await gitState(config.repoRoot);

  if (config.run.dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        {
          runId,
          git,
          cases: cases.map((c) => ({ id: c.id, suite: c.suite, tags: c.tags })),
          models: config.sut.modelSpecs,
          config: describeConfig(config),
        },
        null,
        2,
      )}\n`,
    );
    log.info(
      `Dry run: ${cases.length} case(s) x ${config.sut.modelSpecs.length} model(s) ` +
        `x ${config.sut.samples} sample(s). Nothing was executed.`,
    );
    return 0;
  }

  log.info(
    `Run ${runId} — ${cases.length} case(s), driver=${config.sut.driver}`,
  );
  const runDir = await createRunDir({ outDir: config.run.outDir, runId });
  const reporter = createJsonlReporter(runDir, { runId });

  let context = null;
  const counts = { ok: 0, failed: 0, error: 0 };
  let infraFailure = false;

  try {
    context = await preflight({ config, log, disposers });

    await runDir.writeManifest({
      runId,
      startedAt: new Date().toISOString(),
      git,
      phase: 1,
      driver: config.sut.driver,
      comparable: config.run.comparable && !context.env.gpu.isFallback,
      environment: {
        node: process.version,
        platform: process.platform,
        chrome: context.browser.chrome.version?.Browser ?? null,
        // Recorded because an attached browser is not a harness-controlled environment: its
        // flags, extensions, and profile were decided elsewhere.
        chromeAttached: Boolean(context.browser.chrome.attached),
        gpu: context.env.gpu,
        chromeAi: context.env.chromeAi,
      },
      resources: context.resources,
      cases: cases.map((c) => c.id),
      config: describeConfig(config),
    });

    log.blank();
    const shared = { config, log, cases, reporter, counts, context };
    const bailed =
      config.sut.driver === "retrieval"
        ? await executeRetrieval(shared)
        : await executeGeneration(shared);
    if (bailed?.infraFailure) infraFailure = true;
  } catch (err) {
    const capture = context?.browser?.capture?.() ?? {};
    const classified = classify(err, capture);
    infraFailure = true;
    log.error(
      `Preflight failed [${classified.outcome}/${classified.code}]: ${classified.message}`,
    );
    if (classified.details?.pageStack) log.debug(classified.details.pageStack);
    await reporter.onError({
      evalCase: null,
      outcome: classified.outcome,
      code: classified.code,
      message: classified.message,
      details: classified.details,
      capture,
    });
  } finally {
    await disposers.run();
  }

  log.blank();
  log.info(`Results: ${runDir.dir}`);
  log.info(
    `  ${counts.ok} passed, ${counts.failed} failed, ${counts.error} errored`,
  );

  // Exit codes are load-bearing: CI must be able to tell "the app got worse" (1) from "the harness
  // or its environment broke" (2), because the second must never be read as a quality regression.
  if (infraFailure) {
    log.warn(
      "Run is INCONCLUSIVE due to infrastructure errors — not a quality regression.",
    );
    return 2;
  }
  return counts.failed > 0 ? 1 : 0;
};

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(2);
    });
}
