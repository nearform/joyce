import { html } from "../util/html.js";

export const Page = ({ name, icon, children }) => html`
  <div id="main">
    <div className="header">
      <h1>
        ${icon &&
        html`<i className=${icon} aria-hidden="true"></i>${" "}`}${name}
      </h1>
    </div>
    <div className="content">${children}</div>
  </div>
`;
