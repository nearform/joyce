import { useState } from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router";

import config from "../../config.js";
import { Menu } from "./menu.js";
import { html } from "../util/html.js";
import { useSettings } from "../hooks/use-settings.js";
import { useClickOutside } from "../hooks/use-click-outside.js";

import { Settings } from "../pages/settings.js";
import { Home } from "../pages/home.js";
import { Posts } from "../pages/posts.js";
import { Search } from "../pages/search.js";
import { Chat } from "../pages/chat.js";
import { Data } from "../pages/data.js";
import { BASE_PATH } from "../../local/data/util.js";

const PAGE_COMPONENTS = {
  Home,
  Posts,
  Search,
  Settings,
  Chat,
  Data,
};

export const Layout = () => {
  const [active, setActive] = useState(false);
  const menuRef = useClickOutside(active, setActive);
  const [settings] = useSettings();

  const toggleMenu = () => {
    setActive(!active);
  };

  // Incorporate components (which can't be in shared config).
  const allPages = settings.isDeveloperMode
    ? config.pages.all
    : config.pages.simple;
  const pages = allPages.map((page) => ({
    ...page,
    Component: PAGE_COMPONENTS[page.name],
  }));

  return html`
    <div id="layout" key="layout" className="${active ? "active" : ""}">
      <${Router} basename="${BASE_PATH}">
        <div ref=${menuRef}>
          <a href="#menu" id="menuLink" className="menu-link" onClick=${toggleMenu}>
            <span></span>
          </a>
          <${Menu}
            pages=${pages}
          />
        </div>
        <${Routes}>
          ${pages.map(
            ({ to, Component }, i) => html`
              <${Route}
                exact=${true}
                path="${to}"
                key=${`route-${i}`}
                Component=${Component}
              />
            `,
          )}
        </${Routes}>
      </${Router}>
    </div>
  `;
};
