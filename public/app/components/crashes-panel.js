/* global window:false */
import { useState } from "react";
import { Link } from "react-router";
import { html } from "../util/html.js";
import { Alert } from "./alert.js";
import { CopyButton } from "./copy-button.js";
import {
  dismissRecovered,
  reportMemoryPressure,
  resetCrashbox,
} from "../../local/data/telemetry.js";
import { useCrashbox } from "../hooks/use-crashbox.js";

const REASON_LABELS = {
  "webgpu-device-lost": {
    label: "WebGPU device lost",
    className: "status-unsupported",
  },
  oom: { label: "Out of memory", className: "status-unsupported" },
  "hard-kill": { label: "Hard kill", className: "status-warning" },
  unknown: { label: "Unknown", className: "status-warning" },
};

const WARNING_LABELS = {
  "memory-pressure": {
    label: "Memory pressure",
    className: "status-warning",
    icon: "iconoir-warning-triangle",
  },
  "device-loss-imminent": {
    label: "GPU device-loss imminent",
    className: "status-unsupported",
    icon: "iconoir-warning-circle",
  },
};

// How many of the newest live warnings the panel renders (crashbox retains more in its buffer).
const MAX_VISIBLE_WARNINGS = 3;

const formatTime = (t) => new Date(t).toLocaleTimeString();

const RecoveredCrash = ({ record, onDismiss }) => {
  const [showCrumbs, setShowCrumbs] = useState(false);
  const [showSnapshot, setShowSnapshot] = useState(false);
  const reason = REASON_LABELS[record.reason] ?? REASON_LABELS.unknown;
  const isWebgpu = record.reason === "webgpu-device-lost";

  return html`
    <${Alert} type="error">
      <h3 style=${{ marginTop: 0 }}>
        <i className="iconoir-warning-circle"></i>${" "}
        Previous session crashed
      </h3>
      <div className="system-info-row">
        <strong>Reason:</strong>${" "}
        <span className=${`status-badge ${reason.className}`}>
          ${reason.label}
        </span>
      </div>
      <div className="system-info-row">
        <strong>Time:</strong> ${new Date(record.lastSeen).toLocaleString()}
      </div>
      <div className="system-info-row">
        <strong>Session:</strong>${" "}
        <code style=${{ fontSize: "0.85em" }}>${record.sessionId}</code>
      </div>
      ${
        isWebgpu &&
        html`
        <p style=${{ marginTop: "0.5rem" }}>
          Suggestion: switch the embeddings extractor to WASM in${" "}
          <${Link} to="/settings">Settings</${Link}>${" "}
          (turn off Experimental WebGPU Embeddings) for a more stable load.
        </p>
      `
      }
      <div className="alert-details">
        <button
          onClick=${() => setShowCrumbs(!showCrumbs)}
          className="pure-button pure-button-xsmall"
        >
          ${showCrumbs ? "Hide" : "Show"}${" "}breadcrumbs${" "}
          (${record.breadcrumbs.length})
        </button>${" "}
        <button
          onClick=${() => setShowSnapshot(!showSnapshot)}
          className="pure-button pure-button-xsmall"
        >
          ${showSnapshot ? "Hide" : "Show"}${" "}snapshot
        </button>${" "}
        <button
          onClick=${onDismiss}
          className="pure-button pure-button-xsmall"
        >
          Dismiss
        </button>
      </div>
      ${
        showCrumbs &&
        html`
          <pre className="alert-stack">
${record.breadcrumbs
              .map(
                (c) =>
                  `[${formatTime(c.t)}] ${c.msg}${c.data ? " " + JSON.stringify(c.data) : ""}`,
              )
              .join("\n")}</pre
          >
        `
      }
      ${
        showSnapshot &&
        html`
          <pre className="alert-stack">
${JSON.stringify(record.snapshot ?? {}, null, 2)}</pre
          >
        `
      }
    </${Alert}>
  `;
};

const isEmpty = (v) =>
  v == null || (typeof v === "object" && Object.keys(v).length === 0);

const InlineView = ({ view }) => {
  if (isEmpty(view.payload)) {
    return html`
      <p
        className="crashes-empty"
        style=${{ color: "var(--color-text-muted)", fontStyle: "italic" }}
      >
        No data for "${view.label}" — nothing to show.
      </p>
    `;
  }
  const text = JSON.stringify(view.payload, null, 2);
  return html`
    <div className="crashes-dump-wrap">
      <${CopyButton}
        text=${text}
        className="crashes-copy-button"
        title="Copy"
      />
      <pre className="crashes-dump">
<code>${text}</code></pre>
    </div>
  `;
};

// Summarize a memory-pressure info object: "serious · 87% · performance.memory".
const warningDetail = (info) => {
  if (!info) {
    return "";
  }
  const parts = [];
  if (info.level) {
    parts.push(info.level);
  }
  if (typeof info.ratio === "number") {
    parts.push(`${Math.round(info.ratio * 100)}%`);
  }
  if (info.source) {
    parts.push(info.source);
  }
  if (info.reason) {
    parts.push(info.reason); // device-loss-imminent carries a reason instead
  }
  return parts.length ? ` — ${parts.join(" · ")}` : "";
};

const WarningRow = ({ warning }) => {
  const cfg = WARNING_LABELS[warning.kind] ?? {
    label: warning.kind,
    className: "status-warning",
    icon: "iconoir-warning-triangle",
  };
  return html`
    <div className="system-info-row">
      <i className=${cfg.icon}></i>${" "}
      <span className=${`status-badge ${cfg.className}`}>${cfg.label}</span>
      <span style=${{ color: "var(--color-text-muted)", marginLeft: "0.5rem" }}>
        ${formatTime(warning.t)}${warningDetail(warning.info)}
      </span>
    </div>
  `;
};

export const CrashesPanel = () => {
  // Re-renders on crashbox events (recovered dismiss, new live warning).
  const { recovered: record, status } = useCrashbox();

  // inlineView: null = nothing shown; { label, payload } = a button has been clicked.
  // payload may itself be null/empty — that's how "no data" is rendered.
  const [inlineView, setInlineView] = useState(null);
  // crashbox keeps the full buffer; the panel shows only the most recent few (newest first) so a
  // long session — or a steady-state pressure signal that re-fires periodically — doesn't flood it.
  const warnings = status?.warnings ?? [];
  const recentWarnings = warnings.slice(-MAX_VISIBLE_WARNINGS).reverse();
  const hiddenWarnings = warnings.length - recentWarnings.length;

  return html`
    <div
      className="tabs-panel"
      role="tabpanel"
      id="tabpanel-crashes"
      aria-labelledby="tab-crashes"
    >
      ${record &&
      html`<${RecoveredCrash}
        record=${record}
        onDismiss=${dismissRecovered}
      />`}

      <h3>Live session warnings</h3>
      ${warnings.length === 0
        ? html`<p style=${{ color: "var(--color-text-muted)" }}>
            No warnings this session.
          </p>`
        : html`<div className="system-info">
            ${recentWarnings.map(
              (w, i) =>
                html`<${WarningRow} key=${`${w.t}-${i}`} warning=${w} />`,
            )}
            ${hiddenWarnings > 0 &&
            html`<div
              className="system-info-row"
              style=${{
                color: "var(--color-text-muted)",
                fontStyle: "italic",
              }}
            >
              + ${hiddenWarnings} earlier
              ${hiddenWarnings === 1 ? "warning" : "warnings"}
            </div>`}
          </div>`}

      <h3>Session diagnostics</h3>
      ${status
        ? html`
            <div className="system-info">
              <div className="system-info-row">
                <strong>Session:</strong>${" "}
                <code style=${{ fontSize: "0.85em" }}>${status.sessionId}</code>
              </div>
              <div className="system-info-row">
                <strong>Breadcrumbs:</strong> ${status.breadcrumbCount}
              </div>
              <div className="system-info-row">
                <strong>Last seen:</strong>${" "}
                ${new Date(status.lastSeen).toLocaleTimeString()}
              </div>
            </div>
          `
        : html`<p>Telemetry not initialized.</p>`}

      <details style=${{ marginTop: "1rem" }}>
        <summary>Debug actions</summary>
        <p style=${{ color: "var(--color-text-muted)" }}>
          Available on the global <code>window.__crashbox</code> handle:${" "}
          <code>dump()</code>, <code>clear()</code>, <code>recovered()</code>.
        </p>
        <div className="crashes-debug-buttons">
          <button
            className="pure-button pure-button-xsmall"
            onClick=${() =>
              setInlineView((cur) =>
                cur?.key === "dump"
                  ? null
                  : {
                      key: "dump",
                      label: "Full dump",
                      payload: window.__crashbox?.dump() ?? null,
                    },
              )}
            type="button"
          >
            ${inlineView?.key === "dump" ? "Hide dump" : "Show dump"}
          </button>
          <button
            className="pure-button pure-button-xsmall"
            onClick=${() =>
              setInlineView((cur) =>
                cur?.key === "recovered"
                  ? null
                  : {
                      key: "recovered",
                      label: "Recovered crash",
                      payload: window.__crashbox?.recovered() ?? null,
                    },
              )}
            type="button"
          >
            ${inlineView?.key === "recovered"
              ? "Hide recovered"
              : "Show recovered"}
          </button>
          <button
            className="pure-button pure-button-xsmall"
            onClick=${() =>
              reportMemoryPressure({
                level: "critical",
                source: "joyce-debug",
                usedBytes: 920 * 1048576,
                limitBytes: 1024 * 1048576,
              })}
            type="button"
          >
            Simulate memory pressure
          </button>
          <button
            className="pure-button pure-button-xsmall"
            onClick=${() => {
              resetCrashbox();
              setInlineView(null);
            }}
            type="button"
          >
            <i className="iconoir-refresh-double"></i>${" "}Reset crashbox
          </button>
        </div>
        ${inlineView !== null && html`<${InlineView} view=${inlineView} />`}
      </details>
    </div>
  `;
};
