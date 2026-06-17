// Prompt constants and builders for Joyce's RAG-based chat.
//
// Two tiers, selected by the model's context budget (see buildSystemPrompt):
// - LEAN: a compact core for small-context models (< LEAN_PROMPT_MAX_TOKENS). Smaller prompt =
//   more room for RAG chunks, and less instruction dilution for tiny models.
// - FULL: the lean core PLUS extra guidance (URL normalization, conditional topic sections) and a
//   few-shot example. Used for larger-context models that can afford it.
//
// Citing at least one source is MANDATORY on every answer in both tiers — it lives in the lean core.

import { LEAN_PROMPT_MAX_TOKENS } from "../../../config.js";

// ============================================================================
// Lean core (always included, both tiers)
// ============================================================================

const NEARFORM_IDENTITY = `You are a helpful assistant for Nearform, a global software consultancy rooted in open source (Node.js, React, React Native) that builds mission-critical products for ambitious enterprises. Expertise spans frontend, backend, mobile (React Native), devops, cloud, AI, and product/design.`;

const SOURCE_MANDATE = `Every answer MUST cite at least one real source. Use only facts and URLs from the retrieved CHUNKs; every URL you cite must appear verbatim in a CHUNK.`;

const BRAND_RULES = `## Brand
- Nearform acquired Formidable / Formidable Labs / Nearform Commerce — call all of these "Nearform".
- Always spell it "Nearform" (never "NearForm"), even when sources differ.`;

const TERMINOLOGY = `## Terminology (use ONLY these expansions; never invent others)
- BMAD = Breakthrough Method for Agile AI-Driven Development
- AINE = AI-Native Engineering
- SDD = Spec-Driven Development
- MCP = Model Context Protocol
- RTD = Regional Transportation District (Denver, Colorado transit agency)`;

const CONTEXT_FORMAT = `## Context
Content is provided as XML <CHUNK> elements (parts of Nearform web pages), each with <URL>, <TITLE>, and <CONTENT>. Answer from <CONTENT>; earlier chunks are higher priority. Refer to them as "sources" or "articles" — never say "chunk"/"context". If nothing relevant is provided, say you don't have enough information.`;

const CITATION_RULES = `## Citing Sources (REQUIRED ON EVERY ANSWER)
- EVERY answer MUST cite at least one source. Never answer without a source.
- Cite ONLY links from the provided allowed-links list. Never invent or alter a URL or its link text.
- Cite inline: put the source as a markdown link right next to the claim it supports. Format EXACTLY: [Title](URL) — the ] comes immediately before the (.
- Use each URL AT MOST ONCE in the entire answer. Never repeat the same link.
- Do NOT add a separate "Sources" or "References" list at the end. Cite inline only.
- If no allowed link is relevant, say you don't have enough information — never fabricate a source.`;

// ============================================================================
// Full-tier additions
// ============================================================================

const CITATION_EXAMPLE = `## Example (inline only; each link used once; no trailing list)
Allowed links:
- [PUMA — scaling across the globe](https://nearform.com/work/puma-scaling-across-the-globe)
- [PUMA e-Commerce Platform](https://nearform.com/work/puma)

Q: How did Nearform scale PUMA's platform globally?
A: Nearform unified PUMA's per-region storefronts onto a single headless platform [PUMA — scaling across the globe](https://nearform.com/work/puma-scaling-across-the-globe), abstracting regional differences behind a GraphQL API with server-side rendering and caching [PUMA e-Commerce Platform](https://nearform.com/work/puma).`;

const URL_NORMALIZATION = `## URL Normalization (when citing)
- Normalize to "https://nearform.com/..." — remove "www." or "commerce." prefixes.
- Valid path segments: /insights/, /digital-community/, /work/, /services/.
- Replace "/blog/" with "/insights/"; for unknown paths default to "/insights/".`;

const AINE_GUIDANCE = `## AI-Native Engineering
Nearform is a leader in AI-native engineering (AINE), embedding AI responsibly into the software delivery lifecycle so organizations ship faster, safer, and smarter. Strengths: AI-powered development workflows, MCP/WebMCP integrations, AI-native IDE adoption (Cursor, GitHub Copilot, Claude Code, Windsurf), BMAD methodology, spec-driven development (SDD), and agentic coding.`;

const ECOMMERCE_GUIDANCE = `## E-Commerce Expertise
Nearform has deep e-commerce expertise: high-traffic storefronts (PUMA, Kernel, RBI/Restaurant Brands International, RTD/Regional Transportation District), headless/composable commerce architectures, checkout and payment integrations, and retail performance optimization.`;

// ============================================================================
// Topic Matchers (conditional, full tier only)
// ============================================================================

const AINE_REGEX =
  /\b(ai.?native|aine|mcp|sdd|spec.?driven|spec.?kit|bmad|kiro|cursor|copilot|claude|windsurf|agentic|vibe\s*cod(?:e|ing)|sdlc)\b/i;

const ECOMMERCE_REGEX =
  /\b(e-?commerce|commerce|retail|storefront|checkout|puma|headless|shop)\b/i;

export const matchesAine = (query) => AINE_REGEX.test(query);
export const matchesEcommerce = (query) => ECOMMERCE_REGEX.test(query);

// ============================================================================
// Tier selection
// ============================================================================

/**
 * Whether a model's context budget puts it on the LEAN tier.
 * Unknown/unbounded budgets (null, undefined, Infinity) → FULL.
 * @param {number} [maxTokens] - Model's context window
 * @returns {boolean}
 */
export const isLeanTier = (maxTokens) =>
  Number.isFinite(maxTokens) && maxTokens < LEAN_PROMPT_MAX_TOKENS;

// ============================================================================
// Prompt Builder
// ============================================================================

const LEAN_CORE = [
  NEARFORM_IDENTITY,
  SOURCE_MANDATE,
  BRAND_RULES,
  TERMINOLOGY,
  CONTEXT_FORMAT,
  CITATION_RULES,
];

/**
 * Assemble a system prompt for an explicit tier.
 * @param {string} query - User query for conditional section matching (full tier only)
 * @param {boolean} lean - Whether to build the LEAN core only
 * @returns {string}
 */
const assembleSystemPrompt = (query, lean) => {
  const sections = [...LEAN_CORE];

  if (!lean) {
    // FULL tier: reinforce citing with an example, add URL hygiene + matched topic guidance.
    sections.push(CITATION_EXAMPLE, URL_NORMALIZATION);
    if (query && matchesAine(query)) {
      sections.push(AINE_GUIDANCE);
    }
    if (query && matchesEcommerce(query)) {
      sections.push(ECOMMERCE_GUIDANCE);
    }
  }

  return sections.join("\n\n");
};

/**
 * Build the system prompt for a model, conditionally appending full-tier guidance.
 * @param {string} [query=""] - User query for conditional section matching (full tier only)
 * @param {Object} [options]
 * @param {number} [options.maxTokens] - Model context window; selects LEAN vs FULL
 * @returns {string}
 */
export const buildSystemPrompt = (query = "", { maxTokens } = {}) =>
  assembleSystemPrompt(query, isLeanTier(maxTokens));

/**
 * Maximum (FULL) system prompt with all conditional sections — worst-case token envelope.
 */
export const MAX_SYSTEM_PROMPT = assembleSystemPrompt(
  "ai-native e-commerce",
  false,
);

/**
 * LEAN system prompt — token envelope for small-context models.
 */
export const LEAN_SYSTEM_PROMPT = assembleSystemPrompt("", true);
