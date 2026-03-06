import { useState, useEffect, useCallback, Fragment } from "react";
import { html } from "../util/html.js";
import { Page } from "../components/page.js";
import { useConfig } from "../contexts/config.js";
import { MODELS, getModelCfg, getProviderForModel } from "../../config.js";
import { formatBytes } from "../../shared-util.js";
import {
  CHROME_ANY_API_POSSIBLE,
  CHROME_HAS_PROMPT_API,
  CHROME_HAS_WRITER_API,
  FEATURES,
} from "../../config.js";
import {
  getMemoryInfo,
  getMemoryTimeline,
  getLastCrash,
  clearLastCrash,
} from "../diagnostics.js";
import { ModelsTable } from "../../local/app/components/models-table.js";
import {
  LoadingButton,
  LOADING,
} from "../../local/app/components/loading/index.js";
import { useLoading } from "../../local/app/context/loading.js";
import { getLoadedData } from "../../local/data/loading.js";
import { checkAvailability } from "../../local/data/api/providers/chrome.js";

// Get model short name from resource id (provider-agnostic)
const modelShortName = (modelId) => {
  const cleanId = modelId.replace(/^llm_/, "");
  const provider = getProviderForModel(cleanId);
  if (!provider) return cleanId;
  return getModelCfg({ provider, model: cleanId }).modelShortName;
};

const SystemInfo = ({ info }) => {
  const { webgpu, limits, gpuInfo, ramGb } = info;

  // WebGPU status determination
  const webgpuStatus = !webgpu.supported
    ? { label: "Not Supported", className: "status-unsupported" }
    : !webgpu.adapterAvailable
      ? { label: "No Adapter", className: "status-warning" }
      : webgpu.isFallback
        ? { label: "Fallback (Software)", className: "status-warning" }
        : { label: "Available", className: "status-supported" };

  return html`
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
  `;
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

const ChromeAIInfo = () => {
  const [promptStatus, setPromptStatus] = useState(null);
  const [writerStatus, setWriterStatus] = useState(null);

  useEffect(() => {
    // Check availability for both APIs
    if (CHROME_HAS_PROMPT_API) {
      checkAvailability("prompt").then(setPromptStatus);
    }
    if (CHROME_HAS_WRITER_API) {
      checkAvailability("writer").then(setWriterStatus);
    }
  }, []);

  const overallStatus = CHROME_ANY_API_POSSIBLE
    ? { label: "Available", className: "status-supported" }
    : { label: "Not Supported", className: "status-unsupported" };

  const promptBadge = getApiStatusBadge(CHROME_HAS_PROMPT_API, promptStatus);
  const writerBadge = getApiStatusBadge(CHROME_HAS_WRITER_API, writerStatus);

  return html`
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
  `;
};

const EmbeddingsInfo = () => {
  const { getStatus } = useLoading();
  const extractorStatus = getStatus(LOADING.EXTRACTOR);
  const extractor =
    extractorStatus === "loaded" ? getLoadedData(LOADING.EXTRACTOR) : null;
  const device = extractor?._device ?? null;

  const badge =
    device === "webgpu"
      ? { label: "WebGPU", className: "status-supported" }
      : device === "wasm"
        ? { label: "WASM", className: "status-warning" }
        : { label: "Not Loaded", className: "status-unsupported" };

  return html`
    <div className="system-info">
      <div className="system-info-row">
        <strong>Embeddings Backend:</strong>
        <span className=${`status-badge ${badge.className}`}>
          ${badge.label}
        </span>
      </div>
    </div>
  `;
};

const toMB = (bytes) =>
  bytes != null ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : "N/A";

const MemoryInfo = () => {
  const [, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const mem = getMemoryInfo();
  const timeline = getMemoryTimeline();
  const hasHeap = mem.usedJSHeapSize != null;

  // Also show data structure sizes from loaded resources
  const postsData = getLoadedData(LOADING.POSTS_DATA);
  const dbData = getLoadedData(LOADING.DB);
  const postCount = postsData ? Object.keys(postsData).length : null;
  const chunkCount = dbData?.chunks?.data?.docs?.count ?? null;

  return html`
    <div className="system-info">
      <div className="system-info-row">
        <strong>Device RAM:</strong> ${mem.deviceMemory != null
          ? `${mem.deviceMemory} GB`
          : "N/A"}
      </div>
      <div className="system-info-row">
        <strong>JS Heap Used:</strong> ${hasHeap
          ? toMB(mem.usedJSHeapSize)
          : "N/A"}
        ${hasHeap && html` / ${toMB(mem.totalJSHeapSize)} allocated`}
        ${hasHeap && html` (limit ${toMB(mem.jsHeapSizeLimit)})`}
      </div>
      ${postCount != null &&
      html`
        <div className="system-info-row">
          <strong>Posts:</strong> ${postCount}
          ${chunkCount != null &&
          html` | <strong>Chunks:</strong> ${chunkCount}`}
        </div>
      `}
      <div className="system-info-row">
        <button className="pure-button" onClick=${refresh}>Refresh</button>
      </div>
      ${timeline.length > 0 &&
      html`
        <details className="system-info-limits">
          <summary>Memory Timeline (${timeline.length} snapshots)</summary>
          <table className="limits-table">
            <thead>
              <tr>
                <td><strong>Resource</strong></td>
                <td><strong>Heap Used</strong></td>
                <td><strong>Heap Total</strong></td>
              </tr>
            </thead>
            <tbody>
              ${timeline.map(
                (s) => html`
                  <tr key=${s.label + s.timestamp}>
                    <td>${s.label}</td>
                    <td>${toMB(s.usedJSHeapSize)}</td>
                    <td>${toMB(s.totalJSHeapSize)}</td>
                  </tr>
                `,
              )}
            </tbody>
          </table>
        </details>
      `}
    </div>
  `;
};

const formatTime = (ts) => {
  if (!ts) return "N/A";
  return new Date(ts).toLocaleString();
};

const CrashInfo = () => {
  const [crash, setCrash] = useState(() => getLastCrash());

  if (!crash)
    return html`
      <div className="system-info">
        <div className="system-info-row">
          <span className="status-badge status-supported">No Crashes</span>
          No previous crash detected.
        </div>
      </div>
    `;

  const lastMilestone = crash.milestones?.length
    ? crash.milestones[crash.milestones.length - 1]
    : null;

  const dismiss = () => {
    clearLastCrash();
    setCrash(null);
  };

  return html`
    <div className="system-info" style=${{ borderLeft: "3px solid #c0392b" }}>
      <div className="system-info-row">
        <span className="status-badge status-unsupported">Crash Detected</span>
        <button className="pure-button" onClick=${dismiss}>Dismiss</button>
      </div>
      <div className="system-info-row">
        <strong>Session:</strong> ${formatTime(crash.startedAt)}
      </div>
      <div className="system-info-row">
        <strong>Platform:</strong> ${crash.platform || "N/A"} ${" | "}
        <strong>Device Memory:</strong> ${crash.deviceMemory != null
          ? `${crash.deviceMemory} GB`
          : "N/A"}
        ${" | "} <strong>Cores:</strong> ${crash.hardwareConcurrency ?? "N/A"}
      </div>
      ${lastMilestone &&
      html`
        <div className="system-info-row">
          <strong>Last milestone:</strong> ${lastMilestone.resource}
          (${lastMilestone.status})
          ${lastMilestone.elapsed != null &&
          html` — ${lastMilestone.elapsed}ms`}
        </div>
      `}
      ${crash.dataSizes &&
      html`
        <div className="system-info-row">
          <strong>Posts:</strong> ${crash.dataSizes.postCount} ${" | "}
          <strong>Chunks:</strong> ${crash.dataSizes.chunkCount}
        </div>
      `}
      ${crash.errors?.length > 0 &&
      html`
        <details className="system-info-limits">
          <summary>Errors (${crash.errors.length})</summary>
          <table className="limits-table">
            <thead>
              <tr>
                <td><strong>Source</strong></td>
                <td><strong>Message</strong></td>
              </tr>
            </thead>
            <tbody>
              ${crash.errors.map(
                (e, i) => html`
                  <tr key=${i}>
                    <td>
                      ${e.source || "N/A"}${e.lineno != null
                        ? `:${e.lineno}`
                        : ""}
                    </td>
                    <td>${e.message}</td>
                  </tr>
                `,
              )}
            </tbody>
          </table>
        </details>
      `}
      ${crash.milestones?.length > 0 &&
      html`
        <details className="system-info-limits">
          <summary>Milestones (${crash.milestones.length})</summary>
          <table className="limits-table">
            <thead>
              <tr>
                <td><strong>Resource</strong></td>
                <td><strong>Status</strong></td>
                <td><strong>Elapsed</strong></td>
              </tr>
            </thead>
            <tbody>
              ${crash.milestones.map(
                (m, i) => html`
                  <tr key=${i}>
                    <td>${m.resource}</td>
                    <td>${m.status}</td>
                    <td>${m.elapsed != null ? `${m.elapsed}ms` : "N/A"}</td>
                  </tr>
                `,
              )}
            </tbody>
          </table>
        </details>
      `}
    </div>
  `;
};

export const Data = () => {
  const { systemInfo } = useConfig();

  return html`
    <${Page} name="Data & Models">
      <h2 className="content-subhead">Data</h2>
      <p>
        We load data, databases, and models for use in the app.
        Some we automatically load (like our posts data), while others can be loaded
        manually. (If you see a gray circle, this is unloaded data that you can click to load.)
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
          FEATURES.chat.enabled &&
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

      ${
        FEATURES.memoryDiagnostics &&
        html`
          <${Fragment}>
            <h2 className="content-subhead">Crash Detection</h2>
            <${CrashInfo} />
            <h2 className="content-subhead">Memory</h2>
            <${MemoryInfo} />
          </${Fragment}>
        `
      }

      <h2 className="content-subhead">Models</h2>

      <${SystemInfo} info=${systemInfo} />
      <${EmbeddingsInfo} />

      ${
        FEATURES.chat.enabled &&
        html`
          <${Fragment}>
            <h3>Google Chrome Built-in AI</h3>
            <p>
              Chrome provides built-in AI powered by Gemini Nano. The browser
              manages model downloads and updates automatically. Requires Chrome
              138+ with AI features enabled. See the Chrome AI
              ${" "}<a
                href="https://developer.chrome.com/docs/ai/built-in-apis"
                target="_blank"
                rel="noopener noreferrer"
              >documentation</a>
              ${" "}for more.
            </p>
            <${ChromeAIInfo} />

            <h3>web-llm</h3>
            <p>
              Available web-llm models for local inference. Status indicates
              whether the model is loaded in memory, currently loading, or
              available for download.
            </p>
            <${ModelsTable} models=${MODELS} />
          </${Fragment}>
        `
      }
    </${Page}>
  `;
};
