// wllama provider — in-browser llama.cpp via WebGPU + WASM, loading GGUFs
// directly from HuggingFace. Uses @wllama/wllama v3.2.3 (OpenAI-compatible
// chat completions, async-iterable streaming).
//
// References:
//   https://github.com/ngxson/wllama  (upstream)
//   https://github.com/reeselevine/wllama  (WebGPU fork — fallback if upstream regresses)
import { Wllama } from "@wllama/wllama";
import { getModelCfg } from "../../../../config.js";
import { estimateTokens } from "../../util.js";

// wllama's `wasm-from-cdn.js` helper ships only as a .d.ts in v3.2.3 — the
// .js is missing on jsdelivr. The shape is trivial, so we inline the CDN URL
// the helper would have produced.
const WLLAMA_VERSION = "3.2.3";
const WASM_CDN_PATH = {
  default: `https://cdn.jsdelivr.net/npm/@wllama/wllama@${WLLAMA_VERSION}/src/wasm/wllama.wasm`,
};

const engines = new Map();

export const setLlmProgressCallback = (model, cb) => {
  if (!engines.has(model)) {
    engines.set(model, { enginePromise: null, progressCallback: null });
  }
  engines.get(model).progressCallback = cb;
};

const buildEngine = async (model, entry) => {
  const cfg = getModelCfg({ provider: "wllama", model });
  if (!cfg.repo || !cfg.file) {
    throw new Error(
      `wllama model "${model}" missing required "repo" / "file" config`,
    );
  }

  const wllama = new Wllama(WASM_CDN_PATH, { parallelDownloads: 3 });

  await wllama.loadModelFromHF(
    { repo: cfg.repo, file: cfg.file },
    {
      n_ctx: cfg.maxTokens ?? 8192,
      progressCallback: ({ loaded, total }) => {
        if (!total) return;
        const ratio = loaded / total;
        entry.progressCallback?.({
          text: `Downloading model: ${Math.round(ratio * 100)}%`,
          progress: ratio,
        });
      },
    },
  );

  // Reflect the actually-allocated context window back into the shared model
  // config so chat-session's token budgeting matches reality. wllama may have
  // clamped our request, and we'd rather report the real n_ctx than a guess.
  // Mutation takes effect for the NEXT createChatSession; the in-flight one
  // captured maxTokens at session start.
  try {
    const info = wllama.getLoadedContextInfo();
    const trained = wllama.getModelMetadata()?.hparams?.nCtxTrain;
    if (info?.n_ctx) {
      cfg.maxTokens = info.n_ctx;
      cfg._nCtxTrain = trained ?? null;
    }
  } catch {
    /* older wllama or model with no metadata — keep configured value */
  }

  entry.progressCallback?.({ text: "Model ready", progress: 1 });
  return wllama;
};

export const getLlmEngine = async (model) => {
  if (!engines.has(model)) {
    engines.set(model, { enginePromise: null, progressCallback: null });
  }
  const entry = engines.get(model);
  if (!entry.enginePromise) {
    entry.enginePromise = buildEngine(model, entry).catch((err) => {
      entry.enginePromise = null; // allow retry
      throw err;
    });
  }
  return entry.enginePromise;
};

export const isLlmCached = async (model) => {
  const entry = engines.get(model);
  return !!(
    entry?.enginePromise &&
    (await entry.enginePromise.then(
      (w) => w.isModelLoaded(),
      () => false,
    ))
  );
};

export const getCapabilities = () => ({
  supportsMultiTurn: true,
  supportsTokenTracking: true,
});

// Many GGUF chat templates (Gemma in particular) reject `system` role and
// require strict user/assistant alternation. Joyce sends
// [system, assistant_context, assistant_links, ...history, user] so we
// coalesce system → user and merge consecutive same-role messages.
const normalizeMessages = (messages) => {
  const remapped = messages.map((m) =>
    m.role === "system" ? { role: "user", content: m.content } : m,
  );
  const merged = [];
  for (const msg of remapped) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      prev.content = `${prev.content}\n\n${msg.content}`;
    } else {
      merged.push({ role: msg.role, content: msg.content });
    }
  }
  return merged;
};

export const createHandler = async ({
  model,
  temperature,
  maxOutputTokens,
}) => {
  const engine = await getLlmEngine(model);

  return {
    async *sendMessage(messages) {
      let assistantContent = "";
      let finishReason = null;
      let usage = null;

      const iterable = await engine.createChatCompletion({
        messages: normalizeMessages(messages),
        stream: true,
        temperature,
        max_tokens: maxOutputTokens,
        // StreamParams requires onData; we consume the async iterable instead,
        // so the callback is a no-op.
        onData: () => {},
      });

      for await (const chunk of iterable) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          assistantContent += delta;
          yield { type: "data", content: delta };
        }
        if (chunk.choices?.[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }
        if (chunk.usage) usage = chunk.usage;
      }

      yield {
        type: "done",
        finishReason: finishReason || "stop",
        usage: {
          inputTokens:
            usage?.prompt_tokens ??
            estimateTokens(messages.map((m) => m.content).join(" ")),
          outputTokens:
            usage?.completion_tokens ?? estimateTokens(assistantContent),
          assistantContent,
        },
      };
    },

    destroy() {
      // Engine is cached across handlers; per-session cleanup is a no-op.
      // Call engine.exit() only if/when the user explicitly evicts the model.
    },
  };
};
