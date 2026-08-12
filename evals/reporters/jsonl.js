// JSONL reporter: one self-describing line per turn, written as each result completes.
//
// Large blobs (answer, context, prompt, searchData) go to sibling files and are referenced by path,
// which keeps results.jsonl greppable and cheap to load while preserving full fidelity for
// postmortems.

/**
 * @param {Object} runDir - from createRunDir()
 * @param {Object} runMeta - {runId, sut defaults, git, gpu, judge}
 * @returns {{onTurn: Function, onError: Function}}
 */
export const createJsonlReporter = (runDir, runMeta) => ({
  /**
   * Record one turn.
   * @param {Object} params
   * @param {Object} params.evalCase
   * @param {Object} params.sut - {provider, model, driver, temperature, tier}
   * @param {number} params.sample
   * @param {Object} params.turn - TurnResult
   * @param {string} params.outcome
   * @param {string|null} params.code
   * @param {Object} [params.scores]
   * @param {Object} [params.judge]
   */
  onTurn: async ({
    evalCase,
    sut,
    sample,
    turn,
    outcome,
    code,
    scores,
    judge,
  }) => {
    const stem = `${evalCase.id}.s${sample}.t${turn?.turn ?? 1}`;
    const artifacts = {};

    if (turn?.rawAnswer) {
      artifacts.answer = await runDir.writeArtifact(
        "answers",
        `${stem}.md`,
        turn.rawAnswer,
      );
    }
    if (turn?.context) {
      artifacts.context = await runDir.writeArtifact(
        "contexts",
        `${stem}.xml`,
        turn.context,
      );
    }
    if (turn?.prompt) {
      artifacts.prompt = await runDir.writeArtifact(
        "prompts",
        `${stem}.json`,
        JSON.stringify(turn.prompt, null, 2),
      );
    }
    if (turn?.searchData) {
      artifacts.searchData = await runDir.writeArtifact(
        "contexts",
        `${stem}.search.json`,
        JSON.stringify(turn.searchData, null, 2),
      );
    }

    await runDir.appendResult({
      runId: runMeta.runId,
      suite: evalCase.suite,
      caseId: evalCase.id,
      tags: evalCase.tags,
      sample,
      turn: turn?.turn ?? 1,
      query: turn?.query ?? evalCase.query,
      sut,
      outcome,
      code: code ?? null,
      finishReason: turn?.finishReason ?? null,
      timings: turn?.timings ?? null,
      usage: turn?.usage
        ? {
            inputTokens: turn.usage.inputTokens,
            outputTokens: turn.usage.outputTokens,
            totalTokens: turn.usage.totalTokens,
            available: turn.usage.available,
            limit: turn.usage.limit,
            contextTokens: turn.usage.contextTokens ?? null,
          }
        : null,
      retrieval: turn?.retrieval ?? null,
      scores: scores ?? null,
      judge: judge ?? null,
      provenance: turn?.provenance ?? null,
      unavailable: turn?.unavailable ?? null,
      artifacts,
    });
  },

  /**
   * Record a harness/infra error, keyed to the case it interrupted.
   * @param {Object} params
   */
  onError: async ({
    evalCase,
    sut,
    sample,
    outcome,
    code,
    message,
    details,
    capture,
  }) => {
    await runDir.appendError({
      runId: runMeta.runId,
      caseId: evalCase?.id ?? null,
      suite: evalCase?.suite ?? null,
      sample: sample ?? null,
      sut: sut ?? null,
      outcome,
      code: code ?? null,
      message,
      details: details ?? null,
      // Only the parts of the capture worth persisting; console output can be enormous.
      capture: capture
        ? {
            failedRequests: capture.failedRequests?.slice(0, 20) ?? [],
            exceptions: capture.exceptions?.slice(0, 20) ?? [],
            rendererCrashed: Boolean(capture.rendererCrashed),
          }
        : null,
    });
  },
});
