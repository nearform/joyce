import { Link, useLocation } from "react-router";
import { html } from "../util/html.js";

// Preserves ALL current search params when navigating
export const PersistentLink = ({ to, children, ...props }) => {
  const location = useLocation();
  const toWithSearch = location.search ? `${to}${location.search}` : to;

  return html`<${Link} to=${toWithSearch} ...${props}>${children}</${Link}>`;
};
