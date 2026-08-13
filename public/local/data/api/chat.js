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
import { extractAllowedLinks, formatAllowedLinks } from "./links.js";
import {
  buildSystemPrompt,
  MAX_SYSTEM_PROMPT,
  LEAN_SYSTEM_PROMPT,
  isLeanTier,
} from "./prompts.js";

// Set to true to enable detailed token debugging in console
const DEBUG_TOKENS = false;

// Short reminder appended to the user turn for recency — small models weight the last tokens most.
// The UI stores the raw query separately, so the displayed question is unaffected.
export const USER_CITATION_REMINDER =
  "\n\n(Cite sources inline from the allowed links only — each at most once, never repeated. If none are relevant, say you don't have enough information; never invent a source.)";

/**
 * Append the citation recency reminder to a user message.
 * @param {string} query - The user's message
 * @returns {string}
 */
export const withCitationReminder = (query) =>
  `${query}${USER_CITATION_REMINDER}`;

/**
 * Build base system prompts with RAG context.
 * Used by both OpenAI-style completions and Chrome Prompt API sessions.
 * Does NOT include the final user query - that's added separately.
 * @param {string} context - RAG context (XML chunks)
 * @param {string} [query=""] - User query for conditional prompt sections
 * @param {Object} [options]
 * @param {number} [options.maxTokens] - Model context window; selects LEAN vs FULL system prompt
 * @returns {Array<{role: string, content: string}>}
 */
export const buildBasePrompts = (
  context = "",
  query = "",
  { maxTokens } = {},
) => {
  // Extract links from context, one entry per unique URL. Identical titles across different URLs
  // get a slug hint appended so no two allowed links share link text (e.g. two PUMA posts with the
  // same title). Lives in links.js so the eval harness can derive the identical list rather than
  // maintaining a second copy of the rule.
  const links = formatAllowedLinks(extractAllowedLinks(context));

  // Only mandate a citation when links actually exist; otherwise an impossible instruction
  // invites hallucinated sources. With no links, steer toward the "not enough info" path.
  const linkDirective = links
    ? `These are the ONLY links you may cite, each at most once and inline where it fits. You MUST cite at least one. Use the exact link text shown:\n${links}`
    : `No sources were retrieved for this question. Do NOT cite or invent any links — tell the user you don't have enough information to answer.`;

  return [
    {
      role: "system",
      content: buildSystemPrompt(query, { maxTokens }),
    },
    {
      role: "assistant",
      content: `The posts chunk content is as follows:\n\n${context}`,
    },
    {
      role: "assistant",
      content: linkDirective,
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
    content: withCitationReminder(query),
  },
];

// Base-prompt token envelope, estimated per tier by overriding the system message with the
// corresponding worst-case system prompt. FULL uses MAX_SYSTEM_PROMPT (all conditional sections);
// LEAN uses LEAN_SYSTEM_PROMPT. buildContextFromChunks picks the estimate matching the model's tier.
const estimateBaseTokens = (systemPrompt) =>
  estimateTokens(
    JSON.stringify(
      createMessages({ query: "" }).map((m) =>
        m.role === "system" ? { ...m, content: systemPrompt } : m,
      ),
    ),
  );

export const BASE_TOKEN_ESTIMATE = estimateBaseTokens(MAX_SYSTEM_PROMPT);
export const LEAN_BASE_TOKEN_ESTIMATE = estimateBaseTokens(LEAN_SYSTEM_PROMPT);

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
}) => {
  const modelCfg = getModelCfg({ provider, model });
  const maxTokens = modelCfg.maxTokens;
  // Budget chunks against the base prompt this model actually gets (LEAN vs FULL).
  const baseTokenEstimate = isLeanTier(maxTokens)
    ? LEAN_BASE_TOKEN_ESTIMATE
    : BASE_TOKEN_ESTIMATE;
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
  let totalContextTokensEst = baseTokenEstimate + queryTokens;

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
          basePromptTokens: baseTokenEstimate,
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
  const chunksTokens = totalContextTokensEst - baseTokenEstimate - queryTokens;

  return {
    context,
    usedChunks,
    chunkCount: usedChunks.length,
    chunkTexts,
    tokenEstimate: totalContextTokensEst,
    // Granular token breakdown for UI display
    tokenBreakdown: {
      basePromptTokens: baseTokenEstimate,
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
  });
};

if (DEBUG_TOKENS) {
  // eslint-disable-next-line no-undef
  console.log(
    "DEBUG(TOKENS) chat.js - BASE_TOKEN_ESTIMATE (full / lean):",
    BASE_TOKEN_ESTIMATE,
    LEAN_BASE_TOKEN_ESTIMATE,
  );
}
