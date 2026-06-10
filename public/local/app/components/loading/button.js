import { Fragment, useState } from "react";
import { html } from "../../../../app/util/html.js";
import { useLoading } from "../../context/loading.js";
import { formatElapsed } from "../../../../shared-util.js";
import { Modal } from "../../../../app/components/modal.js";
import {
  MODELS,
  getProviderForModel,
  providerManagesMemory,
} from "../../../../config.js";
import { findResourceById } from "../../../data/loading.js";

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
  cached: {
    icon: "iconoir-database",
    cls: "loading-status-cached",
    title: "Cached on disk — click to load into memory",
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
  const {
    getStatus,
    getError,
    getElapsed,
    getProgress,
    getCached,
    startLoading,
    unload,
    deleteCache,
  } = useLoading();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const loadStatus = forceStatus || getStatus(resourceId);
  // Show "cached" (downloaded, not in memory) instead of a bare "not loaded" when the bytes are on
  // disk — makes an unloaded/evicted model read as "fast to reload", not gone.
  const cached =
    !forceStatus && loadStatus === "not_loaded" && getCached(resourceId);
  const status = cached ? "cached" : loadStatus;
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
  const handleUnload = () => unload(resourceId);
  const handleDelete = () => deleteCache(resourceId);

  // Clickable to start a load from "not_loaded" (incl. cached, whose loadStatus is "not_loaded") and
  // from "error" — startLoading retries a failed load, matching the models table's error → retry.
  const isClickable =
    (loadStatus === "not_loaded" || loadStatus === "error") && !forceStatus;
  const isModel = resourceId?.toLowerCase().startsWith("llm_");

  // Look up model metadata for LLM resources
  const modelId = isModel ? resourceId.replace(/^llm_/i, "") : null;
  const modelMeta = modelId ? MODELS.find((m) => m.model === modelId) : null;

  // Memory actions (unload / delete-from-disk) are offered only for providers that manage their own
  // memory + cache (MEMORY_MANAGED_PROVIDERS). Prefer the registered resource's provider (set when it
  // was created) and fall back to a config lookup. Chrome built-in AI is OS-managed → excluded.
  const provider = isModel
    ? (findResourceById(resourceId)?.provider ?? getProviderForModel(modelId))
    : null;
  const canManageMemory = providerManagesMemory(provider);
  // A loaded model can be unloaded (→ Cached) by clicking its status icon again.
  const canUnload = canManageMemory && !forceStatus && loadStatus === "loaded";
  // A cached model's on-disk bytes can be deleted (→ Not loaded) via the inline trash — matching the
  // models table. Loaded models unload first (status click), then become deletable. The trash slot is
  // reserved on every row (a hidden placeholder when absent) so the icon column and the label/icon
  // divider bar stay aligned whether or not a row currently shows the trash.
  const canDelete = canManageMemory && !forceStatus && status === "cached";
  const primaryClick = canUnload
    ? handleUnload
    : isClickable
      ? handleStartLoading
      : null;
  const primaryTitle = canUnload
    ? "Loaded — click to unload from memory"
    : loadStatus === "error"
      ? `${title} — click to retry`
      : title;

  const handleInfoClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsModalOpen(true);
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
                      ? `${modelMeta.quantization || "—"} · ${modelMeta.vramMb ? `${modelMeta.vramMb} MB VRAM` : "—"}`
                      : "Model info"}
                    onClick=${handleInfoClick}
                    key="info"
                    ><i className="iconoir-info-circle"></i
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
              primaryClick
                ? html`
                    <button
                      className=${`loading-status-icon-button ${state.cls}`}
                      onClick=${primaryClick}
                      type="button"
                      title=${primaryTitle}
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
            ${
              canDelete
                ? html`
                    <button
                      className="loading-status-icon-button loading-status-delete"
                      onClick=${handleDelete}
                      type="button"
                      title="Delete from disk"
                      key="delete"
                    >
                      <i className="iconoir-trash"></i>
                    </button>
                  `
                : html`
                    <span
                      className="loading-status-icon loading-status-delete loading-status-delete-placeholder"
                      aria-hidden="true"
                      key="delete-placeholder"
                    >
                      <i className="iconoir-trash"></i>
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
                href=${modelMeta.modelUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                ${modelMeta.model} <i className="iconoir-open-new-window"></i>
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
                  <div className="modal-stat-card">
                    <i className="iconoir-database"></i>
                    <span className="modal-stat-label">VRAM Required</span>
                    <span className="modal-stat-value">
                      ${modelMeta.vramMb
                        ? `${modelMeta.vramMb.toLocaleString()} MB`
                        : "—"}
                    </span>
                  </div>
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
    </${Fragment}>
  `;
};
