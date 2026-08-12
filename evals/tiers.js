// Model capability tiers.
//
// Thresholds key off a tier rather than a model id, because per-model tables rot the moment
// Qwen3.5-4B becomes Qwen4-4B, and a 60-case x 5-model threshold matrix is unreviewable.
//
// The known-model table is a convenience, not a requirement: any model the table doesn't recognise
// falls back to its actual context window, which the app reports at runtime. That's what lets a new
// provider (LiteRT.js, wllama) be evaluated with no harness change.

/** Weakest to strongest. Threshold resolution walks *up* this ladder for defaults. */
export const TIER_ORDER = Object.freeze(["tiny", "small", "mid", "large"]);

const KNOWN_TIERS = Object.freeze({
  // shared-config.js notes SmolLM2-360M is below the floor for grounded RAG regardless of prompt.
  "SmolLM2-360M-Instruct-q4f16_1-MLC": "tiny",
  "TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC": "tiny",
  "Llama-3.2-1B-Instruct-q4f16_1-MLC": "tiny",
  "Qwen3.5-2B-q4f16_1-MLC": "small",
  "Qwen3.5-4B-q4f16_1-MLC": "mid",
  "gemini-nano-prompt": "mid",
  // The Writer API is single-turn and biased toward short output, so it behaves a tier below the
  // Prompt API even though the underlying model is the same.
  "gemini-nano-writer": "small",
});

/**
 * Capability tier for a model.
 *
 * @param {{model: string, maxTokens?: number}} modelInfo
 * @returns {string} one of TIER_ORDER
 */
export const getTier = ({ model, maxTokens }) => {
  if (KNOWN_TIERS[model]) return KNOWN_TIERS[model];
  if (!Number.isFinite(maxTokens)) return "mid";
  if (maxTokens < 2560) return "tiny";
  if (maxTokens < 4096) return "small";
  if (maxTokens < 16384) return "mid";
  return "large";
};

/**
 * Whether a model lands on the app's LEAN prompt tier, which drops CITATION_EXAMPLE,
 * URL_NORMALIZATION, and the conditional topic sections. Mirrors isLeanTier in
 * public/local/data/api/prompts.js, but reads the constant from the Node-safe shared config so the
 * two cannot drift.
 *
 * @param {number} maxTokens
 * @param {number} leanMaxTokens - LEAN_PROMPT_MAX_TOKENS from shared-config.js
 * @returns {boolean}
 */
export const isLeanTier = (maxTokens, leanMaxTokens) =>
  Number.isFinite(maxTokens) && maxTokens < leanMaxTokens;
