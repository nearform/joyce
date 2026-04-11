/* global caches:false */
// Transformers.js provider implementation
// Uses @huggingface/transformers for Gemma 4 ONNX models via WebGPU
// See: https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX
import {
  AutoProcessor,
  Gemma4ForConditionalGeneration,
  TextStreamer,
} from "@huggingface/transformers";

// Map of model -> { processorPromise, modelPromise, progressCallback }
const engines = new Map();

const getEntry = (model) => {
  if (!engines.has(model)) {
    engines.set(model, {
      processorPromise: null,
      modelPromise: null,
      progressCallback: null,
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
 * Get or create a model engine (processor + generation model).
 * @param {string} model - The model ID (e.g., "onnx-community/gemma-4-E2B-it-ONNX")
 * @returns {Promise<{ processor: AutoProcessor, generationModel: Gemma4ForConditionalGeneration }>}
 */
export const getLlmEngine = async (model) => {
  const entry = getEntry(model);

  if (!entry.processorPromise) {
    entry.processorPromise = AutoProcessor.from_pretrained(model);
  }

  if (!entry.modelPromise) {
    // Track per-file bytes to compute aggregate download progress
    const fileProgress = new Map(); // file -> { loaded, total }

    entry.modelPromise = Gemma4ForConditionalGeneration.from_pretrained(model, {
      dtype: "q4f16",
      device: "webgpu",
      progress_callback: (info) => {
        if (info.status === "progress" && info.total) {
          fileProgress.set(info.file, {
            loaded: info.loaded,
            total: info.total,
          });
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
          entry.progressCallback?.({
            text: "Model loaded",
            progress: 1,
          });
        }
      },
    });
  }

  const [processor, generationModel] = await Promise.all([
    entry.processorPromise,
    entry.modelPromise,
  ]);

  return { processor, generationModel };
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
 * Create a conversation handler for transformers.js Gemma 4 models.
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
  const { processor, generationModel } = await getLlmEngine(model);

  return {
    /**
     * Send messages and stream response.
     * @param {Array<{role: string, content: string}>} messages - Full messages array
     * @yields {{ type: "data", content: string } | { type: "done", finishReason: string, usage: Object }}
     */
    async *sendMessage(messages) {
      // Build prompt using the processor's chat template
      const prompt = processor.apply_chat_template(messages, {
        enable_thinking: false,
        add_generation_prompt: true,
      });

      // Tokenize (text-only: pass null for image and audio)
      const inputs = await processor(prompt, null, null, {
        add_special_tokens: false,
      });
      const inputLength = inputs.input_ids.dims.at(-1);

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

      const streamer = new TextStreamer(processor.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (text) => {
          enqueue(text);
        },
      });

      // Start generation in background
      const generatePromise = generationModel
        .generate({
          ...inputs,
          max_new_tokens: maxOutputTokens,
          do_sample: temperature > 0,
          temperature: temperature > 0 ? temperature : undefined,
          streamer,
        })
        .then((output) => {
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
