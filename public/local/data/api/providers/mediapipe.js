/* global navigator:false,Worker:false,URL:false */
// MediaPipe LLM Inference provider implementation
// Uses Google's MediaPipe GenAI Tasks for on-device LLM inference via WebGPU + WASM.
// Runs inference in a Web Worker to avoid blocking the main thread.
// See: https://ai.google.dev/edge/mediapipe/solutions/genai/llm_inference/web_js

import { CHAT_MODELS_MAP } from "../../../../config.js";
import { estimateTokens } from "../../util.js";

// OPFS directory name for cached models
const OPFS_MODEL_DIR = "mediapipe-models";

// Map of model -> { worker, progressCallback, ready, readyPromise }
const engines = new Map();

/**
 * Get the OPFS cache key for a model.
 * @param {string} model - The model ID
 * @returns {string} Cache filename
 */
const getCacheKey = (model) => model.replace(/[^a-zA-Z0-9_-]/g, "_");

/**
 * Check if OPFS is available.
 * @returns {boolean}
 */
const hasOpfs = () =>
  typeof navigator !== "undefined" && navigator.storage?.getDirectory;

/**
 * Set a progress callback for a specific model.
 * @param {string} model - The model ID
 * @param {Function} cb - Progress callback function
 */
export const setLlmProgressCallback = (model, cb) => {
  if (!engines.has(model)) {
    engines.set(model, {
      worker: null,
      progressCallback: null,
      ready: false,
      readyPromise: null,
    });
  }
  engines.get(model).progressCallback = cb;
};

/**
 * Create and initialize the worker for a model.
 * @param {string} model - The model ID
 * @returns {Promise<void>} Resolves when the engine is ready
 */
const initWorker = (model) => {
  const entry = engines.get(model);
  if (entry.readyPromise) return entry.readyPromise;

  const modelCfg = CHAT_MODELS_MAP.mediaPipe?.[model];
  if (!modelCfg?.modelUrl) {
    return Promise.reject(
      new Error(`No modelUrl configured for MediaPipe model: ${model}`),
    );
  }

  entry.readyPromise = new Promise((resolve, reject) => {
    // Resolve worker path relative to this module
    const workerUrl = new URL("./mediapipe-worker.js", import.meta.url);
    const worker = new Worker(workerUrl);
    entry.worker = worker;

    const onMessage = (e) => {
      const msg = e.data;
      switch (msg.type) {
        case "progress":
          entry.progressCallback?.({
            text: msg.text,
            progress: msg.value ?? undefined,
          });
          break;
        case "ready":
          entry.ready = true;
          entry.progressCallback?.({ text: "Model ready", progress: 1 });
          resolve();
          break;
        case "error":
          reject(new Error(msg.message));
          break;
      }
    };

    worker.addEventListener("message", onMessage);

    worker.postMessage({
      type: "init",
      modelUrl: modelCfg.modelUrl,
      maxTokens: modelCfg.maxTokens || 1024,
      temperature: 0.8,
      topK: 40,
    });
  });

  return entry.readyPromise;
};

/**
 * Get or create an LLM engine (worker) for a specific model.
 * @param {string} model - The model ID
 * @returns {Promise<Worker>} The worker instance
 */
export const getLlmEngine = async (model) => {
  if (!engines.has(model)) {
    engines.set(model, {
      worker: null,
      progressCallback: null,
      ready: false,
      readyPromise: null,
    });
  }

  await initWorker(model);
  return engines.get(model).worker;
};

/**
 * Check if a model is cached in OPFS.
 * @param {string} model - The model ID
 * @returns {Promise<boolean>} Whether the model is cached
 */
export const isLlmCached = async (model) => {
  if (!hasOpfs()) return false;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_MODEL_DIR);
    const handle = await dir.getFileHandle(getCacheKey(model));
    const file = await handle.getFile();
    return file.size > 0;
  } catch {
    return false;
  }
};

/**
 * Get capabilities for a MediaPipe model.
 * @returns {{ supportsMultiTurn: boolean, supportsTokenTracking: boolean }}
 */
export const getCapabilities = () => ({
  supportsMultiTurn: true,
  supportsTokenTracking: true,
});

/**
 * Format conversation messages as a Gemma turn-formatted prompt string.
 * MediaPipe has no built-in chat history — we must construct the prompt manually.
 * @param {Array<{role: string, content: string}>} messages - OpenAI-style messages
 * @returns {string} Gemma-formatted prompt
 */
const formatGemmaPrompt = (messages) => {
  let prompt = "";
  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "assistant") {
      prompt += `<start_of_turn>model\n${msg.content}<end_of_turn>\n`;
    } else if (msg.role === "user") {
      prompt += `<start_of_turn>user\n${msg.content}<end_of_turn>\n`;
    }
  }
  // End with model turn marker to prompt generation
  prompt += "<start_of_turn>model\n";
  return prompt;
};

/**
 * Create a conversation handler for MediaPipe.
 * Yields unified events: { type: "data", content } and { type: "done", finishReason, usage }
 *
 * @param {Object} options
 * @param {string} options.model - Model ID
 * @param {number} options.temperature - Sampling temperature
 * @param {number} options.maxOutputTokens - Max tokens for response
 * @returns {Promise<Object>} Handler with sendMessage(messages) and destroy()
 */
/* eslint-disable no-unused-vars -- temperature/maxOutputTokens set at engine init time */
export const createHandler = async ({
  model,
  temperature,
  maxOutputTokens,
}) => {
  /* eslint-enable no-unused-vars */
  const worker = await getLlmEngine(model);

  return {
    /**
     * Send messages and stream response.
     * Takes full OpenAI-style messages array (same as web-llm).
     * @param {Array<{role: string, content: string}>} messages - Full messages array
     * @yields {{ type: "data", content: string } | { type: "done", finishReason: string, usage: Object }}
     */
    async *sendMessage(messages) {
      const prompt = formatGemmaPrompt(messages);
      let assistantContent = "";
      let done = false;

      // Set up message listener as a promise-based queue
      const queue = [];
      let resolve = null;
      let waitPromise = new Promise((r) => {
        resolve = r;
      });

      const onMessage = (e) => {
        const msg = e.data;
        if (
          msg.type === "token" ||
          msg.type === "done" ||
          msg.type === "error"
        ) {
          queue.push(msg);
          const oldResolve = resolve;
          waitPromise = new Promise((r) => {
            resolve = r;
          });
          oldResolve();
        }
      };

      worker.addEventListener("message", onMessage);

      try {
        worker.postMessage({ type: "generate", prompt });

        while (!done) {
          await waitPromise;

          while (queue.length > 0) {
            const msg = queue.shift();

            if (msg.type === "error") {
              throw new Error(msg.message);
            }

            if (msg.type === "token") {
              assistantContent += msg.content;
              yield { type: "data", content: msg.content };
            }

            if (msg.type === "done") {
              done = true;
            }
          }
        }

        yield {
          type: "done",
          finishReason: "stop",
          usage: {
            inputTokens: estimateTokens(prompt),
            outputTokens: estimateTokens(assistantContent),
            assistantContent,
          },
        };
      } finally {
        worker.removeEventListener("message", onMessage);
      }
    },

    destroy() {
      // Workers are cached and reused across sessions, no per-handler cleanup
    },
  };
};
