/* global caches:false, localStorage:false, navigator:false */
// Transformers.js provider implementation
// Uses @huggingface/transformers for ONNX models via WebGPU
// Supports Gemma 4 (multimodal) and text-only models (Qwen, SmolLM, etc.)
import {
  AutoModelForCausalLM,
  AutoProcessor,
  AutoTokenizer,
  Gemma4ForConditionalGeneration,
  TextStreamer,
} from "@huggingface/transformers";
import { CHAT_MODELS_MAP } from "../../../../config.js";
import { IS_MOBILE_IOS } from "../../../../shared-config.js";
import { getSettings } from "../../../../app/hooks/use-settings.js";

const isGemmaModel = (model) => model.toLowerCase().includes("gemma");

// ---------------------------------------------------------------------------
// Crash tracking
// ---------------------------------------------------------------------------
// Before model load or generation we write a marker to localStorage. If the
// browser tab crashes (OOM, WebGPU device lost, etc.) the marker survives and
// is detected on the next page load. On success we promote it to "last crash"
// history and clear the pending marker.
const CRASH_KEY = "tjs_crash_pending";
const CRASH_HISTORY_KEY = "tjs_crash_last";

const setCrashMarker = (model, phase) => {
  try {
    localStorage.setItem(
      CRASH_KEY,
      JSON.stringify({ model, phase, ts: new Date().toISOString() }),
    );
  } catch {
    /* best-effort */
  }
};

const clearCrashMarker = () => {
  try {
    localStorage.removeItem(CRASH_KEY);
  } catch {
    /* best-effort */
  }
};

/**
 * Check for a crash from a previous session.
 * If a pending marker exists, the previous session crashed during model
 * load or generation. Promote it to crash history and clear the marker.
 * @returns {{ model: string, phase: string, ts: string } | null}
 */
export const checkCrash = () => {
  try {
    const pending = localStorage.getItem(CRASH_KEY);
    if (pending) {
      localStorage.setItem(CRASH_HISTORY_KEY, pending);
      localStorage.removeItem(CRASH_KEY);
      return JSON.parse(pending);
    }
    const last = localStorage.getItem(CRASH_HISTORY_KEY);
    return last ? JSON.parse(last) : null;
  } catch {
    return null;
  }
};

/**
 * Clear crash history (e.g. from a "dismiss" button).
 */
export const clearCrashHistory = () => {
  try {
    localStorage.removeItem(CRASH_HISTORY_KEY);
    localStorage.removeItem(CRASH_KEY);
  } catch {
    /* best-effort */
  }
};

// Map of model -> { processorOrTokenizerPromise, modelPromise, progressCallback, isGemma }
const engines = new Map();

const getEntry = (model) => {
  if (!engines.has(model)) {
    engines.set(model, {
      processorOrTokenizerPromise: null,
      modelPromise: null,
      progressCallback: null,
      isGemma: isGemmaModel(model),
    });
  }
  return engines.get(model);
};

/**
 * Set a progress callback for a specific model.
 * @param {string} model - The model ID
 * @param {Function} cb - Progress callback function
 */
export const setLlmProgressCallback = (model, cb) => {
  getEntry(model).progressCallback = cb;
};

/**
 * Build a progress_callback for model download tracking.
 * Shared by both Gemma and text-only loading paths.
 */
const makeProgressCallback = (entry) => {
  const fileProgress = new Map();
  return (info) => {
    if (info.status === "progress" && info.total) {
      fileProgress.set(info.file, { loaded: info.loaded, total: info.total });
      let totalLoaded = 0;
      let totalSize = 0;
      for (const f of fileProgress.values()) {
        totalLoaded += f.loaded;
        totalSize += f.total;
      }
      const pct = totalSize > 0 ? totalLoaded / totalSize : 0;
      entry.progressCallback?.({
        text: `Downloading model: ${Math.round(pct * 100)}%`,
        progress: pct,
      });
    } else if (info.status === "done" && fileProgress.size > 0) {
      entry.progressCallback?.({ text: "Model loaded", progress: 1 });
    }
  };
};

/**
 * Look up quantization from config, falling back to "q4f16".
 */
const getQuantization = (model) =>
  CHAT_MODELS_MAP.transformersJs?.[model]?.quantization ?? "q4f16";

/**
 * Resolve the device for model inference.
 * - Desktop (non-iOS): always "webgpu"
 * - Mobile iOS: defaults to CPU (no device option), unless the user
 *   enables the "WebGPU Chat" experimental setting AND WebGPU is available.
 * @returns {Promise<string|null>} "webgpu" or null (WASM/CPU fallback)
 */
const resolveDevice = async () => {
  if (!IS_MOBILE_IOS) return "webgpu";

  // On iOS, only use WebGPU if the user explicitly opts in
  if (!getSettings().experimentalWebgpuChat) return null;

  // Check if WebGPU is actually available
  if (!("gpu" in navigator)) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter ? "webgpu" : null;
  } catch {
    return null;
  }
};

/**
 * Get or create a model engine (processor/tokenizer + generation model).
 * @param {string} model - The model ID
 * @returns {Promise<Object>} Engine with { generationModel } and either { processor } or { tokenizer }
 */
export const getLlmEngine = async (model) => {
  const entry = getEntry(model);
  const dtype = getQuantization(model);

  if (!entry.processorOrTokenizerPromise) {
    entry.processorOrTokenizerPromise = entry.isGemma
      ? AutoProcessor.from_pretrained(model)
      : AutoTokenizer.from_pretrained(model);
  }

  if (!entry.modelPromise) {
    const progressCallback = makeProgressCallback(entry);

    entry.modelPromise = resolveDevice().then(async (device) => {
      setCrashMarker(model, "load");
      const opts = {
        dtype,
        ...(device ? { device } : {}),
        progress_callback: progressCallback,
      };

      const result = entry.isGemma
        ? await Gemma4ForConditionalGeneration.from_pretrained(model, opts)
        : await AutoModelForCausalLM.from_pretrained(model, opts);
      clearCrashMarker();
      return result;
    });
  }

  const [processorOrTokenizer, generationModel] = await Promise.all([
    entry.processorOrTokenizerPromise,
    entry.modelPromise,
  ]);

  return entry.isGemma
    ? { processor: processorOrTokenizer, generationModel }
    : { tokenizer: processorOrTokenizer, generationModel };
};

/**
 * Check if a model is cached.
 * Transformers.js v4 caches ONNX model files in the browser Cache API.
 * @param {string} model - The model ID
 * @returns {Promise<boolean>} Whether the model is cached
 */
export const isLlmCached = async (model) => {
  try {
    if (typeof caches === "undefined") return false;
    const cache = await caches.open("transformers-cache");
    const keys = await cache.keys();
    // Check if any cached entries belong to this model
    return keys.some((req) => req.url.includes(encodeURIComponent(model)));
  } catch {
    return false;
  }
};

/**
 * Get capabilities for a transformers.js model.
 * @returns {{ supportsMultiTurn: boolean, supportsTokenTracking: boolean }}
 */
export const getCapabilities = () => ({
  supportsMultiTurn: true,
  supportsTokenTracking: true,
});

/**
 * Create a conversation handler for transformers.js models.
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
  const gemma = isGemmaModel(model);

  return {
    /**
     * Send messages and stream response.
     * @param {Array<{role: string, content: string}>} messages - Full messages array
     * @yields {{ type: "data", content: string } | { type: "done", finishReason: string, usage: Object }}
     */
    async *sendMessage(messages) {
      // Build prompt using the appropriate chat template
      const templateOpts = {
        add_generation_prompt: true,
        ...(gemma ? { enable_thinking: false } : { tokenize: false }),
      };

      let prompt, inputs, inputLength;
      if (gemma) {
        prompt = engine.processor.apply_chat_template(messages, templateOpts);
        inputs = await engine.processor(prompt, null, null, {
          add_special_tokens: false,
        });
      } else {
        prompt = engine.tokenizer.apply_chat_template(messages, templateOpts);
        inputs = engine.tokenizer(prompt, { add_special_tokens: false });
      }
      inputLength = inputs.input_ids.dims.at(-1);

      // Set up token streaming via Promise-based queue
      // TextStreamer uses callbacks; we bridge to the async generator pattern.
      const tokenQueue = [];
      let queueResolve = null;
      let streamDone = false;

      const enqueue = (value) => {
        if (queueResolve) {
          const resolve = queueResolve;
          queueResolve = null;
          resolve(value);
        } else {
          tokenQueue.push(value);
        }
      };

      const dequeue = () => {
        if (tokenQueue.length > 0) {
          return Promise.resolve(tokenQueue.shift());
        }
        if (streamDone) {
          return Promise.resolve(null);
        }
        return new Promise((resolve) => {
          queueResolve = resolve;
        });
      };

      const tokenizerRef = gemma
        ? engine.processor.tokenizer
        : engine.tokenizer;
      const streamer = new TextStreamer(tokenizerRef, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (text) => {
          enqueue(text);
        },
      });

      // Start generation in background
      setCrashMarker(model, "generate");
      const generatePromise = engine.generationModel
        .generate({
          ...inputs,
          max_new_tokens: maxOutputTokens,
          do_sample: temperature > 0,
          temperature: temperature > 0 ? temperature : undefined,
          streamer,
        })
        .then((output) => {
          clearCrashMarker();
          streamDone = true;
          enqueue(null); // null sentinel = done
          return output;
        });

      // Yield streamed tokens
      let assistantContent = "";
      while (true) {
        const text = await dequeue();
        if (text === null) break;
        assistantContent += text;
        yield { type: "data", content: text };
      }

      // Wait for generation to complete and get token counts
      const output = await generatePromise;
      const outputLength = output.dims
        ? output.dims.at(-1)
        : Array.isArray(output)
          ? (output[0]?.length ?? 0)
          : 0;

      yield {
        type: "done",
        finishReason: "stop",
        usage: {
          inputTokens: inputLength,
          outputTokens: Math.max(0, outputLength - inputLength),
          assistantContent,
        },
      };
    },

    destroy() {
      // Models are cached and reused across sessions, no per-session cleanup
    },
  };
};
