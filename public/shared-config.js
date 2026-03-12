/**
 * Shared client configuration. (No secrets, Node.js compatible).
 */

// Chrome Built-in AI feature detection
// ## Enabling in Chrome
// - Prompt: https://developer.chrome.com/docs/ai/prompt-api#use_on_localhost
// - Writer: https://developer.chrome.com/docs/ai/writer-api#add_support_to_localhost
export const CHROME_HAS_PROMPT_API = "LanguageModel" in globalThis;
export const CHROME_HAS_WRITER_API = "Writer" in globalThis;
export const CHROME_ANY_API_POSSIBLE =
  CHROME_HAS_PROMPT_API || CHROME_HAS_WRITER_API;

export const CHROME_DEFAULT_TOP_K = 40;

const BASE_PAGES = [
  { name: "Home", navName: "Joyce", to: "/", icon: "iconoir-home-simple" },
  { name: "Posts", to: "/posts", icon: "iconoir-multiple-pages-empty" },
  { name: "Search", to: "/search", icon: "iconoir-doc-magnifying-glass-in" },
  { name: "Chat", to: "/chat", icon: "iconoir-chat-bubble" },
  { name: "Settings", to: "/settings", icon: "iconoir-tools" },
];

const DEV_ONLY_PAGES = [
  { name: "Data", to: "/data-load", icon: "iconoir-cpu" },
];

export const TOKEN_CUSHION_CHAT = 512; // 250 ok for web-llm
export const TOKEN_CUSHION_EMBEDDINGS = 25;
export const MAX_OUTPUT_TOKENS = 1024; // Limit LLM response length

// When false: token limit checks warn and proceed, letting real API errors occur
// When true: token limit checks throw errors immediately (current behavior)
export const THROW_ON_TOKEN_LIMIT = false;

/**
 * Calculate token cushion for multi-turn conversations.
 * Scales proportionally with model size, with floor and ceiling.
 * Reserves space for the next user question + assistant response.
 * @param {number} maxTokens - Model's maximum context window
 * @returns {number} Token cushion to reserve
 */
export const getMultiTurnCushion = (maxTokens) => {
  if (maxTokens <= 2048) {
    // Small models (1-2K): fixed minimum for one exchange
    return 350;
  } else if (maxTokens <= 4096) {
    // Medium models (4K): ~12% = 491 tokens
    return Math.floor(maxTokens * 0.12);
  } else if (maxTokens <= 8192) {
    // Large models (8K Gemini): ~10% = 819 tokens
    return Math.floor(maxTokens * 0.1);
  } else {
    // Very large models: ~8% with 2000 token cap
    return Math.min(2000, Math.floor(maxTokens * 0.08));
  }
};

// Minimum number of context chunks to maintain in multi-turn conversations
export const MIN_CONTEXT_CHUNKS = 5;

// Ratio of available tokens to use for RAG context in multi-turn conversations
// Remainder is reserved for conversation history growth across turns
export const MULTI_TURN_CONTEXT_RATIO = 0.7;

// How to handle multiple chunks from the same post when building context
// "duplicate" - add all chunks in order (current behavior)
// "combine" - merge text with separator into single chunk per post
// "skip" - only use first chunk per post
export const CHUNK_DEDUP_MODE = "combine";
export const CHUNK_COMBINE_SEPARATOR = "\n\n...\n\n";

// TODO(CHAT): Can we programmatically get these values?
export const PROMPT_API_GEMINI_NANO_MAX_TOKENS = 32768;
export const PROMPT_API_GEMINI_NANO_MAX_TOKENS_ADJUSTED_PROMPT = 8192; // Session max input is much smaller, like around 9K on my mac.
export const PROMPT_API_GEMINI_NANO_MAX_TOKENS_ADJUSTED_WRITER = 5000; // Session max input around 6K on my mac.

const config = {
  pages: {
    all: [...BASE_PAGES, ...DEV_ONLY_PAGES],
    simple: BASE_PAGES,
  },
  embeddings: {
    // Note: if you change the embedding model, you'll need to re-generate all post embeddings.
    model: "Xenova/gte-small",
    maxTokens: 512, // https://huggingface.co/thenlper/gte-small#limitation
    dataChunkSizes: {
      MEDIUM: 256,
      LARGE: 512,
    },
  },
  // Chrome Built-in AI (Gemini Nano) - available in Chrome with AI features enabled
  // See: https://developer.chrome.com/docs/ai/built-in-apis
  chrome: {
    models: {
      chat: [
        {
          model: "gemini-nano-prompt",
          modelShortName: "Gemini Nano (Prompt)",
          shortOption: "Flexible",
          api: "prompt",
          maxTokens: PROMPT_API_GEMINI_NANO_MAX_TOKENS_ADJUSTED_PROMPT,
          default: CHROME_HAS_PROMPT_API,
        },
        {
          model: "gemini-nano-writer",
          modelShortName: "Gemini Nano (Writer)",
          shortOption: "Writing",
          api: "writer",
          maxTokens: PROMPT_API_GEMINI_NANO_MAX_TOKENS_ADJUSTED_WRITER,
          default: !CHROME_HAS_PROMPT_API && CHROME_HAS_WRITER_API,
        },
      ],
    },
  },
  // MediaPipe LLM Inference (on-device via WebGPU + WASM)
  // See: https://ai.google.dev/edge/mediapipe/solutions/genai/llm_inference/web_js
  mediaPipe: {
    models: {
      chat: [
        {
          model: "gemma-3n-e2b-it-web",
          modelShortName: "Gemma 3n E2B",
          shortOption: "Gemma 3n",
          modelUrl:
            "https://huggingface.co/google/gemma-3n-E2B-it-mediapipe-Web/resolve/main/gemma3n-E2B-it-Web.litertlm",
          maxTokens: 1024,
          sizeMb: 3040,
        },
      ],
    },
  },
  // web-llm model metadata (vramMb, maxTokens) is mutated into model objects at load time
  // from prebuiltAppConfig. See: https://github.com/mlc-ai/web-llm/blob/main/src/config.ts
  webLlm: {
    models: {
      chat: [
        // {
        //   // TODO: REMOVE?
        //   // Notes: prone to ongoing gibberish.
        //   model: "SmolLM2-360M-Instruct-q4f16_1-MLC",
        //   modelShortName: "SmolLM2-360M",
        //   autoLoad: false,
        // },
        {
          model: "TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC",
          modelShortName: "TinyLlama-1.1B",
          shortOption: "Fast",
        },
        {
          model: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
          modelShortName: "Llama-3.2-1B",
          shortOption: "Better",
        },
        {
          model: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
          modelShortName: "Qwen2.5-0.5B",
          shortOption: "Best",
          default: !CHROME_ANY_API_POSSIBLE,
        },
      ],
    },
  },
};

// Default embedding chunk size (uses the MEDIUM size from dataChunkSizes)
export const DEFAULT_EMBEDDING_CHUNK_SIZE =
  config.embeddings.dataChunkSizes.MEDIUM;

export const ALL_PROVIDERS = {
  chrome: "Chrome",
  mediaPipe: "MediaPipe",
  webLlm: "web-llm",
};

export const ALL_CHAT_MODELS = Object.keys(ALL_PROVIDERS).map((provider) => ({
  provider,
  models: config[provider].models.chat,
}));

export const CHAT_MODELS_MAP = Object.fromEntries(
  ALL_CHAT_MODELS.map(({ provider, models }) => [
    provider,
    Object.fromEntries(models.map((modelObj) => [modelObj.model, modelObj])),
  ]),
);

// Find the default chat model by looking for `default: true` across all providers
export const DEFAULT_CHAT_MODEL = (() => {
  for (const { provider, models } of ALL_CHAT_MODELS) {
    const defaultModel = models.find((m) => m.default);
    if (defaultModel) {
      return { provider, model: defaultModel.model };
    }
  }
  throw new Error(
    "No default chat model found (set `default: true` on a model)",
  );
})();
export const DEFAULT_DATASTORE = "postgresql";
export const DEFAULT_API = "chat";
export const DEFAULT_TEMPERATURE = 0.4; // TODO(CHAT): note about temperature in SLMs.

export const getModelCfg = ({ provider, model }) => {
  const modelCfg = CHAT_MODELS_MAP[provider][model];
  if (!modelCfg) {
    throw new Error(
      `Could not find config options for model "${model}". Incorrect configuration?`,
    );
  }
  return modelCfg;
};

export const getSimpleModelOptions = (provider) =>
  config[provider].models.chat
    .filter((m) => m.shortOption)
    .map(({ model, shortOption }) => ({ provider, model, label: shortOption }));

/**
 * Find which provider owns a given model ID.
 * @param {string} modelId - The model ID to look up
 * @returns {string | null} The provider key or null if not found
 */
export const getProviderForModel = (modelId) => {
  for (const { provider, models } of ALL_CHAT_MODELS) {
    if (models.some((m) => m.model === modelId)) {
      return provider;
    }
  }
  return null;
};

/**
 * Get the path to the embeddings file for a given chunk size.
 * @param {number} size - The chunk size (e.g., 256, 512)
 * @returns {string} - The path to the embeddings file
 */
export const getEmbeddingsPath = (size = DEFAULT_EMBEDDING_CHUNK_SIZE) =>
  `/data/posts-embeddings-${size}.json`;

export default config;
