/* global navigator:false, console:false */
// HuggingFace Transformers provider implementation
// Runs ONNX models in-browser via WebGPU using @huggingface/transformers
import { pipeline, TextStreamer } from "@huggingface/transformers";
import { getModelCfg } from "../../../../config.js";

// ONNX models in browser have practical limits below their theoretical max_position_embeddings.
// Large KV caches cause SafeInt integer overflows in ONNX Runtime's WASM/WebGPU backend.
// Keep well under the limit to leave room for max_new_tokens of generated output.
const ONNX_MAX_INPUT_TOKENS = 3072;

// Map of model -> { pipelinePromise, progressCallback }
const engines = new Map();

/**
 * Set a progress callback for a specific model.
 * @param {string} model - The model ID
 * @param {Function} cb - Progress callback function
 */
export const setLlmProgressCallback = (model, cb) => {
  if (!engines.has(model)) {
    engines.set(model, { pipelinePromise: null, progressCallback: null });
  }
  engines.get(model).progressCallback = cb;
};

/**
 * Map HF transformers progress events to the { text, progress } shape.
 * @param {Object} event - HF transformers progress event
 * @returns {{ text: string, progress: number } | null}
 */
const mapProgress = (event) => {
  if (event.status === "progress" && event.progress != null) {
    const pct = Math.round(event.progress);
    const name = event.file ?? event.name ?? "model";
    return { text: `Downloading ${name}: ${pct}%`, progress: pct / 100 };
  }
  if (event.status === "ready") {
    return { text: "Model ready", progress: 1 };
  }
  if (event.status === "initiate") {
    return { text: `Loading ${event.file ?? "model"}...`, progress: 0 };
  }
  return null;
};

/**
 * Count tokens for a messages array using the tokenizer's chat template.
 * @param {Object} tokenizer - The pipeline's tokenizer
 * @param {Array} messages - Chat messages array
 * @returns {number} Token count
 */
const countChatTokens = (tokenizer, messages) => {
  const text = tokenizer.apply_chat_template(messages, {
    tokenize: false,
    add_generation_prompt: true,
  });
  return tokenizer(text).input_ids.size;
};

/**
 * Truncate messages to fit within ONNX_MAX_INPUT_TOKENS.
 * Strategy: keep the system message and last user message intact,
 * trim RAG context (assistant messages near the start) first.
 * @param {Object} tokenizer - The pipeline's tokenizer
 * @param {Array} messages - Chat messages array
 * @returns {Array} Truncated messages
 */
const truncateMessages = (tokenizer, messages) => {
  let tokenCount = countChatTokens(tokenizer, messages);
  if (tokenCount <= ONNX_MAX_INPUT_TOKENS) return messages;

  console.warn(
    `[hf-transformers] Input ${tokenCount} tokens exceeds ${ONNX_MAX_INPUT_TOKENS}, truncating`,
  );

  // Work with a mutable copy
  const result = messages.map((m) => ({ ...m }));

  // Progressively trim the longest content message (skip last user message)
  while (countChatTokens(tokenizer, result) > ONNX_MAX_INPUT_TOKENS) {
    let longestIdx = -1;
    let longestLen = 0;
    for (let i = 0; i < result.length - 1; i++) {
      if (result[i].content.length > longestLen) {
        longestLen = result[i].content.length;
        longestIdx = i;
      }
    }
    if (longestIdx === -1 || longestLen < 100) break;

    // Cut the longest message in half
    const msg = result[longestIdx];
    msg.content = msg.content.slice(0, Math.floor(msg.content.length / 2));
  }

  // Final fallback: if still too long, drop middle messages
  while (
    result.length > 2 &&
    countChatTokens(tokenizer, result) > ONNX_MAX_INPUT_TOKENS
  ) {
    result.splice(1, 1);
  }

  return result;
};

/**
 * Detect WebGPU availability, returning "webgpu" or "wasm".
 * @returns {Promise<string>}
 */
const detectDevice = async () => {
  if ("gpu" in navigator) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return "webgpu";
    } catch {
      /* fall through to WASM */
    }
  }
  return "wasm";
};

/**
 * Get or create an LLM pipeline for a specific model.
 * @param {string} model - The model ID
 * @returns {Promise<Object>} The pipeline instance
 */
export const getLlmEngine = async (model) => {
  if (!engines.has(model)) {
    engines.set(model, { pipelinePromise: null, progressCallback: null });
  }

  const entry = engines.get(model);
  if (!entry.pipelinePromise) {
    const modelCfg = getModelCfg({ provider: "hfTransformers", model });
    const device = await detectDevice();

    entry.pipelinePromise = pipeline("text-generation", model, {
      device,
      dtype: modelCfg.dtype ?? "q4f16",
      progress_callback: (event) => {
        const mapped = mapProgress(event);
        if (mapped) entry.progressCallback?.(mapped);
      },
    });
  }
  return entry.pipelinePromise;
};

/**
 * Check if a model is cached.
 * HF transformers uses Cache API internally but has no public cache check API.
 * @returns {Promise<boolean>}
 */
export const isLlmCached = async () => {
  return false;
};

/**
 * Get capabilities for an HF Transformers model.
 * @returns {{ supportsMultiTurn: boolean, supportsTokenTracking: boolean }}
 */
export const getCapabilities = () => ({
  supportsMultiTurn: true,
  supportsTokenTracking: true,
});

/**
 * Create a conversation handler for HF Transformers.
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
  const generator = await getLlmEngine(model);

  return {
    /**
     * Send messages and stream response.
     * @param {Array<{role: string, content: string}>} messages - Full messages array
     * @yields {{ type: "data", content: string } | { type: "done", finishReason: string, usage: Object }}
     */
    async *sendMessage(messages) {
      // Truncate input to stay within ONNX Runtime's safe limits.
      // Apply chat template to get actual token count, then trim messages if needed.
      const truncated = truncateMessages(generator.tokenizer, messages);

      // Push/pull queue to bridge TextStreamer callbacks to async generator
      const queue = [];
      const waiting = [];
      const push = (v) => (waiting.length ? waiting.shift()(v) : queue.push(v));
      const pull = () =>
        queue.length
          ? Promise.resolve(queue.shift())
          : new Promise((r) => waiting.push(r));

      const streamer = new TextStreamer(generator.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (text) => push({ type: "data", content: text }),
      });

      const genPromise = generator(truncated, {
        max_new_tokens: maxOutputTokens,
        max_length: ONNX_MAX_INPUT_TOKENS + maxOutputTokens,
        temperature: temperature > 0 ? temperature : undefined,
        do_sample: temperature > 0,
        streamer,
      }).then(() => push(null));

      let assistantContent = "";
      while (true) {
        const event = await pull();
        if (!event) break;
        assistantContent += event.content;
        yield event;
      }
      await genPromise;

      // Count tokens using the tokenizer for accurate tracking
      const inputText = truncated.map((m) => m.content).join(" ");
      const inputTokens = generator.tokenizer(inputText).input_ids.size;
      const outputTokens = generator.tokenizer(assistantContent).input_ids.size;

      yield {
        type: "done",
        finishReason: "stop",
        usage: {
          inputTokens,
          outputTokens,
          assistantContent,
        },
      };
    },

    destroy() {
      // Pipelines are cached and reused, no cleanup needed per-session
    },
  };
};
