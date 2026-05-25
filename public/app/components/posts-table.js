import { Fragment, useState } from "react";
import { html } from "../util/html.js";
import { Category } from "./category.js";
import { Vertical } from "./vertical.js";
import { useSettings } from "../hooks/use-settings.js";
import { useTableSort } from "../hooks/use-table-sort.js";

const BASE_HEADINGS = {
  date: "Date",
  title: "Title",
  "categories.primary": "Cat.",
  "verticals.primary": "Vert.",
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
  usedChunks = [],
  chunkTexts = {},
}) => {
  const { getSortSymbol, handleColumnSort, sortItems } = useTableSort();
  const [settings] = useSettings();
  const [expandedSlug, setExpandedSlug] = useState(null);
  const hasChunks = usedChunks.length > 0;
  const usedChunkSlugs = new Set(usedChunks.map((c) => c.slug));

  const headings = settings.displayAnalytics
    ? { ...BASE_HEADINGS, ...ANALYTICS_HEADINGS }
    : BASE_HEADINGS;

  const colSpan = (hasChunks ? 1 : 0) + Object.keys(headings).length;

  const analyticsTitle =
    analyticsDates.start !== null && analyticsDates.end !== null
      ? `Analytics from ${new Date(analyticsDates.start).toLocaleDateString()} to ${new Date(analyticsDates.end).toLocaleDateString()}`
      : "";

  const getChunksForSlug = (slug) => {
    const chunks = [];
    const slugChunks = usedChunks.filter((c) => c.slug === slug);
    for (const chunk of slugChunks) {
      const key = `${chunk.slug}:${chunk.start}:${chunk.end}`;
      const text = chunkTexts[key];
      if (text) {
        chunks.push({ key, text, start: chunk.start, end: chunk.end });
      }
    }
    return chunks;
  };

  // Short-circuit.
  if (posts.length === 0) {
    return html`<div />`;
  }

  return html`
    <div>
      <h2 className="content-subhead">${heading}</h2>
      <table className="pure-table pure-table-bordered">
        <thead>
          <tr>
            ${hasChunks &&
            html`<th title="Included in prompt context">
              <i className="iconoir-quote"></i>
            </th>`}
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
                slug,
                categories,
                verticals,
                analytics,
                similarity,
                embeddingNumTokens,
              },
              i,
            ) => {
              const isExpanded = expandedSlug === slug;
              const chunksForPost = getChunksForSlug(slug);
              return html`
                <${Fragment}>
                  <tr key=${`post-item-${i}`}>
                    ${
                      hasChunks &&
                      html`<td>
                        ${usedChunkSlugs.has(slug) &&
                        html`<i
                          class="iconoir-quote"
                          style=${{ cursor: "pointer" }}
                          onClick=${() =>
                            setExpandedSlug(isExpanded ? null : slug)}
                          title=${isExpanded
                            ? "Click to collapse chunk excerpts"
                            : "Click to view chunk excerpts"}
                        ></i>`}
                      </td>`
                    }
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
                    <td>
                      ${
                        verticals?.primary &&
                        Vertical({ vertical: verticals.primary })
                      }
                    </td>
                    ${
                      settings.displayAnalytics
                        ? html`
                            <td key="views">${analytics.views}</td>
                            <td key="users">${analytics.users}</td>
                            <td key="time">${analytics.time.toFixed(2)}</td>
                            <td key="bounceRate">
                              ${(analytics.bounceRate * 100).toFixed(0)}%
                            </td>
                          `
                        : null
                    }
                  </tr>
                  ${
                    isExpanded &&
                    html`
                      <tr key=${`post-item-${i}-expansion`}>
                        <td colspan=${colSpan} style=${{ padding: "0" }}>
                          <div class="chunk-excerpts">
                            ${chunksForPost.map(
                              (chunk, idx) => html`
                                <div class="chunk-excerpt">
                                  <div class="chunk-label">
                                    Chunk ${idx + 1} ${" "}<span
                                      class="chunk-label-num"
                                      >(${chunk.start}–${chunk.end})</span
                                    >
                                  </div>
                                  <div class="chunk-text">${chunk.text}</div>
                                </div>
                              `,
                            )}
                          </div>
                        </td>
                      </tr>
                    `
                  }
                </${Fragment}>
              `;
            },
          )}
        </tbody>
      </table>
    </div>
  `;
};
