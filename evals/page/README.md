# `evals/page/` — browser-side functions

Everything in this directory is serialized with `Function.prototype.toString()` and evaluated
inside the Chrome page. These files never execute in Node.

That works cleanly because this repo has no build step, so `toString()` yields the exact authored
source. It also means four rules are non-negotiable.

## The four rules

### 1. No closure references

The function is stringified and re-parsed in a completely different realm. Anything it didn't
receive as its argument does not exist there.

```js
// BROKEN — MAX is not in scope inside the page
const MAX = 10;
export const bad = () => MAX;

// CORRECT — everything arrives via the single argument, or is defined inline
export const good = (arg) => {
  const MAX = 10;
  return Math.min(arg.n, MAX);
};
```

Each exported function takes **exactly one** JSON-serializable argument, which the injector
`JSON.stringify`s into the call site.

### 2. No `import` statements — use `await import(url)`

A static `import` would be a parse error in the evaluated expression. Load app modules at runtime
with a dynamic import against an absolute URL built from `arg.base`:

```js
export const example = async (arg) => {
  const api = await import(`${arg.base}local/data/api/index.js`);
  return api.search({ query: arg.query });
};
```

This is the _mechanism_, not a workaround. Because ES modules are keyed by resolved URL, a dynamic
import in the page's **main world** returns the very same module instances the running app is
using — sharing its built Orama databases, its loaded embedding extractor, and its resident
web-llm engine. That is what makes the pipeline driver the real pipeline rather than a
reimplementation of it.

Two consequences worth internalizing:

- **Main world only.** An isolated world cannot resolve the bare specifiers in the app's import map
  (`@orama/orama`, `@xenova/transformers`), so the import would fail — and even if it succeeded, it
  would build a second module graph with its own empty caches. `evals/lib/inject.js` never uses an
  isolated world; do not change that.
- **`arg.base` must have a trailing slash.** It is `/` under `npm run dev` (web root is `public/`)
  and `/public/` under `npm run dev:root`.

### 3. Return JSON-safe values, or a JSON string

Return values come back through CDP's `returnByValue`, which drops `undefined`, cannot represent
`Map`/`Set`/class instances, and has practical depth limits.

For anything large or nested — a turn result, a search payload — `JSON.stringify` it yourself and
return the string. Node parses it back. That sidesteps deep-serialization limits and keeps the
shape stable.

### 4. Never hold a long-lived promise open on the harness's behalf

A page function must return promptly. Do **not** write one that resolves "when the model finishes
loading" or "when generation completes" and let Node `await` it across minutes.

A `Runtime.evaluate` with `awaitPromise: true` that stays pending dies with **"Promise was
collected"** if the execution context is disturbed at all — which happens routinely when the tab is
backgrounded, and is common in an attached browser with other tabs open. It fails intermittently,
and the longer the wait the likelier it is: this bit us on a ~700ms resource load, and a web-llm
model download runs for tens of minutes.

The pattern that works:

- Page: a **short** function that _starts_ the work and returns immediately.
- Page: emit progress over the binding (fire-and-forget — no pending promise).
- Node: poll a **short** status function on an interval, and own the deadline.

`awaitResource` in `evals/lib/browser.js` is the reference implementation. Keeping the clock in
Node has a second benefit: page-timer throttling in a background tab can't affect it.

## Streaming back to Node

For long operations, emit progress with the binding installed by the harness. `arg.bindingName`
holds its name; payloads over ~60 KB must be chunked, which `evals/lib/binding.js` reassembles:

```js
const makeSend = (name) => {
  const MAX = 60000;
  let seq = 0;
  return (event) => {
    const body = JSON.stringify(event);
    if (body.length <= MAX) {
      window[name](body);
      return;
    }
    const id = `c${(seq += 1)}`;
    const total = Math.ceil(body.length / MAX);
    for (let i = 0; i < total; i += 1) {
      window[name](
        JSON.stringify({
          __chunk: { id, i, total, s: body.slice(i * MAX, (i + 1) * MAX) },
        }),
      );
    }
  };
};
```

Keep per-event traffic small and ordered — a generated answer produces hundreds of token deltas, so
send heartbeats (every N deltas) rather than the text itself.

For **short** work, return the full payload as the function's JSON result. For work that runs long
enough to trip rule 4 — generation, model loading — send the terminal payload over the binding as a
final `done` event instead (the chunker above exists for exactly that) and have Node resolve on
that event rather than on the evaluate's return value. Otherwise you have reintroduced the
long-lived promise by the back door.

## Linting

`eslint.config.js` gives this directory **browser** globals only, and deliberately excludes it from
the Node-globals block. Referencing `process` here is a lint error rather than a `ReferenceError`
discovered at runtime inside Chrome.
