import { html } from "../util/html.js";

export const Tabs = ({ tabs, activeTab, onTabChange }) => {
  return html`
    <div className="tabs-bar" role="tablist">
      ${tabs.map(
        (tab) => html`
          <button
            key=${tab.id}
            className=${`tabs-tab${activeTab === tab.id ? " tabs-tab-active" : ""}`}
            role="tab"
            aria-selected=${activeTab === tab.id}
            onClick=${() => onTabChange(tab.id)}
          >
            <i className=${tab.icon}></i> ${tab.label}
          </button>
        `,
      )}
    </div>
  `;
};
