// LLM Provider Aggregator
// Routes to provider-specific implementations based on provider parameter
import * as webLlm from "./providers/web-llm.js";
import * as chrome from "./providers/chrome.js";
import { DEFAULT_CHAT_MODEL } from "../../../config.js";

const PROVIDERS = {
  webLlm,
  chrome,
};

/**
 * Get the provider module for a given provider key
 * @param {string} provider - The provider key (e.g., "webLlm", "chrome")
 * @returns {Object} The provider module
 */
const getProvider = (provider) => {
  const providerModule = PROVIDERS[provider];
  if (!providerModule) {
    throw new Error(`Unknown LLM provider: ${provider}`);
  }
  return providerModule;
};

/**
 * Set a progress callback for a specific model
 * @param {string} provider - The provider key
 * @param {string} model - The model ID
 * @param {Function} cb - Progress callback function
 */
export const setLlmProgressCallback = (provider, model, cb) => {
  getProvider(provider).setLlmProgressCallback(model, cb);
};

/**
 * Get or create an LLM engine for a specific model
 * @param {Object} params - Parameters
 * @param {string} params.provider - The provider key
 * @param {string} params.model - The model ID
 * @returns {Promise<Object>} The engine instance (provider-specific)
 */
export const getLlmEngine = async ({
  provider = DEFAULT_CHAT_MODEL.provider,
  model = DEFAULT_CHAT_MODEL.model,
} = {}) => {
  return getProvider(provider).getLlmEngine(model);
};

/**
 * Check if a model is cached
 * @param {string} provider - The provider key
 * @param {string} model - The model ID
 * @returns {Promise<boolean>} Whether the model is cached
 */
export const isLlmCached = async (provider, model) => {
  return getProvider(provider).isLlmCached(model);
};

/**
 * Get capabilities for a specific provider and model.
 * Capabilities are defined in provider implementations (single source of truth).
 * @param {string} provider - The provider key (e.g., "webLlm", "chrome")
 * @param {string} model - The model ID
 * @returns {{ supportsMultiTurn: boolean, supportsTokenTracking: boolean }}
 */
export const getProviderCapabilities = (provider, model) => {
  return getProvider(provider).getCapabilities(model);
};
