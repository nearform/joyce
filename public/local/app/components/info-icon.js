import { useState } from "react";
import { html } from "../../../app/util/html.js";
import { Modal } from "../../../app/components/modal.js";

/**
 * Reusable info icon component with tooltip and modal
 * @param {Object} props
 * @param {string} props.tooltip - Brief tooltip text shown on hover
 * @param {string} props.modalTitle - Title for the modal
 * @param {any} props.children - Modal content (passed as children)
 * @param {string} props.className - Optional additional CSS class
 */
export const InfoIcon = ({ tooltip, modalTitle, children, className = "" }) => {
  const [isModalOpen, setIsModalOpen] = useState(false);

  const handleClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsModalOpen(true);
  };

  return html`
    <span
      className=${`info-icon ${className ?? ""}`.trim()}
      title=${tooltip}
      onClick=${handleClick}
    >
      <i className="iconoir-info-circle"></i>
    </span>
    <${Modal}
      isOpen=${isModalOpen}
      onClose=${() => setIsModalOpen(false)}
      title=${modalTitle}
    >
      ${children}
    </${Modal}>
  `;
};
