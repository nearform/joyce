import { html } from "../../../app/util/html.js";
import { useLoading } from "../context/loading.js";
import { StatusIcon } from "./status-icon.js";

const HEADINGS = {
  model: "Model",
  quantization: "Quant",
  maxTokens: "Tokens",
  downloadSizeMb: "Download",
  status: "Status",
};

const COLUMN_INFO = {
  model: "Model identifier",
  quantization: "Quantization format",
  maxTokens: "Context window size",
  downloadSizeMb: "Approximate download size",
  status: "Loading status (click to load)",
};

export const HfModelsTable = ({ models = [] }) => {
  const { getStatus, getError, getProgress, startLoading } = useLoading();

  if (models.length === 0) {
    return html`<div />`;
  }

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

  return html`
    <div className="models-table-container">
      <table className="pure-table pure-table-bordered">
        <thead>
          <tr>
            ${Object.entries(HEADINGS).map(
              ([key, label]) => html`
                <th key=${key} title=${COLUMN_INFO[key]}>${label}</th>
              `,
            )}
          </tr>
        </thead>
        <tbody>
          ${enrichedModels.map(
            (
              {
                model,
                modelShortName,
                quantization,
                maxTokens,
                downloadSizeMb,
                resourceId,
                status,
                progress,
                error,
              },
              i,
            ) => {
              const handleLoad = () => startLoading(resourceId);
              const hfUrl = `https://huggingface.co/${model}`;
              return html`
                <tr key=${`hf-model-${i}`}>
                  <td>
                    <a href=${hfUrl} target="_blank" rel="noopener noreferrer">
                      ${modelShortName ?? model}
                    </a>
                  </td>
                  <td>${quantization ?? "—"}</td>
                  <td>${maxTokens ?? "—"}</td>
                  <td>${downloadSizeMb ? `~${downloadSizeMb} MB` : "—"}</td>
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
  `;
};
