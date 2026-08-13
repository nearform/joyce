// Allowed-link derivation from the RAG context XML.
//
// Extracted from chat.js so the eval harness can compute the *exact* same allowed-link list the
// model was shown, without duplicating the logic. Two copies of a regex like this drift, and when
// they do the evals quietly start grading against a different rule than the app enforces.
//
// Deliberately dependency-free (no config.js, no llm-splitter), so it is importable from Node as
// well as the browser.

/** Matches the leading tags of each context chunk. Mirrors buildContextFromChunks' output. */
export const CHUNK_LINK_PATTERN =
  /<CHUNK><URL>([^<]+)<\/URL><TITLE>([^<]+)<\/TITLE><CONTENT>/g;

/**
 * Human-readable hint derived from a URL's last path segment, used to disambiguate
 * identical titles ("puma-design-system" -> "puma design system").
 * @param {string} url
 * @returns {string}
 */
export const slugHint = (url) =>
  url.replace(/\/+$/, "").split("/").pop().replace(/[-_]+/g, " ").trim();

/**
 * Derive the allowed-link list from a context string, one entry per unique URL.
 *
 * Titles that collide across different URLs get a slug hint appended, so no two allowed links
 * share link text (e.g. two PUMA posts that happen to share a title). The `label` is what the
 * model is told to use verbatim — scorers must compare citation text against `label`, never
 * against the raw post title.
 *
 * @param {string} context - RAG context (XML chunks)
 * @returns {Array<{url: string, title: string, label: string}>}
 */
export const extractAllowedLinks = (context = "") => {
  const seenUrls = new Set();
  /** @type {Array<{url: string, title: string}>} */
  const entries = [];
  for (const match of context.matchAll(CHUNK_LINK_PATTERN)) {
    const [, url, title] = match;
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);
    entries.push({ url, title });
  }

  const titleCounts = entries.reduce((counts, { title }) => {
    counts[title] = (counts[title] ?? 0) + 1;
    return counts;
  }, /** @type {Record<string, number>} */ ({}));

  return entries.map(({ url, title }) => ({
    url,
    title,
    label: titleCounts[title] > 1 ? `${title} — ${slugHint(url)}` : title,
  }));
};

/**
 * Render allowed links as the markdown list shown to the model.
 * @param {Array<{url: string, label: string}>} links
 * @returns {string}
 */
export const formatAllowedLinks = (links) =>
  links.map(({ url, label }) => `- [${label}](${url})`).join("\n");
