// Retrieval scorers. Fully deterministic, no LLM, no judge.
//
// These answer the single most useful diagnostic question in a RAG suite: was the gold post even
// available to the model? Prompt-tuning to fix a retrieval failure is the most common wasted day on
// a project like this, so the failure message states the verdict outright.

/**
 * Recall / MRR of gold slugs against ranked retrieval output.
 *
 * Two recall numbers matter and they mean different things:
 *  - recallTopK  : did search find it at all?
 *  - recallUsed  : did it survive the token budget into the context the model actually saw?
 * A gap between them is a budgeting problem, not a retrieval-quality problem, and definitely not a
 * generation problem. `recallUsed` is only available once a model (hence a token budget) is in play,
 * so a retrieval-only run reports recallTopK and leaves recallUsed null.
 *
 * @param {Object} params
 * @param {string[]} params.rankedSlugs - deduped, best-similarity-first
 * @param {string[]|null} [params.usedSlugs] - slugs that fit the context, when known
 * @param {Object} params.gold - {slugs?: string[], anyOf?: string[][]}
 * @param {Object} [params.options] - {k?: number}
 * @returns {{score: number, pass: boolean, message: string, details: Object}}
 */
export const scoreRetrievalRecall = ({
  rankedSlugs,
  usedSlugs = null,
  gold,
  options = {},
}) => {
  const goldSlugs = gold?.slugs ?? [];
  const anyOf = gold?.anyOf ?? [];
  const k = options.k ?? rankedSlugs.length;
  const topK = rankedSlugs.slice(0, k);
  const topKSet = new Set(topK);
  const usedSet = usedSlugs ? new Set(usedSlugs) : null;

  // A case with no gold slugs (out-of-domain, abstention) has nothing to recall. Report
  // notApplicable rather than a vacuous 1.0 so it can't inflate an aggregate.
  if (!goldSlugs.length && !anyOf.length) {
    return {
      score: 1,
      pass: true,
      notApplicable: true,
      message: "",
      details: { reason: "no gold slugs", retrievedCount: rankedSlugs.length },
    };
  }

  const found = goldSlugs.filter((s) => topKSet.has(s));
  const missing = goldSlugs.filter((s) => !topKSet.has(s));

  // Rank every slug the case cares about, including anyOf members: a case expressed purely as
  // anyOf still needs a rank and an MRR, and reporting "no rank" there would hide exactly the
  // ranking-quality signal this scorer exists to expose.
  const tracked = [...new Set([...goldSlugs, ...anyOf.flat()])];
  const ranks = {};
  for (const slug of tracked) {
    const idx = rankedSlugs.indexOf(slug);
    ranks[slug] = idx === -1 ? null : idx + 1;
  }

  // anyOf groups: each group is satisfied by at least one member. Used when several posts
  // legitimately answer the question (three PUMA posts, a multi-part series).
  const groupResults = anyOf.map((group) => ({
    group,
    satisfied: group.some((s) => topKSet.has(s)),
  }));
  const groupsSatisfied = groupResults.filter((g) => g.satisfied).length;

  const recallTopK = goldSlugs.length ? found.length / goldSlugs.length : null;
  const recallUsed = usedSet
    ? goldSlugs.length
      ? goldSlugs.filter((s) => usedSet.has(s)).length / goldSlugs.length
      : null
    : null;

  const firstGoldRank = Math.min(
    ...tracked.map((s) => ranks[s] ?? Number.POSITIVE_INFINITY),
    Number.POSITIVE_INFINITY,
  );
  const mrr = Number.isFinite(firstGoldRank) ? 1 / firstGoldRank : 0;

  // Score on the strictest available signal: what the model actually saw, when we know it.
  const primary =
    recallUsed ??
    recallTopK ??
    (anyOf.length ? groupsSatisfied / anyOf.length : 1);
  const groupsOk = !anyOf.length || groupsSatisfied === anyOf.length;
  const score = anyOf.length
    ? Math.min(primary, groupsSatisfied / anyOf.length)
    : primary;

  const message = buildMessage({
    missing,
    ranks,
    recallTopK,
    recallUsed,
    groupResults,
    usedSet,
  });

  return {
    score,
    pass: score >= 1 && groupsOk,
    message,
    details: {
      recallTopK,
      recallUsed,
      mrr,
      firstGoldRank: Number.isFinite(firstGoldRank) ? firstGoldRank : null,
      ranks,
      found,
      missing,
      groups: groupResults,
      retrievedCount: rankedSlugs.length,
    },
  };
};

const buildMessage = ({
  missing,
  ranks,
  recallTopK,
  recallUsed,
  groupResults,
  usedSet,
}) => {
  const parts = [];

  // The distinction that saves the wasted day: retrieved-but-dropped vs never-retrieved.
  if (usedSet) {
    const droppedByBudget = Object.entries(ranks).filter(
      ([slug, rank]) => rank !== null && !usedSet.has(slug),
    );
    if (droppedByBudget.length) {
      parts.push(
        `Gold post(s) ${droppedByBudget
          .map(([slug, rank]) => `${slug} (rank ${rank})`)
          .join(
            ", ",
          )} were retrieved but dropped by the token budget before reaching the model. ` +
          `This is a RETRIEVAL/BUDGET failure, not a generation failure.`,
      );
    }
  }

  if (missing.length) {
    parts.push(
      `Gold post(s) ${missing.join(", ")} were not retrieved at all ` +
        `(recall ${formatRatio(recallTopK)}). This is a RETRIEVAL failure — the model never saw ` +
        `them, so no prompt change can fix it.`,
    );
  }

  const unsatisfied = groupResults.filter((g) => !g.satisfied);
  if (unsatisfied.length) {
    parts.push(
      `No member retrieved for required group(s): ` +
        unsatisfied.map((g) => `[${g.group.join(" | ")}]`).join(", "),
    );
  }

  if (!parts.length && recallUsed !== null && recallUsed < 1) {
    parts.push(`recallUsed ${formatRatio(recallUsed)} below target.`);
  }

  return parts.join(" ");
};

const formatRatio = (v) => (v === null ? "n/a" : `${Math.round(v * 100)}%`);
