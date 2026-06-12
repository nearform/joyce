import { useState, useEffect, useMemo } from "react";
import { Link, useSearchParams } from "react-router";
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
import {
  pickBestModel,
  tierClass,
  tierLabel,
} from "../../local/data/recommendations.js";
import { useCrashbox } from "../hooks/use-crashbox.js";

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

// Stable reference for the "no warnings" case so fitCtx memoization below doesn't invalidate every
// render (a fresh `[]` each call would change identity and defeat the useMemo).
const EMPTY_WARNINGS = [];

// The live `{ warnings, recovered }` state used to drive the device-fit recommendations. Re-renders
// (via useCrashbox) when crashbox emits a warning or a recovery is dismissed.
const useCrashboxState = () => {
  const { recovered, status } = useCrashbox();
  return { warnings: status?.warnings ?? EMPTY_WARNINGS, recovered };
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

// Resolve Chrome built-in AI (Prompt/Writer) availability into ready-to-render badges.
// Availability is only probed when chat is enabled and the API is feature-detected as present;
// on iOS Safari (no built-in AI) this stays inert. Shared by SystemPanel and ModelsPanel.
const useChromeAiStatus = (experimentalChat) => {
  const [promptStatus, setPromptStatus] = useState(null);
  const [writerStatus, setWriterStatus] = useState(null);
  useEffect(() => {
    if (!experimentalChat) return;
    if (CHROME_HAS_PROMPT_API)
      checkAvailability("prompt").then(setPromptStatus);
    if (CHROME_HAS_WRITER_API)
      checkAvailability("writer").then(setWriterStatus);
  }, [experimentalChat]);
  return {
    promptBadge: getApiStatusBadge(CHROME_HAS_PROMPT_API, promptStatus),
    writerBadge: getApiStatusBadge(CHROME_HAS_WRITER_API, writerStatus),
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

const deviceClassLabel = (deviceInfo) => {
  if (!deviceInfo) return "Unknown";
  const platform = deviceInfo.isIOS
    ? "iOS"
    : deviceInfo.isAndroid
      ? "Android"
      : "Desktop";
  const browser = deviceInfo.isSafari
    ? "Safari"
    : deviceInfo.isChrome
      ? "Chrome"
      : "Other";
  const form = deviceInfo.isMobile ? "Mobile" : "Desktop";
  return `${form} / ${platform} / ${browser}`;
};

const SystemPanel = ({ systemInfo, deviceInfo, experimentalChat }) => {
  const { webgpu, limits, gpuInfo, ramGb } = systemInfo;
  const { getStatus } = useLoading();
  const extractorStatus = getStatus(LOADING.EXTRACTOR);
  const extractor =
    extractorStatus === "loaded" ? getLoadedData(LOADING.EXTRACTOR) : null;
  const device = extractor?._device ?? null;
  const { warnings, recovered } = useCrashboxState();
  const fitCtx = useMemo(
    () => ({ systemInfo, deviceInfo, warnings, recovered }),
    [systemInfo, deviceInfo, warnings, recovered],
  );
  // Pick the best model only when chat is enabled — otherwise the recommendation isn't
  // actionable. The card is still gated on experimentalChat below.
  const best = experimentalChat ? pickBestModel(MODELS, fitCtx) : null;

  // Chrome built-in AI availability, surfaced alongside the web-llm pick so "Best for this
  // device" reflects every provider, not just web-llm.
  const { promptBadge, writerBadge } = useChromeAiStatus(experimentalChat);

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
      <h3>Device Profile</h3>
      <div className="system-info">
        <div className="system-info-row">
          <strong>Class:</strong> ${deviceClassLabel(deviceInfo)}
        </div>

        <div className="system-info-row">
          <strong>WebGPU:</strong>
          <span className=${`status-badge ${webgpuStatus.className}`}>
            ${webgpuStatus.label}
          </span>
          ${limits.maxBufferSize != null &&
          html`<span className="gpu-info">
            ${formatBytes(limits.maxBufferSize)} max buffer
          </span>`}
          ${gpuInfo && html`<span className="gpu-info">${gpuInfo}</span>`}
        </div>

        <div className="system-info-row">
          <strong>System RAM:</strong>${" "}
          ${ramGb != null
            ? `${ramGb} GB`
            : "Unknown (iOS Safari does not expose deviceMemory)"}
        </div>

        <div className="system-info-row">
          <strong>Embeddings Backend:</strong>
          <span className=${`status-badge ${embeddingsBadge.className}`}>
            ${embeddingsBadge.label}
          </span>
        </div>

        <div className="system-info-row">
          <strong>Cache backend:</strong>${" "}
          <span
            className=${`status-badge ${useIndexedDBCache ? "status-warning" : "status-supported"}`}
          >
            ${useIndexedDBCache ? "IndexedDB" : "Cache API"}
          </span>
          ${useIndexedDBCache &&
          html`<span className="gpu-info">(common on iOS Safari)</span>`}
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

      ${experimentalChat &&
      html`
        <h3>Best for this device</h3>
        <div className="system-info">
          <div className="system-info-row">
            <strong>web-llm:</strong>
            ${best
              ? html`
                  ${best.model.model}
                  ${best.model.vramMb != null &&
                  html`<span className="gpu-info">
                    (${best.model.vramMb} MB VRAM)
                  </span>`}
                  <span className=${`status-badge ${tierClass(best.fit.tier)}`}>
                    ${tierLabel(best.fit.tier)}
                  </span>
                `
              : html`
                  <span className="status-badge status-unsupported">
                    No clearly-safe model
                  </span>
                `}
          </div>
          ${best
            ? html`
                <div
                  className="system-info-row"
                  style=${{ color: "var(--color-text-muted)" }}
                >
                  ${best.fit.reasons.join(" ")}
                </div>
              `
            : html`
                <div
                  className="system-info-row"
                  style=${{ color: "var(--color-text-muted)" }}
                >
                  See the${" "}<strong>AI Models</strong>${" "}tab for the
                  smallest options.
                </div>
              `}

          <div className="system-info-row">
            <strong>Chrome Prompt API:</strong>
            <span className=${`status-badge ${promptBadge.className}`}>
              ${promptBadge.label}
            </span>
          </div>
          <div className="system-info-row">
            <strong>Chrome Writer API:</strong>
            <span className=${`status-badge ${writerBadge.className}`}>
              ${writerBadge.label}
            </span>
          </div>
        </div>
      `}
    </div>
  `;
};

const ModelsPanel = ({ experimentalChat, systemInfo, deviceInfo }) => {
  const { promptBadge, writerBadge } = useChromeAiStatus(experimentalChat);
  const { warnings, recovered } = useCrashboxState();
  const fitCtx = useMemo(
    () => ({ systemInfo, deviceInfo, warnings, recovered }),
    [systemInfo, deviceInfo, warnings, recovered],
  );

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
      <${ModelsTable} models=${MODELS} fitCtx=${fitCtx} />
    </div>
  `;
};

export const Data = () => {
  const [settings] = useSettings();
  const { systemInfo, deviceInfo } = useConfig();
  const [searchParams, setSearchParams] = useSearchParams();

  const crashboxOn = settings.isDeveloperMode && settings.experimentalCrashbox;
  const tabs = crashboxOn ? [...BASE_TABS, CRASHES_TAB] : BASE_TABS;
  const defaultTab = tabs[0]?.id ?? "resources";

  const [activeTab, setActiveTab] = useState(() => {
    const urlTab = searchParams.get("tab");
    if (urlTab && tabs.some((t) => t.id === urlTab)) return urlTab;
    return defaultTab;
  });

  useEffect(() => {
    setSearchParams({ tab: activeTab }, { replace: true });
  }, [activeTab, setSearchParams]);

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
        html`<${SystemPanel}
          systemInfo=${systemInfo}
          deviceInfo=${deviceInfo}
          experimentalChat=${settings.experimentalChat}
        />`
      }
      ${
        activeTab === "models" &&
        html`<${ModelsPanel}
          experimentalChat=${settings.experimentalChat}
          systemInfo=${systemInfo}
          deviceInfo=${deviceInfo}
        />`
      }
      ${activeTab === "crashes" && crashboxOn && html`<${CrashesPanel} />`}
    </${Page}>
  `;
};
