/* global LanguageModel:false,Writer:false */
// Chrome AI provider implementation using Chrome Built-in AI APIs
// Supports both Prompt API and Writer API via pseudo-models
// See: https://developer.chrome.com/docs/ai/built-in-apis

import {
  CHROME_DEFAULT_TOP_K,
  CHROME_HAS_PROMPT_API,
  CHROME_HAS_WRITER_API,
} from "../../../../config.js";
import { buildBasePrompts } from "../chat.js";
import { estimateTokens } from "../../util.js";
import { wrap, breadcrumb, errMessage } from "../../telemetry.js";

const PROMPT_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

const WRITER_OPTIONS = {
  expectedInputLanguages: ["en"],
  expectedContextLanguages: ["en"],
};

// Map of model -> { progressCallback }
const modelState = new Map();

/**
 * Create a download progress monitor for Chrome AI APIs.
 * @param {Function|null} progressCallback - Optional callback for download progress
 * @returns {Function} Monitor function for Chrome AI create() options
 */
const createDownloadMonitor = (progressCallback) => (m) => {
  m.addEventListener("downloadprogress", (e) => {
    progressCallback?.({
      text: `Downloading model: ${Math.round(e.loaded * 100)}%`,
      progress: e.loaded,
    });
  });
};

/**
 * Check Chrome AI availability for a specific API type.
 * @param {"prompt" | "writer"} apiType - The API to check
 * @returns {Promise<{ available: boolean, downloading?: boolean, reason: string }>}
 */
export const checkAvailability = async (apiType) => {
  let status;
  try {
    if (apiType === "prompt") {
      if (!CHROME_HAS_PROMPT_API) {
        return {
          available: false,
          reason: "Prompt API not supported in this browser",
        };
      }
      status = await LanguageModel.availability(PROMPT_OPTIONS);
    } else if (apiType === "writer") {
      if (!CHROME_HAS_WRITER_API) {
        return {
          available: false,
          reason: "Writer API not supported in this browser",
        };
      }
      status = await Writer.availability(WRITER_OPTIONS);
    }
  } catch (err) {
    return { available: false, reason: err.message };
  }

  if (status) {
    return {
      available: status === "available",
      downloading: status === "downloading" || status === "downloadable",
      reason: status,
    };
  }
  return { available: false, reason: "Unknown API type" };
};

/**
 * Determine API type from model ID.
 * @param {string} model - The model ID (e.g., "gemini-nano-prompt")
 * @returns {"prompt" | "writer"}
 */
const getApiType = (model) => (model.includes("-writer") ? "writer" : "prompt");

/**
 * Set a progress callback for a specific model.
 * @param {string} model - The model ID
 * @param {Function} cb - Progress callback function
 */
export const setLlmProgressCallback = async (model, cb) => {
  if (!modelState.has(model)) {
    modelState.set(model, { progressCallback: null });
  }
  modelState.get(model).progressCallback = cb;

  const apiType = getApiType(model);
  const status = await checkAvailability(apiType);

  if (!status.available && !status.downloading) {
    cb(new Error(status.reason || "Chrome AI not available"));
  } else if (status.downloading) {
    cb({ text: "Waiting for Chrome to download AI model..." });
  } else {
    cb({ text: "Chrome AI ready", progress: 1 });
  }
};

/**
 * Get or create an LLM engine for a specific model.
 * Returns a dummy engine - actual sessions are created in createHandler.
 * @param {string} model - The model ID
 * @returns {Promise<Object>} Engine placeholder
 */
export const getLlmEngine = async (model) => {
  const apiType = getApiType(model);
  const status = await checkAvailability(apiType);
  if (!status.available && !status.downloading) {
    throw new Error(
      `Chrome AI (${apiType} API) not available: ${status.reason}. ` +
        "Ensure you're using Chrome 138+ with AI features enabled.",
    );
  }
  return {}; // Placeholder - actual session created in createHandler
};

/**
 * Unload a model. No-op for Chrome built-in AI: the model is the OS's, not held in a page-owned
 * engine, and sessions are created per-handler — there's nothing for us to free.
 * @returns {Promise<void>}
 */
export const unloadLlmEngine = async () => {};

/**
 * Check if a model is cached/ready.
 * @param {string} model - The model ID
 * @returns {Promise<boolean>} Whether the model is ready
 */
export const isLlmCached = async (model) => {
  const status = await checkAvailability(getApiType(model));
  return status.available === true;
};

/**
 * Get capabilities for a Chrome AI model.
 * @param {string} model - The model ID
 * @returns {{ supportsMultiTurn: boolean, supportsTokenTracking: boolean }}
 */
export const getCapabilities = (model) => ({
  supportsMultiTurn: getApiType(model) === "prompt",
  supportsTokenTracking: true,
});

/**
 * Create a conversation handler for Chrome AI.
 * Yields unified events: { type: "data", content } and { type: "done", finishReason, usage }
 *
 * @param {Object} options
 * @param {string} options.model - Model ID (determines prompt vs writer API)
 * @param {string} options.systemContext - RAG context for system prompt
 * @param {number} options.temperature - Sampling temperature
 * @returns {Promise<Object>} Handler with sendMessage(userMessage) and destroy()
 */
export const createHandler = async ({ model, systemContext, temperature }) => {
  const apiType = getApiType(model);
  const progressCallback = modelState.get(model)?.progressCallback ?? null;

  if (apiType === "prompt") {
    return createPromptHandler({
      systemContext,
      temperature,
      progressCallback,
    });
  } else {
    return createWriterHandler({ systemContext, progressCallback });
  }
};

/**
 * Create a Prompt API handler (multi-turn).
 */
const createPromptHandler = async ({
  systemContext,
  temperature,
  progressCallback,
}) => {
  const status = await checkAvailability("prompt");
  if (!status.available && !status.downloading) {
    throw new Error(
      `Chrome Prompt API not available: ${status.reason}. ` +
        "Ensure you're using Chrome 138+ with AI features enabled.",
    );
  }

  const initialPrompts = buildBasePrompts(systemContext);

  const session = await wrap(
    "chrome.prompt.create",
    () =>
      LanguageModel.create({
        ...PROMPT_OPTIONS,
        topK: CHROME_DEFAULT_TOP_K,
        temperature,
        initialPrompts: initialPrompts.length > 0 ? initialPrompts : undefined,
        monitor: progressCallback
          ? createDownloadMonitor(progressCallback)
          : undefined,
      }),
    () => ({ temperature, initialPromptCount: initialPrompts.length }),
  );

  return {
    /**
     * Send a message and stream response.
     * @param {string} userMessage - The user's message
     * @yields {{ type: "data", content: string } | { type: "done", finishReason: string, usage: Object }}
     */
    async *sendMessage(userMessage) {
      breadcrumb("chrome.prompt.stream.start", {
        msgLen: userMessage.length,
        contextUsage: session.contextUsage ?? session.inputUsage ?? 0,
      });
      const stream = session.promptStreaming(userMessage);
      let assistantContent = "";

      try {
        for await (const chunk of stream) {
          if (chunk) {
            assistantContent += chunk;
            yield { type: "data", content: chunk };
          }
        }
      } catch (err) {
        breadcrumb("chrome.prompt.stream.error", {
          name: err?.name,
          message: errMessage(err),
          tokensSoFar: assistantContent.length,
        });
        throw err;
      }
      breadcrumb("chrome.prompt.stream.done", {
        outputChars: assistantContent.length,
      });

      yield {
        type: "done",
        finishReason: "stop",
        usage: {
          // New API: contextUsage/contextWindow, old: inputUsage/inputQuota
          // https://github.com/webmachinelearning/prompt-api/blob/153ee14cd21c6f093cbaeb27c0024a3af28723d1/README.md#api-updates-deprecations-and-renaming
          inputTokens: session.contextUsage ?? session.inputUsage ?? 0,
          outputTokens: estimateTokens(assistantContent),
          assistantContent,
          inputQuota: session.contextWindow ?? session.inputQuota,
        },
      };
    },

    destroy() {
      session?.destroy();
    },
  };
};

/**
 * Create a Writer API handler (single-turn).
 */
const createWriterHandler = async ({ systemContext, progressCallback }) => {
  const status = await checkAvailability("writer");
  if (!status.available && !status.downloading) {
    throw new Error(
      `Chrome Writer API not available: ${status.reason}. ` +
        "Ensure you're using Chrome 138+ with AI features enabled.",
    );
  }

  const basePrompts = buildBasePrompts(systemContext);
  const fullSharedContext = basePrompts.map((m) => m.content).join("\n\n");

  return {
    /**
     * Send a message and stream response.
     * Single-turn: creates fresh writer for each message.
     * @param {string} userMessage - The writing task
     * @yields {{ type: "data", content: string } | { type: "done", finishReason: string, usage: Object }}
     */
    async *sendMessage(userMessage) {
      const writer = await wrap(
        "chrome.writer.create",
        () =>
          Writer.create({
            tone: "neutral",
            length: "medium",
            format: "markdown",
            sharedContext: fullSharedContext,
            ...WRITER_OPTIONS,
            outputLanguage: "en",
            monitor: progressCallback
              ? createDownloadMonitor(progressCallback)
              : undefined,
          }),
        () => ({ contextLen: fullSharedContext.length }),
      );

      try {
        // New API: measureContextUsage, old: measureInputUsage
        // https://github.com/webmachinelearning/prompt-api/blob/153ee14cd21c6f093cbaeb27c0024a3af28723d1/README.md#api-updates-deprecations-and-renaming
        const measureUsage =
          writer.measureContextUsage ?? writer.measureInputUsage;
        const inputTokens = await measureUsage.call(writer, userMessage, {
          context: "",
        });
        breadcrumb("chrome.writer.stream.start", {
          msgLen: userMessage.length,
          inputTokens,
        });
        const stream = writer.writeStreaming(userMessage, { context: "" });
        let assistantContent = "";

        try {
          for await (const chunk of stream) {
            if (chunk) {
              assistantContent += chunk;
              yield { type: "data", content: chunk };
            }
          }
        } catch (err) {
          breadcrumb("chrome.writer.stream.error", {
            name: err?.name,
            message: errMessage(err),
            tokensSoFar: assistantContent.length,
          });
          throw err;
        }
        breadcrumb("chrome.writer.stream.done", {
          outputChars: assistantContent.length,
        });

        yield {
          type: "done",
          finishReason: "stop",
          usage: {
            inputTokens,
            outputTokens: estimateTokens(assistantContent),
            assistantContent,
            inputQuota: writer.contextWindow ?? writer.inputQuota,
          },
        };
      } finally {
        writer.destroy();
      }
    },

    destroy() {
      // Writer creates/destroys per-call, nothing to clean up at handler level
    },
  };
};
