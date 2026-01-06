/* global Blob:false,window:false */
import FileSaver from "file-saver";
import { html, openTextInNewWindow } from "../util/html.js";

const { saveAs } = FileSaver;

const postsToCsv = (posts) => {
  return (
    ["Date", "Type", "Title", "URL", "Category"].join(",") +
    "\n" +
    posts
      .map((post) => {
        const { title, postType, date, href, categories } = post;
        // Escape any commas in the title with quotes
        const escapedTitle = `"${title}"`.replace(/\n/g, " ");
        return [date, postType, escapedTitle, href, categories.primary].join(
          ",",
        );
      })
      .join("\n")
  );
};

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
    const blob = new Blob([postsToCsv(posts)], { type: "text/csv" });
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
