import { prebuiltAppConfig } from "@mlc-ai/web-llm";
import config, { CHAT_MODELS_MAP } from "./shared-config.js";

export * from "./shared-config.js";

// ======================================================
// Dynamic model configuration
// ======================================================
// https://github.com/mlc-ai/web-llm/blob/main/src/config.ts
// Quantization formats: q{bits}f{float_bits}[_{version}]
// e.g., q4f16_1 = 4-bit quantization with float16, q0f32 = full precision float32
const QUANTIZATION_REGEX = /q\d+f\d+(?:_\d+)?/;

// ======================================================
// Model reference data
// ======================================================

// Models we deliberately hide from the picker and the models table because they don't work in our
// setup (filtered out of MODELS below).
// - gemma3-1b-it-q4f16_1-MLC: web-llm 0.2.83's only gemma3 build can't serve RAG. Its wasm is
//   compiled for sliding-window attention (sliding_window_size 512), so forcing full attention
//   (context_window_size 4096) produces gibberish, while sliding mode caps usable context at ~512
//   tokens — far smaller than our injected RAG context. No larger/fixed gemma3 build exists in
//   0.2.83. https://github.com/mlc-ai/web-llm/issues/478
//   https://huggingface.co/mlc-ai/gemma3-1b-it-q4f16_1-MLC/raw/main/mlc-chat-config.json
const BLOCKED_MODELS = new Set(["gemma3-1b-it-q4f16_1-MLC"]);

// Approximate public release (YYYY-MM) per model family, shown in the models table "Released" column.
// Matched as a prefix against the web-llm model_id; ordered most-specific-first so "Qwen3.5" beats
// "Qwen3" and "Llama-3.2" beats "Llama-3". Unmatched ids render as "—".
const RELEASE_DATES = [
  ["Qwen3.5", "2026-02"],
  ["Qwen3", "2025-04"],
  ["Qwen2.5", "2024-09"],
  ["Qwen2", "2024-06"],
  ["Llama-3.2", "2024-09"],
  ["Llama-3.1", "2024-07"],
  ["Llama-3-", "2024-04"],
  ["Llama-2", "2023-07"],
  ["gemma3", "2025-03"],
  ["gemma-2b", "2024-02"],
  ["gemma-2-", "2024-06"],
  ["Phi-4", "2025-02"],
  ["Phi-3.5", "2024-08"],
  ["Phi-3", "2024-04"],
  ["phi-2", "2023-12"],
  ["phi-1_5", "2023-09"],
  ["SmolLM2", "2024-11"],
  ["DeepSeek-R1", "2025-01"],
  ["OLMo-2-0425", "2025-04"],
  ["OLMo-2-1124", "2024-11"],
  ["Ministral-3", "2025-12"],
  ["Mistral-7B-Instruct-v0.2", "2023-12"],
  ["Mistral-7B", "2024-05"],
  ["Hermes-3", "2024-08"],
  ["Hermes-2", "2024-03"],
  ["OpenHermes", "2023-11"],
  ["NeuralHermes", "2023-12"],
  ["WizardMath", "2023-08"],
  ["TinyLlama", "2023-12"],
  ["stablelm-2", "2024-01"],
  ["RedPajama", "2023-05"],
  ["snowflake-arctic-embed", "2024-04"],
];

/**
 * Approximate release date (YYYY-MM) for a web-llm model id, or null if unknown.
 * @param {string} modelId
 * @returns {string | null}
 */
export const getModelReleaseDate = (modelId = "") =>
  RELEASE_DATES.find(([prefix]) => modelId.startsWith(prefix))?.[1] ?? null;

// Mutate web-llm models to include metadata from prebuiltAppConfig
for (const modelObj of config.webLlm.models.chat) {
  const found = prebuiltAppConfig.model_list.find(
    (m) => m.model_id === modelObj.model,
  );
  if (found) {
    modelObj.maxTokens = found.overrides?.context_window_size ?? null;
    modelObj.vramMb = found.vram_required_MB ?? null;
    modelObj.quantization =
      found.model_id.match(QUANTIZATION_REGEX)?.[0] ?? null;
  }
}

// ======================================================
// Helper functions
// ======================================================
export const MODELS = prebuiltAppConfig.model_list
  .filter((model) => !BLOCKED_MODELS.has(model.model_id))
  .map((model) => ({
    model: model.model_id,
    modelUrl: model.model,
    quantization: model.model_id.match(QUANTIZATION_REGEX)?.[0] ?? null,
    maxTokens: model.overrides?.context_window_size ?? null,
    vramMb: model.vram_required_MB ?? null,
    released: getModelReleaseDate(model.model_id),
  }))
  .sort((a, b) => (a.vramMb ?? 0) - (b.vramMb ?? 0));

/**
 * Dynamically add a model to the chat models list (session only, not persisted).
 * Used when loading unconfigured models from the models table.
 * @param {string} provider - The provider key (e.g., "webLlm", "chrome")
 * @param {string} modelId - The model ID to add
 * @returns {Object} The model config object (existing or newly created)
 */
export const addChatModel = (provider, modelId) => {
  // Check if already exists
  const providerConfig = config[provider];
  if (!providerConfig) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const existing = providerConfig.models.chat.find((m) => m.model === modelId);
  if (existing) return existing;

  // Look up metadata from prebuiltAppConfig (web-llm specific)
  const prebuilt =
    provider === "webLlm"
      ? prebuiltAppConfig.model_list.find((m) => m.model_id === modelId)
      : null;

  // Create new model config
  const newModel = {
    model: modelId,
    modelShortName: modelId.split("-q")[0], // Strip quantization suffix for short name
    autoLoad: false,
    maxTokens: prebuilt?.overrides?.context_window_size ?? null,
    vramMb: prebuilt?.vram_required_MB ?? null,
    quantization: modelId.match(QUANTIZATION_REGEX)?.[0] ?? null,
  };

  // Add to config array (ALL_CHAT_MODELS references this, so it auto-updates)
  providerConfig.models.chat.push(newModel);

  // Update CHAT_MODELS_MAP
  if (!CHAT_MODELS_MAP[provider]) {
    CHAT_MODELS_MAP[provider] = {};
  }
  CHAT_MODELS_MAP[provider][modelId] = newModel;

  return newModel;
};

export default config;
