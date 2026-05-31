import { useState, useEffect } from "react";
import { Link } from "react-router";
import { html } from "../util/html.js";
import { Page } from "../components/page.js";
import { Tabs } from "../components/tabs.js";
import { useConfig } from "../contexts/config.js";
import { MODELS, getModelCfg, getProviderForModel } from "../../config.js";
import { formatBytes } from "../../shared-util.js";
import {
  CHROME_ANY_API_POSSIBLE,
  CHROME_HAS_PROMPT_API,
  CHROME_HAS_WRITER_API,
} from "../../config.js";
import { useSettings } from "../hooks/use-settings.js";
import { ModelsTable } from "../../local/app/components/models-table.js";
import { useIndexedDBCache } from "../../local/data/api/providers/web-llm.js";
import {
  LoadingButton,
  LOADING,
} from "../../local/app/components/loading/index.js";
import { useLoading } from "../../local/app/context/loading.js";
import { getLoadedData } from "../../local/data/loading.js";
import { checkAvailability } from "../../local/data/api/providers/chrome.js";
import { CrashesPanel } from "../components/crashes-panel.js";

const BASE_TABS = [
  { id: "resources", label: "Resources", icon: "iconoir-database" },
  { id: "system", label: "System", icon: "iconoir-cpu" },
  { id: "models", label: "AI Models", icon: "iconoir-brain" },
];
const CRASHES_TAB = {
  id: "crashes",
  label: "Crashes",
  icon: "iconoir-warning-triangle",
};

// Get model short name from resource id (provider-agnostic)
const modelShortName = (modelId) => {
  const cleanId = modelId.replace(/^llm_/, "");
  const provider = getProviderForModel(cleanId);
  if (!provider) return cleanId;
  return getModelCfg({ provider, model: cleanId }).modelShortName;
};

// Status badge helper for Chrome AI APIs
const getApiStatusBadge = (hasApi, availability) => {
  if (!hasApi) {
    return { label: "Not Supported", className: "status-unsupported" };
  }
  if (!availability) {
    return { label: "Checking...", className: "status-warning" };
  }
  if (availability.available) {
    return { label: "Available", className: "status-supported" };
  }
  if (availability.downloading) {
    return { label: availability.reason, className: "status-warning" };
  }
  return {
    label: availability.reason || "Unavailable",
    className: "status-unsupported",
  };
};

const ResourcesPanel = ({ experimentalChat }) => {
  return html`
    <div className="tabs-panel" role="tabpanel" id="tabpanel-resources" aria-labelledby="tab-resources">
      <p style=${{ color: "var(--color-text-muted)", marginTop: 0 }}>
        Gray circles indicate unloaded resources you can click to load.
      </p>
      <div>
        <${LoadingButton} resourceId=${LOADING.POSTS_DATA}>
          <strong>Posts</strong>: posts data
        </${LoadingButton}>
        <${LoadingButton} resourceId=${LOADING.POSTS_EMBEDDINGS}>
          <strong>Posts Embeddings</strong>: chunked embeddings for posts data
        </${LoadingButton}>
        <${LoadingButton} resourceId=${LOADING.DB}>
          <strong>Database</strong>: search indexes
        </${LoadingButton}>
        <${LoadingButton} resourceId=${LOADING.EXTRACTOR}>
          <strong>Extractor</strong>: embeddings extraction model
        </${LoadingButton}>
        ${
          experimentalChat &&
          Object.keys(LOADING)
            .filter((key) => key.startsWith("LLM_"))
            .map(
              (key) => html`
            <${LoadingButton} resourceId=${LOADING[key]} key=${key}>
              <strong>Model</strong>: ${modelShortName(LOADING[key])}
            </${LoadingButton}>
          `,
            )
        }
      </div>
    </div>
  `;
};

const SystemPanel = ({ systemInfo }) => {
  const { webgpu, limits, gpuInfo, ramGb } = systemInfo;
  const { getStatus } = useLoading();
  const extractorStatus = getStatus(LOADING.EXTRACTOR);
  const extractor =
    extractorStatus === "loaded" ? getLoadedData(LOADING.EXTRACTOR) : null;
  const device = extractor?._device ?? null;

  const embeddingsBadge =
    device === "webgpu"
      ? { label: "WebGPU", className: "status-supported" }
      : device === "wasm"
        ? { label: "WASM", className: "status-warning" }
        : { label: "Not Loaded", className: "status-unsupported" };

  // WebGPU status determination
  const webgpuStatus = !webgpu.supported
    ? { label: "Not Supported", className: "status-unsupported" }
    : !webgpu.adapterAvailable
      ? { label: "No Adapter", className: "status-warning" }
      : webgpu.isFallback
        ? { label: "Fallback (Software)", className: "status-warning" }
        : { label: "Available", className: "status-supported" };

  return html`
    <div
      className="tabs-panel"
      role="tabpanel"
      id="tabpanel-system"
      aria-labelledby="tab-system"
    >
      <div className="system-info">
        <div className="system-info-row">
          <strong>WebGPU:</strong>
          <span className=${`status-badge ${webgpuStatus.className}`}>
            ${webgpuStatus.label}
          </span>
          ${gpuInfo && html`<span className="gpu-info">${gpuInfo}</span>`}
        </div>

        <div className="system-info-row">
          <strong>System RAM:</strong> ${ramGb != null ? `${ramGb} GB` : "N/A"}
        </div>

        <div className="system-info-row">
          <strong>Embeddings Backend:</strong>
          <span className=${`status-badge ${embeddingsBadge.className}`}>
            ${embeddingsBadge.label}
          </span>
        </div>

        ${webgpu.adapterAvailable &&
        html`
          <details className="system-info-limits">
            <summary>WebGPU Limits</summary>
            <table className="limits-table">
              <tbody>
                <tr>
                  <td>Max Buffer Size</td>
                  <td>${formatBytes(limits.maxBufferSize)}</td>
                </tr>
                <tr>
                  <td>Max Storage Buffer Binding</td>
                  <td>${formatBytes(limits.maxStorageBufferBindingSize)}</td>
                </tr>
                <tr>
                  <td>Max Compute Workgroup Storage</td>
                  <td>${formatBytes(limits.maxComputeWorkgroupStorageSize)}</td>
                </tr>
                ${webgpu.preferredFormat &&
                html`
                  <tr>
                    <td>Preferred Canvas Format</td>
                    <td>${webgpu.preferredFormat}</td>
                  </tr>
                `}
              </tbody>
            </table>
          </details>
        `}
      </div>
    </div>
  `;
};

const ModelsPanel = ({ experimentalChat }) => {
  const [promptStatus, setPromptStatus] = useState(null);
  const [writerStatus, setWriterStatus] = useState(null);

  useEffect(() => {
    if (!experimentalChat) return;
    if (CHROME_HAS_PROMPT_API) {
      checkAvailability("prompt").then(setPromptStatus);
    }
    if (CHROME_HAS_WRITER_API) {
      checkAvailability("writer").then(setWriterStatus);
    }
  }, [experimentalChat]);

  if (!experimentalChat) {
    return html`
      <div className="tabs-panel" role="tabpanel" id="tabpanel-models" aria-labelledby="tab-models">
        <p>
          Enable${" "}<strong>Experimental Chat</strong>${" "}in${" "}
          <${Link} to="/settings">Settings</${Link}>${" "}to view AI model information.
        </p>
      </div>
    `;
  }

  const overallStatus = CHROME_ANY_API_POSSIBLE
    ? { label: "Available", className: "status-supported" }
    : { label: "Not Supported", className: "status-unsupported" };

  const promptBadge = getApiStatusBadge(CHROME_HAS_PROMPT_API, promptStatus);
  const writerBadge = getApiStatusBadge(CHROME_HAS_WRITER_API, writerStatus);

  return html`
    <div
      className="tabs-panel"
      role="tabpanel"
      id="tabpanel-models"
      aria-labelledby="tab-models"
    >
      <h3>Chrome AI</h3>
      <div className="system-info">
        <div className="system-info-row">
          <strong>Chrome AI:</strong>
          <span className=${`status-badge ${overallStatus.className}`}>
            ${overallStatus.label}
          </span>
        </div>
        <div className="system-info-row">
          <strong>Prompt API:</strong>
          <span className=${`status-badge ${promptBadge.className}`}>
            ${promptBadge.label}
          </span>
        </div>
        <div className="system-info-row">
          <strong>Writer API:</strong>
          <span className=${`status-badge ${writerBadge.className}`}>
            ${writerBadge.label}
          </span>
        </div>
      </div>

      <h3>web-llm</h3>
      <div className="system-info">
        <div className="system-info-row">
          <strong>Cache Backend:</strong>
          <span
            className=${`status-badge ${useIndexedDBCache ? "status-warning" : "status-supported"}`}
          >
            ${useIndexedDBCache ? "IndexedDB" : "Cache API"}
          </span>
        </div>
      </div>
      <p>
        Available web-llm models for local inference. Status indicates whether
        the model is loaded in memory, currently loading, or available for
        download.
      </p>
      <${ModelsTable} models=${MODELS} />
    </div>
  `;
};

export const Data = () => {
  const [settings] = useSettings();
  const { systemInfo } = useConfig();
  const [activeTab, setActiveTab] = useState("resources");

  // The Crashes tab is dev-mode-only; without dev mode the user wouldn't even reach
  // this page (Data itself is dev-only), but gate the tab anyway so it's explicit.
  const tabs = settings.isDeveloperMode
    ? [...BASE_TABS, CRASHES_TAB]
    : BASE_TABS;

  return html`
    <${Page} name="Data & Models" icon="iconoir-cpu">
      <p>Data, system information, and AI models used by the app.</p>
      <${Tabs} tabs=${tabs} activeTab=${activeTab} onTabChange=${setActiveTab} />
      ${
        activeTab === "resources" &&
        html`<${ResourcesPanel}
          experimentalChat=${settings.experimentalChat}
        />`
      }
      ${
        activeTab === "system" &&
        html`<${SystemPanel} systemInfo=${systemInfo} />`
      }
      ${
        activeTab === "models" &&
        html`<${ModelsPanel} experimentalChat=${settings.experimentalChat} />`
      }
      ${activeTab === "crashes" && settings.isDeveloperMode && html`<${CrashesPanel} />`}
    </${Page}>
  `;
};
