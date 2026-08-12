import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";

// Node runtime globals used by scripts/ and evals/. Hand-maintained rather than pulling in the
// `globals` package, to keep devDependencies minimal (the same reason the rest of the repo uses
// `/* global ... */` headers). Scoped via `files` so nothing under public/ is affected.
const NODE_GLOBALS = {
  AbortController: "readonly",
  AbortSignal: "readonly",
  Buffer: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  fetch: "readonly",
  performance: "readonly",
  process: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  structuredClone: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  WebSocket: "readonly",
};

// Browser globals for evals/page/*.js — those functions are serialized with toString() and
// evaluated inside the Chrome page, so they run in a browser, not in Node. Deliberately omits
// `process`, making a stray Node reference a lint error instead of a runtime ReferenceError
// inside Chrome.
const PAGE_GLOBALS = {
  clearInterval: "readonly",
  clearTimeout: "readonly",
  document: "readonly",
  Event: "readonly",
  localStorage: "readonly",
  location: "readonly",
  MutationObserver: "readonly",
  navigator: "readonly",
  performance: "readonly",
  sessionStorage: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  URLSearchParams: "readonly",
  window: "readonly",
};

export default [
  {
    ignores: [".data/*"],
  },
  js.configs.recommended,
  {
    files: ["evals/**/*.js", "scripts/**/*.js"],
    // Excluded so page/ does NOT also inherit the Node globals: flat-config `globals` objects
    // merge rather than replace, so without this a page file could reference `process` and lint
    // clean while throwing a ReferenceError inside Chrome.
    ignores: ["evals/page/**/*.js"],
    languageOptions: { globals: NODE_GLOBALS },
  },
  {
    files: ["evals/page/**/*.js"],
    languageOptions: { globals: PAGE_GLOBALS },
  },
  eslintConfigPrettier,
];
