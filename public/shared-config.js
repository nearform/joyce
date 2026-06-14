/**
 * Shared client configuration. (No secrets, Node.js compatible).
 */

/* global navigator:false */

// Chrome Built-in AI feature detection
// ## Enabling in Chrome
// - Prompt: https://developer.chrome.com/docs/ai/prompt-api#use_on_localhost
// - Writer: https://developer.chrome.com/docs/ai/writer-api#add_support_to_localhost
export const CHROME_HAS_PROMPT_API = "LanguageModel" in globalThis;
export const CHROME_HAS_WRITER_API = "Writer" in globalThis;
export const CHROME_ANY_API_POSSIBLE =
  CHROME_HAS_PROMPT_API || CHROME_HAS_WRITER_API;

export const CHROME_DEFAULT_TOP_K = 40;

// Broad mobile (iOS/Android) detection, evaluated once at load to pick a lighter set of out-of-the-box
// model tiers. Node-safe: with no `navigator` it falls through to desktop. This mirrors the heuristic
// in getDeviceInfo() (local/data/util.js) — that remains the runtime source of truth for per-model
// fit; this is just a coarse build-time switch for which curated defaults we surface.
const UA = (typeof navigator !== "undefined" && navigator.userAgent) || "";
const PLATFORM = (typeof navigator !== "undefined" && navigator.platform) || "";
const MAX_TOUCH_POINTS =
  (typeof navigator !== "undefined" && navigator.maxTouchPoints) || 0;
export const IS_MOBILE =
  /iPad|iPhone|iPod|Android/.test(UA) ||
  /Mobi/.test(UA) ||
  (PLATFORM === "MacIntel" && MAX_TOUCH_POINTS > 1); // iPadOS reports as MacIntel

const BASE_PAGES = [
  { name: "Home", navName: "Joyce", to: "/", icon: "iconoir-glasses" },
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
export const GEMMA_NANO_MAX_TOKENS = 32768;
export const GEMMA_NANO_MAX_TOKENS_ADJUSTED_PROMPT = 8192; // Session max input is much smaller, like around 9K on my mac.
export const GEMMA_NANO_MAX_TOKENS_ADJUSTED_WRITER = 5000; // Session max input around 6K on my mac.

// web-llm curated tiers (Fast / Better / Best), preselected only — no auto-download. Metadata
// (vramMb, maxTokens) is mutated in from prebuiltAppConfig at load. See config.js.
//
// Desktop: capable modern instruct models, Qwen3.5-favored (mirrors recommendations.js ranking).
const WEB_LLM_CHAT_DESKTOP = [
  {
    model: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    modelShortName: "Llama-3.2-1B",
    shortOption: "Fast",
    default: !CHROME_ANY_API_POSSIBLE,
  },
  {
    // Reasoning model: emits <think>. Suppressed by default via the "Model Thinking" setting.
    model: "Qwen3.5-2B-q4f16_1-MLC",
    modelShortName: "Qwen3.5-2B",
    shortOption: "Better",
  },
  {
    // Reasoning model: emits <think>. Suppressed by default via the "Model Thinking" setting.
    model: "Qwen3.5-4B-q4f16_1-MLC",
    modelShortName: "Qwen3.5-4B",
    shortOption: "Best",
  },
];

// Mobile (iOS/Android): a lighter SmolLM2 → TinyLlama → Llama ladder, all q4f16_1 and <900MB, so the
// out-of-the-box picks load without risking a Safari tab kill. Larger models stay reachable via the
// models table; these are just the flagged defaults.
const WEB_LLM_CHAT_MOBILE = [
  {
    model: "SmolLM2-360M-Instruct-q4f16_1-MLC",
    modelShortName: "SmolLM2-360M",
    shortOption: "Fast",
    default: !CHROME_ANY_API_POSSIBLE,
  },
  {
    model: "TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC",
    modelShortName: "TinyLlama-1.1B",
    shortOption: "Better",
  },
  {
    model: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    modelShortName: "Llama-3.2-1B",
    shortOption: "Best",
  },
];

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
          maxTokens: GEMMA_NANO_MAX_TOKENS_ADJUSTED_PROMPT,
          default: CHROME_HAS_PROMPT_API,
        },
        {
          model: "gemini-nano-writer",
          modelShortName: "Gemini Nano (Writer)",
          shortOption: "Writing",
          api: "writer",
          maxTokens: GEMMA_NANO_MAX_TOKENS_ADJUSTED_WRITER,
          default: !CHROME_HAS_PROMPT_API && CHROME_HAS_WRITER_API,
        },
      ],
    },
  },
  // wllama: llama.cpp WASM + WebGPU runtime, loads GGUFs directly from
  // HuggingFace. Each model declares its HF { repo, file } and downloadSizeMb.
  // All entries below are single-file GGUFs under 2 GB (the ArrayBuffer
  // ceiling wllama enforces for non-split files).
  wllama: {
    models: {
      chat: [
        // Tiny — iOS-safe (fits within Safari's 512 MB maxBufferSize cap)
        {
          model: "wllama-gemma-3-270m-q4km",
          modelShortName: "Gemma 3 270M",
          shortOption: "Fast",
          repo: "unsloth/gemma-3-270m-it-GGUF",
          file: "gemma-3-270m-it-Q4_K_M.gguf",
          downloadSizeMb: 253,
          quantization: "Q4_K_M",
          maxTokens: 4096,
        },
        // Small — MBA-friendly
        {
          model: "wllama-gemma-3-1b-q4km",
          modelShortName: "Gemma 3 1B",
          shortOption: "Better",
          repo: "unsloth/gemma-3-1b-it-GGUF",
          file: "gemma-3-1b-it-Q4_K_M.gguf",
          downloadSizeMb: 806,
          quantization: "Q4_K_M",
          maxTokens: 4096,
        },
        // Medium
        {
          model: "wllama-qwen3-1_7b-q4km",
          modelShortName: "Qwen3 1.7B",
          shortOption: "Best",
          repo: "unsloth/Qwen3-1.7B-GGUF",
          file: "Qwen3-1.7B-Q4_K_M.gguf",
          downloadSizeMb: 1135,
          quantization: "Q4_K_M",
          maxTokens: 4096,
        },
        // Large — single GGUF, near the 2 GB ArrayBuffer ceiling.
        {
          model: "wllama-qwen3-1_7b-q8",
          modelShortName: "Qwen3 1.7B Q8",
          shortOption: "Power",
          repo: "unsloth/Qwen3-1.7B-GGUF",
          file: "Qwen3-1.7B-Q8_0.gguf",
          downloadSizeMb: 1830,
          quantization: "Q8_0",
          maxTokens: 4096,
        },
        // Big — reach the 4B-class via Unsloth Dynamic IQ2 (still under 2 GB).
        {
          model: "wllama-qwen3-4b-ud-iq2m",
          modelShortName: "Qwen3 4B (UD-IQ2_M)",
          shortOption: "Big",
          repo: "unsloth/Qwen3-4B-GGUF",
          file: "Qwen3-4B-UD-IQ2_M.gguf",
          downloadSizeMb: 1530,
          quantization: "UD-IQ2_M",
          maxTokens: 4096,
        },
        // Bigger — Gemma 3 4B at Q2_K (heaviest single-file variant under 2 GB).
        {
          model: "wllama-gemma-3-4b-q2k",
          modelShortName: "Gemma 3 4B (Q2_K)",
          shortOption: "Bigger",
          repo: "unsloth/gemma-3-4b-it-GGUF",
          file: "gemma-3-4b-it-Q2_K.gguf",
          downloadSizeMb: 1730,
          quantization: "Q2_K",
          maxTokens: 8192,
        },
      ],
    },
  },
  // web-llm model metadata (vramMb, maxTokens) is mutated into model objects at load time
  // from prebuiltAppConfig. See: https://github.com/mlc-ai/web-llm/blob/main/src/config.ts
  webLlm: {
    models: {
      chat: IS_MOBILE ? WEB_LLM_CHAT_MOBILE : WEB_LLM_CHAT_DESKTOP,
    },
  },
};

// Default embedding chunk size (uses the MEDIUM size from dataChunkSizes)
export const DEFAULT_EMBEDDING_CHUNK_SIZE =
  config.embeddings.dataChunkSizes.MEDIUM;

export const ALL_PROVIDERS = {
  chrome: "Chrome",
  webLlm: "web-llm",
  wllama: "wllama (GGUF)",
};

// Providers whose models we can unload from memory and delete from disk — i.e. those holding a
// page-owned engine + managing their own cache. Chrome built-in AI is OS-managed (unload/delete are
// no-ops), so it's excluded. Add future providers here as they gain unload/delete support; the UI
// (loading button, models table) reads this list to decide whether to offer those actions.
export const MEMORY_MANAGED_PROVIDERS = ["webLlm"];
export const providerManagesMemory = (provider) =>
  MEMORY_MANAGED_PROVIDERS.includes(provider);

// Providers that keep only ONE chat model resident at a time: loading a model evicts this provider's
// other resident models (single-model eviction), and default-mode loads are serialized so a second
// click caches-then-evicts instead of stacking two models in memory at once. The
// experimentalMultipleModels setting overrides this to allow stacking. Distinct from
// MEMORY_MANAGED_PROVIDERS (which is about whether unload/delete are offered) — a provider could
// manage its own memory yet still permit multiple resident models. Add future providers here as they
// gain page-owned engines that need this policy.
export const SINGLE_MODEL_PROVIDERS = ["webLlm"];
export const usesSingleModelPolicy = (provider) =>
  SINGLE_MODEL_PROVIDERS.includes(provider);

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
