import { html } from "../util/html.js";

export const VERTICALS_LIST = [
  "health",
  "finance",
  "retail",
  "government",
  "telco",
  "sustainability",
  "logistics",
  "travel",
  "media",
  "sports",
  "none",
];

// Make sure at least as long as `VERTICALS_LIST`.
const VERTICAL_COLORS = [
  "#E74C3C",
  "#2980B9",
  "#27AE60",
  "#8E44AD",
  "#F39C12",
  "#16A085",
  "#D35400",
  "#2C3E50",
  "#C0392B",
  "#1ABC9C",
  "#95A5A6",
];

const VERTICAL_COLORS_MAP = new Map(
  VERTICALS_LIST.map((vertical, idx) => [vertical, VERTICAL_COLORS[idx]]),
);

const getVerticalColor = (vertical) => VERTICAL_COLORS_MAP.get(vertical);

const getRgbaVerticalColor = (vertical) => {
  const color = getVerticalColor(vertical);
  if (!color) {
    throw new Error(`Unknown vertical: ${vertical}`);
  }

  // Remove leading `#` and convert to rgba.
  return color
    .slice(1)
    .match(/.{2}/g)
    .map((x) => parseInt(x, 16))
    .join(", ");
};

export const Vertical = ({ vertical }) => html`
  <span
    className="ui-vertical-label"
    style="${{ "--label-color": getRgbaVerticalColor(vertical) }}"
  >
    ${vertical}
  </span>
`;
