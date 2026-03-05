/* global console:false */
// Eval runner — orchestrates RAG eval across test cases
// Async generator yielding progress events. Zero React/DOM deps.

import { createChatSession } from "../api/chat-session.js";
import { computeMetrics } from "./metrics.js";
import { createJudge } from "./judge.js";
import { saveRun } from "./results.js";
import { FEATURES } from "../../../config.js";

const log = FEATURES.evalLog
  ? (...args) => console.log("[eval]", ...args)
  : () => {};

/**
 * Run eval across a set of test cases.
 *
 * @param {Object} options
 * @param {{ provider: string, model: string }} options.subject - Subject model to evaluate
 * @param {{ provider: string, model: string }} options.judge - Judge model for LLM scoring
 * @param {Array} options.cases - Array of test case objects from eval-dataset.json
 * @param {number} options.temperature - Temperature for subject model
 * @yields {{ type: "progress"|"case_result"|"done", ... }}
 */
export async function* runEval({ subject, judge, cases, temperature }) {
  const total = cases.length;
  const results = [];

  // Create judge session (reused across all cases)
  yield {
    type: "progress",
    caseId: null,
    step: "init",
    message: "Creating judge session...",
  };

  log("Starting eval run", { subject, judge, temperature, totalCases: total });

  let judgeInstance;
  try {
    judgeInstance = await createJudge(judge);
    log("Judge session created", judge);
  } catch (err) {
    yield {
      type: "progress",
      caseId: null,
      step: "judge_error",
      message: `Failed to create judge: ${err.message}`,
    };
    return;
  }

  try {
    for (let i = 0; i < cases.length; i++) {
      const testCase = cases[i];
      const { id, query, expectedTopics, filters } = testCase;

      yield {
        type: "progress",
        caseId: id,
        step: "rag",
        message: `[${i + 1}/${total}] Running RAG for: ${query}`,
        index: i,
        total,
      };

      log(`--- Case ${i + 1}/${total}: ${id} ---`);
      log("Query:", query);

      let answer = "";
      let context = "";
      let searchData = null;

      // Create subject chat session
      const session = createChatSession({
        provider: subject.provider,
        model: subject.model,
        temperature,
      });

      try {
        // Run RAG + collect streamed answer
        for await (const event of session.start(query, filters || {})) {
          if (event.type === "search") {
            searchData = event.message;
          } else if (event.type === "data") {
            answer += event.message;
          }
        }

        log("Answer:", answer);

        // Use the actual XML context the LLM received (built by RAG pipeline)
        if (searchData?.metadata?.context) {
          context = searchData.metadata.context;
          log(
            "Context chunks:",
            searchData.metadata.contextChunkCount,
            "tokens:",
            searchData.metadata.contextTokenEstimate,
          );
        }
      } catch (err) {
        log("Error:", err.message);
        yield {
          type: "case_result",
          caseId: id,
          result: {
            id,
            query,
            error: err.message,
            answer: null,
            metrics: null,
            judgeScores: null,
          },
        };
        results.push({
          id,
          query,
          error: err.message,
          answer: null,
          metrics: null,
          judgeScores: null,
        });
        session.destroy();
        continue;
      }

      session.destroy();

      // Compute programmatic metrics
      yield {
        type: "progress",
        caseId: id,
        step: "metrics",
        message: `[${i + 1}/${total}] Computing metrics...`,
        index: i,
        total,
      };

      const metrics = computeMetrics({
        answer,
        context,
        expectedTopics: expectedTopics || [],
      });
      log("Metrics:", metrics);

      // Judge scoring
      yield {
        type: "progress",
        caseId: id,
        step: "judge",
        message: `[${i + 1}/${total}] Judge scoring...`,
        index: i,
        total,
      };

      let judgeResult;
      try {
        judgeResult = await judgeInstance.score({ query, context, answer });
        log("Judge scores:", judgeResult.scores);
        log("Judge raw:", judgeResult.raw);
      } catch (err) {
        log("Judge error:", err.message);
        judgeResult = { scores: null, raw: `Judge error: ${err.message}` };
      }

      const caseResult = {
        id,
        query,
        category: testCase.category,
        difficulty: testCase.difficulty,
        answer,
        context,
        metrics,
        judgeScores: judgeResult.scores,
        judgeRaw: judgeResult.raw,
        error: null,
      };

      results.push(caseResult);

      yield { type: "case_result", caseId: id, result: caseResult };
    }
  } finally {
    judgeInstance.destroy();
  }

  // Build summary
  const scored = results.filter((r) => r.judgeScores);
  const dims = ["faithfulness", "relevance", "citationQuality", "completeness"];

  const avgScores = {};
  for (const dim of dims) {
    const values = scored.map((r) => r.judgeScores[dim].score);
    avgScores[dim] =
      values.length > 0
        ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) /
          10
        : null;
  }

  const withMetrics = results.filter((r) => r.metrics);
  const avgCitationRatio =
    withMetrics.length > 0
      ? Math.round(
          (withMetrics.reduce((a, r) => a + r.metrics.citations.ratio, 0) /
            withMetrics.length) *
            100,
        )
      : null;
  const avgTopicRatio =
    withMetrics.length > 0
      ? Math.round(
          (withMetrics.reduce((a, r) => a + r.metrics.topics.ratio, 0) /
            withMetrics.length) *
            100,
        )
      : null;

  const summary = {
    totalCases: cases.length,
    completedCases: results.filter((r) => !r.error).length,
    errorCases: results.filter((r) => r.error).length,
    avgScores,
    avgProgrammatic: {
      citationRatio: avgCitationRatio,
      topicRatio: avgTopicRatio,
    },
  };

  const run = {
    id: `eval_${Date.now()}`,
    timestamp: Date.now(),
    subject,
    judge,
    temperature,
    summary,
    cases: results,
  };

  saveRun(run);

  log("Run complete", summary);

  yield { type: "done", summary, run };
}
