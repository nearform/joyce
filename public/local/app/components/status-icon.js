import { useState } from "react";
import { html } from "../../../app/util/html.js";
import { Modal } from "../../../app/components/modal.js";

// Status icon configuration matching LoadingButton patterns
export const STATUS_CONFIG = {
  available: {
    icon: "iconoir-circle",
    cls: "loading-status-not-loaded",
    title: "Click to load",
    clickable: true,
  },
  loading: {
    icon: "iconoir-refresh",
    cls: "loading-status-loading",
    title: "Loading...",
    clickable: false,
  },
  loaded: {
    icon: "iconoir-check-circle",
    cls: "loading-status-loaded",
    title: "Loaded",
    clickable: false,
  },
  error: {
    icon: "iconoir-warning-circle",
    cls: "loading-status-error",
    title: "Error loading model",
    clickable: true,
  },
};

/**
 * Status icon with optional error detail modal.
 * @param {Object} props
 * @param {string} props.status - "available" | "loading" | "loaded" | "error"
 * @param {Function} props.onLoad - Called on click when clickable (load or retry)
 * @param {{ progress: number }|null} props.progress - Loading progress
 * @param {Error|string|null} props.error - Error object when status is "error"
 */
export const StatusIcon = ({ status, onLoad, progress, error }) => {
  const [isErrorModalOpen, setIsErrorModalOpen] = useState(false);
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.available;
  const progressPercent =
    status === "loading" && progress?.progress != null
      ? Math.round(progress.progress * 100)
      : null;

  const icon = config.clickable
    ? html`
        <button
          className=${`loading-status-icon-button ${config.cls}`}
          onClick=${onLoad}
          type="button"
          title=${status === "error" ? "Click to retry" : config.title}
        >
          <i className=${config.icon}></i>
        </button>
      `
    : html`
        <span
          className=${`loading-status-icon ${config.cls}`}
          title=${config.title}
        >
          <i className=${config.icon}></i>
        </span>
      `;

  const errorMessage = error?.message || error?.toString() || "Unknown error";

  return html`
    <span className="status-icon-wrapper">
      ${icon}
      ${progressPercent !== null &&
      html`<span className="status-progress-text">${progressPercent}%</span>`}
      ${status === "error" &&
      html`<span
          className="loading-status-info loading-status-error-info"
          title="View error details"
          onClick=${(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsErrorModalOpen(true);
          }}
          ><i className="iconoir-warning-circle"></i
        ></span>
        <${Modal}
          isOpen=${isErrorModalOpen}
          onClose=${() => setIsErrorModalOpen(false)}
          title="Load Error"
        >
          <p style=${{ wordBreak: "break-word" }}>${errorMessage}</p>
          <button
            className="pure-button"
            onClick=${() => {
              setIsErrorModalOpen(false);
              onLoad?.();
            }}
            type="button"
          >
            <i className="iconoir-refresh"></i>${" "}Retry
          </button>
        </${Modal}>`}
    </span>
  `;
};
