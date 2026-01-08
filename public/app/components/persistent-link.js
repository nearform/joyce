/* global URLSearchParams:false,URL:false */
import { Link, useLocation } from "react-router";
import { html } from "../util/html.js";

// Merge current location search params into a destination path
const mergeSearch = (to, currentSearch) => {
  // Extract parts based on type - object form already has them separated
  const urlObj = typeof to === "string" ? new URL(to, "http://x") : to;
  const { search, hash } = urlObj;

  // But get path (which can have different base paths) from the destination URL.
  const pathname = String(to).split(/[?#]/)[0];

  if (!currentSearch) {
    return `${pathname}${search}${hash}`;
  }

  // Merge params - destination params take precedence
  const destParams = new URLSearchParams(search);
  const currentParams = new URLSearchParams(currentSearch);

  for (const [key, value] of currentParams) {
    if (!destParams.has(key)) {
      destParams.set(key, value);
    }
  }

  const mergedSearch = destParams.toString();
  return `${pathname}${mergedSearch ? "?" + mergedSearch : ""}${hash}`;
};

// Preserves ALL current search params when navigating
export const PersistentLink = ({ to, children, ...props }) => {
  const location = useLocation();
  const toWithSearch = mergeSearch(to, location.search);

  return html`<${Link} to=${toWithSearch} ...${props}>${children}</${Link}>`;
};
