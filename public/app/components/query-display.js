import { html } from "../util/html.js";

export const QueryDisplay = ({ query }) => {
  if (!query) return null;

  return html`
    <div className="query-display" key="query-display">${query}</div>
  `;
};
