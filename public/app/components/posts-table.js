import { html } from "../util/html.js";
import { Category } from "./category.js";
import { useSettings } from "../hooks/use-settings.js";
import { useTableSort } from "../hooks/use-table-sort.js";

const BASE_HEADINGS = {
  date: "Date",
  title: "Title",
  "categories.primary": "Cat.",
};

const ANALYTICS_HEADINGS = {
  "analytics.views": "Views",
  "analytics.users": "Users",
  "analytics.time": "Time",
  "analytics.bounceRate": "Bounce",
};

export const PostsTable = ({
  heading,
  posts = [],
  analyticsDates = { start: null, end: null },
}) => {
  const { getSortSymbol, handleColumnSort, sortItems } = useTableSort();
  const [settings] = useSettings();

  // Short-circuit.
  if (posts.length === 0) {
    return html`<div />`;
  }

  // Get the appropriate headings based on settings
  const headings = settings.displayAnalytics
    ? { ...BASE_HEADINGS, ...ANALYTICS_HEADINGS }
    : BASE_HEADINGS;

  const analyticsTitle =
    analyticsDates.start !== null && analyticsDates.end !== null
      ? `Analytics from ${new Date(analyticsDates.start).toLocaleDateString()} to ${new Date(analyticsDates.end).toLocaleDateString()}`
      : "";

  return html`
    <div>
      <h2 className="content-subhead">${heading}</h2>
      <table className="pure-table pure-table-bordered">
        <thead>
          <tr>
            ${Object.entries(headings).map(
              ([key, label]) =>
                html`<th
                  key=${key}
                  style=${{ whiteSpace: "nowrap" }}
                  title="${key.startsWith("analytics.") ? analyticsTitle : ""}"
                  onClick=${() => handleColumnSort(key)}
                >
                  ${label}${" "}${getSortSymbol(key)}
                </th>`,
            )}
          </tr>
        </thead>
        <tbody>
          ${sortItems(posts).map(
            (
              {
                date,
                title,
                href,
                categories,
                analytics,
                similarity,
                embeddingNumTokens,
              },
              i,
            ) => {
              return html`
                <tr key=${`post-item-${i}`}>
                  <td style=${{ minWidth: "90px" }}>
                    ${date ? new Date(date).toISOString().substring(0, 10) : ""}
                  </td>
                  <td
                    title=${JSON.stringify({
                      embeddingNumTokens,
                      similarity,
                    })}
                  >
                    <a href="${href}">${title}</a>
                  </td>
                  <td>${Category({ category: categories.primary })}</td>
                  ${settings.displayAnalytics
                    ? html`
                        <td key="views">${analytics.views}</td>
                        <td key="users">${analytics.users}</td>
                        <td key="time">${analytics.time.toFixed(2)}</td>
                        <td key="bounceRate">
                          ${(analytics.bounceRate * 100).toFixed(0)}%
                        </td>
                      `
                    : null}
                </tr>
              `;
            },
          )}
        </tbody>
      </table>
    </div>
  `;
};
