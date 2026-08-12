// Serializing Node-side functions into the browser page, and unwrapping what comes back.
//
// This works cleanly because the repo has no build step: Function.prototype.toString() returns the
// exact authored source, with no transpilation to reason about. That's what makes hand-rolled
// injection as ergonomic as a browser-automation library's evaluate().

import { PageError } from "./errors.js";

/**
 * Turn a CDP exceptionDetails payload into an error worth reading.
 *
 * CDP reports thrown values in several shapes depending on what was thrown, and the useful text
 * hides in a different field each time — an unhandled `undefined` here is the difference between a
 * real stack trace and "Unknown page exception".
 *
 * @param {Object} details - Runtime.exceptionDetails
 * @returns {PageError}
 */
export const describeException = (details) => {
  const ex = details.exception ?? {};
  const raw =
    ex.description ??
    (ex.value !== undefined
      ? `Thrown non-Error: ${JSON.stringify(ex.value)}`
      : null) ??
    ex.preview?.description ??
    details.text ??
    "Unknown page exception";

  const frames = (details.stackTrace?.callFrames ?? []).map(
    (f) =>
      `${f.functionName || "<anonymous>"} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`,
  );

  return new PageError("page.exception", String(raw).split("\n")[0], {
    className: ex.className ?? null,
    pageStack: String(raw),
    frames,
  });
};

/**
 * Evaluate a self-contained function inside the page and return its value.
 *
 * IMPORTANT: this always runs in the page's MAIN world. An isolated world cannot resolve the bare
 * specifiers in public/index.html's import map (`@orama/orama`, `@xenova/transformers`), so
 * `await import("/local/data/api/index.js")` would fail there — and even if it succeeded it would
 * produce a second module graph rather than the instances the app is already using. Sharing the
 * app's module instances is the entire point of the pipeline driver, so do not "harden" this into
 * an isolated world.
 *
 * `fn` must be self-contained: no closure variables, no import statements (use `await import(url)`
 * at runtime), and it must return a JSON-safe value. See evals/page/README.md.
 *
 * @param {import("./cdp.js").CdpSession} session
 * @param {Function} fn - serialized via toString()
 * @param {*} [arg] - single JSON-serializable argument
 * @param {{timeoutMs?: number, awaitPromise?: boolean, userGesture?: boolean}} [options]
 * @returns {Promise<*>}
 */
export const evaluateFn = async (
  session,
  fn,
  arg,
  { timeoutMs, awaitPromise = true, userGesture = true } = {},
) => {
  const expression = `(${fn.toString()})(${JSON.stringify(arg ?? null)})`;
  const { result, exceptionDetails } = await session.send(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise,
      returnByValue: true,
      // Chrome's built-in AI (LanguageModel.create) can require transient user activation.
      userGesture,
    },
    { timeoutMs },
  );
  if (exceptionDetails) throw describeException(exceptionDetails);
  return result?.value;
};

/**
 * Evaluate a raw expression. Prefer evaluateFn; this exists for one-line probes.
 * @param {import("./cdp.js").CdpSession} session
 * @param {string} expression
 * @param {{timeoutMs?: number, awaitPromise?: boolean}} [options]
 * @returns {Promise<*>}
 */
export const evaluateExpression = async (
  session,
  expression,
  { timeoutMs, awaitPromise = true } = {},
) => {
  const { result, exceptionDetails } = await session.send(
    "Runtime.evaluate",
    { expression, awaitPromise, returnByValue: true },
    { timeoutMs },
  );
  if (exceptionDetails) throw describeException(exceptionDetails);
  return result?.value;
};

/**
 * Register a function to run on every new document, before any page script.
 *
 * This is how settings are seeded: the Chat route does not exist unless `experimentalChat` is true,
 * because layout.js filters it out of the page list before Routes is built. Seeding after load
 * would be too late.
 *
 * @param {import("./cdp.js").CdpSession} session
 * @param {Function} fn
 * @param {*} [arg]
 * @returns {Promise<string>} script identifier
 */
export const addInitScript = async (session, fn, arg) => {
  const source = `(${fn.toString()})(${JSON.stringify(arg ?? null)});`;
  const { identifier } = await session.send(
    "Page.addScriptToEvaluateOnNewDocument",
    { source },
  );
  return identifier;
};
