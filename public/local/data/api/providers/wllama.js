// wllama provider — in-browser llama.cpp via WebGPU + WASM, loading GGUFs
// directly from HuggingFace.
//
// Using the @reeselevine/wllama-webgpu fork rather than upstream @wllama/wllama.
// Reasoning: the fork ships separate JSPI and asyncify WASM builds which give
// better iOS Safari / iOS Chrome compatibility (upstream crashed on iOS Chrome
// in our testing). The fork is also the implementation behind the
// llamas-on-the-web demo, where iOS support has been actively iterated on.
//
// API differences vs upstream worth knowing:
//   * loadModelFromHF takes (repo, file, params) positional, not ({repo, file}, params).
//   * createChatCompletion takes (messages, options) positional.
//   * Stream chunks are { token, piece, currentText } — NOT OpenAI-style deltas.
//   * Sampling lives under options.sampling.temp (not options.temperature).
//   * No usage stats from the chunks; we estimate tokens ourselves.
/* global console:false, performance:false, setInterval:false, clearInterval:false */
import { Wllama } from "@reeselevine/wllama-webgpu";
import WasmFromCDN from "@reeselevine/wllama-webgpu/esm/wasm-from-cdn.js";
import { Template } from "@huggingface/jinja";
import { getModelCfg } from "../../../../config.js";
import { estimateTokens } from "../../util.js";
import { hasWebGPU } from "../capacity.js";

// ChatML-ish fallback when the model has no chat_template metadata.
const DEFAULT_CHAT_TEMPLATE =
  "{% for message in messages %}{{'<|im_start|>' + message['role'] + '\\n' + message['content'] + '<|im_end|>' + '\\n'}}{% endfor %}{% if add_generation_prompt %}{{ '<|im_start|>assistant\\n' }}{% endif %}";

// Render Joyce's messages through the loaded model's embedded Jinja chat
// template. This mirrors llamas-on-the-web/src/chat.ts — bypassing
// createChatCompletion in favor of createCompletion(prompt) gives us a
// streaming path that actually fires onNewToken reliably on this fork.
const formatChat = async (wllama, messages) => {
  const templateStr = wllama.getChatTemplate() ?? DEFAULT_CHAT_TEMPLATE;
  const template = new Template(templateStr);
  const bosToken = await wllama.detokenize([wllama.getBOS()], true);
  const eosToken = await wllama.detokenize([wllama.getEOS()], true);
  return template.render({
    messages,
    bos_token: bosToken,
    eos_token: eosToken,
    add_generation_prompt: true,
  });
};

// Flip to false once we trust the streaming path.
const DEBUG = true;
const dbg = (...args) => DEBUG && console.log("[wllama]", ...args);

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

  // The fork's `backend` defaults to 'cpu' — must explicitly opt into WebGPU.
  const backend = hasWebGPU() ? "webgpu" : "cpu";
  dbg("constructing Wllama", { backend });
  const wllama = new Wllama(WasmFromCDN, { backend });

  await wllama.loadModelFromHF(cfg.repo, cfg.file, {
    n_ctx: cfg.maxTokens ?? 8192,
    progressCallback: ({ loaded, total }) => {
      if (!total) return;
      const ratio = loaded / total;
      entry.progressCallback?.({
        text: `Downloading model: ${Math.round(ratio * 100)}%`,
        progress: ratio,
      });
    },
  });

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
    dbg("model loaded", {
      n_ctx: info?.n_ctx,
      n_ctx_train: trained,
      usingWebGPU: wllama.usingWebGPU?.(),
      isMultithread: wllama.isMultithread?.(),
    });
  } catch {
    /* older fork build — keep configured value */
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
      const normalized = normalizeMessages(messages);
      const nPredict = maxOutputTokens ?? 1024;

      dbg("sendMessage called", {
        rawMessageCount: messages.length,
        normalizedCount: normalized.length,
        normalizedRoles: normalized.map((m) => m.role),
        normalizedLengths: normalized.map((m) => m.content.length),
        nPredict,
        temperature,
      });

      const t0 = performance.now();
      const prompt = await formatChat(engine, normalized);
      dbg("prompt rendered", {
        promptChars: prompt.length,
        promptPreview: prompt.slice(0, 120),
        templateMs: Math.round(performance.now() - t0),
      });

      // Bridge wllama's onNewToken callback to our async generator via a
      // push/pull queue. createCompletion's promise resolves with the final
      // text once generation completes (or aborts).
      const queue = [];
      const waiters = [];
      let done = false;
      let firstChunkAt = null;
      let assistantContent = "";
      let tokenCount = 0;

      const push = (item) => {
        if (waiters.length) waiters.shift()(item);
        else queue.push(item);
      };
      const pull = () =>
        queue.length
          ? Promise.resolve(queue.shift())
          : new Promise((resolve) => waiters.push(resolve));

      const heartbeat = setInterval(() => {
        if (firstChunkAt === null) {
          dbg(
            `still awaiting first chunk... ${Math.round((performance.now() - t0) / 1000)}s elapsed`,
          );
        }
      }, 2000);

      const generation = engine
        .createCompletion(prompt, {
          nPredict,
          sampling: {
            temp: temperature,
            top_k: 40,
            top_p: 0.9,
          },
          onNewToken: (_token, _piece, currentText) => {
            if (firstChunkAt === null) {
              firstChunkAt = performance.now();
              clearInterval(heartbeat);
              dbg("first token received", {
                ttftMs: Math.round(firstChunkAt - t0),
                currentTextPreview: currentText?.slice(0, 60),
              });
            }
            const delta = currentText.slice(assistantContent.length);
            if (delta) {
              assistantContent = currentText;
              tokenCount++;
              if (tokenCount === 1 || tokenCount % 25 === 0) {
                dbg(`token ${tokenCount}`, {
                  deltaLen: delta.length,
                  totalLen: assistantContent.length,
                });
              }
              push({ kind: "data", content: delta });
            }
          },
        })
        .then((final) => {
          // Belt-and-suspenders: if onNewToken under-reported the final text
          // (rare but observed with EOS tokens), reconcile here.
          if (final && final.length > assistantContent.length) {
            const tail = final.slice(assistantContent.length);
            assistantContent = final;
            push({ kind: "data", content: tail });
          }
          done = true;
          push({ kind: "end" });
        })
        .catch((err) => {
          done = true;
          push({ kind: "error", err });
        })
        .finally(() => clearInterval(heartbeat));

      try {
        while (true) {
          const item = await pull();
          if (item.kind === "data") {
            yield { type: "data", content: item.content };
          } else if (item.kind === "end") {
            break;
          } else if (item.kind === "error") {
            dbg("createCompletion threw", item.err);
            throw item.err;
          }
        }
        dbg("stream complete", {
          tokenCount,
          totalChars: assistantContent.length,
          totalMs: Math.round(performance.now() - t0),
          ttftMs: firstChunkAt === null ? null : Math.round(firstChunkAt - t0),
        });
      } finally {
        clearInterval(heartbeat);
        await generation; // ensure promise settles so we don't leak
      }

      if (firstChunkAt === null) {
        dbg(
          "WARNING: createCompletion returned with zero tokens emitted via onNewToken",
        );
      }

      // Fork doesn't expose finish_reason. Heuristic: hitting the nPredict cap
      // implies the model was still generating — treat as "length"; otherwise
      // assume EOS / natural stop.
      const finishReason = tokenCount >= nPredict ? "length" : "stop";

      yield {
        type: "done",
        finishReason,
        usage: {
          inputTokens: estimateTokens(prompt),
          outputTokens: estimateTokens(assistantContent),
          assistantContent,
        },
      };
      void done; // silence unused-var
    },

    destroy() {
      // Engine is cached across handlers; per-session cleanup is a no-op.
      // Call engine.exit() only if/when the user explicitly evicts the model.
    },
  };
};
