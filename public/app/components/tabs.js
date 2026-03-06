import { useCallback } from "react";
import { html } from "../util/html.js";

export const Tabs = ({ tabs, activeTab, onTabChange }) => {
  const handleKeyDown = useCallback(
    (event) => {
      const currentIndex = tabs.findIndex((t) => t.id === activeTab);
      let nextIndex;
      if (event.key === "ArrowRight") {
        nextIndex = (currentIndex + 1) % tabs.length;
      } else if (event.key === "ArrowLeft") {
        nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = tabs.length - 1;
      } else {
        return;
      }
      event.preventDefault();
      onTabChange(tabs[nextIndex].id);
    },
    [tabs, activeTab, onTabChange],
  );

  return html`
    <div className="tabs-bar" role="tablist">
      ${tabs.map(
        (tab) => html`
          <button
            key=${tab.id}
            id=${`tab-${tab.id}`}
            className=${`tabs-tab${activeTab === tab.id ? " tabs-tab-active" : ""}`}
            role="tab"
            aria-selected=${activeTab === tab.id}
            aria-controls=${`tabpanel-${tab.id}`}
            tabindex=${activeTab === tab.id ? 0 : -1}
            onClick=${() => onTabChange(tab.id)}
            onKeyDown=${handleKeyDown}
          >
            <i className=${tab.icon}></i> ${tab.label}
          </button>
        `,
      )}
    </div>
  `;
};
