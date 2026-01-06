/* global document:false */

import { useEffect } from "react";
import { html } from "../util/html.js";
import { useClickOutside } from "../hooks/use-click-outside.js";
import { useEscapeKey } from "../hooks/use-escape-key.js";

export const Modal = ({ isOpen, onClose, title, children }) => {
  const modalRef = useClickOutside(isOpen, onClose);
  useEscapeKey(isOpen, onClose);

  // Prevent body scroll when modal is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "unset";
    }

    return () => {
      document.body.style.overflow = "unset";
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return html`
    <div className="modal-overlay">
      <div className="modal-container" ref=${modalRef}>
        <div className="modal-header">
          <h2 className="modal-title">${title}</h2>
          <button
            className="modal-close-button"
            onClick=${onClose}
            aria-label="Close modal"
          >
            ×
          </button>
        </div>
        <div className="modal-content">${children}</div>
      </div>
    </div>
  `;
};
