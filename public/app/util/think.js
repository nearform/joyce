// Helpers for reasoning models (Qwen3, DeepSeek-R1-Distill) that wrap their chain-of-thought in
// `<think>…</think>` before the real answer. We hide that block from the rendered answer and expose
// it separately via a developer-mode viewer. Pure string functions — no DOM, safe to import anywhere.

// Matched non-greedily and case-insensitively; [\s\S] so it spans newlines.
const THINK_BLOCK = /<think>([\s\S]*?)<\/think>/gi;
const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

/**
 * Remove every `<think>…</think>` block from model output so the user sees only the answer. Also
 * drops a still-open `<think>` with no closing tag yet — that's reasoning mid-stream, which would
 * otherwise flash raw tags into the answer as it arrives.
 * @param {string} text
 * @returns {string}
 */
export const stripThinking = (text) => {
  if (!text) return text;
  let out = text.replace(THINK_BLOCK, "");
  const open = out.toLowerCase().indexOf(OPEN_TAG);
  if (open !== -1) {
    out = out.slice(0, open); // unterminated block — still streaming the reasoning
  }
  return out.replace(/^\s+/, "");
};

/**
 * Concatenate the contents of every `<think>` block (tags stripped). Includes an unterminated
 * trailing block so the viewer updates live while reasoning streams. Empty string when there's none
 * — which is also the case when web-llm disables thinking (it emits an empty `<think></think>`).
 * @param {string} text
 * @returns {string}
 */
export const extractThinking = (text) => {
  if (!text) return "";
  /** @type {string[]} */
  const blocks = [];
  for (const match of text.matchAll(THINK_BLOCK)) {
    blocks.push(match[1].trim());
  }
  const lastOpen = text.toLowerCase().lastIndexOf(OPEN_TAG);
  if (
    lastOpen !== -1 &&
    text.toLowerCase().indexOf(CLOSE_TAG, lastOpen) === -1
  ) {
    blocks.push(text.slice(lastOpen + OPEN_TAG.length).trim());
  }
  return blocks.filter(Boolean).join("\n\n---\n\n");
};

/**
 * Whether `text` carries any non-empty reasoning — gates the developer-mode "thinking" icon.
 * @param {string} text
 * @returns {boolean}
 */
export const hasThinking = (text) => extractThinking(text).length > 0;
