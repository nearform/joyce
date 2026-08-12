// Case definition helpers.
//
// Cases are plain ESM modules — no YAML, no schema tooling, consistent with the zero-build repo.
// defineCase validates at module load so a typo fails immediately rather than mid-run, hours in.

import { HarnessError } from "../lib/errors.js";

/** Markers that block a run: `evals:add` leaves these behind for a human to resolve. */
const REQUIRED_TODO = /TODO\(evals:required\)/;

/**
 * @typedef {Object} EvalCase
 * @property {string} id - stable kebab-case id; never renamed or reused
 * @property {string} suite
 * @property {string[]} tags
 * @property {string} query
 * @property {string[]} followUps
 * @property {Object} filters
 * @property {number} samples
 * @property {Object} gold
 * @property {boolean} expectAbstain
 * @property {RegExp[]} forbid
 * @property {Object} expect - scorerName -> threshold spec
 * @property {Object} flags
 * @property {string} notes
 * @property {Object} provenance
 */

const DEFAULT_FILTERS = {
  postType: [],
  minDate: "",
  categoryPrimary: [],
  verticalPrimary: [],
};

/**
 * Normalize and validate a case definition.
 * @param {Object} input
 * @returns {EvalCase}
 */
export const defineCase = (input) => {
  if (!input?.id || typeof input.id !== "string") {
    throw new HarnessError(
      "harness.bad_case",
      `Case is missing a string "id": ${JSON.stringify(input)}`,
    );
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.id)) {
    throw new HarnessError(
      "harness.bad_case",
      `Case id "${input.id}" must be kebab-case (ids are the join key for baseline diffing)`,
    );
  }
  if (typeof input.query !== "string" || !input.query.length) {
    // An intentionally empty query is expressed with `allowEmptyQuery` so a typo can't slip past.
    if (!input.flags?.allowEmptyQuery) {
      throw new HarnessError(
        "harness.bad_case",
        `Case "${input.id}" has no query`,
      );
    }
  }

  const notes = input.notes ?? "";
  return Object.freeze({
    id: input.id,
    suite: input.suite ?? "unknown",
    tags: Object.freeze(input.tags ?? []),
    query: input.query ?? "",
    followUps: Object.freeze(input.followUps ?? []),
    filters: Object.freeze({ ...DEFAULT_FILTERS, ...(input.filters ?? {}) }),
    samples: input.samples ?? null,
    gold: Object.freeze(input.gold ?? {}),
    expectAbstain: Boolean(input.expectAbstain),
    forbid: Object.freeze(input.forbid ?? []),
    expect: Object.freeze(input.expect ?? {}),
    flags: Object.freeze(input.flags ?? {}),
    notes,
    provenance: Object.freeze(input.provenance ?? {}),
    hasRequiredTodo: REQUIRED_TODO.test(notes),
  });
};

/**
 * Build a suite, stamping the suite id onto each case and rejecting duplicate ids.
 * @param {string} suite
 * @param {Object[]} cases
 * @returns {{id: string, cases: EvalCase[]}}
 */
export const defineSuite = (suite, cases) => {
  const seen = new Set();
  const built = cases.map((c) => {
    const built = defineCase({ ...c, suite });
    if (seen.has(built.id)) {
      throw new HarnessError(
        "harness.bad_case",
        `Duplicate case id in suite "${suite}": ${built.id}`,
      );
    }
    seen.add(built.id);
    return built;
  });
  return Object.freeze({ id: suite, cases: Object.freeze(built) });
};
