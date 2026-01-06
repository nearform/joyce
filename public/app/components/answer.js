import { useState, Fragment } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { html, openTextInNewWindow } from "../util/html.js";
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

  const handleOpen = () => openTextInNewWindow(JSON.stringify(data, null, 2));

  return html`
    <span onClick=${handleOpen} title="Open full prompt as JSON">
      <i className="ui-icon-button iconoir-message-text"></i>
    </span>
  `;
};

/**
 * Icon link that opens the full context (XML chunks) prettified in a new page.
 */
const ContextDataLink = ({ data }) => {
  if (!data) return null;

  const handleOpen = () => openTextInNewWindow(prettifyXml(data));

  return html`
    <span onClick=${handleOpen} title="Open full context as XML">
      <i className="ui-icon-button iconoir-page"></i>
    </span>
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
  prompt,
  rawContext,
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
        ${hasCost && html`$${totalCost}`}) ${" "}
        <${PromptDataLink} data=${prompt} />
        <${ContextDataLink} data=${rawContext} />
      </summary>

      <div>
        ${model &&
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
        `}
        ${elapsed &&
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
        `}
        ${usage &&
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
        `}
        ${chunks &&
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
        `}
        ${context &&
        html`
          <${Fragment}>
            <div>
              <strong>Context:</strong>
            </div>
            <ul>
              <li>Base prompt: ${formatInt(context.basePromptTokens)} tokens (est)</li>
              <li>Chunks: ${formatInt(context.chunkCount)} chunks, ${formatInt(context.chunksTokens)} tokens (est)</li>
              <li>User query: ${formatInt(context.queryTokens)} tokens (est)</li>
              <li>Total: ${formatInt(context.totalTokens)} tokens (est)</li>
            </ul>
          </${Fragment}>
        `}
        ${internal &&
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
        `}
      </div>
    </details>
  `;
};

const AnswerContainer = ({
  children,
  isDeveloperMode,
  isRaw,
  setIsRaw,
}) => html`
  <div className="answer" style=${{ position: "relative" }}>
    <${Fragment}>
      <div
        className="pure-button-group"
        role="group"
      >
        ${
          isDeveloperMode &&
          html`
          <${Fragment}>
            <button
              onClick=${() => setIsRaw(false)}
              className=${`pure-button ${!isRaw ? "pure-button-active" : ""}`}
            >
              <i className="iconoir-empty-page"></i>
              HTML
            </button>
            <button
              onClick=${() => setIsRaw(true)}
              className=${`pure-button ${isRaw ? "pure-button-active" : ""}`}
            >
              <i className="iconoir-code"></i>
              Raw
            </button>
          </${Fragment}>
        `
        }
      </div>
    </${Fragment}>
    ${children}
  </div>
`;

export const Answer = ({ answer, queryInfo, onNewConversation }) => {
  const [isRaw, setIsRaw] = useState(false);
  const [settings] = useSettings();
  const { isDeveloperMode } = settings;

  let answerSection = null;
  if (isRaw && isDeveloperMode) {
    answerSection = html`<div className="answer-raw">
      ${answer
        .split("\n")
        .map((par, i) => html`<p key=${`answer-par-${i}`}>${par}</p>`)}
    </div>`;
  } else {
    // Sanitize and render markdown
    const renderedHtml = marked.parse(answer, { breaks: true, gfm: true });
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
      <${AnswerContainer} ...${{ isDeveloperMode, isRaw, setIsRaw }}>
        ${answerSection}
      </${AnswerContainer}>
      <${ContextLimitWarning}
        finishReason=${queryInfo?.finishReason}
        onNewConversation=${onNewConversation}
      />
      ${isDeveloperMode && queryInfo && html`<${QueryInfo} ...${queryInfo} />`}
    </${Fragment}>
  `;
};
