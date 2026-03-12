// MediaPipe LLM Inference Web Worker (classic script)
// Must be a classic worker (not module) because MediaPipe's WASM loader uses importScripts().
// See: https://github.com/google-ai-edge/mediapipe/issues/5257

/* global self:false */

const MEDIAPIPE_CDN =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@0.10.26";

let llm = null;

/**
 * Initialize the MediaPipe LLM engine.
 * @param {Object} data - Init message data
 * @param {string} [data.modelUrl] - URL to fetch model from
 * @param {ArrayBuffer} [data.modelBuffer] - Pre-loaded model data
 * @param {number} data.maxTokens - Total token budget (input + output)
 * @param {number} data.temperature - Sampling temperature
 * @param {number} data.topK - Top-K sampling parameter
 */
const handleInit = async (data) => {
  try {
    // Dynamic import of the ESM bundle (works in classic workers)
    const { FilesetResolver, LlmInference } = await import(
      `${MEDIAPIPE_CDN}/genai_bundle.mjs`
    );

    self.postMessage({ type: "progress", text: "Loading WASM runtime..." });

    const genai = await FilesetResolver.forGenAiTasks(`${MEDIAPIPE_CDN}/wasm`);

    self.postMessage({ type: "progress", text: "Loading model..." });

    // Build base options
    const baseOptions = { delegate: "GPU" };

    if (data.modelBuffer) {
      baseOptions.modelAssetBuffer = new Uint8Array(data.modelBuffer);
    } else if (data.modelUrl) {
      baseOptions.modelAssetPath = data.modelUrl;
    } else {
      throw new Error("Either modelUrl or modelBuffer is required");
    }

    // Create WebGPU device
    try {
      baseOptions.gpuOptions = {
        device: await LlmInference.createWebGpuDevice(),
      };
    } catch (err) {
      throw new Error(`WebGPU not available: ${err.message}`);
    }

    llm = await LlmInference.createFromOptions(genai, {
      baseOptions,
      maxTokens: data.maxTokens || 1024,
      topK: data.topK || 40,
      temperature: data.temperature || 0.8,
      randomSeed: Math.floor(Math.random() * 1000),
    });

    self.postMessage({ type: "ready" });
  } catch (err) {
    self.postMessage({ type: "error", message: err.message });
  }
};

/**
 * Generate a streaming response.
 * @param {Object} data - Generate message data
 * @param {string} data.prompt - The formatted prompt string
 */
const handleGenerate = (data) => {
  if (!llm) {
    self.postMessage({ type: "error", message: "Engine not initialized" });
    return;
  }

  try {
    llm.generateResponse(data.prompt, (partialResult, done) => {
      if (partialResult) {
        self.postMessage({ type: "token", content: partialResult });
      }
      if (done) {
        self.postMessage({ type: "done" });
      }
    });
  } catch (err) {
    self.postMessage({ type: "error", message: err.message });
  }
};

/**
 * Count tokens in a prompt.
 * @param {Object} data - Token count message data
 * @param {string} data.text - Text to count tokens for
 */
const handleCountTokens = async (data) => {
  if (!llm) {
    self.postMessage({
      type: "tokenCount",
      count: 0,
      error: "Engine not initialized",
    });
    return;
  }
  try {
    const count = await llm.sizeInTokens(data.text);
    self.postMessage({ type: "tokenCount", count });
  } catch (err) {
    self.postMessage({ type: "tokenCount", count: 0, error: err.message });
  }
};

/**
 * Cancel in-progress generation.
 */
const handleCancel = () => {
  if (llm) {
    llm.cancelProcessing();
  }
};

/**
 * Clean up and close the engine.
 */
const handleClose = () => {
  if (llm) {
    llm.close();
    llm = null;
  }
};

// Message router
self.onmessage = (e) => {
  const { type, ...data } = e.data;
  switch (type) {
    case "init":
      handleInit(data);
      break;
    case "generate":
      handleGenerate(data);
      break;
    case "countTokens":
      handleCountTokens(data);
      break;
    case "cancel":
      handleCancel();
      break;
    case "close":
      handleClose();
      break;
    default:
      self.postMessage({
        type: "error",
        message: `Unknown message type: ${type}`,
      });
  }
};
