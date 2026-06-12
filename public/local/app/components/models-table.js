import { useState, useMemo } from "react";
import { html } from "../../../app/util/html.js";
import { useTableSort } from "../../../app/hooks/use-table-sort.js";
import { useLoading } from "../context/loading.js";
import { ModelsFilter } from "./models-filter.js";
import {
  addChatModel,
  getProviderForModel,
  providerManagesMemory,
} from "../../../config.js";
import {
  assessModelFit,
  tierClass,
  tierLabel,
} from "../../data/recommendations.js";

const DEFAULT_FILTERS = {
  modelText: "",
  quantization: [],
  maxTokens: [],
  vramMin: null,
  vramMax: null,
};

// Sort priority for the Fit column — safe first when ascending.
const FIT_SORT_RANK = { safe: 0, risky: 1, blocked: 2 };

const buildHeadings = (showFit) => ({
  model: "Model",
  quantization: "Quant",
  maxTokens: "Tokens",
  vramMb: "VRAM",
  released: "Date",
  ...(showFit ? { fit: "Fit" } : {}),
  status: "Status",
});

const COLUMN_INFO = {
  model: "Model identifier",
  quantization: "Quantization format",
  maxTokens: "Context window size",
  vramMb: "GPU memory required",
  released: "Approximate model family release date",
  fit: "Estimated fit for this device",
  status: "Loading status (click to load)",
};

// Status icon configuration matching LoadingButton patterns. `action` drives the primary click:
// "load" → load into memory, "unload" → free memory (Loaded → Cached), null → not clickable.
// `deletable` adds a secondary trash button to evict the on-disk bytes (Cached → Not loaded).
const STATUS_CONFIG = {
  available: {
    icon: "iconoir-circle",
    cls: "loading-status-not-loaded",
    title: "Click to load",
    action: "load",
  },
  loading: {
    icon: "iconoir-refresh",
    cls: "loading-status-loading",
    title: "Loading...",
    action: null,
  },
  loaded: {
    icon: "iconoir-check-circle",
    cls: "loading-status-loaded",
    title: "Loaded — click to unload from memory",
    action: "unload",
  },
  cached: {
    icon: "iconoir-database",
    cls: "loading-status-cached",
    title: "Cached on disk — click to load",
    action: "load",
    deletable: true,
  },
  error: {
    icon: "iconoir-warning-circle",
    cls: "loading-status-error",
    title: "Error loading model — click to retry",
    action: "load",
  },
};

const StatusIcon = ({
  status,
  canManageMemory,
  onLoad,
  onUnload,
  onDelete,
  progress,
}) => {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.available;
  const progressPercent =
    status === "loading" && progress?.progress != null
      ? Math.round(progress.progress * 100)
      : null;

  // Unload + delete are only offered for providers that manage their own memory/cache.
  const handleClick =
    config.action === "unload"
      ? canManageMemory
        ? onUnload
        : null
      : config.action === "load"
        ? onLoad
        : null;
  const showDelete = config.deletable && canManageMemory;

  const icon = handleClick
    ? html`
        <button
          className=${`loading-status-icon-button ${config.cls}`}
          onClick=${handleClick}
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
      ${showDelete &&
      html`<button
        className="loading-status-icon-button loading-status-delete"
        onClick=${onDelete}
        type="button"
        title="Delete from disk"
      >
        <i className="iconoir-trash"></i>
      </button>`}
      ${progressPercent !== null &&
      html`<span className="status-progress-text">${progressPercent}%</span>`}
    </span>
  `;
};

export const ModelsTable = ({ models = [], fitCtx }) => {
  const { getSortSymbol, handleColumnSort, sortItems } = useTableSort();
  const {
    getStatus,
    getProgress,
    getCached,
    startLoading,
    unload,
    deleteCache,
  } = useLoading();
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const showFit = !!fitCtx;
  const HEADINGS = buildHeadings(showFit);

  // Fit assessment is the expensive per-model work (it walks systemInfo/warnings/properties), so
  // memoize it on the inputs that actually affect it — not the loading status/progress that tick on
  // every load. With fitCtx now stable (memoized by the parent), this recomputes only when the model
  // list, device context, or fit visibility changes, instead of on every render.
  const fits = useMemo(
    () => (showFit ? models.map((m) => assessModelFit(m, fitCtx)) : null),
    [models, fitCtx, showFit],
  );

  if (models.length === 0) {
    return html`<div />`;
  }

  // Enrich models with status, progress, resourceId, and (optionally) the memoized fit.
  const enrichedModels = models.map((m, i) => {
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
    } else if (getCached(resourceId)) {
      status = "cached"; // downloaded, not in memory — fast to load
    } else {
      status = "available";
    }
    const fit = fits ? fits[i] : null;
    // For sorting only — keeps the sortItems comparator simple.
    const fitRank = fit ? FIT_SORT_RANK[fit.tier] : 0;
    return { ...m, resourceId, status, progress, fit, fitRank };
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
                // Sort by the numeric `fitRank` shadow field but keep the column header keyed
                // on "fit" for click semantics — fit.tier strings sort alphabetically backwards.
                const sortKey = key === "fit" ? "fitRank" : key;
                return html`<th
                  key=${key}
                  className="sortable-header"
                  title=${tooltip}
                  onClick=${() => handleColumnSort(sortKey)}
                >
                  ${label}${" "}${getSortSymbol(sortKey)}
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
                  released,
                  resourceId,
                  status,
                  progress,
                  fit,
                },
                i,
              ) => {
                const handleLoad = () => {
                  // Register model in chat config so it appears in model selector
                  // Note: models-table is currently web-llm specific
                  addChatModel("webLlm", model);
                  startLoading(resourceId);
                };
                const handleUnload = () => unload(resourceId);
                const handleDelete = () => deleteCache(resourceId);
                // The table is built from web-llm's prebuilt list; unconfigured models aren't in
                // ALL_CHAT_MODELS so getProviderForModel returns null — default to webLlm. A future
                // provider's models would resolve to their own key and gate accordingly.
                const canManageMemory = providerManagesMemory(
                  getProviderForModel(model) ?? "webLlm",
                );
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
                    <td>${released ?? "—"}</td>
                    ${showFit &&
                    html`<td>
                      <span
                        className=${`status-badge ${tierClass(fit.tier)}`}
                        title=${fit.reasons.join(" ")}
                      >
                        ${tierLabel(fit.tier)}
                      </span>
                    </td>`}
                    <td>
                      <${StatusIcon}
                        status=${status}
                        canManageMemory=${canManageMemory}
                        onLoad=${handleLoad}
                        onUnload=${handleUnload}
                        onDelete=${handleDelete}
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
