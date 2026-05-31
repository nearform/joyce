// web-llm provider implementation
// Unified handler interface for chat sessions
import {
  CreateMLCEngine,
  hasModelInCache,
  prebuiltAppConfig,
} from "@mlc-ai/web-llm";
import { DEFAULT_CHAT_MODEL } from "../../../../config.js";
import { wrap, breadcrumb, attachGPUDevice } from "../../telemetry.js";

const DEFAULT_MODEL = DEFAULT_CHAT_MODEL.model;

// Fall back to IndexedDB when Cache API is unavailable (e.g. iOS Chrome/WebKit)
export const useIndexedDBCache = typeof caches === "undefined";
if (useIndexedDBCache) {
  prebuiltAppConfig.useIndexedDBCache = true;
}

// Map of model -> { enginePromise, progressCallback }
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
    entry.enginePromise = wrap(
      "web-llm.engine.create",
      () =>
        CreateMLCEngine(model, {
          appConfig: useIndexedDBCache ? prebuiltAppConfig : undefined,
          initProgressCallback: (progress) => {
            entry.progressCallback?.(progress);
          },
        }),
      () => ({ model, cache: useIndexedDBCache ? "indexeddb" : "cache-api" }),
    ).then((engine) => {
      // Best-effort: hand the GPU device to crashbox for device.lost / uncapturederror
      // wrapping. web-llm exposes the device on the runtime; the shape isn't public, so
      // optional-chain everything.
      const gpuDevice = engine?.getGPUDevice?.() ?? engine?.runtime?.device;
      if (gpuDevice) {
        attachGPUDevice(gpuDevice);
      }
      return engine;
    });
  }
  return entry.enginePromise;
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
 * Get capabilities for a web-llm model.
 * @returns {{ supportsMultiTurn: boolean, supportsTokenTracking: boolean }}
 */
export const getCapabilities = () => ({
  supportsMultiTurn: true,
  supportsTokenTracking: true,
});

/**
 * Create a conversation handler for web-llm.
 * Yields unified events: { type: "data", content } and { type: "done", finishReason, usage }
 *
 * @param {Object} options
 * @param {string} options.model - Model ID
 * @param {number} options.temperature - Sampling temperature
 * @param {number} options.maxOutputTokens - Max tokens for response
 * @returns {Promise<Object>} Handler with sendMessage(messages) and destroy()
 */
export const createHandler = async ({
  model,
  temperature,
  maxOutputTokens,
}) => {
  const engine = await getLlmEngine(model);

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
            stream: true,
            stream_options: { include_usage: true },
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
          message: String(err?.message ?? err).slice(0, 200),
          tokensSoFar: assistantContent.length,
        });
        throw err;
      }
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
