# Joyce chat evals

An eval harness for Joyce's RAG chat. It drives the real app in a real browser, so what it
measures is what users get.

> **Status: Phase 1 (spine).** Preflight plus a retrieval-only pass works today. Generation,
> scorers for citations and output hygiene, and the LLM judge land in later phases — see
> "Roadmap" at the end. Sections marked _(planned)_ describe work not yet built.

## Why this exists

Answer quality in Joyce is governed **entirely by prompt instructions**. There is no code-level
validation of citations, URLs, or output hygiene anywhere in the app — so "did that prompt edit
help?" has only ever been answerable by vibes. This harness makes it answerable by measurement.

Three failure modes prompted it:

1. **Duplicate citations** — the same source cited more than once, despite the prompt's
   "use each URL AT MOST ONCE".
2. **Hallucinated URLs** — rarer now, but entirely unguarded.
3. **Leaked internal mechanics** — answers that say "the chunks provided" instead of neutral
   phrasing.

## Quick start

```sh
node evals/run.js --dry-run          # resolve config + case list, execute nothing
npm run evals -- --suite smoke       # boot the app in Chrome, run the smoke suite
npm run evals -- --help              # full option list
```

You do **not** need a dev server running. The harness probes `http://127.0.0.1:4300/` first:

- Joyce already being served there → it reuses it and never touches it. Your own `npm run dev`
  survives an eval run, including a Ctrl-C'd one.
- Something else on the port → it refuses and tells you, rather than killing your process.
- Nothing there → it spawns `npx serve` and tears that down on exit.

Configuration is layered: code defaults → `.env` → environment → CLI flags. Copy the template:

```sh
cp evals/env.example .env
```

## One-time setup

**Chrome profile.** The harness uses a dedicated persistent profile at
`.data/evals/chrome-profile` so web-llm's multi-GB model downloads survive between runs. It is
created automatically. Quit any Chrome already using that directory — `--user-data-dir` is
exclusive, and a second launch silently hands off to the running instance instead of starting.

**Chrome built-in AI (optional).** `chrome::gemini-nano-*` cases need the model downloaded _in the
eval profile_. The preflight reports availability, and when the model is absent those cases are
skipped rather than failed.

Check what preflight says first — it prints one of:

- `availability=downloadable` — the API is present and the flags are already fine. You only need to
  trigger the download once (below).
- `LanguageModel=false` — the API isn't exposed at all; enable the Prompt API and the on-device
  model at `chrome://flags` in the eval profile first.

To trigger the download, launch the eval profile by hand and run one line in DevTools:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$PWD/.data/evals/chrome-profile"
# DevTools console:  await LanguageModel.create()
# Progress:          chrome://on-device-internals
```

The download is a few GB and persists in the profile. Re-run preflight; `availability` should read
`available`.

**Judge (optional, later phase).** Point `JOYCE_EVAL_JUDGE_BASE_URL` at any OpenAI-compatible
server. With `JOYCE_EVAL_JUDGE_MODEL=auto` the harness reads the model id from `GET /v1/models`, so
it keeps working when you switch llama-server launchers — and records the resolved id in every
result, so a judge swap is visible rather than silent.

## How it works

The app is no-build native ESM with an import map. Because ES modules are keyed by resolved URL, a
CDP `Runtime.evaluate` in the page's **main world** can `await import("/local/data/api/index.js")`
and get _the same module instances the running app is using_ — its built Orama databases, its
loaded embedding extractor, its resident web-llm engine.

That is the whole trick: the harness doesn't reimplement the pipeline, it calls the one the app is
already running. Preflight asserts this explicitly and aborts if it ever stops being true, because
a silent fallback to a second module graph would mean measuring a pipeline nobody uses.

CDP is hand-rolled against Node 24's global `WebSocket` (`evals/lib/cdp.js`) — no browser-automation
dependency. Functions in `evals/page/` are serialized with `toString()` and evaluated in the page;
they have their own rules, documented in [`page/README.md`](./page/README.md).

## Layout

```
run.js         CLI entry, orchestration, teardown
config.js      Layered config + --help text
tiers.js       Model capability tiers (thresholds key off these, not model ids)
lib/           cdp, chrome, server, inject, binding, browser, errors, logger, fs-out
page/          Browser-side functions (see page/README.md for the rules)
cases/         Eval cases, one module per suite
scorers/       Deterministic scorers + the gate matrix
reporters/     JSONL now; markdown/HTML/baselines later
baselines/     Committed, so score changes show up in PR review
```

Run artifacts go to `.data/evals/<runId>/` (gitignored, and ignored by eslint and prettier so
generated output can never break `npm run check`): `manifest.json`, `results.jsonl`,
`errors.jsonl`, plus `answers/`, `contexts/`, and `prompts/` holding the large blobs that
`results.jsonl` references by path.

## Exit codes

These are load-bearing — CI must be able to tell "the app got worse" from "the harness broke",
because reporting the second as the first destroys trust in the suite.

| Code | Meaning                                                                      |
| ---- | ---------------------------------------------------------------------------- |
| `0`  | Clean run, everything passed                                                 |
| `1`  | Quality failures — a scorer's threshold was not met                          |
| `2`  | Infrastructure failure — run is **inconclusive**, never a quality regression |

Every case resolves to exactly one outcome, and only `ok` carries a quality signal. The rest
(`harness_error`, `server_error`, `cdn_error`, `model_load_error`, `timeout`, `sut_error`,
`skipped`, `skipped_unavailable`, `judge_error`) are infrastructure and are tracked separately.

## Writing a case

Cases are plain ESM modules — no YAML, no schema tooling, consistent with the zero-build repo.
`defineSuite` validates at load time, so a typo fails immediately rather than an hour into a run.

```js
import { defineSuite } from "./_helpers.js";

export default defineSuite("retrieval", [
  {
    id: "puma-global-scaling", // stable, kebab-case, NEVER renamed or reused —
    tags: ["retrieval", "work"], // ids are the join key for baseline diffing
    query: "How did Nearform help PUMA scale their platform globally?",
    gold: {
      slugs: ["work-puma-scaling-across-the-globe"], // all must be retrieved
      anyOf: [["work-puma", "work-puma-design-system"]], // ≥1 per group
    },
    expect: { retrievalRecall: 1 },
    notes: "What should have happened, and what actually did.",
    provenance: {
      foundBy: "you@nearform.com",
      foundAt: "2026-08-12",
      reason: "...",
    },
  },
]);
```

Register the suite in `cases/index.js`.

### Thresholds: tiers, not model ids

A 1B model and a 4B model need different bars, but per-model tables rot the moment `Qwen3.5-4B`
becomes `Qwen4-4B`. So thresholds key off a **capability tier** (`tiny`/`small`/`mid`/`large`,
resolved in `tiers.js` from a known-model table with a context-window fallback), and each scorer
declares its own default **gate** per tier in `scorers/index.js`:

- `blocking` — a failure reddens CI
- `tracking` — recorded and diffed, but never fails CI

Use `tracking` when a tier genuinely cannot do the task yet. Lowering a threshold to 0.2 instead is
a lie that looks like a pass.

### Setting a threshold honestly

Never set a threshold to the score you just observed — that's a snapshot, not a target, and it
locks in the bug at its current severity. Set it at the behavior you'd actually require, and let
the case be red until it isn't. If you find yourself lowering a threshold to make CI green, that's
a revert, not a threshold change.

## Retrieval bug vs generation bug vs prompt bug

Stop at the first "yes". Getting this wrong is the most common wasted day on a RAG project, so
`retrievalRecall`'s failure message states the verdict outright rather than leaving you to guess.

| Check                                                                | Verdict                                                                      |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Gold slug absent from the ranked retrieval results?                  | **RETRIEVAL** — embeddings/similarity/chunking. No prompt change can fix it. |
| Retrieved, but absent from the context the model saw?                | **RETRIEVAL/BUDGET** — the token budget evicted it.                          |
| In the context, but not cited (or something else was)?               | **GENERATION**                                                               |
| Fails at `mid` but passes at `large`?                                | **GENERATION (capacity)** — set the threshold per tier.                      |
| Fails identically at every tier, and a prompt rule would produce it? | **PROMPT**                                                                   |
| Claim absent from the corpus entirely?                               | **DATA** — corpus gap; the case is an abstention case.                       |

## Roadmap

| Phase | Contents                                                                    | Status   |
| ----- | --------------------------------------------------------------------------- | -------- |
| 1     | CDP client, Chrome/server lifecycle, preflight, retrieval pass, JSONL       | **done** |
| 2     | Pipeline driver (generation), citation scorers, seed cases, Markdown report | next     |
| 3     | Output-hygiene scorers, including the internal-mechanics leak detector      | planned  |
| 4     | Blessed vocabulary + the four prompt fixes, measured before/after           | planned  |
| 5     | LLM judge + judge calibration meta-eval                                     | planned  |
| 6     | In-app capture button, `evals:add`, the full runbook                        | planned  |
| 7     | Case mining + HTML review page, HTML report, baselines                      | planned  |
| 8     | Multi-turn, consistency, entity/date, `ui` driver                           | planned  |
