// Pipeline driver: calls the app's own createChatSession in the page's main world.
//
// The default driver. Because a main-world dynamic import returns the same module instances the
// running app uses, this drives the real pipeline — sharing its Orama databases, its embedding
// extractor, and its resident model — rather than a reimplementation that could drift.

import { parseThinking } from "../../public/app/util/think.js";
import { SutError, TimeoutError } from "../lib/errors.js";
import { runTurns } from "../page/pipeline-turn.js";
import { rankedSlugsFrom, usedSlugsFrom } from "./index.js";

/**
 * @param {Object} browser - from openBrowser()
 * @param {Object} log
 * @returns {Object} driver
 */
export const createPipelineDriver = (browser, log) => ({
  name: "pipeline",

  /**
   * Make a model usable, loading it if needed. Called once per model by the runner, since a cold
   * web-llm load is a multi-GB download that must not be repeated per case.
   *
   * @param {{provider: string, model: string}} spec
   * @param {{timeoutMs: number, onProgress?: Function}} opts
   */
  ensureModel: async ({ provider, model }, { timeoutMs, onProgress }) => {
    // No-op for curated models; registers uncurated web-llm ids so any prebuilt model can be
    // evaluated via --model without touching app source.
    const registered = await browser.register(provider, model);
    if (registered.error) {
      throw new SutError(
        "llm.register_failed",
        `Could not register ${model}: ${registered.error}`,
      );
    }

    const resourceId = `llm_${model}`;
    const started = Date.now();
    const result = await browser.awaitResource(resourceId, {
      timeoutMs,
      onProgress,
    });

    if (result.status === "missing") {
      throw new SutError(
        "llm.unknown_model",
        `No resource "${resourceId}". Is "${provider}::${model}" a model this app knows about?`,
      );
    }
    if (result.status === "timeout") {
      throw new TimeoutError(
        "timeout.model_load",
        `Model ${model} did not load within ${timeoutMs}ms`,
      );
    }
    if (result.status === "error") {
      throw new SutError("llm.load_error", `Model ${model} failed to load`, {
        resourceId,
      });
    }

    return { loadMs: Date.now() - started, cached: result.elapsedMs < 2_000 };
  },

  /**
   * Run one case (all its turns) against the current model.
   * @param {import("./index.js").CaseRunSpec} spec
   */
  runCase: async ({
    evalCase,
    provider,
    model,
    temperature,
    enableThinking,
    timeouts,
  }) => {
    browser.resetCapture();

    // Guard against silent model eviction: SINGLE_MODEL_PROVIDERS unloads other web-llm models,
    // so a model that was loaded a minute ago may not be resident now. Catching it here reports a
    // model_load_error instead of scoring whatever degraded answer would have come out.
    const statuses = await browser.resourceStatuses([`llm_${model}`]);
    if (statuses[`llm_${model}`] !== "loaded") {
      throw new SutError(
        "llm.evicted_mid_run",
        `Model ${model} is "${statuses[`llm_${model}`]}" immediately before running ` +
          `${evalCase.id}; it was evicted after loading.`,
      );
    }

    const payload = await streamTurns(browser, log, {
      base: browser.base,
      provider,
      model,
      temperature,
      enableThinking,
      query: evalCase.query,
      followUps: [...evalCase.followUps],
      filters: { ...evalCase.filters },
      timeouts,
    });

    return { turns: payload.turns.map((t) => toTurnResult(t, provider)) };
  },
});

/**
 * Start generation and resolve on the terminal binding event.
 *
 * Deliberately NOT awaiting the evaluate's return value: see rule 4 in evals/page/README.md. The
 * page function returns immediately and the real payload arrives as a `complete` event, so no
 * long-lived promise is held open across a generation that can run for minutes.
 */
const streamTurns = (browser, log, arg) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      stream.stop();
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      finish(
        reject,
        new TimeoutError(
          "timeout.turn",
          `Generation exceeded ${arg.timeouts.turnMs}ms for "${arg.query.slice(0, 60)}"`,
        ),
      );
    }, arg.timeouts.turnMs);

    const stream = browser.openStream({
      stallMs: arg.timeouts.stallMs,
      onEvent: (evt) => {
        if (evt.type === "complete") {
          finish(resolve, evt.payload);
        } else if (evt.type === "failed") {
          finish(
            reject,
            new SutError("sut.generation_threw", evt.message, {
              stack: evt.stack,
            }),
          );
        } else if (evt.type === "__stall") {
          finish(
            reject,
            new TimeoutError(
              "timeout.stall",
              `No output for ${Math.round(evt.idleMs / 1000)}s during generation`,
            ),
          );
        } else if (evt.type === "search") {
          log.status?.(`    search ${evt.ms}ms, ${evt.chunkCount} chunks`);
        } else if (evt.type === "firstToken") {
          log.status?.(`    first token ${evt.ms}ms`);
        } else if (evt.type === "delta") {
          log.status?.(`    generating... ${evt.chars} chars`);
        } else if (evt.type === "cannotContinue") {
          log.warn?.(`    turn ${evt.turn} skipped: session cannot continue`);
        }
      },
    });

    browser
      .evaluateJson(runTurns, { ...arg, bindingName: stream.bindingName })
      .catch((err) => {
        finish(reject, err);
      });
  });

/** Shape a raw page turn into the TurnResult contract scorers depend on. */
const toTurnResult = (raw, provider) => {
  const parsed = parseThinking(raw.rawAnswer ?? "");
  const usage = raw.usage ?? null;

  return {
    turn: raw.turn,
    query: raw.query,
    rawAnswer: raw.rawAnswer ?? "",
    answer: parsed.visible,
    thinking: parsed.thinking,
    prompt: usage?.prompt ?? null,
    context: usage?.context ?? null,
    usage,
    searchData: raw.searchData ?? null,
    usedChunks: raw.usedChunks ?? null,
    chunkTexts: raw.chunkTexts ?? null,
    retrieval: {
      chunkCount: raw.searchData?.chunks?.length ?? 0,
      postCount: Object.keys(raw.searchData?.posts ?? {}).length,
      rankedSlugs: rankedSlugsFrom(raw.searchData),
      usedSlugs: usedSlugsFrom(raw.usedChunks),
      similarity: raw.searchData?.metadata?.chunks?.similarity ?? null,
    },
    timings: raw.timings ?? {},
    finishReason: raw.finishReason ?? null,
    unavailable: {},
    provenance: {
      context: "observed",
      // chat-session.js computes buildMessages() unconditionally, but the Chrome handler is given a
      // raw string with the context installed as systemContext — so for chrome the recorded prompt
      // is a web-llm-shaped array the model never actually saw. Judges must use `context` instead.
      prompt: provider === "chrome" ? "synthesized" : "observed",
    },
  };
};
