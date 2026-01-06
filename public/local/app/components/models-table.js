import { useState } from "react";
import { html } from "../../../app/util/html.js";
import { useTableSort } from "../../../app/hooks/use-table-sort.js";
import { useLoading } from "../context/loading.js";
import { ModelsFilter } from "./models-filter.js";
import { addChatModel } from "../../../config.js";

const DEFAULT_FILTERS = {
  modelText: "",
  quantization: [],
  maxTokens: [],
  vramMin: null,
  vramMax: null,
};

const HEADINGS = {
  model: "Model",
  quantization: "Quant",
  maxTokens: "Tokens",
  vramMb: "VRAM",
  status: "Status",
};

const COLUMN_INFO = {
  model: "Model identifier",
  quantization: "Quantization format",
  maxTokens: "Context window size",
  vramMb: "GPU memory required",
  status: "Loading status (click to load)",
};

// Status icon configuration matching LoadingButton patterns
const STATUS_CONFIG = {
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

const StatusIcon = ({ status, onLoad, progress }) => {
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
          title=${config.title}
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

  return html`
    <span className="status-icon-wrapper">
      ${icon}
      ${progressPercent !== null &&
      html`<span className="status-progress-text">${progressPercent}%</span>`}
    </span>
  `;
};

export const ModelsTable = ({ models = [] }) => {
  const { getSortSymbol, handleColumnSort, sortItems } = useTableSort();
  const { getStatus, getProgress, startLoading } = useLoading();
  const [filters, setFilters] = useState(DEFAULT_FILTERS);

  if (models.length === 0) {
    return html`<div />`;
  }

  // Enrich models with status, progress, and resourceId (all models can be loaded)
  const enrichedModels = models.map((m) => {
    const resourceId = `llm_${m.model}`;
    const loadingStatus = getStatus(resourceId);
    const progress = getProgress(resourceId);
    let status;
    if (loadingStatus === "loaded") {
      status = "loaded";
    } else if (loadingStatus === "loading") {
      status = "loading";
    } else if (loadingStatus === "error") {
      status = "error";
    } else {
      status = "available";
    }
    return { ...m, resourceId, status, progress };
  });

  // Apply filters
  const filteredModels = enrichedModels
    .filter(
      (m) =>
        !filters.modelText ||
        m.model.toLowerCase().includes(filters.modelText.toLowerCase()),
    )
    .filter(
      (m) =>
        filters.quantization.length === 0 ||
        filters.quantization.some((q) => q.value === m.quantization),
    )
    .filter(
      (m) =>
        filters.maxTokens.length === 0 ||
        filters.maxTokens.some((t) => t.value === m.maxTokens),
    )
    .filter((m) => filters.vramMin == null || m.vramMb >= filters.vramMin)
    .filter((m) => filters.vramMax == null || m.vramMb <= filters.vramMax);

  return html`
    <div>
      <${ModelsFilter}
        models=${models}
        filters=${filters}
        setFilters=${setFilters}
      />
      <div className="models-table-container">
        <table className="pure-table pure-table-bordered">
          <thead>
            <tr>
              ${Object.entries(HEADINGS).map(([key, label]) => {
                const tooltip = COLUMN_INFO[key];
                return html`<th
                  key=${key}
                  className="sortable-header"
                  title=${tooltip}
                  onClick=${() => handleColumnSort(key)}
                >
                  ${label}${" "}${getSortSymbol(key)}
                </th>`;
              })}
            </tr>
          </thead>
          <tbody>
            ${sortItems(filteredModels).map(
              (
                {
                  model,
                  modelUrl,
                  quantization,
                  maxTokens,
                  vramMb,
                  resourceId,
                  status,
                  progress,
                },
                i,
              ) => {
                const handleLoad = () => {
                  // Register model in chat config so it appears in model selector
                  // Note: models-table is currently web-llm specific
                  addChatModel("webLlm", model);
                  startLoading(resourceId);
                };
                return html`
                  <tr key=${`model-item-${i}`}>
                    <td>
                      <a
                        href="${modelUrl}"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        ${model}
                      </a>
                    </td>
                    <td>${quantization ?? "—"}</td>
                    <td>${maxTokens ?? "—"}</td>
                    <td>${vramMb ?? "—"}</td>
                    <td>
                      <${StatusIcon}
                        status=${status}
                        onLoad=${handleLoad}
                        progress=${progress}
                      />
                    </td>
                  </tr>
                `;
              },
            )}
          </tbody>
        </table>
      </div>
    </div>
  `;
};
