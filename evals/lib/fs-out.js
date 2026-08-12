// Run-directory management and artifact writes.
//
// Results stream to results.jsonl as each case completes rather than being buffered until the end:
// a run killed at minute 40 must still leave an analysable dataset behind.

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";

/**
 * Filesystem-safe, sortable run id.
 * @param {Date} [now]
 * @returns {string}
 */
export const makeRunId = (now = new Date()) =>
  now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[:]/g, "-");

const run = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 5_000 }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });

/**
 * Current git state, used in the run manifest and baseline fingerprints.
 *
 * `dirty` matters: a baseline written from a dirty tree can't be attributed to a commit, so
 * --update-baseline refuses in that case.
 *
 * @param {string} cwd
 * @returns {Promise<{sha: string|null, branch: string|null, dirty: boolean|null}>}
 */
export const gitState = async (cwd) => {
  const sha = await run("git", ["rev-parse", "HEAD"], cwd);
  const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const status = await run("git", ["status", "--porcelain"], cwd);
  return { sha, branch, dirty: status == null ? null : status.length > 0 };
};

/**
 * Create the run directory tree.
 * @param {{outDir: string, runId: string}} options
 * @returns {Promise<Object>} paths and writers
 */
export const createRunDir = async ({ outDir, runId }) => {
  const dir = join(outDir, runId);
  const sub = {
    answers: join(dir, "answers"),
    contexts: join(dir, "contexts"),
    prompts: join(dir, "prompts"),
  };
  await mkdir(dir, { recursive: true });
  for (const path of Object.values(sub)) await mkdir(path, { recursive: true });

  const resultsPath = join(dir, "results.jsonl");
  const errorsPath = join(dir, "errors.jsonl");

  return {
    dir,
    sub,
    resultsPath,
    errorsPath,

    /**
     * Append one result record. Called per turn as it completes.
     * @param {Object} record
     */
    appendResult: (record) =>
      appendFile(resultsPath, `${JSON.stringify(record)}\n`, "utf8"),

    /**
     * Append one error record.
     * @param {Object} record
     */
    appendError: (record) =>
      appendFile(errorsPath, `${JSON.stringify(record)}\n`, "utf8"),

    /**
     * Write the run manifest. Config must already be redacted via describeConfig().
     * @param {Object} manifest
     */
    writeManifest: (manifest) =>
      writeFile(
        join(dir, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      ),

    /**
     * Write a large blob to a sibling file and return its run-relative path, so results.jsonl
     * stays greppable while full fidelity is preserved for postmortems.
     * @param {"answers"|"contexts"|"prompts"} kind
     * @param {string} name
     * @param {string} content
     * @returns {Promise<string>} path relative to the run dir
     */
    writeArtifact: async (kind, name, content) => {
      const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
      await writeFile(join(sub[kind], safe), content, "utf8");
      return `${kind}/${safe}`;
    },

    /**
     * Write an arbitrary top-level file (summary.md, report.html).
     * @param {string} name
     * @param {string} content
     */
    writeFile: (name, content) => writeFile(join(dir, name), content, "utf8"),
  };
};
