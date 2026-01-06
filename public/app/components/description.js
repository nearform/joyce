import { Fragment, useState } from "react";
import { html } from "../util/html.js";
import { Modal } from "./modal.js";

export const Description = ({ children }) => {
  const [isDescriptionModalOpen, setIsDescriptionModalOpen] = useState(false);

  return html`
    <${Fragment}>
      <div className="bubble-button-container">
        <button
          className="bubble-button-button"
          onClick=${() => setIsDescriptionModalOpen(true)}
          type="button"
          title="Page description and details"
        >
          <i className="iconoir-info-circle"></i>
          <span>Description</span>
        </button>
      </div>

      <${Modal}
        isOpen=${isDescriptionModalOpen}
        onClose=${() => setIsDescriptionModalOpen(false)}
        title="Description"
      >
        ${children}
      </${Modal}>
    </${Fragment}>
  `;
};
