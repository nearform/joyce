# Research

Findings from evaluating technology for this project. Kept separate from [data.md](./data.md),
which documents the data we actually ship and use.

## LiteRT-LM: web model constraints

Findings from evaluating Google's [LiteRT-LM Web API](https://developers.google.com/edge/litert-lm/js)
(`@litert-lm/core@0.15.0`) as a provider, measured 2026-08-06/07 on desktop Chrome 151 and Safari
26 / macOS (WebGPU `maxBufferSize` 4096 MB, `shader-f16` + `subgroups` available).

### The `-web` packaging is required, not cosmetic

The `GPU_ARTISAN` backend loads a model by streaming it section by section. Plain `.litertlm`
builds — the ones targeting Android/desktop — contain sections its streaming loader can't parse,
and fail immediately:

```
Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm  ->  Streaming LlmExecutorMetadata section is not supported yet.
qwen3_0.6b_q4_block32_ekv1280.litertlm    ->  Streaming HF_Tokenizer_Zlib section is not supported yet.
```

Only `-web.litertlm` files work, and across all 243 HuggingFace repos tagged `library=litert-lm`
exactly five exist — all Gemma 4, the smallest 2008 MB. Third-party uploads named `-web` (e.g.
`Tdamre/MiniCPM5-1B-web.litertlm`) are byte-identical renames of their non-web siblings and fail
the same way. The Gemma 3 LiteRT repos are additionally `gated: auto` on HuggingFace — they 401
without an auth token, so a static site cannot fetch them at all.

### Backend availability on web

Enum: `UNSPECIFIED=0 CPU_ARTISAN=1 GPU_ARTISAN=2 CPU=3 GPU=4 GOOGLE_TENSOR_ARTISAN=5 NPU=6`.

| Backend       | Status                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------- |
| `GPU_ARTISAN` | The real path. Streams weights to the GPU; no wasm-heap copy. Default, and the only one.  |
| `CPU`         | Works, but copies the whole model into the wasm heap first — impossible at 2 GB.          |
| `CPU_ARTISAN` | Not compiled into the web wasm build — throws `Unsupported backend: 1`.                   |
| `GPU`         | **Crashes the tab.** No compiled executor; walks into a null function pointer. Never use. |

### Why there is no mobile tier

Small plain `.litertlm` models _do_ run on the `CPU` backend, so a mobile tier looked plausible:

| Model                             |    Size |   Load | Prefill |     Decode |
| --------------------------------- | ------: | -----: | ------: | ---------: |
| `Qwen3-0.6B_dynamic_wi4b32_afp32` |  328 MB | 15.5 s | 4 tok/s |  7.5 tok/s |
| `MiniCPM5-1B`                     | 1103 MB | 88.5 s | 8 tok/s | 21.4 tok/s |

Decode is tolerable; **prefill is the blocker**. Joyce is RAG-first, so every turn prefills a
context of a few thousand tokens — at 4-8 tok/s that is minutes before the first token, on a
desktop. A phone would be worse. So `LITERT_CHAT_MOBILE` is empty and `LITERT_POSSIBLE` gates the
provider off on mobile; web-llm continues to serve that tier.

### Ways around the 2 GB floor: all closed (measured, do not retry)

The `-web` requirement was attacked directly, not just worked around. Every route is dead:

| Attempt                                                                                                          | Result                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Backend.GPU` (enum 4) via the public API — non-streaming VFS load onto the registered "GPU WebGPU" accelerator  | **Crashes.** Null function pointer on one model, hard tab kill on the next. The enum entry exists but its executor is not compiled into the web wasm. Never expose this backend.    |
| Raw-wasm bypass — `ModelAssets.create(vfsPath)` + `Engine.createEngine()` to force GPU_ARTISAN without streaming | `Unsupported backend: 2`. The artisan executor is bound to the streaming constructor in the C++ build; the JS coupling (`isStreaming = backend === GPU_ARTISAN`) merely mirrors it. |
| `Backend.CPU_ARTISAN`                                                                                            | `Unsupported backend: 1`. Not in the web build.                                                                                                                                     |
| Wider model hunt — 658 HuggingFace repos swept by tag, name, and full-text search                                | Only Gemma 4 and Gemma 3n `-web` builds exist; everything else is a mirror. Nothing small.                                                                                          |
| Newer runtime                                                                                                    | `0.15.0` is latest (2026-07-31). No pending fix.                                                                                                                                    |

So the web wasm supports exactly two working combinations: **GPU_ARTISAN + streaming** (needs `-web` packaging, 2 GB floor) and **CPU + VFS** (any `.litertlm`, but prefill-bound).

The only theoretical remaining path is repackaging a small model into a streamable bundle ourselves. The streaming loader rejects specific section types by name (`LlmExecutorMetadata`, `HF_Tokenizer_Zlib` — note the compressed tokenizer), so a `-web` build is one whose sections are all streamable. Doing that means Python `litert-torch` tooling, undocumented format knowledge, and hosting custom model builds forever. Not worth it. Revisit if Google adds streaming support for more section types.

For a real mobile tier the alternative is MediaPipe `@mediapipe/tasks-genai` as a separate provider: `gemma3-270m-it-q4_0-web.task` (249 MB) and `gemma3-1b-it-int4-web.task` (700 MB), available ungated from the `72fstudio/gemma-3-1b-it` and `WilburDev/gemma3-1b-it-int4` mirrors (the `litert-community` originals are `gated: auto`).

### Reproducing this

Measured with a throwaway page under `public/` (deleted after the fact — these findings are the
artifact, not the harness). To re-check when a new `@litert-lm/core` ships, a page needs only:

1. An import map entry for `@litert-lm/core`, then `await loadLiteRtLm(LITERT_WASM_URL)`.
2. `Engine.create({ model: <Blob>, backend, mainExecutorSettings: { maxNumTokens } })` per
   (model x backend) pair, then `createConversation()` and `sendMessageStreaming()`.
3. Read the stream with an explicit `getReader()` loop — Safari has no `ReadableStream`
   async iteration, so `for await...of` throws there.
4. Cache downloads in the Cache API. Re-fetching a multi-GB file per attempt trips what looks like
   HuggingFace throttling and produces bogus `TypeError: network error` rows.

The signal to watch for is the error string. `Streaming <Section> section is not supported yet`
means the model isn't `-web`-packaged; `Unsupported backend: N` means that executor isn't in the
wasm build at all.

### Runtime notes

- No `SharedArrayBuffer` / cross-origin isolation needed — the wasm builds contain none and the
  engine forces single-threaded execution. Works on GitHub Pages with no COOP/COEP headers.
- `maxNumTokens` (`LITERT_MAX_TOKENS` in `shared-config.js`) is a KV-cache budget we choose, not a
  model ceiling — Gemma 4 supports 32k. Bigger cache costs GPU memory on top of ~1.8 GB of weights.
- LiteRT-LM caches nothing itself; `litert-cache.js` owns download, progress, and the Cache API.
