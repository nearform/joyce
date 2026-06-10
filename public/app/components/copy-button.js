/* global navigator:false, document:false, setTimeout:false */
import { useState } from "react";
import { html } from "../util/html.js";

/**
 * Copy `text` to the clipboard, returning whether it actually succeeded. Prefers the async Clipboard
 * API; falls back to a hidden textarea + execCommand for non-secure contexts / older WebKit where
 * `navigator.clipboard` is missing or throws. Returns false if every path fails so callers don't show
 * a false "Copied!".
 * @param {string} text
 * @returns {Promise<boolean>}
 */
const copyText = async (text) => {
  // Guard the call (don't just optional-chain the await): a missing clipboard resolves to undefined
  // rather than throwing, which would skip the fallback and look like success.
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the execCommand fallback
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
};

/**
 * Icon button that copies `text` to the clipboard with a brief check-mark affordance. Falls back to
 * a hidden textarea + execCommand for non-secure contexts / browsers without the async clipboard API
 * (e.g. older WebKit), so the copy still works where `navigator.clipboard` is unavailable.
 * @param {{ text: string, className?: string, title?: string }} props
 */
export const CopyButton = ({
  text,
  className = "answer-actions-btn",
  title = "Copy to clipboard",
}) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    // Only show the "Copied!" affordance when the copy actually succeeded.
    if (!(await copyText(text))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return html`
    <button
      type="button"
      className=${className}
      onClick=${handleCopy}
      title=${copied ? "Copied!" : title}
      aria-label=${copied ? "Copied!" : title}
    >
      <i className=${copied ? "iconoir-check" : "iconoir-copy"}></i>
    </button>
  `;
};
