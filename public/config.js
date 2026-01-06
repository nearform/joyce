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
  .map((model) => ({
    model: model.model_id,
    modelUrl: model.model,
    quantization: model.model_id.match(QUANTIZATION_REGEX)?.[0] ?? null,
    maxTokens: model.overrides?.context_window_size ?? null,
    vramMb: model.vram_required_MB ?? null,
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
