# Research Brief: MediaPipe LLM Inference as a Joyce Provider

## Context

Joyce currently has two browser-based LLM providers: **web-llm** (WebGPU via MLC) and **Chrome Built-in AI** (Gemini Nano). This research evaluates Google's **MediaPipe LLM Inference API** (`@mediapipe/tasks-genai`) as a third provider, focusing on feasibility for Joyce's pure-static, no-build, ESM-only architecture.

---

## 1. What is MediaPipe LLM Inference?

MediaPipe's GenAI Tasks provide a browser-based LLM inference runtime that runs models entirely on-device using **WebGPU + WebAssembly**. It's part of Google's AI Edge stack and powers the same engine behind Chrome's built-in Gemini Nano.

**Package**: `@mediapipe/tasks-genai` v0.10.26
**Bundle**: `genai_bundle.mjs` (57 KB ESM) + WASM assets from `wasm/` directory
**CDN**: Available on jsdelivr — fully compatible with Joyce's import map pattern:

```
https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@0.10.26/genai_bundle.mjs
https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@0.10.26/wasm/  (WASM runtime files)
```

### Deprecation Notice

Google's docs flag MediaPipe GenAI Tasks as "deprecated" in favor of **LiteRT-LM**. However:

- LiteRT-LM has **no JavaScript/web SDK yet** (only Kotlin, C++, Swift, Python)
- The MediaPipe web JS API remains the _only_ way to use these models in browsers
- LiteRT-LM's `.litertlm` format is consumed _by_ the MediaPipe JS API for web
- Google's own web demos still use `@mediapipe/tasks-genai`
- The "deprecation" is more of a rebranding/layering — MediaPipe JS is the web frontend for LiteRT-LM

**Assessment**: Safe to build on for now. When LiteRT-LM ships a JS SDK, migration should be straightforward since it's the same underlying engine.

---

## 2. API Surface

### Core Classes

```javascript
import { FilesetResolver, LlmInference } from "@mediapipe/tasks-genai";
```

### Initialization

```javascript
// 1. Load WASM runtime
const genai = await FilesetResolver.forGenAiTasks(
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@0.10.26/wasm",
);

// 2. Create inference engine
const llm = await LlmInference.createFromOptions(genai, {
  baseOptions: {
    modelAssetPath: "https://example.com/model.litertlm", // or .task
    delegate: "GPU",
    gpuOptions: { device: await LlmInference.createWebGpuDevice() },
  },
  maxTokens: 1024, // total budget: input + output
  topK: 40,
  temperature: 0.8,
  randomSeed: 101,
});
```

### Text Generation (Streaming)

```javascript
// Callback-based streaming — NOT an async generator
llm.generateResponse(prompt, (partialResult, done) => {
  // partialResult: incremental text chunk
  // done: boolean — true on final chunk
});

// Also available:
llm.generateResponses(prompt); // multiple responses
llm.sizeInTokens(prompt); // token counting
llm.cancelProcessing(); // abort generation
llm.close(); // cleanup
```

### Key Differences from web-llm

| Aspect         | web-llm                          | MediaPipe                                     |
| -------------- | -------------------------------- | --------------------------------------------- |
| Streaming      | OpenAI-compatible async iterator | Callback `(partial, done)`                    |
| Multi-turn     | Built-in message array           | Manual prompt templating                      |
| Token tracking | Usage object in stream           | `sizeInTokens()` method                       |
| Model format   | MLC-compiled WebGPU shaders      | `.litertlm` / `.task` files                   |
| Model source   | MLC model registry               | HuggingFace (google/, litert-community/)      |
| Engine caching | IndexedDB / Cache API            | OPFS (Origin Private File System) recommended |

### Multi-turn Conversation Pattern

MediaPipe has **no built-in chat history**. You must construct the prompt manually using Gemma's turn markers:

```
<start_of_turn>user
What is JavaScript?<end_of_turn>
<start_of_turn>model
JavaScript is a programming language...<end_of_turn>
<start_of_turn>user
How does it differ from Python?<end_of_turn>
<start_of_turn>model
```

This is similar to how Joyce's Chrome provider works — the session layer handles history concatenation.

---

## 3. Available Models

### Web-Optimized Models (recommended)

Web models use a different internal format optimized for WebGPU/WASM with lower memory usage. They are identified by a `-Web` suffix.

| Model                | Params        | Size    | Format      | Notes                           |
| -------------------- | ------------- | ------- | ----------- | ------------------------------- |
| **Gemma-3n E2B Web** | ~2B effective | 3.04 GB | `.litertlm` | Smallest practical chat model   |
| **Gemma-3n E4B Web** | ~4B effective | ~4.5 GB | `.litertlm` | Better quality, needs more VRAM |
| Gemma-3 1B           | 1B            | ~500 MB | `.task`     | Older format, less capable      |
| Gemma-3 270M         | 270M          | ~300 MB | `.task`     | Very small, limited quality     |

### Non-Web Models (for reference — NOT usable in browser)

These require the native LiteRT-LM runtime:

- Gemma-3n E2B/E4B (non-web `.litertlm`)
- Phi-4-mini, Qwen2.5-1.5b, Qwen3.5-0.8B/2B/4B
- FunctionGemma-270M

### Model Sources

- **google/** org on HuggingFace: Official Gemma-3n web models
- **litert-community/** org on HuggingFace: Community-converted models (86+ models, mostly vision/embedding; text models growing)

### Model Choice Comparison with web-llm

|               | web-llm (MLC)                        | MediaPipe                       |
| ------------- | ------------------------------------ | ------------------------------- |
| Smallest      | Qwen2.5-0.5B (~350 MB)               | Gemma-3 270M (~300 MB)          |
| Sweet spot    | Llama-3.2-1B (~700 MB)               | Gemma-3n E2B (~3 GB)            |
| Best quality  | Larger models available              | Gemma-3n E4B (~4.5 GB)          |
| Model variety | Wide (Llama, Qwen, Phi, Gemma, etc.) | Narrow (primarily Gemma family) |

**Key limitation**: MediaPipe's web model selection is much narrower than web-llm's. You're essentially limited to the Gemma family for chat, with Google controlling which models get web-optimized builds. Third-party/HuggingFace open-source SLMs (Phi, Qwen, Mistral, etc.) are **not currently convertible to the web format** — the web conversion pipeline is not publicly available.

---

## 4. Integration Feasibility for Joyce

### What Works Well

1. **CDN/ESM delivery**: The `.mjs` bundle + WASM assets on jsdelivr fit Joyce's import map pattern perfectly
2. **No build step**: Works as a direct ESM import, no bundler needed
3. **Static site compatible**: No backend required; models fetched client-side
4. **Familiar runtime**: Same WebGPU requirement as web-llm — targets the same browsers
5. **Small JS payload**: 57 KB bundle (much smaller than web-llm's ~1.5 MB)
6. **Token counting**: `sizeInTokens()` enables Joyce's token budgeting system

### Challenges & Concerns

1. **Model hosting**: Models are 300 MB - 4.5 GB. Can't bundle with the static site. Options:
   - Link directly to HuggingFace URLs (CORS may be an issue)
   - User downloads model file, loaded via File API
   - Cache in OPFS after first download (pattern from Google's own examples)

2. **Web Worker requirement**: Model loading blocks the main thread. Google strongly recommends running in a Web Worker. However, there's a **known issue** with ESM module workers — `importScripts()` doesn't work in module workers, and MediaPipe's WASM loader may have trouble in `type: "module"` workers. The `js_worker` example uses classic (non-module) workers with `importScripts()`.

3. **Callback vs async generator**: Joyce's provider interface uses `async *sendMessage()` generators. MediaPipe uses callbacks. This is easily bridged — wrap the callback in a Promise/generator pattern.

4. **No built-in multi-turn**: Must manually construct Gemma turn-formatted prompts. Joyce already does this for the Chrome provider, so the pattern exists.

5. **Narrow model selection**: Practically limited to Gemma-3n E2B/E4B for web. No ability to bring your own HuggingFace models unlike web-llm.

6. **LoRA support**: Available for Gemma-2 2B and Phi-2 (GPU only) — interesting for fine-tuning but not a primary concern for Joyce.

### Provider Interface Mapping

Joyce's required provider exports → MediaPipe implementation:

| Joyce Interface                     | MediaPipe Implementation                                                  |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `setLlmProgressCallback(model, cb)` | Monitor fetch progress of model download                                  |
| `getLlmEngine(model)`               | `FilesetResolver.forGenAiTasks()` + `LlmInference.createFromOptions()`    |
| `isLlmCached(model)`                | Check OPFS for cached model file                                          |
| `getCapabilities(model)`            | `{ supportsMultiTurn: true, supportsTokenTracking: true }`                |
| `createHandler(options)`            | Return object with `sendMessage()` wrapping `generateResponse()` callback |

### Streaming Bridge Pattern

```javascript
// Wrapping MediaPipe's callback API into Joyce's async generator pattern
async *sendMessage(prompt) {
  const chunks = [];
  let resolve;
  let promise = new Promise(r => { resolve = r; });

  llm.generateResponse(prompt, (partial, done) => {
    chunks.push(partial);
    const old = resolve;
    promise = new Promise(r => { resolve = r; });
    old();
    if (done) resolve(); // final signal
  });

  while (true) {
    await promise;
    while (chunks.length) {
      const content = chunks.shift();
      yield { type: "data", content };
    }
    if (llm.isIdle) {
      yield { type: "done", finishReason: "stop", usage: {} };
      break;
    }
  }
}
```

---

## 5. Comparison: MediaPipe vs Existing Providers

| Feature          | Chrome AI                 | web-llm                  | MediaPipe                           |
| ---------------- | ------------------------- | ------------------------ | ----------------------------------- |
| Setup complexity | Zero (built into browser) | Medium (model download)  | Medium-High (model download + WASM) |
| Model download   | None                      | 350 MB - 2 GB            | 300 MB - 4.5 GB                     |
| Model choice     | 1 (Gemini Nano)           | 10+ families             | ~4 Gemma variants                   |
| Quality ceiling  | Good (Gemini Nano)        | High (larger models)     | High (Gemma-3n E4B)                 |
| Browser support  | Chrome 138+ only          | Chrome, Edge (WebGPU)    | Chrome, Edge (WebGPU)               |
| Multi-turn       | Native (Prompt API)       | Native (OpenAI format)   | Manual prompt templating            |
| JS bundle size   | 0 KB                      | ~1.5 MB                  | 57 KB                               |
| Worker needed?   | No                        | No (runs in main thread) | Strongly recommended                |
| Offline capable  | Yes                       | Yes (after cache)        | Yes (after OPFS cache)              |

---

## 6. Recommendation

### Should Joyce add a MediaPipe provider?

**Cautious yes, with caveats.**

**Pros:**

- Gives access to Gemma-3n models, which are Google's latest and most capable small models
- Gemma-3n E2B is competitive quality-wise with the larger MLC models Joyce already supports
- Lightweight JS bundle (57 KB vs web-llm's 1.5 MB)
- Same WebGPU requirement as web-llm — no new browser constraints
- Google's on-device AI investment means continued model improvements

**Cons:**

- Model selection is very narrow (Gemma only, web variants only)
- Model files are large (3+ GB for the useful ones)
- The "deprecated" status creates uncertainty, though the practical risk is low
- Web Worker complexity for model loading
- No third-party model support (can't use HuggingFace SLMs like Phi, Qwen, Mistral)
- Overlaps with Chrome AI (both run Gemma/Gemini models from Google)

**When it makes most sense:**

- If Gemma-3n quality is meaningfully better than what web-llm offers at similar sizes
- If you want to offer Gemma-3n to non-Chrome browsers (Chrome AI is Chrome-only)
- As a "Google models on any WebGPU browser" option complementing Chrome AI

### Implementation Effort

Moderate. The provider interface is well-established in Joyce. Main work:

1. New provider file (~150-200 lines) following existing patterns
2. Web Worker setup for model loading (adds complexity vs other providers)
3. Model caching strategy (OPFS)
4. Prompt templating for Gemma turn format
5. Config entries in `shared-config.js`
6. Import map entry in `index.html`

---

## 7. Open Questions

1. **Model hosting**: Where would the 3+ GB model files live? Direct HuggingFace links? User-provided?
2. **Worker architecture**: Is the ESM module worker limitation a blocker, or can we use a classic worker?
3. **Chrome AI overlap**: Is there value in MediaPipe when Chrome AI already provides Gemini Nano for free? The main differentiator would be Gemma-3n on non-Chrome browsers.
4. **LiteRT-LM timeline**: When Google ships a web JS SDK for LiteRT-LM, should we wait for that instead?

---

## 8. Deep Dive: LiteRT-LM and the Deprecation Question

### Current State (March 2026)

LiteRT-LM is at **v0.9.0-alpha03**. It supports Kotlin, C++, Swift (in development), and Python (in development). **There is no JavaScript/web SDK, no GitHub issues tracking web support, and no published timeline for one.**

### How the Pieces Fit Together

Google's AI Edge stack has three layers:

1. **LiteRT** — Low-level on-device ML runtime (successor to TFLite). Converts PyTorch/JAX/TF models to `.tflite`.
2. **LiteRT-LM** — LLM-specific pipeline framework on top of LiteRT. Handles tokenization, KV caching, decoding. Uses `.litertlm` format (evolved from `.task` with better metadata/compression).
3. **MediaPipe GenAI Tasks** — High-level "just set temperature and go" APIs. The **web JS API** (`@mediapipe/tasks-genai`) lives at this layer.

The deprecation notice means: "prefer LiteRT-LM's native APIs (Kotlin/C++) for mobile." For web, MediaPipe JS is still the only option and Google's own Chrome demos use it.

### .litertlm vs .task Format

|             | `.task`                           | `.litertlm`                                                     |
| ----------- | --------------------------------- | --------------------------------------------------------------- |
| Origin      | MediaPipe's general bundle format | LiteRT-LM's LLM-specific format                                 |
| Contents    | TFLite model + metadata           | Model + tokenizer + generation config + compression metadata    |
| Web support | Yes (older models)                | Yes (newer models, `-Web` suffix required)                      |
| Conversion  | Public Python pipeline            | Web variants are "hand-crafted" by Google, not auto-convertible |

### Web Model Specifics

Web-suffixed `.litertlm` files are **not** just the same model repackaged — they have:

- Different prefill signature lengths tuned for browser constraints
- KV cache layout optimized for WebGPU execution
- WebAssembly compatibility baked in
- ~10% smaller than their non-web counterparts (e.g., E2B: 3.04 GB web vs 3.39 GB standard)
- **Not compatible** with LiteRT-LM's native runtime or tools like Model Explorer

### Risk Assessment

| Risk                       | Level       | Rationale                                                                     |
| -------------------------- | ----------- | ----------------------------------------------------------------------------- |
| MediaPipe JS API removed   | **Low**     | No replacement exists for web; Google still actively uses it                  |
| API surface changes        | **Low**     | Package at v0.10.26, stable for months                                        |
| Model format changes       | **Medium**  | `.litertlm` is still evolving; web variants are hand-crafted                  |
| LiteRT-LM gets web SDK     | **Low-Med** | No signs of imminent work; when it ships, migration should be straightforward |
| Better alternative emerges | **Medium**  | WebLLM/web-llm continues to mature; Chrome AI expanding                       |

### Recommendation

Build on `@mediapipe/tasks-genai` now. The deprecation is organizational, not functional. When LiteRT-LM eventually ships a web SDK, it will likely either wrap or replace the same underlying WASM engine, making migration a package swap rather than a rewrite.

---

## 9. Deep Dive: Model Hosting & Caching for Static Sites

### The Problem

MediaPipe's useful web models are 3-4.5 GB. Joyce is a static site on GitHub Pages. You can't bundle models in the repo, and users need to download them on first use.

### HuggingFace Direct Downloads

**CORS is the blocker.** HuggingFace does NOT serve model files with `Access-Control-Allow-Origin: *` headers. Direct `fetch()` from a different origin (like GitHub Pages) will fail.

**Workarounds:**

1. **HuggingFace `resolve` URLs** — Some HuggingFace endpoints may work, but CORS is inconsistent
2. **User-provided file** — User downloads the model manually, loads via `<input type="file">` or drag-and-drop
3. **Proxy/CDN** — Host models on a CORS-enabled CDN (e.g., Cloudflare R2, S3 + CloudFront)
4. **Kaggle** — MediaPipe's own demos use Kaggle-hosted models, which may have better CORS support

### OPFS (Origin Private File System) Caching

OPFS is the recommended caching strategy for multi-GB model files. It's what Google's own MediaPipe TypeScript sample uses.

**How it works:**

```
First load:  fetch(model_url) → ReadableStream → tee() → [consumer, OPFS writer]
Next loads:  OPFS read → consumer (no network)
```

**Key characteristics:**

- **Performance**: 3-4x faster than IndexedDB for large files
- **Size limits**: Subject to browser quota (typically several GB, varies by device/browser)
- **Browser support**: Chrome 86+, Edge 86+, Firefox 111+, Safari 15.2+
- **Persistence**: Survives browser restart, but not "Clear Site Data"
- **Worker access**: Synchronous `FileSystemSyncAccessHandle` available only in Web Workers (faster); async API on main thread

**OPFS caching pattern (from MediaPipe's `opfs_cache.ts`):**

```javascript
async function loadModelWithCache(modelUrl) {
  const root = await navigator.storage.getDirectory();
  const modelDir = await root.getDirectoryHandle("models", { create: true });

  try {
    // Try cache first
    const cached = await modelDir.getFileHandle("gemma-3n-e2b.litertlm");
    const file = await cached.getFile();
    if (file.size === expectedSize) {
      return file.stream().getReader(); // Cache hit
    }
  } catch {
    /* cache miss */
  }

  // Download and cache simultaneously
  const response = await fetch(modelUrl);
  const [consumerStream, cacheStream] = response.body.tee();

  // Write to OPFS in background
  const cacheFile = await modelDir.getFileHandle("gemma-3n-e2b.litertlm", {
    create: true,
  });
  const writable = await cacheFile.createWritable();
  cacheStream.pipeTo(writable); // Fire-and-forget

  return consumerStream.getReader(); // Stream to MediaPipe immediately
}
```

### Comparison: Caching Strategies

| Strategy                   | Max Size               | Speed                | Browser Support                   | Best For                                |
| -------------------------- | ---------------------- | -------------------- | --------------------------------- | --------------------------------------- |
| **OPFS**                   | Device-dependent (GB+) | Fastest              | Chrome 86+, FF 111+, Safari 15.2+ | Large model files                       |
| **Cache API**              | ~50% of free disk      | Fast                 | All modern                        | HTTP response caching                   |
| **IndexedDB**              | ~50% of free disk      | Slow for large blobs | All modern                        | Structured data, not ideal for GB files |
| **Service Worker + Cache** | Same as Cache API      | Fast                 | All modern                        | Offline-first patterns                  |

### How web-llm Does It (for comparison)

web-llm uses the **Cache API** to store model shards as Request/Response pairs. Joyce already has a fallback to IndexedDB for iOS Chrome/WebKit where Cache API is restricted. OPFS would be a new caching layer specific to the MediaPipe provider.

### Progress Tracking

For a 3 GB download, progress feedback is essential:

```javascript
const response = await fetch(modelUrl);
const total = +response.headers.get("Content-Length");
const reader = response.body.getReader();
let received = 0;

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  received += value.length;
  progressCallback(received / total); // 0.0 → 1.0
  // Write chunk to OPFS + feed to MediaPipe
}
```

This maps directly to Joyce's `setLlmProgressCallback(model, cb)` interface.

### Recommended Approach for Joyce

1. **Primary**: Try to fetch from a known model URL (HuggingFace resolve endpoint or configured CDN)
2. **Fallback**: Allow user to load a local file via File API
3. **Cache**: Store in OPFS after first successful load
4. **Progress**: Report download progress through Joyce's existing callback system
5. **Validation**: Store file size metadata alongside cached model for integrity checks

---

## 10. Deep Dive: Web Worker Architecture

### The ESM Module Worker Problem

MediaPipe's WASM loader uses `importScripts()` internally. ES module workers (`new Worker(url, { type: 'module' })`) do not support `importScripts()` — they use `import` statements instead. This is a fundamental incompatibility.

**GitHub Issue [#5257](https://github.com/google-ai-edge/mediapipe/issues/5257)**: A PR (#5278) attempted to add `import()` fallback, but wasn't merged. The MediaPipe team acknowledged their "build pipeline is pretty complicated due to how our internal JS compiler is set up."

### Solution: Classic Worker + Dynamic Import Bridge

Joyce's main app is pure ESM, but the MediaPipe worker file must be a **classic script**. This is not a conflict — you can launch a classic worker from ESM code, and classic workers support dynamic `import()` for loading helper modules.

```
┌──────────────────────────────────┐
│  mediapipe.js (ESM provider)     │  ← Joyce's provider module
│  const worker = new Worker(      │
│    "./mediapipe-worker.js"       │  ← Classic worker (no { type: 'module' })
│  );                              │
└──────────┬───────────────────────┘
           │ postMessage / onmessage
┌──────────▼───────────────────────┐
│  mediapipe-worker.js (classic)   │
│  importScripts("...genai...");   │  ← MediaPipe WASM bundle
│  const helpers = await import(   │
│    "./mediapipe-helpers.js"      │  ← Dynamic ESM import works in classic workers!
│  );                              │
└──────────────────────────────────┘
```

**Key insight**: `importScripts()` and dynamic `import()` coexist in classic workers. The worker file itself uses `importScripts()` for MediaPipe (which requires it), while using dynamic `import()` for any Joyce helper modules that are written as ESM.

### Message Protocol

Based on MediaPipe's official samples and Joyce's provider interface:

```javascript
// ── Main Thread → Worker ──────────────────────────

// Initialize engine
worker.postMessage({
  type: "init",
  modelUrl: "https://...", // or modelBuffer for File API
  maxTokens: 1024,
  temperature: 0.8,
});

// Generate (streaming)
worker.postMessage({
  type: "generate",
  prompt: "<start_of_turn>user\n...", // Pre-formatted Gemma prompt
});

// Cancel
worker.postMessage({ type: "cancel" });

// Cleanup
worker.postMessage({ type: "close" });

// ── Worker → Main Thread ──────────────────────────

// Init progress (model download)
self.postMessage({ type: "progress", value: 0.45 });

// Init complete
self.postMessage({ type: "ready" });

// Streaming token
self.postMessage({ type: "token", content: "Hello" });

// Generation complete
self.postMessage({ type: "done" });

// Error
self.postMessage({ type: "error", message: "WebGPU not available" });
```

### Transferring Model Data

For user-provided model files (File API):

```javascript
// Main thread: read file as ArrayBuffer, transfer (zero-copy) to worker
const buffer = await file.arrayBuffer();
worker.postMessage({ type: "init", modelBuffer: buffer }, [buffer]);

// Worker: use createFromModelBuffer
const llm = await LlmInference.createFromModelBuffer(genai, {
  modelAssetBuffer: modelBuffer,
  // ...options
});
```

`ArrayBuffer` transfer via the second argument to `postMessage()` is zero-copy — the buffer moves to the worker without duplication.

For URL-based loading, the worker fetches the model itself (no transfer needed).

### SharedArrayBuffer / COOP-COEP

**Not required.** MediaPipe's LLM inference doesn't need SharedArrayBuffer for basic text generation. The worker communicates via message passing, not shared memory.

If needed in the future, GitHub Pages does NOT set COOP/COEP headers and provides no way to configure them. You'd need a custom domain with a proxy (e.g., Cloudflare Worker) that injects the headers. But this is **not a concern for the MediaPipe provider**.

### Architectural Comparison with Existing Providers

|                  | Chrome AI      | web-llm         | MediaPipe (proposed)        |
| ---------------- | -------------- | --------------- | --------------------------- |
| Thread model     | Main thread    | Main thread     | Web Worker (required)       |
| Engine lifecycle | Session-scoped | Cached globally | Cached in worker            |
| Module type      | ESM            | ESM             | Classic worker + ESM bridge |
| New files needed | 0              | 0               | 2 (provider + worker)       |

### Implementation Sketch

**File: `public/local/data/api/providers/mediapipe.js`** (ESM, ~150 lines)

- Exports: `setLlmProgressCallback`, `getLlmEngine`, `isLlmCached`, `getCapabilities`, `createHandler`
- Creates and manages the classic worker
- Bridges worker messages to Joyce's async generator interface
- Handles OPFS cache checks for `isLlmCached`

**File: `public/local/data/api/providers/mediapipe-worker.js`** (classic script, ~80 lines)

- `importScripts()` loads MediaPipe from CDN
- Handles init (WASM + model loading), generate (streaming), cancel, close
- Posts progress/token/done/error messages back

---

## Sources

- [MediaPipe LLM Inference Web JS Guide](https://ai.google.dev/edge/mediapipe/solutions/genai/llm_inference/web_js)
- [MediaPipe LLM Inference Overview](https://ai.google.dev/edge/mediapipe/solutions/genai/llm_inference)
- [MediaPipe JS Worker Sample](https://github.com/google-ai-edge/mediapipe-samples/tree/main/examples/llm_inference/js_worker)
- [MediaPipe TypeScript Chat Sample](https://github.com/google-ai-edge/mediapipe-samples/tree/main/examples/llm_inference/llm_chat_ts)
- [LiteRT-LM GitHub](https://github.com/google-ai-edge/LiteRT-LM)
- [LiteRT-LM Blog Post](https://developers.googleblog.com/on-device-genai-in-chrome-chromebook-plus-and-pixel-watch-with-litert-lm/)
- [litert-community on HuggingFace](https://huggingface.co/litert-community)
- [Web vs Regular Model Discussion](https://huggingface.co/google/gemma-3n-E2B-it-litert-lm/discussions/6)
- [@mediapipe/tasks-genai on npm](https://www.npmjs.com/package/@mediapipe/tasks-genai)
- [@mediapipe/tasks-genai on jsdelivr](https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@0.10.26/)
- [MediaPipe ESM Worker Issue #5257](https://github.com/google-ai-edge/mediapipe/issues/5257)
- [Convert HF SafeTensors to MediaPipe Task](https://ai.google.dev/gemma/docs/conversions/hf-to-mediapipe-task)
- [LiteRT-LM Overview](https://ai.google.dev/edge/litert-lm/overview)
- [LiteRT for Web (LiteRT.js)](https://ai.google.dev/edge/litert/web)
- [Origin Private File System - web.dev](https://web.dev/articles/origin-private-file-system)
- [OPFS - MDN](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
- [ES modules in service workers - web.dev](https://web.dev/articles/es-modules-in-sw)
- [Module workers - web.dev](https://web.dev/articles/module-workers)
- [MediaPipe ESM Worker in Samples Issue #174](https://github.com/google-ai-edge/mediapipe-samples/issues/174)
- [Google Developers Blog: On-device GenAI with LiteRT-LM](https://developers.googleblog.com/on-device-genai-in-chrome-chromebook-plus-and-pixel-watch-with-litert-lm/)
