// Browser-side: seed app settings before the app boots. See ./README.md for the rules.

/**
 * Settings the harness seeds into localStorage.
 *
 * This is not merely convenience — the Chat route does not exist without `experimentalChat`,
 * because layout.js filters it out of the page list before Routes is constructed.
 *
 * Note this object lives in the Node-side module scope and is inlined into the injected call as
 * part of the argument, so it does NOT violate the no-closures rule.
 */
export const EVAL_SETTINGS = {
  // Without this the /chat route renders nothing at all.
  experimentalChat: true,
  // Enables multi-turn follow-ups.
  experimentalChatConversations: true,
  // Renders `details.query-info`, which is the ui driver's only reliable turn-complete signal,
  // and exposes the model picker for every provider.
  isDeveloperMode: true,
  showExperimental: true,
  // Per-case override; off by default so <think> output doesn't pollute answers.
  enableThinking: false,
  // Off: avoids an extra CDN import and breadcrumb noise we don't consume.
  experimentalCrashbox: false,
  // Off matches production behaviour (one resident web-llm model, others evicted).
  experimentalMultipleModels: false,
  displayModelStats: false,
  // CRITICAL: web-llm's preflight budget derives from navigator.deviceMemory, which the browser
  // caps at 8 (GB). On a 128GB machine that makes the larger models look like they "won't fit",
  // producing a bogus won't-fit verdict and a critical memory-pressure report. Override
  // explicitly so model selection reflects the real machine.
  memoryBudgetMb: 65536,
};

/**
 * Seed localStorage settings and, optionally, the SPA redirect path.
 *
 * Runs via Page.addScriptToEvaluateOnNewDocument, i.e. after document creation on the real origin
 * but before any page script, so storage is available and same-origin.
 *
 * @param {{settings: Object, redirectPath?: string|null, storageKey?: string}} arg
 */
export const seedSettings = (arg) => {
  const key = arg.storageKey || "app_settings";
  let existing;
  try {
    existing = JSON.parse(localStorage.getItem(key) || "{}");
  } catch {
    existing = {};
  }
  localStorage.setItem(key, JSON.stringify({ ...existing, ...arg.settings }));

  // Reaching /chat directly 404s under `npx serve` (no SPA rewrite). Rather than depending on the
  // dev server's 404 behaviour, emulate public/404.html's shim: index.html's inline script
  // consumes this key and replaces history state before the deferred module script renders, so
  // BrowserRouter mounts the requested route with its search params intact — which matters
  // because chat.js reads model/temperature/filters from the URL on first render only.
  if (arg.redirectPath) {
    sessionStorage.setItem("ghpages_redirect_path", arg.redirectPath);
  }
};
