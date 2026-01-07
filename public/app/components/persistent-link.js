/* global URLSearchParams:false,URL:false */
import { Link, useLocation } from "react-router";
import { html } from "../util/html.js";

// Merge current location search params into a destination path
const mergeSearch = (to, currentSearch) => {
  if (!currentSearch) return to;

  // URL requires an absolute URL, so use a dummy base for relative paths
  const url = new URL(to, "http://x");
  const currentParams = new URLSearchParams(currentSearch);

  // Add current params that aren't already in the destination
  for (const [key, value] of currentParams) {
    if (!url.searchParams.has(key)) {
      url.searchParams.set(key, value);
    }
  }

  return url.pathname + url.search + url.hash;
};

// Preserves ALL current search params when navigating
export const PersistentLink = ({ to, children, ...props }) => {
  const location = useLocation();
  const toWithSearch = mergeSearch(to, location.search);

  return html`<${Link} to=${toWithSearch} ...${props}>${children}</${Link}>`;
};
