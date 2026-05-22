// RAG (Retrieval-Augmented Generation) - Search + Context Building
// Combines search and context building into a single operation

import { search } from "./search.js";
import { buildContextFromChunks, rebuildContextWithLimit } from "./chat.js";
import { searchResultsToPosts } from "../../../app/data/util.js";
import { MIN_CONTEXT_CHUNKS } from "../../../config.js";

/**
 * Perform RAG search and build context for LLM.
 *
 * @param {Object} options
 * @param {string} options.query - User's query
 * @param {Object} options.filters - Search filters
 * @param {string[]} options.filters.postType - Post types to filter
 * @param {string} options.filters.minDate - Minimum date filter
 * @param {string[]} options.filters.categoryPrimary - Categories to filter
 * @param {string[]} options.filters.verticalPrimary - Verticals to filter
 * @param {string} options.provider - LLM provider
 * @param {string} options.model - Model ID
 * @param {boolean} options.supportsMultiTurn - Whether model supports multi-turn
 * @returns {Promise<{ searchData: Object, contextState: Object }>}
 */
export const performRagSearch = async ({
  query,
  filters = {},
  provider,
  model,
  supportsMultiTurn,
}) => {
  const startTime = Date.now();

  // Step 1: RAG search
  const searchResults = await search({
    query,
    postType: filters.postType ?? [],
    minDate: filters.minDate ?? "",
    categoryPrimary: filters.categoryPrimary ?? [],
    verticalPrimary: filters.verticalPrimary ?? [],
    withContent: false,
  });

  const { posts, chunks, metadata } = searchResults;
  metadata.elapsed.search = Date.now() - startTime;

  // Step 2: Build context from chunks
  const contextResult = await buildContextFromChunks({
    chunks,
    query,
    provider,
    model,
    forMultiTurn: supportsMultiTurn,
    isFirstTurn: true,
  });

  // Enrich metadata with context info
  metadata.context = contextResult.context;
  metadata.contextChunkCount = contextResult.chunkCount;
  metadata.contextTokenEstimate = contextResult.tokenEstimate;
  metadata.contextTokens = contextResult.tokenBreakdown;

  // Build search data for UI
  const searchData = {
    posts,
    chunks,
    metadata,
    displayPosts: searchResultsToPosts({ posts, chunks }),
  };

  // Build context state for session
  const contextState = {
    context: contextResult.context,
    chunkCount: contextResult.chunkCount,
    tokenBreakdown: contextResult.tokenBreakdown,
    rawChunks: chunks,
    usedChunks: contextResult.usedChunks,
    chunkTexts: contextResult.chunkTexts,
    initialQuery: query,
  };

  return { searchData, contextState };
};

/**
 * Reduce context by rebuilding with fewer chunks.
 *
 * @param {Object} options
 * @param {Object} options.contextState - Current context state
 * @param {string} options.provider - LLM provider
 * @param {string} options.model - Model ID
 * @returns {Promise<Object|null>} New context state or null if reduction not possible
 */
export const reduceContext = async ({ contextState, provider, model }) => {
  const { rawChunks, chunkCount, initialQuery } = contextState;

  if (!rawChunks?.length || chunkCount <= MIN_CONTEXT_CHUNKS) {
    return null;
  }

  const targetChunks = Math.max(Math.floor(chunkCount / 2), MIN_CONTEXT_CHUNKS);

  try {
    const result = await rebuildContextWithLimit({
      chunks: rawChunks,
      query: initialQuery,
      provider,
      model,
      targetChunkCount: targetChunks,
    });

    return {
      context: result.context,
      chunkCount: result.chunkCount,
      tokenBreakdown: result.tokenBreakdown,
      rawChunks,
      initialQuery,
    };
  } catch (err) {
    console.warn("Failed to reduce context:", err); // eslint-disable-line no-undef
    return null;
  }
};
