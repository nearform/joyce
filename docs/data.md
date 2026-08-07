# Data

## Data Files

| File                                    | Description                                         |
| --------------------------------------- | --------------------------------------------------- |
| `public/data/posts.json`                | Source blog post data                               |
| `public/data/posts-embeddings-256.json` | Pre-computed embeddings (256 token chunks, default) |
| `public/data/posts-embeddings-512.json` | Pre-computed embeddings (512 token chunks)          |

_Note_: The source blog post data comes from a separate process -- scraping the public website, converting to JSON, and adding the category labels.

## Orama Databases

At runtime, two [Orama](https://docs.oramasearch.com/docs/orama-js) databases are created in-browser:

- **postsDb** — Full-text search on post metadata (title, authors, categories, etc.)
- **chunksDb** — Vector search using 384-dimension embeddings from `gte-small`

See `public/local/data/api/search.js` for the schema and initialization.

## NPM Commands

Regenerate embeddings files from posts.json. (Should be run whenever `posts.json` is updated). We presently use the `Xenova/gte-small` text embedding model. This generates multiple files based on chunk sizes configured in `shared-config.js`.

```sh
$ npm run data:embeddings
```

## LiteRT-LM model constraints

Findings from evaluating Google's [LiteRT-LM Web API](https://developers.google.com/edge/litert-lm/js)
(`@litert-lm/core`) as a provider, measured 2026-08-06 on desktop Chrome 151 / macOS
(WebGPU `maxBufferSize` 4096 MB, `shader-f16` + `subgroups` available).

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

| Backend       | Status                                                                           |
| ------------- | -------------------------------------------------------------------------------- |
| `GPU_ARTISAN` | The real path. Streams weights to the GPU; no wasm-heap copy. Default.           |
| `CPU`         | Works, but copies the whole model into the wasm heap first — impossible at 2 GB. |
| `CPU_ARTISAN` | Not compiled into the web wasm build — throws `Unsupported backend: 1`.          |

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

### Runtime notes

- No `SharedArrayBuffer` / cross-origin isolation needed — the wasm builds contain none and the
  engine forces single-threaded execution. Works on GitHub Pages with no COOP/COEP headers.
- `maxNumTokens` (`LITERT_MAX_TOKENS` in `shared-config.js`) is a KV-cache budget we choose, not a
  model ceiling — Gemma 4 supports 32k. Bigger cache costs GPU memory on top of ~1.8 GB of weights.
- LiteRT-LM caches nothing itself; `litert-cache.js` owns download, progress, and the Cache API.
