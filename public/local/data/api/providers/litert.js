// LiteRT-LM provider implementation using Google's @litert-lm/core Web API.
// In-browser inference over WebGPU with `.litertlm` models from HuggingFace.
// See: https://developers.google.com/edge/litert-lm/js
//
// Shape note: unlike web-llm (stateless, resends the whole conversation each turn), a LiteRT
// `Conversation` owns its own history and takes the system prompt once at creation — so this
// provider follows chrome.js's model: systemContext at createHandler(), a raw string per message.

import { Backend, Engine, loadLiteRtLm } from "@litert-lm/core";
import { LITERT_WASM_URL, getModelCfg } from "../../../../config.js";
import { buildBasePrompts } from "../chat.js";
import { estimateTokens } from "../../util.js";
import {
  wrap,
  breadcrumb,
  reportMemoryPressure,
  errMessage,
} from "../../telemetry.js";
import {
  modelUrl,
  isCached,
  deleteCached,
  getModelSource,
} from "./litert-cache.js";

// A WebGPU OOM surfaces as a thrown error rather than an event. Same detection web-llm uses.
const isOomError = (err) =>
  /out of memory|\boom\b|rangeerror|allocation failed|device.*lost/i.test(
    String((err && (err.message || err.name)) || err),
  );

// Map of model -> { enginePromise, progressCallback, engine, evicted }. `evicted` marks an unload
// that raced an in-flight load, so the loader can tear the engine down as soon as it materializes
// rather than leaving multiple GB resident with nothing referencing it.
const engines = new Map();

// The wasm module is a singleton for the whole page — loadLiteRtLm() throws if called twice.
let wasmPromise = null;
const ensureWasm = () => {
  if (!wasmPromise) {
    wasmPromise = wrap(
      "litert.wasm.load",
      () => loadLiteRtLm(LITERT_WASM_URL),
      () => ({ url: LITERT_WASM_URL }),
    ).catch((err) => {
      wasmPromise = null; // allow a retry
      throw err;
    });
  }
  return wasmPromise;
};

const getEntry = (model) => {
  if (!engines.has(model)) {
    engines.set(model, { enginePromise: null, progressCallback: null });
  }
  return engines.get(model);
};

const urlFor = (model) => modelUrl(getModelCfg({ provider: "litert", model }));

/**
 * Set a progress callback for a specific model.
 * @param {string} model - The model ID
 * @param {Function} cb - Progress callback, called with { text, progress }
 */
export const setLlmProgressCallback = (model, cb) => {
  getEntry(model).progressCallback = cb;
};

/**
 * Get or create an LLM engine for a specific model.
 * Downloads + caches the model bytes, then builds a WebGPU engine over them.
 * @param {string} model - The model ID
 * @returns {Promise<Engine>} The engine instance
 */
export const getLlmEngine = async (model) => {
  const entry = getEntry(model);
  if (entry.enginePromise) return entry.enginePromise;

  const cfg = getModelCfg({ provider: "litert", model });

  entry.enginePromise = (async () => {
    try {
      await ensureWasm();

      entry.progressCallback?.({ text: "Preparing model…", progress: 0 });
      const source = await getModelSource(modelUrl(cfg), {
        onProgress: (p) => entry.progressCallback?.(p),
        downloadSizeMb: cfg.downloadSizeMb,
      });

      entry.progressCallback?.({
        text: "Loading model onto GPU…",
        progress: 1,
      });
      const engine = await wrap(
        "litert.engine.create",
        () =>
          Engine.create({
            model: source,
            // GPU_ARTISAN is the only backend that streams weights straight to the GPU. Every other
            // backend copies the whole model into the wasm heap first, which cannot work at 2 GB.
            backend: Backend.GPU_ARTISAN,
            // Enables getBenchmarkInfo(), which gives real per-turn prefill/decode token counts.
            benchmarkEnabled: true,
            mainExecutorSettings: { maxNumTokens: cfg.maxTokens },
          }),
        () => ({ model, maxNumTokens: cfg.maxTokens }),
      );

      // Unlike web-llm (construct-then-reload), Engine.create() is a single call with no handle to
      // grab early — so an unload during the load can't tear anything down while it's in flight.
      // Catch that here, or a multi-GB engine is left resident with nothing referencing it.
      if (entry.evicted) {
        breadcrumb("litert.load.evicted", { model });
        await engine.delete().catch(() => {});
        throw new Error(
          `Model load for "${model}" was cancelled by an unload.`,
        );
      }

      entry.engine = engine;
      return engine;
    } catch (err) {
      // An eviction (we called unloadLlmEngine mid-load) is expected, not an OOM.
      if (!entry.evicted && isOomError(err)) {
        reportMemoryPressure({ level: "critical", source: "litert.load" });
      } else if (entry.evicted) {
        breadcrumb("litert.load.evicted", { model });
      }
      breadcrumb("litert.load.error", { model, message: errMessage(err) });
      entry.enginePromise = null; // allow a retry after a failed load
      entry.engine = null;
      throw err;
    }
  })();

  return entry.enginePromise;
};

/**
 * Unload a model from memory — frees GPU/wasm resources; the cached bytes on disk are kept, so a
 * later load skips the download. No-op if the model isn't resident.
 * @param {string} model - The model ID
 * @returns {Promise<void>}
 */
export const unloadLlmEngine = async (model) => {
  const entry = engines.get(model);
  if (!entry) return;

  entry.evicted = true; // tell an in-flight loader this rejection is an eviction, not a crash
  engines.delete(model);
  const engine = entry.engine;
  entry.engine = null;
  entry.enginePromise = null;
  try {
    await engine?.delete();
  } catch {
    // Best-effort: tearing down mid-load can throw — the memory is freed regardless.
  }
};

/**
 * Delete a model's bytes from the cache — frees the download. Unloads first if resident.
 * @param {string} model - The model ID
 * @returns {Promise<void>}
 */
export const deleteModelCache = async (model) => {
  await unloadLlmEngine(model);
  try {
    await deleteCached(urlFor(model));
    breadcrumb("litert.cache.delete", { model });
  } catch (err) {
    breadcrumb("litert.cache.delete.error", {
      model,
      message: errMessage(err),
    });
  }
};

/**
 * Check if a model's bytes are cached.
 * @param {string} model - The model ID
 * @returns {Promise<boolean>}
 */
export const isLlmCached = async (model) => isCached(urlFor(model));

/**
 * Get capabilities for a LiteRT-LM model.
 * @returns {{ supportsMultiTurn: boolean, supportsTokenTracking: boolean, usesMessageArray: boolean }}
 */
export const getCapabilities = () => ({
  supportsMultiTurn: true,
  supportsTokenTracking: true,
  // The Conversation owns its history, so sendMessage() takes a raw user string.
  usesMessageArray: false,
});

/**
 * Create a conversation handler for LiteRT-LM.
 * Yields unified events: { type: "data", content } and { type: "done", finishReason, usage }
 *
 * @param {Object} options
 * @param {string} options.model - Model ID
 * @param {string} options.systemContext - RAG context for the system prompt
 * @param {number} options.temperature - Sampling temperature
 * @param {number} [options.maxTokens] - Model context window; selects LEAN vs FULL system prompt
 * @param {number} [options.maxOutputTokens] - Cap on generated tokens
 * @returns {Promise<Object>} Handler with sendMessage(userMessage) and destroy()
 */
export const createHandler = async ({
  model,
  systemContext,
  temperature,
  maxTokens,
  maxOutputTokens,
}) => {
  const engine = await getLlmEngine(model);
  const preface = buildBasePrompts(systemContext, "", { maxTokens });

  const conversation = await wrap(
    "litert.conversation.create",
    () =>
      engine.createConversation({
        preface: { messages: preface },
        sessionConfig: {
          samplerParams: { temperature },
          ...(maxOutputTokens && { maxOutputTokens }),
        },
      }),
    () => ({ model, prefaceCount: preface.length }),
  );

  // getTokenCount() is whole-conversation (prompt + everything generated so far), but chat-session
  // expects `inputTokens` to be cumulative INPUT only — it overwrites rather than accumulates. Track
  // our own running output total so we can subtract it back out.
  let cumulativeOutputTokens = 0;

  return {
    /**
     * Send a message and stream the response.
     * @param {string} userMessage - The user's message
     * @yields {{ type: "data", content: string } | { type: "done", finishReason: string, usage: Object }}
     */
    async *sendMessage(userMessage) {
      breadcrumb("litert.stream.start", { msgLen: userMessage.length });
      let assistantContent = "";

      // sendMessageStreaming returns a ReadableStream. Safari does not implement async iteration on
      // ReadableStream (no Symbol.asyncIterator), so `for await...of` throws there — read it with an
      // explicit reader instead, which works in every browser.
      const reader = conversation.sendMessageStreaming(userMessage).getReader();
      let drained = false;

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            drained = true;
            break;
          }
          // A chunk's `content` is an array of parts; only text parts are supported on web today.
          let delta = "";
          for (const part of value?.content ?? []) {
            if (part.type === "text" && part.text) delta += part.text;
          }
          if (delta) {
            assistantContent += delta;
            yield { type: "data", content: delta };
          }
        }
      } catch (err) {
        if (isOomError(err)) {
          reportMemoryPressure({ level: "critical", source: "litert.stream" });
        }
        breadcrumb("litert.stream.error", {
          name: err?.name,
          message: errMessage(err),
          charsSoFar: assistantContent.length,
        });
        throw err;
      } finally {
        // Runs on an abandoned generator too (the consumer stopping mid-answer calls .return()).
        // Cancel first when the stream is still live, or the conversation keeps decoding into a
        // reader nobody is draining.
        if (!drained) {
          conversation.cancel();
          await reader.cancel().catch(() => {});
        }
        reader.releaseLock();
      }
      breadcrumb("litert.stream.done", {
        outputChars: assistantContent.length,
      });

      // Real counts from the runtime; Joyce's estimator only as a backstop. GPU_ARTISAN logs
      // "GetProfileSummary not implemented for backend: GpuArtisan", but that only affects the
      // tokens/sec rates — the token COUNTS are populated (a decode capped at exactly
      // MAX_OUTPUT_TOKENS reports exactly that, which an estimate would never do).
      let outputTokens = null;
      let totalTokens = null;
      try {
        const bench = await conversation.getBenchmarkInfo();
        outputTokens = bench?.lastDecodeTokenCount || null;
      } catch (err) {
        breadcrumb("litert.benchmark.error", { message: errMessage(err) });
      }
      try {
        totalTokens = await conversation.getTokenCount();
      } catch (err) {
        breadcrumb("litert.tokencount.error", { message: errMessage(err) });
      }

      outputTokens = outputTokens ?? estimateTokens(assistantContent);
      cumulativeOutputTokens += outputTokens;

      const inputTokens =
        totalTokens == null
          ? estimateTokens(userMessage)
          : Math.max(0, totalTokens - cumulativeOutputTokens);

      // LiteRT-LM doesn't report why generation ended, so infer it. Hitting the output cap must
      // surface as "length" — ContextLimitWarning keys off exactly that string to offer a new
      // conversation, and reporting "stop" for a truncated answer hides the truncation entirely.
      const hitOutputCap =
        Boolean(maxOutputTokens) && outputTokens >= maxOutputTokens;

      yield {
        type: "done",
        finishReason: hitOutputCap ? "length" : "stop",
        usage: { inputTokens, outputTokens, assistantContent },
      };
    },

    destroy() {
      // Tear down the conversation but keep the engine cached for the next session.
      try {
        conversation.cancel();
      } catch {
        // Nothing in flight.
      }
      conversation.delete().catch(() => {
        // Best-effort cleanup.
      });
    },
  };
};
