// LLM-as-judge for RAG eval scoring
// Uses Chrome Prompt API or web-llm to score answers on 4 dimensions

/* global LanguageModel:false */
import { checkAvailability } from "../api/providers/chrome.js";
import { createHandler as createWebLlmHandler } from "../api/providers/web-llm.js";
import { getModelCfg, CHROME_DEFAULT_TOP_K } from "../../../config.js";
import { estimateTokens } from "../util.js";

const JUDGE_SYSTEM_PROMPT = `You are an expert evaluator for a RAG (Retrieval-Augmented Generation) system. You will be given a user query, the context chunks provided to the LLM, and the LLM's answer. Score the answer on 4 dimensions using a 1-5 scale.

Scoring dimensions:
1. **Faithfulness** (1-5): Does the answer only use facts present in the context? 5 = entirely grounded, 1 = mostly hallucinated.
2. **Relevance** (1-5): Does the answer address the user's query? 5 = directly answers, 1 = off-topic.
3. **Citation Quality** (1-5): Are sources cited with valid URLs from the context? 5 = all claims cited, 1 = no citations.
4. **Completeness** (1-5): Does the answer cover the key aspects available in the context? 5 = comprehensive, 1 = superficial.

Respond with ONLY a JSON object in this exact format (no markdown fencing):
{"faithfulness":{"score":N,"reason":"..."},"relevance":{"score":N,"reason":"..."},"citationQuality":{"score":N,"reason":"..."},"completeness":{"score":N,"reason":"..."}}`;

// Reserve tokens for the judge's JSON output (~200 tokens)
const JUDGE_OUTPUT_RESERVE = 256;

/**
 * Build the judge evaluation prompt for a single case.
 * Truncates context if needed to fit within the model's context window.
 * @param {{ query: string, context: string, answer: string, maxInputTokens: number }} params
 * @returns {string}
 */
const buildJudgePrompt = ({ query, context, answer, maxInputTokens }) => {
  const wrapper = (ctx) =>
    `<QUERY>${query}</QUERY>\n\n<CONTEXT>${ctx}</CONTEXT>\n\n<ANSWER>${answer}</ANSWER>\n\nEvaluate the answer. Respond with JSON only.`;

  // If no budget constraint, return full prompt
  if (!maxInputTokens) return wrapper(context);

  const systemTokens = estimateTokens(JUDGE_SYSTEM_PROMPT);
  const queryTokens = estimateTokens(query);
  const answerTokens = estimateTokens(answer);
  const overhead = 50; // XML tags, instruction text
  const budgetForContext =
    maxInputTokens - systemTokens - queryTokens - answerTokens - overhead;

  if (budgetForContext <= 0) {
    // No room for context at all — send without it
    return wrapper("[context truncated — model context window too small]");
  }

  const contextTokens = estimateTokens(context);
  if (contextTokens <= budgetForContext) {
    return wrapper(context);
  }

  // Truncate context to fit — rough char estimate (1 token ≈ 4 chars)
  const maxChars = budgetForContext * 4;
  const truncated = context.slice(0, maxChars) + "\n[...truncated]";
  return wrapper(truncated);
};

/**
 * Try to parse judge JSON from a response string.
 * Attempts raw parse first, then regex extraction.
 * @param {string} text
 * @returns {Object|null}
 */
const parseJudgeResponse = (text) => {
  // Try direct parse
  try {
    return JSON.parse(text.trim());
  } catch {
    // noop
  }

  // Try extracting JSON from the response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      // noop
    }
  }

  return null;
};

/**
 * Validate parsed judge scores have the expected shape.
 * @param {Object} parsed
 * @returns {boolean}
 */
const validateScores = (parsed) => {
  const dims = ["faithfulness", "relevance", "citationQuality", "completeness"];
  return dims.every(
    (d) =>
      parsed[d] &&
      typeof parsed[d].score === "number" &&
      parsed[d].score >= 1 &&
      parsed[d].score <= 5,
  );
};

/**
 * Collect full response from a handler's sendMessage generator.
 * @param {AsyncGenerator} generator
 * @returns {Promise<string>}
 */
const collectResponse = async (generator) => {
  let text = "";
  for await (const event of generator) {
    if (event.type === "data") {
      text += event.content;
    }
  }
  return text;
};

/**
 * Create a judge instance for scoring RAG answers.
 *
 * @param {{ provider: string, model: string }} options
 * @returns {Promise<{ score: Function, destroy: Function }>}
 */
export const createJudge = async ({ provider, model }) => {
  const temperature = 0.1;
  const modelCfg = getModelCfg({ provider, model });
  const maxTokens = modelCfg.maxTokens ?? 4096;
  const maxOutputTokens = Math.min(
    JUDGE_OUTPUT_RESERVE,
    Math.floor(maxTokens / 4),
  );
  const maxInputTokens = maxTokens - maxOutputTokens;

  // --- Chrome: fresh LanguageModel session per case to avoid context overflow ---
  if (provider === "chrome") {
    const status = await checkAvailability("prompt");
    if (!status.available && !status.downloading) {
      throw new Error(`Chrome Prompt API not available: ${status.reason}`);
    }

    const sessionOpts = {
      topK: CHROME_DEFAULT_TOP_K,
      temperature,
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
      initialPrompts: [{ role: "system", content: JUDGE_SYSTEM_PROMPT }],
    };

    const score = async ({ query, context, answer }) => {
      const prompt = buildJudgePrompt({
        query,
        context,
        answer,
        maxInputTokens,
      });

      // Create a fresh session per case so conversation history doesn't accumulate
      const session = await LanguageModel.create(sessionOpts);

      try {
        // First attempt
        let raw = await session.prompt(prompt);
        let parsed = parseJudgeResponse(raw);

        if (parsed && validateScores(parsed)) {
          return { scores: parsed, raw };
        }

        // Retry within same session (it remembers the failed attempt)
        const retryRaw = await session.prompt(
          "Your previous response was not valid JSON. Respond with ONLY a JSON object in this exact format, no markdown fencing:\n" +
            '{"faithfulness":{"score":N,"reason":"..."},"relevance":{"score":N,"reason":"..."},"citationQuality":{"score":N,"reason":"..."},"completeness":{"score":N,"reason":"..."}}',
        );
        const retryParsed = parseJudgeResponse(retryRaw);

        if (retryParsed && validateScores(retryParsed)) {
          return { scores: retryParsed, raw: retryRaw };
        }

        return { scores: null, raw: `${raw}\n---RETRY---\n${retryRaw}` };
      } finally {
        session.destroy();
      }
    };

    return {
      score,
      destroy: () => {},
    };
  }

  // --- web-llm: stateless handler ---
  const handler = await createWebLlmHandler({
    model,
    temperature,
    maxOutputTokens,
  });

  const score = async ({ query, context, answer }) => {
    const prompt = buildJudgePrompt({
      query,
      context,
      answer,
      maxInputTokens,
    });

    const messages = [
      { role: "system", content: JUDGE_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ];

    // First attempt
    let raw = await collectResponse(handler.sendMessage(messages));
    let parsed = parseJudgeResponse(raw);

    if (parsed && validateScores(parsed)) {
      return { scores: parsed, raw };
    }

    // Retry with correction
    const retryMessages = [
      ...messages,
      { role: "assistant", content: raw },
      {
        role: "user",
        content:
          "Your response was not valid JSON. Respond with ONLY a JSON object in this exact format, no markdown fencing:\n" +
          '{"faithfulness":{"score":N,"reason":"..."},"relevance":{"score":N,"reason":"..."},"citationQuality":{"score":N,"reason":"..."},"completeness":{"score":N,"reason":"..."}}',
      },
    ];

    const retryRaw = await collectResponse(handler.sendMessage(retryMessages));
    const retryParsed = parseJudgeResponse(retryRaw);

    if (retryParsed && validateScores(retryParsed)) {
      return { scores: retryParsed, raw: retryRaw };
    }

    return { scores: null, raw: `${raw}\n---RETRY---\n${retryRaw}` };
  };

  return {
    score,
    destroy: () => handler.destroy?.(),
  };
};
