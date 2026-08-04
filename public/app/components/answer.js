import { useState, useMemo, Fragment } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { html, openTextInNewWindow } from "../util/html.js";
import { parseThinking } from "../util/think.js";
import { CopyButton } from "./copy-button.js";
import { useSettings } from "../hooks/use-settings.js";
import { ALL_PROVIDERS, getModelCfg } from "../../config.js";
import { formatInt, formatFloat, formatElapsed } from "../../shared-util.js";
import { ContextLimitWarning } from "./context-messages.js";

/**
 * Prettify XML context string with proper indentation.
 * Transforms compact XML into readable format with each CHUNK on its own line.
 * @param {string} xmlString - The raw XML context string
 * @returns {string} Prettified XML
 */
const prettifyXml = (xmlString) => {
  if (!xmlString) return "";
  // Add newlines and indentation for CHUNK elements
  return xmlString
    .replace(/<CHUNK>/g, "\n<CHUNK>\n  ")
    .replace(/<\/CHUNK>/g, "\n</CHUNK>")
    .replace(/<URL>/g, "<URL>")
    .replace(/<\/URL>/g, "</URL>\n  ")
    .replace(/<TITLE>/g, "<TITLE>")
    .replace(/<\/TITLE>/g, "</TITLE>\n  ")
    .replace(/<CONTENT>/g, "<CONTENT>\n    ")
    .replace(/<\/CONTENT>/g, "\n  </CONTENT>")
    .trim();
};

/**
 * Icon link that opens the full prompt (messages array) as JSON in a new page.
 */
const PromptDataLink = ({ data }) => {
  if (!data) return null;

  const handleOpen = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openTextInNewWindow(JSON.stringify(data, null, 2));
  };

  return html`
    <button
      className="answer-actions-btn"
      onClick=${handleOpen}
      title="Open full prompt as JSON"
      aria-label="Open full prompt as JSON"
    >
      <i className="iconoir-message-text"></i>
    </button>
  `;
};

/**
 * Icon link that opens the model's `<think>` reasoning in a new page. Only rendered when the
 * answer actually carries reasoning (i.e. `thinking` is non-empty).
 */
const ThinkingDataLink = ({ thinking }) => {
  if (!thinking) return null;

  const handleOpen = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openTextInNewWindow(thinking);
  };

  return html`
    <button
      className="answer-actions-btn"
      onClick=${handleOpen}
      title="Open model reasoning (<think>)"
      aria-label="Open model reasoning"
    >
      <i className="iconoir-brain"></i>
    </button>
  `;
};

/**
 * Icon link that opens the full context (XML chunks) prettified in a new page.
 */
const ContextDataLink = ({ data }) => {
  if (!data) return null;

  const handleOpen = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openTextInNewWindow(prettifyXml(data));
  };

  return html`
    <button
      className="answer-actions-btn"
      onClick=${handleOpen}
      title="Open full context as XML"
      aria-label="Open full context as XML"
    >
      <i className="iconoir-page"></i>
    </button>
  `;
};

const QueryInfo = ({
  elapsed,
  usage,
  model,
  provider,
  providerApi,
  finishReason,
  chunks,
  context,
  internal,
  turnNumber,
} = {}) => {
  if (!elapsed && !usage && !model && !chunks && !context) return null;

  const totalElapsed = elapsed?.tokensLast
    ? formatElapsed(elapsed.tokensLast)
    : null;

  // Look up model config
  const modelCfg = getModelCfg({ provider, model });
  const maxTokens = modelCfg ? formatInt(modelCfg.maxTokens) : null;
  // Infer cost availability from pricing config
  const hasCost = modelCfg?.pricing && usage?.input?.cost != null;
  const totalCost = hasCost
    ? (usage.input.cost + usage.output.cost).toFixed(2)
    : null;

  // Check for conversation-specific fields
  const hasConversationTokens = usage?.available != null;

  const ElapsedDelta = ({ delta }) => {
    if (delta == null || Number.isNaN(delta)) return null;
    return html`<${Fragment}>(<i className="iconoir-triangle"></i> ${formatElapsed(delta)})</${Fragment}>`;
  };

  return html`
    <details className="query-info">
      <summary>
        <i className="iconoir-nav-arrow-right"></i>
        <em>Query Info</em> (
        ${model && html`${model}${(totalElapsed || usage) && ", "}`}
        ${totalElapsed && html`${totalElapsed}${hasCost && ", "}`}
        ${hasCost && html`$${totalCost}`})
      </summary>

      <div>
        ${
          model &&
          html`
            <div key="model">
              <strong>Model:</strong> ${model}
              <ul>
                ${provider && html`<li>Provider: ${ALL_PROVIDERS[provider]}</li>`}
                ${providerApi && html`<li>API: ${providerApi}</li>`}
                ${maxTokens && html`<li>Input: ${maxTokens} max tokens</li>`}
                ${finishReason && html`<li>Finish reason: ${finishReason}</li>`}
              </ul>
            </div>
          `
        }
        ${
          elapsed &&
          html`
          <${Fragment}>
            <div>
              <strong>Elapsed time:</strong> ${totalElapsed}
            </div>
            <ul>
              <li>
                Start: ${formatElapsed(0)}
              </li>
              ${
                elapsed.embeddingQuery && elapsed.embeddingQuery
                  ? html`
                  <${Fragment}>
                    <li>Embeddings: ${formatElapsed(elapsed.embeddingQuery)} <${ElapsedDelta} delta=${elapsed.embeddingQuery} /></li>
                    <li>DB chunks: ${formatElapsed(elapsed.databaseQuery)} <${ElapsedDelta} delta=${elapsed.databaseQuery - elapsed.embeddingQuery} /></li>
                  </${Fragment}>
                `
                  : html`<li>
                      Chunks: ${formatElapsed(elapsed.chunks)}
                      <${ElapsedDelta} delta=${elapsed.chunks} />
                    </li>`
              }
              <li>
                First Token: ${formatElapsed(elapsed.tokensFirst)}
                ${" "}<${ElapsedDelta} delta=${elapsed.tokensFirst - elapsed.chunks} />
              </li>
              <li>
                Last Token: ${formatElapsed(elapsed.tokensLast)}
                ${" "}<${ElapsedDelta} delta=${elapsed.tokensLast - elapsed.tokensFirst} />
              </li>
            </ul>
          </${Fragment}>
        `
        }
        ${
          chunks &&
          html`
          <${Fragment}>
            <div>
              <strong>Chunks:</strong>
            </div>
            <ul>
              <li>
                Count: ${formatInt(chunks.numChunks)} chunks
              </li>
              <li>
                Similarity: ${formatFloat(chunks.similarityMin)} - ${formatFloat(chunks.similarityMax)} (avg: ${formatFloat(chunks.similarityAvg)})
              </li>
            </ul>
          </${Fragment}>
        `
        }
        ${
          usage &&
          html`
          <${Fragment}>
            <div>
              <strong>Usage:</strong>
            </div>
            <ul>
              ${turnNumber && html`<li>Turn: ${turnNumber}</li>`}
              <li>
                Input: ${hasCost && html`$${formatFloat(usage.input.cost)}, `}${formatInt(usage.input.tokens)} tokens
                ${usage.input.cachedTokens > 0 && html` (${formatInt(usage.input.cachedTokens)} cached)`}
              </li>
              <li>
                Output: ${hasCost && html`$${formatFloat(usage.output.cost)}, `}${formatInt(usage.output.tokens)} tokens
                ${usage.output.reasoningTokens > 0 && html` (${formatInt(usage.output.reasoningTokens)} reasoning)`}
              </li>
              ${
                hasConversationTokens &&
                html`
                  <${Fragment} key="conversation-tokens">
                    <li>Total: ${formatInt(usage.totalTokens)} tokens used</li>
                    <li>
                      Available: ${formatInt(usage.available)} /
                      ${" "}${formatInt(usage.limit)} tokens
                    </li>
                  </${Fragment}>
                `
              }
            </ul>
          </${Fragment}>
        `
        }
        ${
          context &&
          html`
          <${Fragment}>
            <div>
              <strong>Context:</strong>
            </div>
            <ul>
              <li>Base prompt: ${formatInt(context.basePromptTokens)} tokens (est)</li>
              <li>Chunks: ${formatInt(context.chunkCount)} chunks, ${formatInt(context.chunksTokens)} tokens (est)</li>
              ${context.historyTokens > 0 && html`<li>History: ${formatInt(context.historyTokens)} tokens (est)</li>`}
              <li>User query: ${formatInt(context.queryTokens)} tokens (est)</li>
              <li>Total: ${formatInt(context.totalTokens)} tokens (est)</li>
            </ul>
          </${Fragment}>
        `
        }
        ${
          internal &&
          internal.queries?.length > 0 &&
          html`
          <${Fragment}>
            <div>
              <strong>Internal:</strong>
            </div>
            <ul>
              ${
                internal.queries &&
                internal.queries.length > 0 &&
                html`
                  <li>
                    <details>
                      <summary>Queries: ${internal.queries.length}</summary>
                      <ul style=${{ listStyle: "none" }}>
                        ${internal.queries.map(
                          (query, i) =>
                            html`<li key=${`internal-query-${i}`}>
                              ${query}
                            </li>`,
                        )}
                      </ul>
                    </details>
                  </li>
                `
              }
            </ul>
          </${Fragment}>
        `
        }
      </div>
    </details>
  `;
};

export const Answer = ({ answer, think, queryInfo, onNewConversation }) => {
  const [isRaw, setIsRaw] = useState(false);
  const [settings] = useSettings();
  const { isDeveloperMode } = settings;

  // Reasoning models wrap chain-of-thought in <think>…</think>; keep it out of the visible answer
  // (and the copy button) — it's surfaced separately via the dev-mode ThinkingDataLink. Reuse the
  // parse the caller already memoized (chat passes it per entry); otherwise parse here, memoized on
  // `answer`, so the component stays correct and cheap for any other caller.
  const parsed = useMemo(() => think ?? parseThinking(answer), [think, answer]);
  const visibleAnswer = parsed.visible;

  let answerSection;
  if (isRaw && isDeveloperMode) {
    answerSection = html`<div className="answer-raw">
      ${visibleAnswer
        .split("\n")
        .map((par, i) => html`<p key=${`answer-par-${i}`}>${par}</p>`)}
    </div>`;
  } else {
    const renderedHtml = marked.parse(visibleAnswer, {
      breaks: true,
      gfm: true,
    });
    const sanitizedHtml = DOMPurify.sanitize(renderedHtml);
    answerSection = html`
      <div
        className="markdown-body"
        dangerouslySetInnerHTML=${{ __html: sanitizedHtml }}
      />
    `;
  }

  return html`
    <${Fragment}>
      <div className="answer">
        ${answerSection}
      </div>
      <div className="answer-actions">
        ${isDeveloperMode && queryInfo && html`<${QueryInfo} ...${queryInfo} />`}
        ${isDeveloperMode && queryInfo?.prompt && html`<${PromptDataLink} data=${queryInfo.prompt} />`}
        ${isDeveloperMode && queryInfo?.rawContext && html`<${ContextDataLink} data=${queryInfo.rawContext} />`}
        ${isDeveloperMode && html`<${ThinkingDataLink} thinking=${parsed.thinking} />`}
        ${
          isDeveloperMode &&
          html`
            <button
              className="answer-actions-btn"
              onClick=${() => setIsRaw((v) => !v)}
              title=${isRaw ? "Show formatted" : "Show raw markdown"}
              aria-label=${isRaw ? "Show formatted" : "Show raw markdown"}
            >
              <i className=${isRaw ? "iconoir-align-left" : "iconoir-code"}></i>
            </button>
          `
        }
        <${CopyButton} text=${visibleAnswer} />
      </div>
      <${ContextLimitWarning}
        finishReason=${queryInfo?.finishReason}
        onNewConversation=${onNewConversation}
      />
    </${Fragment}>
  `;
};
