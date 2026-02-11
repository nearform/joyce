# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Joyce is a browser-based knowledge assistant for Nearform's web content. It is a **no-build, pure JavaScript** web app that runs entirely in the browser with no backend server. Deployed as a static site to GitHub Pages.

## Commands

```sh
npm run dev            # Serve public/ at http://127.0.0.1:4300/
npm run dev:root       # Serve . at http://127.0.0.1:4301/public
npm run check          # Run lint + prettier check (same as CI)
npm run format         # Fix lint + prettier issues
npm run data:embeddings  # Regenerate embeddings from posts.json
```

There is no test framework configured.

## Code Style

- **Pure JavaScript only** — no TypeScript, no JSX, no build step
- **Pure CSS only** — no CSS-in-JS or preprocessors
- 2 spaces indentation, double quotes, semicolons, trailing commas
- 100 character line limit
- camelCase for variables/functions, PascalCase for components, UPPER_SNAKE_CASE for constants
- kebab-case for file and directory names
- ESM `import`/`export` exclusively with relative paths including file extension: `./foo/bar.js`
- Prefer arrow functions, `const` over `let`, no `var`
- Prettier config is `{}` (defaults), ESLint uses recommended + prettier compat

## Architecture

### Runtime Dependencies (CDN via import map)

All runtime deps come from CDN (esm.sh, cdn.jsdelivr.net) via an import map in `public/index.html`. No `node_modules` at runtime. Import map entries must be fully version-pinned (e.g., `htm@3.1.1`, not `htm@^3`). Add `?external=react,react-dom` to packages depending on either.

Key libraries: React 19, React Router 7, HTM (JSX-like templates without build), Orama (browser search engine), @xenova/transformers, @mlc-ai/web-llm, Pure CSS 2.0.

### HTM Templating

Uses `htm` tagged template literals instead of JSX. Key patterns:
- Expressions: `=${variable}`, `=${{ object }}`, `=${[array]}`
- Inline styles must use object syntax: `style=${{ backgroundColor: "red" }}` (never string syntax)
- Spacing with inline elements on new indented lines: use `${" "}` before/after the element
- Conditional rendering: `${condition && html\`...\`}`
- Prefer CSS classes from `public/styles.css` over inline styles; inline only for dynamic/computed values

### Directory Layout

- `public/` — Static web root (deployed as-is to GitHub Pages)
  - `index.html` — Entry point with import map
  - `config.js`, `shared-config.js`, `shared-util.js` — Shared config/utils (work in both browser and Node)
  - `app/` — Frontend: pages, components, hooks, contexts, utilities
  - `local/data/` — Data layer: resource loading, Orama DBs, embeddings, LLM providers, RAG
  - `data/` — Static data files (posts.json, embeddings JSON) — **proprietary, not MIT**
- `scripts/` — Node.js scripts for data generation (embeddings)

### Data Layer (`public/local/data/`)

All data processing happens client-side. No remote backend.

**Resource loading system** (`loading.js`): Manages async resources with dependency tracking, status states (`not_loaded`/`loading`/`loaded`/`error`), and pub/sub notifications. Resources: `POSTS_DATA`, `POSTS_EMBEDDINGS`, `DB` (depends on both), `EXTRACTOR`.

**Two Orama databases** built at runtime:
- `postsDb` — Full-text search on post metadata
- `chunksDb` — Vector search using 384-dim embeddings (Xenova/gte-small)

**Embeddings**: Pre-computed, quantized as uint8 in JSON files. Dequantized to floats at runtime. Generated via `npm run data:embeddings`.

**Caching pattern**: Use `getAndCache` from `shared-util.js` for memoizing async operations.

### LLM Providers (`public/local/data/api/providers/`)

- **Web-LLM** (`web-llm.js`): In-browser LLM via WebGPU. OpenAI-compatible API.
- **Chrome Built-in AI** (`chrome.js`): Gemini Nano via Prompt API (`LanguageModel`) and Writer API (`Writer`). Requires Chrome 138+.

### RAG Pipeline (`public/local/data/api/rag.js`)

Query → vector search → retrieve top chunks → build XML context → estimate tokens → handle multi-turn conversations with token budgets.

### Routing

React Router v7 with `BrowserRouter`. Import from `"react-router"` (unified package in v7). Uses `basename` prop for GitHub Pages subdirectory deployment. `404.html` handles SPA redirect.

### Icons

Use [Iconoir](https://iconoir.com/) for all iconography.
