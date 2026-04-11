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
