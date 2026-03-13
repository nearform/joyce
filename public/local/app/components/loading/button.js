import { Fragment, useState } from "react";
import { html } from "../../../../app/util/html.js";
import { useLoading } from "../../context/loading.js";
import { formatElapsed } from "../../../../shared-util.js";
import { Modal } from "../../../../app/components/modal.js";
import {
  MODELS,
  getModelCfg,
  getProviderForModel,
} from "../../../../config.js";

const STATES = {
  not_loaded: {
    icon: "iconoir-circle",
    cls: "loading-status-not-loaded",
    title: "Not Loaded",
  },
  loading: {
    icon: "iconoir-refresh",
    cls: "loading-status-loading",
    title: "Loading",
  },
  loaded: {
    icon: "iconoir-check-circle",
    cls: "loading-status-loaded",
    title: "Loaded",
  },
  error: {
    icon: "iconoir-warning-circle",
    cls: "loading-status-error",
    title: (err) => `Error${err ? `: ${err}` : ""}`,
  },
};

/**
 * Component for displaying loading status and initiating loads
 * @param {Object} props
 * @param {string} props.resourceId - The resource identifier
 * @param {string} props.label - Display label for the resource
 * @param {string} props.forceStatus - Optional status to force (for demo purposes)
 */
export const LoadingButton = ({
  resourceId,
  label,
  forceStatus = null,
  children,
}) => {
  const { getStatus, getError, getElapsed, getProgress, startLoading } =
    useLoading();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const status = forceStatus || getStatus(resourceId);
  const error = getError(resourceId);
  const elapsed = getElapsed(resourceId);
  const progress = getProgress(resourceId);
  const state = STATES[status] || STATES.not_loaded;
  const title =
    typeof state.title === "function" ? state.title(error) : state.title;

  // Format progress percentage for display
  const progressPercent =
    progress?.progress != null ? Math.round(progress.progress * 100) : null;

  const handleStartLoading = () => {
    startLoading(resourceId);
  };

  const isClickable =
    (status === "not_loaded" || status === "error") && !forceStatus;
  const isModel = resourceId?.toLowerCase().startsWith("llm_");

  // Look up model metadata for LLM resources
  // Try web-llm MODELS first (has modelUrl), then fall back to shared config (all providers)
  const modelId = isModel ? resourceId.replace(/^llm_/i, "") : null;
  const modelProvider = modelId ? getProviderForModel(modelId) : null;
  const webLlmMeta = modelId ? MODELS.find((m) => m.model === modelId) : null;
  const sharedMeta =
    modelId && modelProvider
      ? getModelCfg({ provider: modelProvider, model: modelId })
      : null;
  const modelMeta = webLlmMeta || sharedMeta;

  const [isErrorModalOpen, setIsErrorModalOpen] = useState(false);

  const handleInfoClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsModalOpen(true);
  };

  const handleErrorClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsErrorModalOpen(true);
  };

  // TODO(LOADING): Maybe add label name and description, separated in styles, then elapsed separately.
  // TODO(LOADING): Add visual progress bar for future enhancement
  return html`
    <${Fragment}>
      <div className="pure-form pure-form-stacked">
        <div className="pure-control-group loading-status-row">
          <label className="loading-status-label">
            <span className="loading-status-text">${children || label}</span>
            ${
              isModel
                ? html`<span
                    className="loading-status-info"
                    title=${modelMeta
                      ? `${modelMeta.quantization || "—"} · ${modelMeta.vramMb ? `${modelMeta.vramMb} MB VRAM` : modelMeta.downloadSizeMb ? `~${modelMeta.downloadSizeMb} MB` : "—"}`
                      : "Model info"}
                    onClick=${handleInfoClick}
                    key="info"
                    ><i className="iconoir-info-circle"></i
                  ></span>`
                : null
            }
            ${
              status === "error"
                ? html`<span
                    className="loading-status-info loading-status-error-info"
                    title="View error details"
                    onClick=${handleErrorClick}
                    key="error-info"
                    ><i className="iconoir-warning-circle"></i
                  ></span>`
                : null
            }
            ${
              status === "loading" && progressPercent !== null
                ? html` <span className="loading-status-progress" key="progress"
                    >(${progressPercent}%)</span
                  >`
                : null
            }
            ${
              elapsed
                ? html` <span className="loading-status-elapsed" key="elapsed"
                    >(${formatElapsed(elapsed)})</span
                  >`
                : null
            }
          </label>
          <div className="loading-status-icon-container">
            ${
              isClickable
                ? html`
                    <button
                      className=${`loading-status-icon-button ${state.cls}`}
                      onClick=${handleStartLoading}
                      type="button"
                      title=${title}
                    >
                      <i className=${state.icon}></i>
                    </button>
                  `
                : html`
                    <span
                      className=${`loading-status-icon ${state.cls}`}
                      title=${title}
                    >
                      <i className=${state.icon}></i>
                    </span>
                  `
            }
          </div>
        </div>
      </div>
      <${Modal}
        isOpen=${isModalOpen}
        onClose=${() => setIsModalOpen(false)}
        title=${
          modelMeta
            ? html`<a
                href=${modelMeta.modelUrl ||
                `https://huggingface.co/${modelMeta.model}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                ${modelMeta.modelShortName || modelMeta.model}${" "}<i
                  className="iconoir-open-new-window"
                ></i>
              </a>`
            : "Model Info"
        }
      >
        ${
          modelMeta
            ? html`
                <div className="modal-stat-cards">
                  <div className="modal-stat-card">
                    <i className="iconoir-cpu"></i>
                    <span className="modal-stat-label">Quantization</span>
                    <span className="modal-stat-value">
                      ${modelMeta.quantization || "—"}
                    </span>
                  </div>
                  <div className="modal-stat-card">
                    <i className="iconoir-align-left"></i>
                    <span className="modal-stat-label">Max Tokens</span>
                    <span className="modal-stat-value">
                      ${modelMeta.maxTokens?.toLocaleString() || "—"}
                    </span>
                  </div>
                  ${modelMeta.vramMb != null
                    ? html`
                        <div className="modal-stat-card">
                          <i className="iconoir-database"></i>
                          <span className="modal-stat-label"
                            >VRAM Required</span
                          >
                          <span className="modal-stat-value">
                            ${`${modelMeta.vramMb.toLocaleString()} MB`}
                          </span>
                        </div>
                      `
                    : null}
                  ${modelMeta.downloadSizeMb != null
                    ? html`
                        <div className="modal-stat-card">
                          <i className="iconoir-download"></i>
                          <span className="modal-stat-label"
                            >Download Size</span
                          >
                          <span className="modal-stat-value">
                            ~${modelMeta.downloadSizeMb.toLocaleString()} MB
                          </span>
                        </div>
                      `
                    : null}
                  <div className="modal-stat-card">
                    <i className=${state.icon}></i>
                    <span className="modal-stat-label">Status</span>
                    <span className="modal-stat-value">${title}</span>
                  </div>
                </div>
              `
            : html`<p>Model information not available.</p>`
        }
      </${Modal}>
      <${Modal}
        isOpen=${isErrorModalOpen}
        onClose=${() => setIsErrorModalOpen(false)}
        title="Load Error"
      >
        <p style=${{ wordBreak: "break-word" }}>
          ${error?.message || error?.toString() || "Unknown error"}
        </p>
        <button
          className="pure-button"
          onClick=${() => {
            setIsErrorModalOpen(false);
            startLoading(resourceId);
          }}
          type="button"
        >
          <i className="iconoir-refresh"></i>${" "}Retry
        </button>
      </${Modal}>
    </${Fragment}>
  `;
};
