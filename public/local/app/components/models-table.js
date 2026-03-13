import { useState } from "react";
import { html } from "../../../app/util/html.js";
import { useTableSort } from "../../../app/hooks/use-table-sort.js";
import { useLoading } from "../context/loading.js";
import { ModelsFilter } from "./models-filter.js";
import { addChatModel } from "../../../config.js";
import { StatusIcon } from "./status-icon.js";

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

export const ModelsTable = ({ models = [] }) => {
  const { getSortSymbol, handleColumnSort, sortItems } = useTableSort();
  const { getStatus, getError, getProgress, startLoading } = useLoading();
  const [filters, setFilters] = useState(DEFAULT_FILTERS);

  if (models.length === 0) {
    return html`<div />`;
  }

  // Enrich models with status, progress, and resourceId (all models can be loaded)
  const enrichedModels = models.map((m) => {
    const resourceId = `llm_${m.model}`;
    const loadingStatus = getStatus(resourceId);
    const progress = getProgress(resourceId);
    const error = getError(resourceId);
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
    return { ...m, resourceId, status, progress, error };
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
                  error,
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
                        error=${error}
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
