// web-llm provider implementation
// Unified handler interface for chat sessions
import {
  MLCEngine,
  hasModelInCache,
  deleteModelAllInfoInCache,
  prebuiltAppConfig,
} from "@mlc-ai/web-llm";
import {
  DEFAULT_CHAT_MODEL,
  WEB_LLM_FREQUENCY_PENALTY,
  WEB_LLM_PRESENCE_PENALTY,
} from "../../../../config.js";
import {
  wrap,
  breadcrumb,
  attachGPUDevice,
  reportMemoryPressure,
  errMessage,
} from "../../telemetry.js";
import {
  beginLoad,
  setLoadProgress,
  setContextTokens,
  finishLoad,
  clearLoad,
  preflightModel,
} from "./web-llm-memory.js";

const DEFAULT_MODEL = DEFAULT_CHAT_MODEL.model;

// web-llm surfaces an in-browser OOM as a thrown error (often a RangeError or a "memory"/"device
// lost" message) rather than a live event. Report it to crashbox as critical memory pressure so it
// shows in the Crashes panel and — if the tab is then hard-killed — recovers as reason "oom".
const isOomError = (err) =>
  /out of memory|\boom\b|rangeerror|allocation failed|device.*lost/i.test(
    String((err && (err.message || err.name)) || err),
  );

// Fall back to IndexedDB when Cache API is unavailable (e.g. iOS Chrome/WebKit)
export const useIndexedDBCache = typeof caches === "undefined";
if (useIndexedDBCache) {
  prebuiltAppConfig.useIndexedDBCache = true;
}

// Map of model -> { enginePromise, progressCallback, engine, evicted }. `engine` is the live
// MLCEngine instance, held from before reload() resolves so eviction can unload() even mid-load.
const engines = new Map();

/**
 * Set a progress callback for a specific model.
 * @param {string} model - The model ID
 * @param {Function} cb - Progress callback function
 */
export const setLlmProgressCallback = (model, cb) => {
  if (!engines.has(model)) {
    engines.set(model, { enginePromise: null, progressCallback: null });
  }
  engines.get(model).progressCallback = cb;
};

/**
 * Get or create an LLM engine for a specific model.
 * @param {string} model - The model ID
 * @returns {Promise<MLCEngine>} The engine instance
 */
export const getLlmEngine = async (model = DEFAULT_MODEL) => {
  if (!engines.has(model)) {
    engines.set(model, { enginePromise: null, progressCallback: null });
  }

  const entry = engines.get(model);
  if (!entry.enginePromise) {
    entry.enginePromise = (async () => {
      // Pre-flight: predict whether this model fits the device BEFORE committing any memory, and arm
      // the heartbeat estimator so reported pressure climbs as the load progresses.
      const rec = prebuiltAppConfig.model_list.find(
        (m) => m.model_id === model,
      );
      beginLoad({
        model,
        vramRequiredMB: rec?.vram_required_MB,
        contextWindowSize: rec?.overrides?.context_window_size,
      });
      const pf = await preflightModel({
        model,
        vramRequiredMB: rec?.vram_required_MB,
        bufferSizeRequiredBytes: rec?.buffer_size_required_bytes,
        lowResource: rec?.low_resource_required,
      });
      breadcrumb("web-llm.preflight", {
        verdict: pf.verdict,
        vramMB: Math.round(pf.vramBytes / 1048576),
        residentMB: Math.round(pf.residentBytes / 1048576), // other models' full vram
        budgetMB: Math.round(pf.budgetBytes / 1048576),
        ratio: pf.ratio != null ? Math.round(pf.ratio * 100) / 100 : null, // (resident+new)/budget
        exceedsBufferCap: pf.exceedsBufferCap,
      });
      // A predicted "won't fit" / "risky" lands a warning in the Crashes panel BEFORE the (likely)
      // hard kill — the whole point of the pre-flight. usedBytes is the PROJECTED total (resident
      // models + this one), so a 2nd model that pushes the sum over budget is flagged here.
      if (pf.verdict !== "ok") {
        reportMemoryPressure({
          level: pf.verdict === "wont-fit" ? "critical" : "serious",
          source: "web-llm.preflight",
          usedBytes: pf.projectedBytes,
          limitBytes: pf.budgetBytes,
        });
      }

      // Construct the engine ourselves (vs CreateMLCEngine) and stash it BEFORE reload() resolves,
      // so eviction can call engine.unload() to tear it down even while it's still loading.
      const engine = new MLCEngine({
        appConfig: useIndexedDBCache ? prebuiltAppConfig : undefined,
        initProgressCallback: (progress) => {
          setLoadProgress(model, progress?.progress); // feeds the heartbeat memory estimate
          entry.progressCallback?.(progress);
        },
      });
      entry.engine = engine;
      try {
        await wrap(
          "web-llm.engine.create",
          () => engine.reload(model),
          () => ({
            model,
            cache: useIndexedDBCache ? "indexeddb" : "cache-api",
          }),
        );
        // Best-effort: hand the GPU device to crashbox for device.lost / uncapturederror wrapping.
        // web-llm exposes the device on the runtime; the shape isn't public, so optional-chain it.
        const gpuDevice = engine?.getGPUDevice?.() ?? engine?.runtime?.device;
        if (gpuDevice) {
          attachGPUDevice(gpuDevice);
        }
        finishLoad(model); // weights committed → pin this model's estimate at 100%
        return engine;
      } catch (err) {
        // The freed allocation shouldn't keep showing in the estimate.
        clearLoad(model);
        // A load failure on a model the pre-flight already flagged as risky/won't-fit IS the OOM —
        // iOS surfaces it as a generic `TypeError: Load failed`, so don't rely on the message text;
        // correlate with the prediction. Report critical so it recovers as reason "oom". But skip
        // this when WE tore it down (unloadLlmEngine) — an eviction isn't an OOM.
        if (!entry.evicted && (pf.verdict !== "ok" || isOomError(err))) {
          reportMemoryPressure({ level: "critical", source: "web-llm.load" });
        } else if (entry.evicted) {
          // We tore this down (single-model eviction) — its rejection is expected, NOT an OOM. Leave
          // a trail so a device run can confirm no spurious web-llm.load critical warning fired here.
          breadcrumb("web-llm.load.evicted", { model });
        }
        entry.enginePromise = null; // allow a retry after a failed load
        entry.engine = null;
        throw err;
      }
    })();
  }
  return entry.enginePromise;
};

/**
 * Unload a model from memory — frees GPU/WASM; the disk cache is kept, so a later load is a fast
 * re-upload (no re-download). Works on an in-flight load too: destroying the engine's device makes
 * the pending reload() reject, which the loader treats as an eviction (not an OOM). No-op if the
 * model isn't tracked.
 * @param {string} model - The model ID
 * @returns {Promise<void>}
 */
export const unloadLlmEngine = async (model) => {
  const entry = engines.get(model);
  if (!entry) {
    return;
  }
  entry.evicted = true; // tell the in-flight loader (if any) this is an eviction, not a crash
  engines.delete(model);
  clearLoad(model); // drop it from crashbox's cumulative estimate
  const engine = entry.engine;
  entry.engine = null;
  entry.enginePromise = null;
  if (engine?.unload) {
    try {
      await engine.unload();
    } catch {
      // Best-effort: unloading mid-load (device teardown) can throw — the memory is freed regardless.
    }
  }
};

/**
 * Check if a model is cached.
 * @param {string} model - The model ID
 * @returns {Promise<boolean>} Whether the model is cached
 */
export const isLlmCached = async (model = DEFAULT_MODEL) => {
  try {
    return await hasModelInCache(
      model,
      useIndexedDBCache ? prebuiltAppConfig : undefined,
    );
  } catch {
    // Cache API unavailable (e.g. iOS Chrome/WebKit)
    return false;
  }
};

/**
 * Delete a model's bytes from disk (Cache API / IndexedDB) — frees the download so the badge drops
 * to "Not loaded". Unload the in-memory engine first if it's resident. Best-effort; no-op on cache
 * errors (e.g. iOS Chrome/WebKit).
 * @param {string} model - The model ID
 * @returns {Promise<void>}
 */
export const deleteModelCache = async (model = DEFAULT_MODEL) => {
  await unloadLlmEngine(model);
  try {
    await deleteModelAllInfoInCache(
      model,
      useIndexedDBCache ? prebuiltAppConfig : undefined,
    );
    breadcrumb("web-llm.cache.delete", { model });
  } catch (err) {
    breadcrumb("web-llm.cache.delete.error", {
      model,
      message: errMessage(err),
    });
  }
};

/**
 * Get capabilities for a web-llm model.
 * @returns {{ supportsMultiTurn: boolean, supportsTokenTracking: boolean, usesMessageArray: boolean }}
 */
export const getCapabilities = () => ({
  supportsMultiTurn: true,
  supportsTokenTracking: true,
  // web-llm is stateless — every request resends the whole conversation, so sendMessage() takes
  // the full messages array rather than a bare user string.
  usesMessageArray: true,
});

/**
 * Create a conversation handler for web-llm.
 * Yields unified events: { type: "data", content } and { type: "done", finishReason, usage }
 *
 * @param {Object} options
 * @param {string} options.model - Model ID
 * @param {number} options.temperature - Sampling temperature
 * @param {number} options.maxOutputTokens - Max tokens for response
 * @param {boolean} [options.enableThinking] - Allow reasoning models to emit a <think> block
 * @returns {Promise<Object>} Handler with sendMessage(messages) and destroy()
 */
export const createHandler = async ({
  model,
  temperature,
  maxOutputTokens,
  enableThinking,
}) => {
  const engine = await getLlmEngine(model);

  // web-llm's `enable_thinking` is a Qwen3-only knob (when false it injects an empty <think></think>
  // to suppress reasoning). Sending it to non-reasoning models would just prepend stray tags, so
  // only attach it for the families that actually reason.
  const isReasoningModel = /qwen3|deepseek-r1/i.test(model);
  const extraBody = isReasoningModel
    ? { enable_thinking: !!enableThinking }
    : undefined;

  return {
    /**
     * Send messages and stream response.
     * @param {Array<{role: string, content: string}>} messages - Full messages array
     * @yields {{ type: "data", content: string } | { type: "done", finishReason: string, usage: Object }}
     */
    async *sendMessage(messages) {
      const stream = await wrap(
        "web-llm.chat.stream.start",
        () =>
          engine.chat.completions.create({
            messages,
            temperature,
            max_tokens: maxOutputTokens,
            // Curb small-model runaway repetition / missing EOS. See WEB_LLM_*_PENALTY in config.
            frequency_penalty: WEB_LLM_FREQUENCY_PENALTY,
            presence_penalty: WEB_LLM_PRESENCE_PENALTY,
            stream: true,
            stream_options: { include_usage: true },
            ...(extraBody && { extra_body: extraBody }),
          }),
        () => ({ model, msgCount: messages.length, maxOutputTokens }),
      );

      let assistantContent = "";
      let finishReason = null;
      let usage = null;

      try {
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) {
            assistantContent += delta;
            yield { type: "data", content: delta };
          }
          if (chunk.choices[0]?.finish_reason) {
            finishReason = chunk.choices[0].finish_reason;
          }
          if (chunk.usage) {
            usage = chunk.usage;
          }
        }
      } catch (err) {
        breadcrumb("web-llm.chat.stream.error", {
          name: err?.name,
          message: errMessage(err),
          charsSoFar: assistantContent.length,
        });
        if (isOomError(err)) {
          reportMemoryPressure({
            level: "critical",
            source: "web-llm.generate",
          });
        }
        throw err;
      }
      // Feed the post-load KV-cache estimate: prompt_tokens is the full cumulative context (web-llm
      // resends history each turn), so it IS the current context size.
      setContextTokens(model, usage?.prompt_tokens ?? 0);
      breadcrumb("web-llm.chat.stream.done", {
        finishReason: finishReason || "stop",
        outputTokens: usage?.completion_tokens ?? 0,
      });

      yield {
        type: "done",
        finishReason: finishReason || "stop",
        usage: {
          inputTokens: usage?.prompt_tokens ?? 0,
          outputTokens: usage?.completion_tokens ?? 0,
          assistantContent,
        },
      };
    },

    destroy() {
      // web-llm engines are cached and reused, no cleanup needed per-session
    },
  };
};
