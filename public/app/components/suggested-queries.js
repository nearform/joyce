import { Fragment, useState } from "react";
import { html, getQuerySetter } from "../util/html.js";
import { useClickOutside } from "../hooks/use-click-outside.js";
import { useEscapeKey } from "../hooks/use-escape-key.js";

const defaultSetQueryValue = getQuerySetter("query");

export const SuggestedQueries = ({
  suggestions = [],
  setQueryValue = defaultSetQueryValue,
  isFetching = false,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const containerRef = useClickOutside(isExpanded, setIsExpanded);
  useEscapeKey(isExpanded, () => setIsExpanded(false));

  const handleQuerySelect = (query) => {
    setQueryValue(query);
    setIsExpanded(false);
  };

  return html`
    <${Fragment}>
      <div className="bubble-button-container" ref=${containerRef}>
        <button
          className="bubble-button-button"
          onClick=${() => setIsExpanded(!isExpanded)}
          type="button"
          disabled=${isFetching}
        >
          <i className="iconoir-light-bulb-on"></i>
          <span>Suggested queries</span>
        </button>
      </div>

      ${
        isExpanded &&
        html`
          <div className="bubble-button-dropdown">
            <ul className="bubble-button-list">
              ${suggestions.map(
                (query, idx) => html`
                  <li
                    key="suggested-query-${idx}"
                    className="suggested-query-item"
                  >
                    <button
                      className="suggested-query-button"
                      onClick=${() => handleQuerySelect(query)}
                      type="button"
                      disabled=${isFetching}
                    >
                      ${query}
                    </button>
                  </li>
                `,
              )}
            </ul>
          </div>
        `
      }
    </${Fragment}>
  `;
};
