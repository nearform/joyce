/* global URLSearchParams:false */
import { useState } from "react";
import { useSearchParams } from "react-router";
import { html } from "../util/html.js";

const SORT_DIRS = {
  ASC: "asc",
  DESC: "desc",
};

const isValidDir = (dir) => dir === SORT_DIRS.ASC || dir === SORT_DIRS.DESC;

const sortIconHtml = (className) =>
  html`<i title="Sort" className="ui-icon-button ${className ?? ""}"></i>`;

const SORT_CHARS = {
  [SORT_DIRS.ASC]: sortIconHtml("iconoir-sort-up"),
  [SORT_DIRS.DESC]: sortIconHtml("iconoir-sort-down"),
  empty: sortIconHtml("iconoir-sort"),
};

export const useTableSort = (
  initialSort = { key: null, direction: null },
  { syncUrl = false } = {},
) => {
  const [searchParams, setSearchParams] = useSearchParams();

  const seededSort = syncUrl
    ? (() => {
        const key = searchParams.get("sortKey");
        const direction = searchParams.get("sortDir");
        if (key && isValidDir(direction)) {
          return { key, direction };
        }
        return initialSort;
      })()
    : initialSort;
  const [sort, setSort] = useState(seededSort);

  const getSortSymbol = (key) => {
    if (sort.key === key) {
      return SORT_CHARS[sort.direction || "empty"];
    }
    return SORT_CHARS.empty;
  };

  const handleColumnSort = (key) => {
    // Default to ascending.
    let direction = SORT_DIRS.ASC;

    // If same key as before iterate to next step.
    if (sort.key === key) {
      if (sort.direction === SORT_DIRS.ASC) {
        direction = SORT_DIRS.DESC;
      } else if (sort.direction === SORT_DIRS.DESC) {
        direction = null;
        key = null;
      }
    }

    setSort({ key, direction });

    if (syncUrl) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (key && direction) {
            next.set("sortKey", key);
            next.set("sortDir", direction);
          } else {
            next.delete("sortKey");
            next.delete("sortDir");
          }
          return next;
        },
        { replace: true },
      );
    }
  };

  // Handle easy strings and numbers
  const compare = (a, b) => {
    // String.
    if (
      (typeof a === "string" || a === null) &&
      (typeof b === "string" || b === null)
    ) {
      return (a || "").localeCompare(b || "");
    }

    // Naively assume everything else fits in here.
    if (a < b) {
      return -1;
    }
    if (a > b) {
      return 1;
    }
    return 0;
  };

  // This is why having nested items was maybe a mistake. :P
  const getVal = (key, val) => {
    if (key.includes(".")) {
      let keys = key.split(".");
      let value = val;
      for (let k of keys) {
        value = value[k];
        if (value === undefined) {
          break;
        }
      }

      return value;
    }

    return val[key];
  };

  const sortItems = (items) => {
    if (sort.key && sort.direction) {
      const dir = sort.direction === SORT_DIRS.ASC ? 1 : -1;

      // Clone before our sort.
      return Object.values(items).sort((a, b) => {
        let aVal = getVal(sort.key, a);
        let bVal = getVal(sort.key, b);

        return dir * compare(aVal, bVal);
      });
    }
    return items;
  };

  return { sort, getSortSymbol, handleColumnSort, sortItems };
};
