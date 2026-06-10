// Helpers for reasoning models (Qwen3, DeepSeek-R1-Distill) that wrap their chain-of-thought in
// `<think>…</think>` before the real answer. We hide that block from the rendered answer and expose
// it separately via a developer-mode viewer. Pure string functions — no DOM, safe to import anywhere.

// Matched non-greedily and case-insensitively; [\s\S] so it spans newlines.
const THINK_BLOCK = /<think>([\s\S]*?)<\/think>/gi;
const OPEN_TAG = "<think>";

/**
 * Split model output into the user-visible answer and its reasoning in a SINGLE pass over the text.
 *
 *  - `visible`: every `<think>…</think>` block removed so the user sees only the answer. A still-open
 *    `<think>` with no closing tag yet (reasoning mid-stream) is dropped too, so raw tags never flash
 *    into the answer as it arrives.
 *  - `thinking`: the contents of every block concatenated (tags stripped), including an unterminated
 *    trailing block so a viewer updates live while reasoning streams. Empty when there's none — also
 *    the case when web-llm disables thinking (it emits an empty `<think></think>`).
 *  - `hasThinking`: whether `thinking` is non-empty (gates the developer-mode "thinking" icon).
 *
 * Replaces separate stripThinking/extractThinking/hasThinking calls, which each re-scanned the text;
 * callers memoize this per answer so a streaming render re-parses only the entry that changed.
 * @param {string} text
 * @returns {{ visible: string, thinking: string, hasThinking: boolean }}
 */
export const parseThinking = (text) => {
  if (!text) return { visible: text || "", thinking: "", hasThinking: false };
  /** @type {string[]} */
  const blocks = [];
  let visible = text.replace(THINK_BLOCK, (_match, inner) => {
    blocks.push(inner.trim());
    return "";
  });
  // Any `<think>` left after complete blocks were removed is an unterminated one still streaming:
  // everything from it onward is reasoning, not answer.
  const open = visible.toLowerCase().indexOf(OPEN_TAG);
  if (open !== -1) {
    blocks.push(visible.slice(open + OPEN_TAG.length).trim());
    visible = visible.slice(0, open);
  }
  const thinking = blocks.filter(Boolean).join("\n\n---\n\n");
  return {
    visible: visible.replace(/^\s+/, ""),
    thinking,
    hasThinking: thinking.length > 0,
  };
};
