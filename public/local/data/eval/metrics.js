// Programmatic eval metrics — no LLM dependency
// Pure functions for ground-truth cross-checks on RAG answers

/**
 * Extract markdown links from text.
 * @param {string} text - Answer text containing markdown links
 * @returns {Array<{ title: string, url: string }>}
 */
export const extractCitations = (text) => {
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  const citations = [];
  let match;
  while ((match = linkRegex.exec(text)) !== null) {
    citations.push({ title: match[1], url: match[2] });
  }
  return citations;
};

/**
 * Validate that citation URLs exist in the provided RAG context.
 * @param {string} answer - The LLM answer text
 * @param {string} context - The XML context string passed to the LLM
 * @returns {{ total: number, valid: number, invalid: Array<{ title: string, url: string }>, ratio: number }}
 */
export const validateCitations = (answer, context) => {
  const citations = extractCitations(answer);
  if (citations.length === 0) {
    return { total: 0, valid: 0, invalid: [], ratio: 0 };
  }

  const invalid = [];
  let valid = 0;

  for (const citation of citations) {
    if (context.includes(citation.url)) {
      valid++;
    } else {
      invalid.push(citation);
    }
  }

  return {
    total: citations.length,
    valid,
    invalid,
    ratio: citations.length > 0 ? valid / citations.length : 0,
  };
};

/**
 * Check coverage of expected topics in the answer.
 * Case-insensitive substring match.
 * @param {string} answer - The LLM answer text
 * @param {string[]} expectedTopics - Topics expected to appear
 * @returns {{ covered: string[], missing: string[], ratio: number }}
 */
export const checkTopicCoverage = (answer, expectedTopics) => {
  if (!expectedTopics || expectedTopics.length === 0) {
    return { covered: [], missing: [], ratio: 1 };
  }

  const lowerAnswer = answer.toLowerCase();
  const covered = [];
  const missing = [];

  for (const topic of expectedTopics) {
    if (lowerAnswer.includes(topic.toLowerCase())) {
      covered.push(topic);
    } else {
      missing.push(topic);
    }
  }

  return {
    covered,
    missing,
    ratio:
      expectedTopics.length > 0 ? covered.length / expectedTopics.length : 0,
  };
};

/**
 * Compute all programmatic metrics for an eval case.
 * @param {{ answer: string, context: string, expectedTopics: string[] }} params
 * @returns {{ citations: Object, topics: Object, answerLength: number }}
 */
export const computeMetrics = ({ answer, context, expectedTopics }) => {
  return {
    citations: validateCitations(answer, context),
    topics: checkTopicCoverage(answer, expectedTopics),
    answerLength: answer.length,
  };
};
