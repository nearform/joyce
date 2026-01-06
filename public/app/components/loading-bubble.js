import { html } from "../util/html.js";

export const LoadingBubble = () => html`
  <div className="loading-bubble">
    <div className="loading-dots">
      <div className="loading-dot"></div>
      <div className="loading-dot"></div>
      <div className="loading-dot"></div>
    </div>
  </div>
`;
