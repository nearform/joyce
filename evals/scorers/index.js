// Scorer registry.
//
// Each entry declares its own default gate matrix by capability tier. Most tier sensitivity lives
// here rather than in case files, so cases stay readable and rarely need per-model overrides.
//
//   blocking : a failure reddens CI
//   tracking : recorded and diffed across runs, but never fails CI
//
// A `tracking` gate is the honest way to express "this tier genuinely cannot do this yet". Lowering
// a threshold to 0.2 instead is a lie that looks like a pass.

import { scoreRetrievalRecall } from "./retrieval.js";

export const SCORERS = Object.freeze({
  retrievalRecall: {
    kind: "deterministic",
    fn: scoreRetrievalRecall,
    // Retrieval is model-independent: the same embeddings and the same similarity floor for every
    // tier. Only the token budget differs, and that's reported separately as recallUsed.
    gate: {
      tiny: "blocking",
      small: "blocking",
      mid: "blocking",
      large: "blocking",
    },
    defaultMin: 1,
  },
});

/**
 * Resolve the gate for a scorer at a tier, honouring a case-level override.
 * @param {string} name
 * @param {string} tier
 * @param {Object} [caseExpect] - the case's `expect[name]` value
 * @returns {"blocking"|"tracking"|"skip"}
 */
export const resolveGate = (name, tier, caseExpect) => {
  if (caseExpect && typeof caseExpect === "object" && caseExpect.gate)
    return caseExpect.gate;
  const scorer = SCORERS[name];
  if (!scorer) return "skip";
  return scorer.gate?.[tier] ?? "blocking";
};

/**
 * Resolve a numeric threshold, walking up the tier ladder for a default so a value set for `small`
 * also applies to `tiny` unless explicitly overridden.
 * @param {number|Object} spec
 * @param {string} tier
 * @param {string[]} tierOrder
 * @returns {number}
 */
export const resolveThreshold = (spec, tier, tierOrder) => {
  if (spec == null) return 1;
  if (typeof spec === "number") return spec;
  if (typeof spec === "object") {
    if (spec.min != null && typeof spec.min === "number") return spec.min;
    if (spec[tier] != null) return spec[tier];
    const i = tierOrder.indexOf(tier);
    for (let j = i + 1; j < tierOrder.length; j += 1) {
      if (spec[tierOrder[j]] != null) return spec[tierOrder[j]];
    }
    if (spec.default != null) return spec.default;
  }
  return 1;
};
