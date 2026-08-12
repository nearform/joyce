// Case registry. Suites are registered here; the runner resolves --suite against this map.

import { HarnessError } from "../lib/errors.js";
import smoke from "./smoke.js";

/** @type {Array<{id: string, cases: Object[]}>} */
const SUITES = [smoke];

export const SUITES_BY_ID = Object.freeze(
  SUITES.reduce((acc, suite) => {
    acc[suite.id] = suite;
    return acc;
  }, {}),
);

export const ALL_CASES = Object.freeze(SUITES.flatMap((s) => s.cases));

// Ids are the join key for baseline diffing, so a collision across suites must be fatal.
const seen = new Set();
for (const c of ALL_CASES) {
  if (seen.has(c.id)) {
    throw new HarnessError(
      "harness.bad_case",
      `Duplicate eval case id across suites: ${c.id}`,
    );
  }
  seen.add(c.id);
}

const isHoldout = (c) => c.tags.includes("holdout");

/**
 * Resolve the cases a run should execute.
 *
 * @param {Object} options
 * @param {string[]} options.suites
 * @param {string[]|null} [options.cases] - explicit ids; bypasses suite filtering
 * @param {string[]|null} [options.tags]
 * @param {boolean} [options.includeHoldout]
 * @param {boolean} [options.allowInbox]
 * @returns {Object[]}
 */
export const selectCases = ({
  suites,
  cases = null,
  tags = null,
  includeHoldout = false,
  allowInbox = false,
}) => {
  let selected;

  if (cases?.length) {
    const byId = new Map(ALL_CASES.map((c) => [c.id, c]));
    const missing = cases.filter((id) => !byId.has(id));
    if (missing.length) {
      throw new HarnessError(
        "harness.bad_config",
        `Unknown case id(s): ${missing.join(", ")}\nKnown ids: ${ALL_CASES.map((c) => c.id).join(", ")}`,
      );
    }
    selected = cases.map((id) => byId.get(id));
  } else {
    const unknown = suites.filter((s) => !SUITES_BY_ID[s]);
    if (unknown.length) {
      throw new HarnessError(
        "harness.bad_config",
        `Unknown suite(s): ${unknown.join(", ")}\nKnown suites: ${Object.keys(SUITES_BY_ID).join(", ")}`,
      );
    }
    selected = suites.flatMap((s) => SUITES_BY_ID[s].cases);
  }

  if (tags?.length) {
    selected = selected.filter((c) => tags.some((t) => c.tags.includes(t)));
  }
  // Explicit --case selection is an override: asking for a holdout case by id should run it.
  if (!includeHoldout && !cases?.length) {
    selected = selected.filter((c) => !isHoldout(c));
  }

  if (!allowInbox) {
    const unresolved = selected.filter((c) => c.hasRequiredTodo);
    if (unresolved.length) {
      throw new HarnessError(
        "harness.bad_case",
        `These cases still have TODO(evals:required) markers and would not test what they claim:\n` +
          unresolved.map((c) => `  - ${c.id}`).join("\n") +
          `\nResolve them, or pass --allow-inbox to run anyway.`,
      );
    }
  }

  return selected;
};
