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

## Gemma 4 WebGPU Memory Limits

The Gemma 4 E2B/E4B ONNX models (`@huggingface/transformers` + WebGPU) hit browser memory limits at modest token counts. The practical input limit is **~3500-4096 tokens** depending on hardware, even on machines with 32GB+ RAM.

### Why It Happens

Three factors compound to cause OOM errors well below the model's 128K spec:

**1. Per-Layer Embeddings (PLE)** -- Gemma 4's novel architecture gives every decoder layer its own small embedding for every token. The `per_layer_inputs` tensor shape is `[batch, seq_len, 35, 256]` in Float32:

| Input Tokens | PLE Tensor Size |
| ------------ | --------------- |
| 2,048        | 70 MB           |
| 4,096        | 140 MB          |
| 6,288        | 215 MB          |
| 8,192        | 280 MB          |

Cost: ~35 KB per input token in this single tensor alone.

**2. Global Attention Layers** -- Gemma 4 E2B has 35 layers (28 sliding-window, 7 global). The 7 global layers compute full quadratic attention (`seq x seq`). Peak memory for a single global layer's attention scores:

| Input Tokens | Attention Peak (1 layer, 8 heads, f32) |
| ------------ | -------------------------------------- |
| 4,096        | ~512 MB                                |
| 6,288        | ~1.2 GB                                |

**3. Chrome WebGPU Memory Budget** -- Chrome caps aggregate GPU memory per WebGPU device at roughly **4-6 GB** (undocumented, empirically observed). This is separate from macOS Metal's `recommendedMaxWorkingSetSize` (~65% of RAM). The model weights (~1.5 GB at q4f16) plus PLE plus attention plus KV cache plus ONNX Runtime buffer pool must all fit within this cap.

### Memory Budget at Prefill Time

| Component                            | At 4,096 tokens | At 6,288 tokens |
| ------------------------------------ | --------------- | --------------- |
| Model weights (q4f16)                | ~1.5 GB         | ~1.5 GB         |
| per_layer_inputs (PLE)               | ~140 MB         | ~215 MB         |
| inputs_embeds                        | ~24 MB          | ~37 MB          |
| Global attention peak (single layer) | ~512 MB         | ~1.2 GB         |
| KV cache + activations + ORT buffers | ~200-400 MB     | ~200-400 MB     |
| **Estimated total peak**             | **~2.0-2.5 GB** | **~3.0-3.4 GB** |

At 4,096 tokens the peak fits within Chrome's ~4-6 GB budget. At 6,288 tokens the attention peak alone nearly doubles, pushing past the limit.

### Current Configuration

- `maxTokens: 4096` -- safe default in `shared-config.js`, controls RAG context budget
- `specMaxTokens: 131072` -- model's actual 128K spec limit (exposed via Settings > Context Size Override)
- `MAX_OUTPUT_TOKENS: 1024` -- limits generation length; each output token adds to KV cache
- The HuggingFace Gemma 4 WebGPU demo uses `max_new_tokens: 512`
- Google's own LiteRT benchmarks use 1024 prefill tokens with 2048 context length

### Unaligned Access Error (~5000-6000 tokens)

A separate error occurs in the ~5000-6000 token range, distinct from the OOM at ~6288:

```
RuntimeError: operation does not support unaligned accesses
```

This is a **WebAssembly error**, not a WebGPU error. ONNX Runtime Web runs a hybrid architecture: GPU kernels on WebGPU, but orchestration and memory management in Emscripten-compiled WASM with pthreads. The WASM spec mandates that atomic operations (used by pthread mutexes) must be naturally aligned -- misaligned atomics trap immediately.

**Root cause**: WASM heap memory corruption under pressure from larger tensors. At higher sequence lengths, intermediate buffers grow, WASM heap grows via `ALLOW_MEMORY_GROWTH`, and Emscripten's pthreads + memory growth combination is [documented as "especially tricky"](https://emscripten.org/docs/porting/pthreads.html). When heap corruption garbles a mutex pointer, the next atomic operation at that address traps. This pattern was confirmed in [emscripten#19040](https://github.com/emscripten-core/emscripten/issues/19040).

**Known related fixes**:

- [onnxruntime#23677](https://github.com/microsoft/onnxruntime/issues/23677) -- incorrect alignment for u32 in uniform buffer (fixed Feb 2025)
- [onnxruntime#23663](https://github.com/microsoft/onnxruntime/pull/23663) -- MatMulNBits prefill shader race condition
- [onnxruntime#26732](https://github.com/microsoft/onnxruntime/issues/26732) -- q4f16 Gemma models produce invalid outputs on WebGPU

**Practical takeaway**: The 4096 default stays safely below both the OOM ceiling (~6288 tokens) and the unaligned access threshold (~5000-6000 tokens). These are upstream ONNX Runtime bugs that may improve with future releases.

### Potential Future Improvements

- **Float16 PLE tensors** -- would halve the ~140 MB to ~70 MB at 4096 tokens (requires upstream ONNX export changes)
- **Chunked prefill** -- process input in chunks instead of all at once (not yet supported by transformers.js)
- **Chrome WebGPU budget increases** -- Chrome 133 raised maxBufferSize to 4GB; total budget may increase in future versions
- **ONNX Runtime GenAI** -- native Gemma 4 support tracked in [onnxruntime-genai#2062](https://github.com/microsoft/onnxruntime-genai/issues/2062) may handle memory more efficiently

### References

- [Gemma 4 PLE architecture (HF blog)](https://huggingface.co/blog/gemma4)
- [PLE implementation details (transformers#45206)](https://github.com/huggingface/transformers/issues/45206)
- [Gemma 4 in ONNX Runtime GenAI (onnxruntime-genai#2062)](https://github.com/microsoft/onnxruntime-genai/issues/2062)
- [Chrome 133 WebGPU maxBufferSize](https://developer.chrome.com/blog/new-in-webgpu-133)
- [WebGPU memory limits discussion (gpuweb#1371)](https://github.com/gpuweb/gpuweb/issues/1371)
- [ONNX Runtime WebGPU buffer allocation (onnxruntime#20038)](https://github.com/microsoft/onnxruntime/issues/20038)

## NPM Commands

Regenerate embeddings files from posts.json. (Should be run whenever `posts.json` is updated). We presently use the `Xenova/gte-small` embeddings model. This generates multiple files based on chunk sizes configured in `shared-config.js`.

```sh
$ npm run data:embeddings
```
