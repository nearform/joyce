/**
 * Build queryInfo object for display in Answer component.
 *
 * Transforms raw usage/metadata from chat session into structured format
 * for QueryInfo component. Handles both initial queries (with search metadata)
 * and follow-up queries (usage only).
 *
 * @param {Object} options
 * @param {Object} options.usage - Usage data from chat session
 * @param {number} options.usage.inputTokens - Input tokens used
 * @param {number} options.usage.outputTokens - Output tokens used
 * @param {number} [options.usage.totalTokens] - Total conversation tokens
 * @param {number} [options.usage.available] - Available tokens remaining
 * @param {number} [options.usage.limit] - Token limit for model
 * @param {Object} [options.usage.elapsed] - Timing information
 * @param {number} [options.usage.turnNumber] - Current turn number
 * @param {Object} [options.usage.contextTokens] - Context token breakdown
 * @param {Array} [options.usage.prompt] - Full prompt messages
 * @param {string} [options.usage.context] - Raw context string
 * @param {string} options.finishReason - Model finish reason
 * @param {Object} options.modelObj - Model configuration
 * @param {string} options.modelObj.model - Model ID
 * @param {string} options.modelObj.provider - Provider name
 * @param {Object} [options.searchMetadata] - Search metadata (first query only)
 * @param {Object} [options.searchMetadata.elapsed] - Search timing
 * @param {Object} [options.searchMetadata.internal] - Internal search details
 * @param {Object} [options.searchMetadata.chunks] - Chunk similarity stats
 * @param {Array} [options.chunks] - Chunks used in context (first query only)
 * @returns {Object} Structured queryInfo for Answer component
 */
export const buildQueryInfo = ({
  usage,
  finishReason,
  modelObj,
  searchMetadata = null,
  chunks = null,
}) => {
  return {
    // Usage tokens (per-turn and cumulative)
    usage: usage
      ? {
          input: {
            tokens: usage.inputTokens,
            cachedTokens: 0, // Not currently tracked
          },
          output: {
            tokens: usage.outputTokens,
            reasoningTokens: 0, // Not currently tracked
          },
          totalTokens: usage.totalTokens,
          available: usage.available,
          limit: usage.limit,
        }
      : null,

    // Timing information (prefer usage timing, fallback to search timing)
    elapsed: usage?.elapsed ?? searchMetadata?.elapsed ?? null,

    // Turn number (from usage or infer 1 for first query with search)
    turnNumber: usage?.turnNumber ?? (searchMetadata ? 1 : null),

    // Internal search details (only present for first query)
    internal: searchMetadata?.internal ?? null,

    // Model information
    model: modelObj.model,
    provider: modelObj.provider,

    // Finish reason (stop, length, etc.)
    finishReason,

    // Chunk information (only present for first query)
    chunks:
      chunks && chunks.length > 0
        ? {
            numChunks: chunks.length,
            similarityMin: searchMetadata?.chunks?.similarity?.min ?? null,
            similarityMax: searchMetadata?.chunks?.similarity?.max ?? null,
            similarityAvg: searchMetadata?.chunks?.similarity?.avg ?? null,
          }
        : null,

    // Context token breakdown (for developer mode display)
    context: usage?.contextTokens ?? null,

    // Raw data for inspection links
    prompt: usage?.prompt ?? null,
    rawContext: usage?.context ?? null,
  };
};
