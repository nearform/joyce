import { html } from "../util/html.js";

export const Page = ({ name, children }) => html`
  <div id="main">
    <div className="header">
      <h1>${name}</h1>
    </div>
    <div className="content">${children}</div>
  </div>
`;
