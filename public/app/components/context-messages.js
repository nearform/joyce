import { html } from "../util/html.js";
import { Alert } from "./alert.js";

/**
 * Check if an error is a context window size exceeded error.
 * @param {Error} error - The error to check
 * @returns {boolean} True if the error is a context exceeded error
 */
export const isContextExceededError = (error) => {
  if (!error) return false;
  const errorStr = error.name || error.message || error.toString();
  return errorStr.includes("ContextWindowSizeExceeded");
};

/**
 * Base component for context-related messages.
 * Not exported - used internally by ContextLimitWarning and ContextExceededError.
 *
 * @param {Object} props
 * @param {string} props.type - Alert type ("warning" or "error")
 * @param {string} props.icon - Iconoir icon class name
 * @param {string} props.title - Message title
 * @param {string} props.message - Message description
 * @param {Function} props.onNewConversation - Callback to start a new conversation
 * @returns {Object} HTM element
 */
const ContextMessage = ({ type, icon, title, message, onNewConversation }) => {
  return html`
    <div className="context-message-container">
      <${Alert} type=${type}>
        <div className="context-message">
          <div className="context-message-content">
            <i className=${icon}></i>
            <div>
              <strong>${title}</strong>
              <p>${message}</p>
            </div>
          </div>
          ${
            onNewConversation &&
            html`
              <button className="pure-button" onClick=${onNewConversation}>
                <i className="iconoir-refresh-double"></i>
                ${" "}New Conversation
              </button>
            `
          }
        </div>
      </${Alert}>
    </div>
  `;
};

/**
 * Warning displayed when a response was truncated due to context limit.
 * Shows when finishReason === "length", indicating the model hit its token limit.
 *
 * @param {Object} props
 * @param {string} props.finishReason - The finish reason from the model response
 * @param {Function} props.onNewConversation - Callback to start a new conversation
 * @returns {Object|null} HTM element or null
 */
export const ContextLimitWarning = ({ finishReason, onNewConversation }) => {
  // Only show warning when finish reason indicates context limit was hit
  if (finishReason !== "length") {
    return null;
  }

  return html`
    <${ContextMessage}
      type="warning"
      icon="iconoir-warning-triangle"
      title="Context limit reached"
      message="The response may have been cut short because the conversation exceeded the model's context window. Start a new conversation for best results."
      onNewConversation=${onNewConversation}
    />
  `;
};

/**
 * Error displayed when the prompt exceeds the model's context window.
 * Shows when web-llm throws ContextWindowSizeExceededError before streaming starts.
 *
 * @param {Object} props
 * @param {Error} props.error - The context exceeded error
 * @param {Function} props.onNewConversation - Callback to start a new conversation
 * @returns {Object|null} HTM element or null
 */
export const ContextExceededError = ({ error, onNewConversation }) => {
  // Only show if error is a context exceeded error
  if (!isContextExceededError(error)) {
    return null;
  }

  return html`
    <${ContextMessage}
      type="error"
      icon="iconoir-warning-circle"
      title="Context window exceeded"
      message="The conversation is too long for this model's context window. Start a new conversation to continue."
      onNewConversation=${onNewConversation}
    />
  `;
};
