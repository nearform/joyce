/* global Blob:false,window:false */
import FileSaver from "file-saver";
import { html, openTextInNewWindow } from "../util/html.js";

const { saveAs } = FileSaver;

const CSV_HEADERS = ["Date", "Type", "Title", "URL", "Category", "Vertical"];

// RFC 4180: quote fields containing comma/quote/newline; double embedded quotes.
const toCsvField = (value) => {
  const str = String(value ?? "").replace(/\r?\n/g, " ");
  return /[",]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

const postsToCsv = (posts) =>
  [
    CSV_HEADERS,
    ...posts.map(({ title, postType, date, href, categories, verticals }) => [
      date,
      postType,
      title,
      href,
      categories.primary,
      verticals?.primary ?? "",
    ]),
  ]
    .map((row) => row.map(toCsvField).join(","))
    .join("\n");

const formatDate = (date) => {
  return date.toISOString().slice(0, -5).replace(/:/g, "-");
};

const getPathname = () => {
  return window.location.pathname.replace(/^\/|\/$/g, "").replace(/\//g, "-");
};

export const DownloadPostsCsv = ({ posts }) => {
  if (!posts) {
    return "";
  }

  const handleDownload = () => {
    // Prepend a UTF-8 BOM so Excel detects the encoding (curly quotes, etc.).
    const blob = new Blob(["﻿" + postsToCsv(posts)], {
      type: "text/csv;charset=utf-8",
    });
    saveAs(blob, `joyce-ai-${getPathname()}-${formatDate(new Date())}.csv`);
  };

  return html`
    <span
      onClick=${handleDownload}
      title="Download currently displayed posts as CSV"
    >
      <i className="ui-icon-button iconoir-download-square"></i>
    </span>
  `;
};

export const JsonDataLink = ({ data }) => {
  if (!data) {
    return "";
  }

  const handleOpen = () => openTextInNewWindow(JSON.stringify(data, null, 2));

  return html`
    <span onClick=${handleOpen} title="Open search API results as JSON">
      <i className="ui-icon-button iconoir-database-export"></i>
    </span>
  `;
};
