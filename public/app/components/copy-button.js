/* global navigator:false, document:false, setTimeout:false */
import { useState } from "react";
import { html } from "../util/html.js";

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
    try {
      await navigator?.clipboard?.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* clipboard unavailable — nothing else to do */
      }
      ta.remove();
    }
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
