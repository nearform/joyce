import { Fragment, useState } from "react";
import { Modal } from "./modal.js";
import { PostsTable } from "./posts-table.js";
import { html } from "../util/html.js";

export const PostsFound = ({ posts = [], analyticsDates }) => {
  const [isSimilarPostsModalOpen, setIsSimilarPostsModalOpen] = useState(false);

  return html`
    <${Fragment}>
      <div className="bubble-button-container" hidden=${!posts.length}>
        <button
          className="bubble-button-button"
          type="button"
          onClick=${() => setIsSimilarPostsModalOpen(true)}
          title="View similar posts used to generate this answer"
        >
          <i className="iconoir-multiple-pages"></i>
          <span>Posts (${posts.length})</span>
        </button>
      </div>

      <${Modal}
        isOpen=${isSimilarPostsModalOpen}
        onClose=${() => setIsSimilarPostsModalOpen(false)}
        title="Similar Posts"
      >
        ${(posts && html`<${PostsTable} posts=${posts} analyticsDates=${analyticsDates} />`) || html`<p className="status">No results.</p>`}
      </${Modal}>
    </${Fragment}>
  `;
};
