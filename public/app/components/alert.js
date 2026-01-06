import { useState } from "react";
import { html } from "../util/html.js";

export const Alert = ({ type = "success", children, err }) => {
  const [showDetails, setShowDetails] = useState(false);
  const typeClasses = {
    success: "alert-success",
    error: "alert-error",
    warning: "alert-warning",
  };

  return html`
    <div className=${`alert ${typeClasses[type]}`}>
      ${children}
      ${err &&
      typeof err !== "string" &&
      html`
        <div className="alert-details">
          <button
            onClick=${() => setShowDetails(!showDetails)}
            className="pure-button pure-button-xsmall"
          >
            ${showDetails ? "Hide" : "Show"} Details
          </button>
          ${showDetails &&
          html`
            <pre className="alert-stack">${err.stack || err.toString()}</pre>
          `}
        </div>
      `}
    </div>
  `;
};
