// Driver interface. Scorers and the runner depend on this shape, never on how a driver obtains it.

/**
 * @typedef {Object} TurnResult
 * @property {number} turn - 1-based
 * @property {string} query
 * @property {string} rawAnswer - exactly as streamed, <think> intact
 * @property {string} answer - user-visible answer, <think> stripped
 * @property {string} thinking - "" when none
 * @property {Array<{role: string, content: string}>|null} prompt - usage.prompt
 * @property {string|null} context - usage.context, the raw XML the model saw
 * @property {Object|null} usage
 * @property {Object|null} searchData
 * @property {Array|null} usedChunks
 * @property {Object|null} chunkTexts
 * @property {Object} retrieval - flattened retrieval summary for reporting
 * @property {Object} timings
 * @property {string|null} finishReason
 * @property {Record<string, string>} unavailable - field -> why it's missing on this driver
 * @property {Record<string, string>} provenance - field -> "observed" | "reconstructed" | "synthesized"
 */

/**
 * @typedef {Object} CaseRunSpec
 * @property {Object} evalCase
 * @property {string} provider
 * @property {string} model
 * @property {number} temperature
 * @property {boolean} enableThinking
 * @property {number} sample
 * @property {Object} timeouts
 */

/**
 * @typedef {Object} Driver
 * @property {string} name
 * @property {(model: {provider: string, model: string}, opts: Object) => Promise<Object>} ensureModel
 * @property {(spec: CaseRunSpec) => Promise<{turns: TurnResult[]}>} runCase
 */

/**
 * Ordered, deduped slugs from a searchData payload — what recall and rank are computed against.
 * @param {Object|null} searchData
 * @returns {string[]}
 */
export const rankedSlugsFrom = (searchData) => {
  const chunks = searchData?.chunks ?? [];
  const seen = new Set();
  const out = [];
  for (const chunk of chunks) {
    if (seen.has(chunk.slug)) continue;
    seen.add(chunk.slug);
    out.push(chunk.slug);
  }
  return out;
};

/**
 * Slugs that actually survived the token budget into the context the model saw.
 *
 * The difference between this and rankedSlugsFrom is the whole "retrieval failure vs budget
 * failure" distinction, so keep them separate.
 * @param {Array|null} usedChunks
 * @returns {string[]}
 */
export const usedSlugsFrom = (usedChunks) => [
  ...new Set((usedChunks ?? []).map((c) => c.slug)),
];
