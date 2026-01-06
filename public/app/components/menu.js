import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { html } from "../util/html.js";

export const MenuPage = ({ name, navName, to, sub, icon }) => {
  const loc = useLocation();
  const [active, setActive] = useState(false);
  useEffect(() => {
    setActive(to === loc.pathname);
  }, [loc]);

  const itemName = navName ?? name;
  const item =
    icon && !sub
      ? html`<i className=${icon} key="icon"></i> ${itemName}`
      : itemName;

  return html`
    <li className="pure-menu-item${active ? " pure-menu-selected" : ""}">
      <${Link} className="pure-menu-link" to="${to}">
        ${sub ? html`<span className="pure-menu-sub"><i className="iconoir-long-arrow-down-right"></i> ${item}</span>` : item}
      </${Link}>
    </li>
  `;
};

export const Menu = ({ pages = [] }) => html`
  <div id="menu">
    <nav className="pure-menu">
      <ul className="pure-menu-list">
        ${pages.map(
          (props, i) =>
            html`<${MenuPage} key=${`menu-link-${i}`} ...${props} />`,
        )}
      </ul>
      <div className="pure-menu-divided" />
    </nav>
  </div>
`;
