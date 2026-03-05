/* global Blob:false,URL:false,document:false,console:false */
import { useState, useEffect, useCallback } from "react";
import { html } from "../util/html.js";
import { Page } from "../components/page.js";
import { useEval } from "../hooks/use-eval.js";
import {
  ALL_CHAT_MODELS,
  DEFAULT_CHAT_MODEL,
  DEFAULT_TEMPERATURE,
} from "../../config.js";
import { fetchWrapper } from "../../local/data/util.js";
import {
  getRuns,
  getRun,
  deleteRun,
  exportRun,
} from "../../local/data/eval/results.js";

// ============================================================================
// Helpers
// ============================================================================

const ALL_MODELS = ALL_CHAT_MODELS.flatMap(({ provider, models }) =>
  models.map((m) => ({ provider, model: m.model, label: m.modelShortName })),
);

const CATEGORIES = ["technology", "services", "case-study", "general"];

const scoreClass = (score) => {
  if (score == null) return "eval-score-na";
  if (score <= 2) return "eval-score-low";
  if (score <= 3) return "eval-score-mid";
  return "eval-score-high";
};

const pctClass = (ratio) => {
  if (ratio == null) return "eval-score-na";
  const pct = ratio * 100;
  if (pct < 40) return "eval-score-low";
  if (pct < 70) return "eval-score-mid";
  return "eval-score-high";
};

const formatScore = (score) => (score != null ? score.toFixed(1) : "-");
const formatPct = (ratio) =>
  ratio != null ? `${Math.round(ratio * 100)}%` : "-";

/**
 * Pick a default judge that differs from the subject when possible.
 */
const pickDefaultJudge = (subjectProvider, subjectModel) => {
  // Prefer a different provider
  const other = ALL_MODELS.find((m) => m.provider !== subjectProvider);
  if (other) return other;
  // Fallback: different model same provider
  const diff = ALL_MODELS.find((m) => m.model !== subjectModel);
  return diff || ALL_MODELS[0];
};

// ============================================================================
// Config Form
// ============================================================================

const ConfigForm = ({ onRun, isRunning, onStop }) => {
  const defaultSubject =
    ALL_MODELS.find(
      (m) =>
        m.provider === DEFAULT_CHAT_MODEL.provider &&
        m.model === DEFAULT_CHAT_MODEL.model,
    ) || ALL_MODELS[0];

  const [subject, setSubject] = useState(defaultSubject);
  const [judge, setJudge] = useState(() =>
    pickDefaultJudge(defaultSubject.provider, defaultSubject.model),
  );
  const [temperature, setTemperature] = useState(DEFAULT_TEMPERATURE);
  const [selectedCategories, setSelectedCategories] = useState(
    new Set(CATEGORIES),
  );

  const toggleCategory = (cat) => {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) {
        next.delete(cat);
      } else {
        next.add(cat);
      }
      return next;
    });
  };

  const handleSubjectChange = (e) => {
    const [provider, model] = e.target.value.split("|");
    const m = ALL_MODELS.find(
      (x) => x.provider === provider && x.model === model,
    );
    setSubject(m);
    // Auto-update judge if it matches the new subject
    if (judge.provider === provider && judge.model === model) {
      setJudge(pickDefaultJudge(provider, model));
    }
  };

  const handleJudgeChange = (e) => {
    const [provider, model] = e.target.value.split("|");
    setJudge(
      ALL_MODELS.find((x) => x.provider === provider && x.model === model),
    );
  };

  const sameModel =
    subject.provider === judge.provider && subject.model === judge.model;

  const handleSubmit = (e) => {
    e.preventDefault();
    onRun({
      subject: { provider: subject.provider, model: subject.model },
      judge: { provider: judge.provider, model: judge.model },
      temperature,
      categories: [...selectedCategories],
    });
  };

  return html`
    <form onSubmit=${handleSubmit} className="eval-config">
      <div className="pure-g">
        <div className="pure-u-1 pure-u-md-1-2">
          <label>Subject Model</label>
          <select
            value="${subject.provider}|${subject.model}"
            onChange=${handleSubjectChange}
            className="pure-input-1"
            disabled=${isRunning}
          >
            ${ALL_MODELS.map(
              (m) => html`
                <option
                  key="${m.provider}|${m.model}"
                  value="${m.provider}|${m.model}"
                >
                  ${m.label} (${m.provider})
                </option>
              `,
            )}
          </select>
        </div>
        <div className="pure-u-1 pure-u-md-1-2">
          <label>Judge Model</label>
          <select
            value="${judge.provider}|${judge.model}"
            onChange=${handleJudgeChange}
            className="pure-input-1"
            disabled=${isRunning}
          >
            ${ALL_MODELS.map(
              (m) => html`
                <option
                  key="${m.provider}|${m.model}"
                  value="${m.provider}|${m.model}"
                >
                  ${m.label} (${m.provider})
                </option>
              `,
            )}
          </select>
          ${sameModel &&
          html`<small className="eval-warning">
            Warning: judge and subject are the same model
          </small>`}
        </div>
      </div>

      <div className="pure-g">
        <div className="pure-u-1 pure-u-md-1-4">
          <label>Temperature</label>
          <input
            type="number"
            min="0"
            max="2"
            step="0.1"
            value=${temperature}
            onChange=${(e) => setTemperature(parseFloat(e.target.value))}
            className="pure-input-1"
            disabled=${isRunning}
          />
        </div>
        <div className="pure-u-1 pure-u-md-3-4">
          <label>Categories</label>
          <div className="eval-categories">
            ${CATEGORIES.map(
              (cat) => html`
                <label key=${cat} className="eval-category-label">
                  <input
                    type="checkbox"
                    checked=${selectedCategories.has(cat)}
                    onChange=${() => toggleCategory(cat)}
                    disabled=${isRunning}
                  />
                  ${" "}${cat}
                </label>
              `,
            )}
          </div>
        </div>
      </div>

      <div className="eval-actions">
        ${isRunning
          ? html`<button
              type="button"
              className="pure-button"
              onClick=${onStop}
            >
              Stop
            </button>`
          : html`<button
              type="submit"
              className="pure-button pure-button-primary"
              disabled=${selectedCategories.size === 0}
            >
              Run Eval
            </button>`}
      </div>
    </form>
  `;
};

// ============================================================================
// Progress
// ============================================================================

const Progress = ({ progress, results, totalCases }) => {
  if (!progress) return null;

  const completed = results.length;
  const pct = totalCases > 0 ? Math.round((completed / totalCases) * 100) : 0;

  return html`
    <div className="eval-progress">
      <div className="eval-progress-bar-track">
        <div
          className="eval-progress-bar-fill"
          style=${{ width: `${pct}%` }}
        ></div>
      </div>
      <p className="eval-progress-text">
        ${completed}/${totalCases} cases${" "}
        ${progress.message ? `— ${progress.message}` : ""}
      </p>
    </div>
  `;
};

// ============================================================================
// Results Table
// ============================================================================

const ResultRow = ({ result, even }) => {
  const { id, query, category, judgeScores, metrics, error } = result;
  const rowClass = `eval-row${even ? " eval-row-even" : ""}`;

  if (error) {
    return html`
      <div key=${id} className="${rowClass} eval-row-error">
        <span className="eval-cell eval-query">${query}</span>
        <span className="eval-cell eval-category">${category}</span>
        <span className="eval-cell eval-error-msg">Error: ${error}</span>
      </div>
    `;
  }

  const s = judgeScores || {};
  const dims = ["faithfulness", "relevance", "citationQuality", "completeness"];

  return html`
    <details key=${id} className=${rowClass}>
      <summary className="eval-grid-row">
        <span className="eval-cell eval-query">${query}</span>
        <span className="eval-cell eval-category">${category}</span>
        ${dims.map(
          (d) => html`
            <span
              key=${d}
              className="eval-cell eval-score ${scoreClass(s[d]?.score)}"
            >
              ${formatScore(s[d]?.score)}
            </span>
          `,
        )}
        <span
          className="eval-cell eval-score ${pctClass(
            metrics?.citations?.ratio,
          )}"
        >
          ${formatPct(metrics?.citations?.ratio)}
        </span>
        <span
          className="eval-cell eval-score ${pctClass(metrics?.topics?.ratio)}"
        >
          ${formatPct(metrics?.topics?.ratio)}
        </span>
      </summary>
      <div className="eval-detail">
        <h4>Answer</h4>
        <pre className="eval-answer">${result.answer}</pre>

        ${judgeScores &&
        html`<div>
          <h4>Judge Reasoning</h4>
          <ul>
            ${dims
              .filter((d) => s[d]?.reason)
              .map(
                (d) =>
                  html`<li key=${d}><strong>${d}:</strong> ${s[d].reason}</li>`,
              )}
          </ul>
        </div>`}
        ${!judgeScores &&
        result.judgeRaw &&
        html`<div>
          <h4>Judge Raw Response</h4>
          <pre className="eval-raw">${result.judgeRaw}</pre>
        </div>`}
        ${metrics?.citations?.invalid?.length > 0 &&
        html`<div>
          <h4>Invalid Citations</h4>
          <ul>
            ${metrics.citations.invalid.map(
              (c) => html`<li key=${c.url}>${c.title} — ${c.url}</li>`,
            )}
          </ul>
        </div>`}
        ${metrics?.topics?.missing?.length > 0 &&
        html`<div>
          <h4>Missing Topics</h4>
          <p>${metrics.topics.missing.join(", ")}</p>
        </div>`}
      </div>
    </details>
  `;
};

const SummaryBar = ({ summary }) => {
  if (!summary) return null;

  const { avgScores, avgProgrammatic } = summary;

  return html`
    <div className="eval-summary">
      <span className="eval-summary-item">
        Cases: ${summary.completedCases}/${summary.totalCases}
        ${summary.errorCases > 0 ? ` (${summary.errorCases} errors)` : ""}
      </span>
      ${avgScores.faithfulness != null &&
      html`<span
        className="eval-summary-item ${scoreClass(avgScores.faithfulness)}"
      >
        Faith: ${avgScores.faithfulness}
      </span>`}
      ${avgScores.relevance != null &&
      html`<span
        className="eval-summary-item ${scoreClass(avgScores.relevance)}"
      >
        Relev: ${avgScores.relevance}
      </span>`}
      ${avgScores.citationQuality != null &&
      html`<span
        className="eval-summary-item ${scoreClass(avgScores.citationQuality)}"
      >
        Cite: ${avgScores.citationQuality}
      </span>`}
      ${avgScores.completeness != null &&
      html`<span
        className="eval-summary-item ${scoreClass(avgScores.completeness)}"
      >
        Compl: ${avgScores.completeness}
      </span>`}
      ${avgProgrammatic.citationRatio != null &&
      html`<span
        className="eval-summary-item ${pctClass(avgProgrammatic.citationRatio)}"
      >
        Cite%: ${avgProgrammatic.citationRatio}%
      </span>`}
      ${avgProgrammatic.topicRatio != null &&
      html`<span
        className="eval-summary-item ${pctClass(avgProgrammatic.topicRatio)}"
      >
        Topic%: ${avgProgrammatic.topicRatio}%
      </span>`}
    </div>
  `;
};

const ResultsTable = ({ results, summary }) => {
  if (results.length === 0) return null;

  return html`
    <div className="eval-results">
      <${SummaryBar} summary=${summary} />

      <div className="eval-grid">
        <div className="eval-grid-row eval-grid-header">
          <span className="eval-cell eval-query">Query</span>
          <span className="eval-cell eval-category">Cat</span>
          <span className="eval-cell eval-score">Faith</span>
          <span className="eval-cell eval-score">Relev</span>
          <span className="eval-cell eval-score">Cite</span>
          <span className="eval-cell eval-score">Compl</span>
          <span className="eval-cell eval-score">Cite%</span>
          <span className="eval-cell eval-score">Topic%</span>
        </div>
        ${results.map(
          (r, i) =>
            html`<${ResultRow} key=${r.id} result=${r} even=${i % 2 === 1} />`,
        )}
      </div>
    </div>
  `;
};

// ============================================================================
// Previous Runs
// ============================================================================

const PreviousRuns = ({ onLoad }) => {
  const [runs, setRuns] = useState(() => getRuns());
  const [selectedId, setSelectedId] = useState("");

  const handleLoad = () => {
    if (!selectedId) return;
    const run = getRun(selectedId);
    if (run) onLoad(run);
  };

  const handleDelete = () => {
    if (!selectedId) return;
    deleteRun(selectedId);
    setRuns(getRuns());
    setSelectedId("");
  };

  if (runs.length === 0) return null;

  return html`
    <div className="eval-previous">
      <h3>Previous Runs</h3>
      <div className="eval-previous-controls">
        <select
          value=${selectedId}
          onChange=${(e) => setSelectedId(e.target.value)}
          className="pure-input-1-2"
        >
          <option value="">Select a run...</option>
          ${runs.map(
            (r) => html`
              <option key=${r.id} value=${r.id}>
                ${new Date(r.timestamp).toLocaleString()} —
                ${r.subject?.model || "unknown"}
                ${r.summary
                  ? ` (avg faith: ${r.summary.avgScores?.faithfulness || "?"})`
                  : ""}
              </option>
            `,
          )}
        </select>
        <button
          className="pure-button"
          onClick=${handleLoad}
          disabled=${!selectedId}
        >
          Load
        </button>
        <button
          className="pure-button"
          onClick=${handleDelete}
          disabled=${!selectedId}
        >
          Delete
        </button>
      </div>
    </div>
  `;
};

// ============================================================================
// Export Button
// ============================================================================

const ExportButton = ({ run }) => {
  if (!run) return null;

  const handleExport = () => {
    const json = exportRun(run);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `eval-${run.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return html`
    <button className="pure-button" onClick=${handleExport}>Export JSON</button>
  `;
};

// ============================================================================
// Main Page
// ============================================================================

export const Eval = () => {
  const { status, progress, results, summary, error, run, stop, lastRun } =
    useEval();
  const [dataset, setDataset] = useState(null);
  const [loadedRun, setLoadedRun] = useState(null);

  // Load eval dataset
  useEffect(() => {
    fetchWrapper("/data/eval-dataset.json")
      .then(setDataset)
      .catch((err) => console.error("Failed to load eval dataset:", err));
  }, []);

  const handleRun = useCallback(
    ({ subject, judge, temperature, categories }) => {
      if (!dataset) return;

      const filteredCases = dataset.cases.filter((c) =>
        categories.includes(c.category),
      );

      if (filteredCases.length === 0) return;

      setLoadedRun(null);
      run({ subject, judge, cases: filteredCases, temperature });
    },
    [dataset, run],
  );

  const handleLoadRun = useCallback((prevRun) => {
    setLoadedRun(prevRun);
  }, []);

  const displayResults = loadedRun ? loadedRun.cases : results;
  const displaySummary = loadedRun ? loadedRun.summary : summary;
  const displayRun = loadedRun || lastRun;

  const totalCases =
    status === "running" && progress?.total ? progress.total : 0;

  return html`
    <${Page} name="Eval">
      <p>
        RAG evaluation system. Tests answer quality using LLM-as-judge scoring
        and programmatic metrics. Select a subject model to evaluate and a judge
        model to score the answers.
      </p>

      ${!dataset && html`<p>Loading eval dataset...</p>`}

      ${
        dataset &&
        html`
          <${ConfigForm}
            onRun=${handleRun}
            isRunning=${status === "running"}
            onStop=${stop}
          />
        `
      }

      ${
        status === "running" &&
        html`<${Progress}
          progress=${progress}
          results=${results}
          totalCases=${totalCases}
        />`
      }

      ${error && html`<p className="eval-error">Error: ${error}</p>`}

      <${ResultsTable}
        results=${displayResults}
        summary=${displaySummary}
      />

      <div className="eval-footer">
        <${ExportButton} run=${displayRun} />
        <${PreviousRuns} onLoad=${handleLoadRun} />
      </div>
    </${Page}>
  `;
};
