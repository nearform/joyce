/**
 * Layered configuration for the eval harness.
 *
 * Precedence, lowest to highest: DEFAULTS -> .env file -> process.env -> CLI flags.
 *
 * `.env` loading uses Node 24's built-in process.loadEnvFile(), so there is no dotenv dependency.
 *
 * Usage:
 *   import { loadConfig, describeConfig } from "./config.js";
 *   const config = loadConfig();
 */

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { HarnessError } from "./lib/errors.js";

const { dirname } = import.meta;
const REPO_ROOT = resolve(dirname, "..");

/**
 * Code defaults. Anything a developer might reasonably want to change is here rather than inline
 * at a call site.
 */
export const DEFAULTS = {
  app: {
    baseUrl: "http://127.0.0.1:4300/",
    autoStartServer: true,
    port: 4300,
    // `npx serve` may download `serve` on a cold npx cache, so be generous.
    startupTimeoutMs: 120_000,
    // Waiting for posts.json (8MB) + embeddings (16MB) + the transformers extractor.
    readyTimeoutMs: 180_000,
  },
  chrome: {
    // Set to a DevTools endpoint ("http://127.0.0.1:9223") to attach to an already-running
    // Chrome instead of launching one. Needed when you keep a browser open on the eval profile,
    // since --user-data-dir is exclusive. An attached browser is never torn down by the harness.
    endpoint: null,
    binary: null,
    // Persistent profile so web-llm's multi-GB model downloads survive between runs. Under .data/
    // so eslint and prettier ignore it, and gitignored.
    userDataDir: ".data/evals/chrome-profile",
    headless: false,
    allowSwiftshader: false,
    extraArgs: [],
    launchTimeoutMs: 60_000,
  },
  sut: {
    driver: "pipeline",
    models: ["webLlm::Llama-3.2-1B-Instruct-q4f16_1-MLC"],
    // 0 for gating runs: DEFAULT_TEMPERATURE is 0.4 in the app, but a deterministic gate needs 0.
    temperature: 0,
    enableThinking: false,
    multipleModels: false,
    samples: 1,
    // WebGPU is a single shared device; parallel generation destroys latency fidelity and invites
    // OOM. Raising this invalidates latency metrics.
    concurrency: 1,
  },
  timeouts: {
    modelLoadMs: 1_800_000,
    searchMs: 60_000,
    firstTokenMs: 180_000,
    streamMs: 600_000,
    stallMs: 90_000,
    turnMs: 900_000,
    caseMs: 1_800_000,
  },
  judge: {
    enabled: false,
    backend: "local",
    // Auto-discovered from GET /v1/models when `model` is "auto" — llama-server aliases change
    // when the user switches launchers.
    baseUrl: "http://127.0.0.1:8001/v1",
    model: "auto",
    apiKey: null,
    maxTokens: 2_000,
    temperature: 0,
    // llama-server runs -np 1 (single slot): a second concurrent request queues at the server and
    // looks like a hang. Pinned to 1 for the local backend regardless of this value.
    concurrency: 1,
    retries: 2,
    timeoutMs: 300_000,
    reasoning: false,
  },
  run: {
    suites: ["smoke"],
    cases: null,
    tags: null,
    outDir: ".data/evals",
    runId: null,
    bail: false,
    dryRun: false,
    updateBaseline: false,
    compare: true,
    expectPromptChange: false,
    includeHoldout: false,
    allowInbox: false,
    logLevel: "info",
  },
  report: { jsonl: true, markdown: true, html: false },
};

/** CLI surface. Kept flat and explicit so `--help` output is honest. */
const CLI_OPTIONS = {
  help: { type: "boolean", short: "h" },
  suite: { type: "string", multiple: true },
  case: { type: "string", multiple: true },
  tag: { type: "string", multiple: true },
  model: { type: "string", multiple: true },
  driver: { type: "string" },
  samples: { type: "string" },
  temperature: { type: "string" },
  concurrency: { type: "string" },
  "enable-thinking": { type: "boolean" },
  "multiple-models": { type: "boolean" },
  "app-url": { type: "string" },
  "no-server": { type: "boolean" },
  port: { type: "string" },
  "chrome-endpoint": { type: "string" },
  "chrome-binary": { type: "string" },
  "chrome-profile": { type: "string" },
  headless: { type: "boolean" },
  "allow-swiftshader": { type: "boolean" },
  judge: { type: "string" },
  "judge-model": { type: "string" },
  "judge-base-url": { type: "string" },
  "judge-max-tokens": { type: "string" },
  "judge-reasoning": { type: "boolean" },
  "out-dir": { type: "string" },
  "run-id": { type: "string" },
  "dry-run": { type: "boolean" },
  bail: { type: "boolean" },
  "no-compare": { type: "boolean" },
  "update-baseline": { type: "boolean" },
  "expect-prompt-change": { type: "boolean" },
  "include-holdout": { type: "boolean" },
  "allow-inbox": { type: "boolean" },
  html: { type: "boolean" },
  "log-level": { type: "string" },
};

export const HELP = `
Run the Joyce chat eval harness.

Usage:
  node evals/run.js [options]

Selection:
  --suite=NAME            Repeatable. Suite id (default: smoke)
  --case=ID               Repeatable. Filter to specific case ids
  --tag=TAG               Repeatable. Filter by case tag
  --include-holdout       Also run cases tagged "holdout" (do this before a release)
  --allow-inbox           Permit cases that still have TODO(evals:required) markers

System under test:
  --model=PROVIDER::ID    Repeatable. e.g. webLlm::Qwen3.5-2B-q4f16_1-MLC
  --driver=pipeline|ui    Default: pipeline
  --samples=N             Repetitions per (model x case). Default: 1
  --temperature=N         Default: 0 (deterministic gate; the app default is 0.4)
  --concurrency=N         SUT tabs. Default 1. >1 invalidates latency metrics.
  --enable-thinking       Allow reasoning models to emit <think>
  --multiple-models       Keep every web-llm model resident (no eviction)

App / browser:
  --app-url=URL           Default: http://127.0.0.1:4300/
  --no-server             Never spawn a dev server; fail if none is listening
  --port=N                Port to spawn the dev server on. Default: 4300
  --chrome-endpoint=URL   Attach to an already-running Chrome (e.g. http://127.0.0.1:9223)
                          instead of launching one. Never torn down by the harness.
  --chrome-binary=PATH    Override Chrome discovery
  --chrome-profile=DIR    Persistent profile dir. Default: .data/evals/chrome-profile
  --headless              Non-comparable run; sets comparable=false
  --allow-swiftshader     With --headless only: permit the CPU fallback adapter

Judge:
  --judge=off|local|anthropic|openai
  --judge-model=ID        Default: auto (local) / claude-haiku-4-5 (anthropic)
  --judge-base-url=URL    Default: http://127.0.0.1:8001/v1
  --judge-max-tokens=N    Default: 2000 (must cover reasoning + JSON)
  --judge-reasoning       Ask the judge model to reason before answering

Output:
  --out-dir=DIR           Default: .data/evals
  --run-id=ID             Override the generated run id
  --html                  Also write a self-contained HTML report
  --dry-run               Print the resolved plan and exit
  --bail                  Stop after the first quality failure
  --no-compare            Skip baseline comparison
  --update-baseline       Rewrite baselines from this run
  --expect-prompt-change  Permit a prompt-driven fingerprint mismatch to produce a real diff
  --log-level=LEVEL       error|warn|info|debug. Default: info
`;

/** Load a .env file if present, tolerating absence. */
const loadEnvFileIfPresent = (path) => {
  try {
    process.loadEnvFile(path);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
};

const asBool = (value) => {
  if (value == null || value === "") return undefined;
  const s = String(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return undefined;
};

const asNum = (value, label) => {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new HarnessError(
      "harness.bad_config",
      `${label} must be a number, got "${value}"`,
    );
  }
  return n;
};

const asList = (value) => {
  if (value == null || value === "") return undefined;
  const items = String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
};

/** Environment overlay. Every key is optional. */
const fromEnv = (env) => ({
  app: {
    baseUrl: env.JOYCE_EVAL_APP_URL,
    autoStartServer: asBool(env.JOYCE_EVAL_AUTOSTART_SERVER),
    port: asNum(env.JOYCE_EVAL_PORT, "JOYCE_EVAL_PORT"),
  },
  chrome: {
    endpoint: env.JOYCE_EVAL_CHROME_ENDPOINT,
    binary: env.JOYCE_EVAL_CHROME_BINARY,
    userDataDir: env.JOYCE_EVAL_CHROME_PROFILE,
    headless: asBool(env.JOYCE_EVAL_HEADLESS),
  },
  sut: {
    driver: env.JOYCE_EVAL_DRIVER,
    models: asList(env.JOYCE_EVAL_MODELS),
    temperature: asNum(env.JOYCE_EVAL_TEMPERATURE, "JOYCE_EVAL_TEMPERATURE"),
    samples: asNum(env.JOYCE_EVAL_SAMPLES, "JOYCE_EVAL_SAMPLES"),
  },
  judge: {
    // JOYCE_EVAL_JUDGE=off is how you disable it via env.
    enabled: env.JOYCE_EVAL_JUDGE ? env.JOYCE_EVAL_JUDGE !== "off" : undefined,
    backend:
      env.JOYCE_EVAL_JUDGE && env.JOYCE_EVAL_JUDGE !== "off"
        ? env.JOYCE_EVAL_JUDGE
        : undefined,
    baseUrl: env.JOYCE_EVAL_JUDGE_BASE_URL,
    model: env.JOYCE_EVAL_JUDGE_MODEL,
    apiKey:
      env.ANTHROPIC_API_KEY ??
      env.OPENAI_API_KEY ??
      env.JOYCE_EVAL_JUDGE_API_KEY,
  },
  run: { outDir: env.JOYCE_EVAL_OUT_DIR, logLevel: env.JOYCE_EVAL_LOG_LEVEL },
});

/** CLI overlay. */
const fromCli = (v) => ({
  app: {
    baseUrl: v["app-url"],
    autoStartServer: v["no-server"] ? false : undefined,
    port: asNum(v.port, "--port"),
  },
  chrome: {
    endpoint: v["chrome-endpoint"],
    binary: v["chrome-binary"],
    userDataDir: v["chrome-profile"],
    headless: v.headless,
    allowSwiftshader: v["allow-swiftshader"],
  },
  sut: {
    driver: v.driver,
    models: v.model?.length ? v.model : undefined,
    temperature: asNum(v.temperature, "--temperature"),
    samples: asNum(v.samples, "--samples"),
    concurrency: asNum(v.concurrency, "--concurrency"),
    enableThinking: v["enable-thinking"],
    multipleModels: v["multiple-models"],
  },
  judge: {
    enabled: v.judge ? v.judge !== "off" : undefined,
    backend: v.judge && v.judge !== "off" ? v.judge : undefined,
    baseUrl: v["judge-base-url"],
    model: v["judge-model"],
    maxTokens: asNum(v["judge-max-tokens"], "--judge-max-tokens"),
    reasoning: v["judge-reasoning"],
  },
  run: {
    suites: v.suite?.length ? v.suite : undefined,
    cases: v.case?.length ? v.case : undefined,
    tags: v.tag?.length ? v.tag : undefined,
    outDir: v["out-dir"],
    runId: v["run-id"],
    bail: v.bail,
    dryRun: v["dry-run"],
    updateBaseline: v["update-baseline"],
    compare: v["no-compare"] ? false : undefined,
    expectPromptChange: v["expect-prompt-change"],
    includeHoldout: v["include-holdout"],
    allowInbox: v["allow-inbox"],
    logLevel: v["log-level"],
  },
  report: { html: v.html },
});

/** Merge overlays, skipping undefined so a lower layer keeps its value. */
const mergeSections = (base, ...overlays) => {
  const out = {};
  for (const [section, defaults] of Object.entries(base)) {
    out[section] = { ...defaults };
    for (const overlay of overlays) {
      for (const [key, value] of Object.entries(overlay?.[section] ?? {})) {
        if (value !== undefined) out[section][key] = value;
      }
    }
  }
  return out;
};

const deepFreeze = (obj) => {
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") deepFreeze(value);
  }
  return Object.freeze(obj);
};

/** Turn "provider::model" into a structured entry, erroring clearly on a malformed spec. */
export const parseModelSpec = (spec) => {
  const idx = spec.indexOf("::");
  if (idx <= 0 || idx === spec.length - 2) {
    throw new HarnessError(
      "harness.bad_config",
      `Model must be "provider::modelId", got "${spec}" ` +
        `(e.g. webLlm::Qwen3.5-2B-q4f16_1-MLC or chrome::gemini-nano-prompt)`,
    );
  }
  return { provider: spec.slice(0, idx), model: spec.slice(idx + 2), spec };
};

const VALID_DRIVERS = new Set(["pipeline", "ui"]);
const VALID_BACKENDS = new Set(["local", "anthropic", "openai"]);
const VALID_LOG_LEVELS = new Set(["error", "warn", "info", "debug"]);

const validate = (c) => {
  if (!VALID_DRIVERS.has(c.sut.driver)) {
    throw new HarnessError(
      "harness.bad_config",
      `--driver must be one of ${[...VALID_DRIVERS].join("|")}, got "${c.sut.driver}"`,
    );
  }
  if (c.judge.enabled && !VALID_BACKENDS.has(c.judge.backend)) {
    throw new HarnessError(
      "harness.bad_config",
      `--judge must be off|${[...VALID_BACKENDS].join("|")}, got "${c.judge.backend}"`,
    );
  }
  if (!VALID_LOG_LEVELS.has(c.run.logLevel)) {
    throw new HarnessError(
      "harness.bad_config",
      `--log-level must be one of ${[...VALID_LOG_LEVELS].join("|")}`,
    );
  }
  if (c.sut.samples < 1) {
    throw new HarnessError("harness.bad_config", "--samples must be >= 1");
  }
  if (c.chrome.endpoint && c.chrome.headless) {
    throw new HarnessError(
      "harness.bad_config",
      "--headless cannot be combined with --chrome-endpoint: the attached browser's mode was " +
        "decided when you launched it, and the harness has no say in it.",
    );
  }
  if (c.chrome.allowSwiftshader && !c.chrome.headless) {
    throw new HarnessError(
      "harness.bad_config",
      "--allow-swiftshader only applies with --headless (headful runs should use the real GPU)",
    );
  }
  if (c.run.updateBaseline && c.chrome.headless) {
    throw new HarnessError(
      "harness.bad_config",
      "Refusing to write a baseline from a --headless run: WebGPU may be a CPU fallback adapter, " +
        "so its scores and latencies are not comparable to a headful run.",
    );
  }
};

/**
 * Build the effective config.
 * @param {{argv?: string[], envFile?: string, env?: Object}} [options]
 * @returns {Object} frozen config
 */
export const loadConfig = ({
  argv = process.argv.slice(2),
  envFile,
  env,
} = {}) => {
  loadEnvFileIfPresent(envFile ?? resolve(REPO_ROOT, ".env"));

  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: CLI_OPTIONS,
      strict: true,
    }));
  } catch (err) {
    throw new HarnessError("harness.bad_config", `${err.message}\n${HELP}`);
  }

  if (values.help) {
    return deepFreeze({ ...mergeSections(DEFAULTS), showHelp: true });
  }

  const merged = mergeSections(
    DEFAULTS,
    fromEnv(env ?? process.env),
    fromCli(values),
  );

  merged.chrome.userDataDir = resolve(REPO_ROOT, merged.chrome.userDataDir);
  merged.run.outDir = resolve(REPO_ROOT, merged.run.outDir);
  merged.repoRoot = REPO_ROOT;
  merged.showHelp = false;
  // Normalize once so every consumer can rely on a trailing slash for URL joining.
  merged.app.baseUrl = merged.app.baseUrl.endsWith("/")
    ? merged.app.baseUrl
    : `${merged.app.baseUrl}/`;
  merged.sut.modelSpecs = merged.sut.models.map(parseModelSpec);
  // A headless run's numbers must never be diffed against a headful baseline.
  merged.run.comparable = !merged.chrome.headless;

  validate(merged);
  return deepFreeze(merged);
};

/**
 * Config safe to print or embed in a run manifest: secrets are replaced with a marker.
 * @param {Object} config
 * @returns {Object}
 */
export const describeConfig = (config) => ({
  ...config,
  judge: { ...config.judge, apiKey: config.judge.apiKey ? "<set>" : null },
});
