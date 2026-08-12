// Browser-side: run the app's real vector search. See ./README.md for the rules.

/**
 * Execute a retrieval-only query through the app's own search pipeline.
 *
 * Deliberately stops short of context building: buildContextFromChunks needs a provider/model to
 * resolve a token budget, so including it would drag an LLM into what is otherwise a free,
 * fully-deterministic check. That's what makes a retrieval suite cheap enough to run on every
 * commit, and it's what separates "search missed it" from "generation ignored it".
 *
 * @param {{base: string, query: string, filters: Object}} arg
 * @returns {Promise<string>} JSON string
 */
export const runSearch = async (arg) => {
  const startedAt = performance.now();
  const api = await import(`${arg.base}local/data/api/index.js`);
  const filters = arg.filters || {};

  const result = await api.search({
    query: arg.query,
    postType: filters.postType || [],
    minDate: filters.minDate || "",
    categoryPrimary: filters.categoryPrimary || [],
    verticalPrimary: filters.verticalPrimary || [],
    withContent: false,
  });

  // Ordered slugs, deduped, best-similarity-first: this is what recall and rank are computed from.
  const chunks = result.chunks || [];
  const seen = new Set();
  const rankedSlugs = [];
  for (const chunk of chunks) {
    if (seen.has(chunk.slug)) continue;
    seen.add(chunk.slug);
    rankedSlugs.push(chunk.slug);
  }

  return JSON.stringify({
    query: arg.query,
    elapsedMs: Math.round(performance.now() - startedAt),
    metadata: result.metadata || null,
    chunkCount: chunks.length,
    postCount: Object.keys(result.posts || {}).length,
    rankedSlugs,
    chunks: chunks.map((c) => ({
      slug: c.slug,
      start: c.start,
      end: c.end,
      similarity: c.similarity,
    })),
  });
};
