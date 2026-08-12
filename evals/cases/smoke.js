// Smoke suite: proves the harness can boot the app, share its modules, and reach retrieval.
//
// Phase 1 runs this with no LLM and no judge. It exists to fail loudly when the *harness* breaks,
// so a genuine quality run never has to guess whether a bad number came from the plumbing.

import { defineSuite } from "./_helpers.js";

export default defineSuite("smoke", [
  {
    id: "smoke-retrieval-puma",
    tags: ["smoke", "retrieval"],
    query: "How did Nearform help PUMA scale their platform globally?",
    // Deliberately loose: a smoke case must fail only when the HARNESS is broken. Asserting all
    // three PUMA posts would keep it permanently red for a retrieval-quality reason, and a smoke
    // case nobody trusts is worse than none. The strict version belongs in the retrieval suite.
    gold: {
      anyOf: [
        [
          "work-puma",
          "work-puma-scaling-across-the-globe",
          "work-puma-design-system",
        ],
      ],
    },
    expect: { retrievalRecall: 1 },
    notes:
      "Harness liveness check: the app boots, the eval shares its Orama databases and embedding " +
      "extractor, and a vector search reaches the corpus. No generation, no judge. " +
      "OBSERVED 2026-08-12 (Phase 1 baseline, worth a real case later): for this query the top " +
      "hit is an unrelated digital-transformation interview; work-puma-scaling-across-the-globe " +
      "ranks 8, work-puma ranks 18, and work-puma-design-system is absent from the top 50. " +
      "Similarity across all 50 chunks spans only 0.886-0.910, so MIN_SIMILARITY=0.8 filters " +
      "nothing and the ranking is close to flat.",
    provenance: {
      foundBy: "harness",
      foundAt: "2026-08-12",
      reason: "Phase 1 smoke case.",
    },
  },
  {
    id: "smoke-retrieval-out-of-domain",
    tags: ["smoke", "retrieval", "abstention"],
    query: "What is the capital of Australia?",
    // MIN_SIMILARITY is 0.8, so a genuinely out-of-domain query should retrieve little or nothing.
    // If this starts returning a full context, the similarity floor has drifted and every
    // abstention case downstream is compromised.
    gold: { slugs: [] },
    expectAbstain: true,
    expect: {},
    notes:
      "Guards the retrieval similarity floor. A large context here means MIN_SIMILARITY changed " +
      "and abstention cases can no longer be trusted.",
    provenance: {
      foundBy: "harness",
      foundAt: "2026-08-12",
      reason: "Phase 1 smoke case.",
    },
  },
]);
