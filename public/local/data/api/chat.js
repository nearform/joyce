import { getChunk } from "llm-splitter";
import { estimateTokens } from "../util.js";
import {
  getModelCfg,
  TOKEN_CUSHION_CHAT,
  getMultiTurnCushion,
  MIN_CONTEXT_CHUNKS,
  MULTI_TURN_CONTEXT_RATIO,
  CHUNK_DEDUP_MODE,
  CHUNK_COMBINE_SEPARATOR,
  THROW_ON_TOKEN_LIMIT,
} from "../../../config.js";
import { getPost } from "./posts.js";
import { buildSystemPrompt, MAX_SYSTEM_PROMPT } from "./prompts.js";

// Set to true to enable detailed token debugging in console
const DEBUG_TOKENS = false;

/**
 * Build base system prompts with RAG context.
 * Used by both OpenAI-style completions and Chrome Prompt API sessions.
 * Does NOT include the final user query - that's added separately.
 * @param {string} context - RAG context (XML chunks)
 * @param {string} [query=""] - User query for conditional prompt sections
 * @returns {Array<{role: string, content: string}>}
 */
export const buildBasePrompts = (context = "", query = "") => {
  // Extract links from context.
  const linkPattern =
    /<CHUNK><URL>([^<]+)<\/URL><TITLE>([^<]+)<\/TITLE><CONTENT>/g;
  let links = "";
  for (const match of context.matchAll(linkPattern)) {
    links += `- [${match[2]}](${match[1]})\n`;
  }

  return [
    {
      role: "system",
      content: buildSystemPrompt(query),
    },
    {
      role: "assistant",
      content: `The posts chunk content is as follows:\n\n${context}`,
    },
    {
      role: "assistant",
      content: `You may only choose links from the following list of urls from the <CHUNKS />: ${links}`,
    },
  ];
};

/**
 * Build full messages array for OpenAI-style completions.
 * Includes base prompts plus the user query.
 * @param {Object} options
 * @param {string} options.query - User's query
 * @param {string} options.context - RAG context (XML chunks)
 * @returns {Array<{role: string, content: string}>}
 */
const createMessages = ({ query, context = "" }) => [
  ...buildBasePrompts(context, query),
  {
    role: "user",
    content: query,
  },
];

// Use MAX_SYSTEM_PROMPT (all conditional sections) for token envelope estimation.
// Over-reserves ~78 tokens worst case when conditional sections don't match.
export const BASE_TOKEN_ESTIMATE = estimateTokens(
  JSON.stringify(
    createMessages({ query: "" }).map((m) =>
      m.role === "system" ? { ...m, content: MAX_SYSTEM_PROMPT } : m,
    ),
  ),
);

/**
 * Build XML context string from search chunks with token limiting.
 * @param {Object} options
 * @param {Array} options.chunks - Array of chunk objects from search
 * @param {string} options.query - User query (for token estimation)
 * @param {string} options.provider - LLM provider key
 * @param {string} options.model - Model ID
 * @param {number} [options.maxChunks] - Optional max number of chunks to include
 * @param {boolean} [options.forMultiTurn=false] - Use larger cushion for multi-turn
 * @param {boolean} [options.isFirstTurn=false] - Skip ratio on first turn to maximize initial context
 * @returns {Promise<{context: string, usedChunks: Array, chunkCount: number, chunkTexts: Object, tokenEstimate: number, tokenBreakdown: {basePromptTokens: number, queryTokens: number, chunksTokens: number, totalTokens: number}}>}
 */
export const buildContextFromChunks = async ({
  chunks,
  query,
  provider,
  model,
  maxChunks,
  forMultiTurn = false,
  isFirstTurn = false,
  maxTokens: maxTokensOverride,
}) => {
  const modelCfg = getModelCfg({ provider, model });
  const maxTokens = maxTokensOverride ?? modelCfg.maxTokens;
  const cushion = forMultiTurn
    ? getMultiTurnCushion(maxTokens)
    : TOKEN_CUSHION_CHAT;

  // For multi-turn, limit context to MULTI_TURN_CONTEXT_RATIO of available space
  // leaving the remainder for conversation history growth across turns.
  // Exception: On first turn, skip the ratio to maximize initial RAG context quality.
  const availableTokens = maxTokens - cushion;
  const applyRatio = forMultiTurn && !isFirstTurn;
  const maxContextTokens = applyRatio
    ? Math.floor(availableTokens * MULTI_TURN_CONTEXT_RATIO)
    : availableTokens;
  // TODO(ESTIMATE): These estimates determine how many chunks fit in context.
  // For Chrome, could use measureContextUsage() for actual counts, but requires
  // creating a session first. For now, estimates provide reasonable approximation.
  const queryTokens = estimateTokens(query);
  let totalContextTokensEst = BASE_TOKEN_ESTIMATE + queryTokens;

  if (DEBUG_TOKENS) {
    const tokensForChunks = maxContextTokens - totalContextTokensEst;
    // eslint-disable-next-line no-undef
    console.log(
      "DEBUG(TOKENS) buildContextFromChunks - BUDGET BREAKDOWN:",
      JSON.stringify(
        {
          model,
          forMultiTurn,
          isFirstTurn,
          applyRatio,
          maxTokens,
          cushion,
          availableTokens,
          multiTurnRatio: applyRatio
            ? MULTI_TURN_CONTEXT_RATIO
            : "N/A (skipped)",
          maxContextTokens,
          basePromptTokens: BASE_TOKEN_ESTIMATE,
          queryTokens,
          startingTotal: totalContextTokensEst,
          tokensForChunks,
          chunksAvailable: chunks.length,
          maxChunksParam: maxChunks ?? "unlimited",
        },
        null,
        2,
      ),
    );
  }

  if (totalContextTokensEst > maxContextTokens) {
    const msg = `Out of room for query (please try a new one): ${query}`;
    if (THROW_ON_TOKEN_LIMIT) {
      throw new Error(msg);
    }
    console.warn(msg); // eslint-disable-line no-undef
    // Proceed anyway - let real API error happen
  }

  const usedChunks = [];
  const chunksToProcess = maxChunks ? chunks.slice(0, maxChunks) : chunks;

  // Track context entries by slug for dedup modes
  // Each entry: { url, content, tokenCount }
  const contextEntries = [];
  const seenSlugs = new Map(); // slug -> index in contextEntries
  const chunkTexts = {}; // {slug:start:end} -> text excerpt

  for (const chunk of chunksToProcess) {
    const post = await getPost(chunk.slug);
    const chunkText = getChunk(post.content, chunk.start, chunk.end).join(
      "\n\n",
    );
    // TODO(ESTIMATE): Per-chunk estimate affects which chunks are included.
    // Use markup factor since chunks will be wrapped in XML tags
    // (<CHUNK><URL>...</URL><TITLE>...</TITLE><CONTENT>...</CONTENT></CHUNK>)
    const chunkTokensEst = estimateTokens(chunkText, true);

    // Check if we've seen this post before
    const existingIndex = seenSlugs.get(chunk.slug);

    if (existingIndex !== undefined) {
      // Handle duplicate post based on dedup mode
      if (CHUNK_DEDUP_MODE === "skip") {
        // Skip this chunk entirely
        continue;
      } else if (CHUNK_DEDUP_MODE === "combine") {
        // TODO(ESTIMATE): This estimate-based check determines context truncation
        if (totalContextTokensEst + chunkTokensEst > maxContextTokens) {
          break;
        }
        // Append to existing entry with separator
        const entry = contextEntries[existingIndex];
        entry.content += CHUNK_COMBINE_SEPARATOR + chunkText;
        totalContextTokensEst += chunkTokensEst;
        usedChunks.push(chunk);
        chunkTexts[`${chunk.slug}:${chunk.start}:${chunk.end}`] = chunkText;
        continue;
      }
      // "duplicate" mode falls through to add as new entry
    }

    // TODO(ESTIMATE): This estimate-based check determines context truncation
    if (totalContextTokensEst + chunkTokensEst > maxContextTokens) {
      if (DEBUG_TOKENS) {
        // eslint-disable-next-line no-undef
        console.log(
          `DEBUG(TOKENS) CHUNK EXCLUDED (budget exceeded):`,
          JSON.stringify({
            chunkIndex: usedChunks.length,
            slug: chunk.slug,
            chunkTokensEst,
            wouldBe: totalContextTokensEst + chunkTokensEst,
            maxContextTokens,
            over: totalContextTokensEst + chunkTokensEst - maxContextTokens,
          }),
        );
      }
      break;
    }

    // Add new context entry
    const entryIndex = contextEntries.length;
    contextEntries.push({
      url: post.href,
      title: post.title,
      content: chunkText,
    });
    seenSlugs.set(chunk.slug, entryIndex);

    // Accumulate tokens and track chunk
    totalContextTokensEst += chunkTokensEst;
    usedChunks.push(chunk);
    chunkTexts[`${chunk.slug}:${chunk.start}:${chunk.end}`] = chunkText;

    if (DEBUG_TOKENS) {
      // eslint-disable-next-line no-undef
      console.log(
        `DEBUG(TOKENS) CHUNK INCLUDED #${usedChunks.length}:`,
        JSON.stringify({
          slug: chunk.slug.slice(0, 40) + (chunk.slug.length > 40 ? "..." : ""),
          chunkTokensEst,
          runningTotal: totalContextTokensEst,
          remaining: maxContextTokens - totalContextTokensEst,
        }),
      );
    }
  }

  if (DEBUG_TOKENS) {
    // eslint-disable-next-line no-undef
    console.log(
      "DEBUG(TOKENS) buildContextFromChunks - FINAL SUMMARY:",
      JSON.stringify(
        {
          chunksIncluded: usedChunks.length,
          chunksAvailable: chunks.length,
          totalContextTokensEst,
          maxContextTokens,
          utilization: `${((totalContextTokensEst / maxContextTokens) * 100).toFixed(1)}%`,
          headroom: maxContextTokens - totalContextTokensEst,
        },
        null,
        2,
      ),
    );
  }

  // Build final context string from entries
  const context = contextEntries
    .map(
      (entry) =>
        `<CHUNK><URL>${entry.url}</URL><TITLE>${entry.title}</TITLE><CONTENT>${entry.content}</CONTENT></CHUNK>`,
    )
    .join("");

  // Calculate granular token breakdown
  const chunksTokens =
    totalContextTokensEst - BASE_TOKEN_ESTIMATE - queryTokens;

  return {
    context,
    usedChunks,
    chunkCount: usedChunks.length,
    chunkTexts,
    tokenEstimate: totalContextTokensEst,
    // Granular token breakdown for UI display
    tokenBreakdown: {
      basePromptTokens: BASE_TOKEN_ESTIMATE,
      queryTokens,
      chunksTokens,
      totalTokens: totalContextTokensEst,
    },
  };
};

/**
 * Rebuild context with a reduced number of chunks.
 * Used for dynamic context reduction in multi-turn conversations.
 * @param {Object} options
 * @param {Array} options.chunks - Original array of chunk objects from search
 * @param {string} options.query - User query (for token estimation)
 * @param {string} options.provider - LLM provider key
 * @param {string} options.model - Model ID
 * @param {number} options.targetChunkCount - Target number of chunks (will be clamped to MIN_CONTEXT_CHUNKS)
 * @returns {Promise<{context: string, usedChunks: Array, chunkCount: number, chunkTexts: Object, tokenEstimate: number, tokenBreakdown: {basePromptTokens: number, queryTokens: number, chunksTokens: number, totalTokens: number}}>}
 */
export const rebuildContextWithLimit = async ({
  chunks,
  query,
  provider,
  model,
  targetChunkCount,
  maxTokens,
}) => {
  const effectiveMax = Math.max(targetChunkCount, MIN_CONTEXT_CHUNKS);
  return buildContextFromChunks({
    chunks,
    query,
    provider,
    model,
    maxChunks: effectiveMax,
    forMultiTurn: true,
    isFirstTurn: false, // Context reduction happens after first turn
    maxTokens,
  });
};

if (DEBUG_TOKENS) {
  // eslint-disable-next-line no-undef
  console.log(
    "DEBUG(TOKENS) chat.js - BASE_TOKEN_ESTIMATE:",
    BASE_TOKEN_ESTIMATE,
  );
}
