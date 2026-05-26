/* global URLSearchParams:false */
import { DEFAULT_CHAT_MODEL, DEFAULT_TEMPERATURE } from "../../config.js";

const MODEL_SEP = "::";

const isMatchingOption = (options, value) =>
  options.some((opt) => opt.value === value);

// Read repeated values from search params (e.g. `?postType=blog&postType=work`)
// and map them back into the `{ label, value }` shape used by react-select.
// Unknown values are dropped so a malformed URL can't inject garbage.
export const parseMulti = (searchParams, key, options) => {
  const raw = searchParams.getAll(key);
  return raw
    .filter((value) => isMatchingOption(options, value))
    .map((value) => options.find((opt) => opt.value === value));
};

export const parseStringParam = (searchParams, key, fallback = "") => {
  const value = searchParams.get(key);
  return value == null ? fallback : value;
};

export const parseFloatParam = (searchParams, key, fallback) => {
  const value = searchParams.get(key);
  if (value == null) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const parseModel = (
  searchParams,
  key,
  fallback = DEFAULT_CHAT_MODEL,
) => {
  const value = searchParams.get(key);
  if (!value || !value.includes(MODEL_SEP)) return fallback;
  const [provider, model] = value.split(MODEL_SEP);
  if (!provider || !model) return fallback;
  return { provider, model };
};

export const serializeModel = ({ provider, model } = {}) =>
  provider && model ? `${provider}${MODEL_SEP}${model}` : "";

const isDefaultModel = (model) =>
  !model ||
  (model.provider === DEFAULT_CHAT_MODEL.provider &&
    model.model === DEFAULT_CHAT_MODEL.model);

// Build a URLSearchParams from an object of intended values. Empty arrays,
// empty strings, nullish, and "default" values (model, temperature) are
// omitted so URLs stay short. Array values use append() to produce repeated
// keys.
export const buildParams = (values) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        if (v != null && v !== "") params.append(key, v);
      }
      continue;
    }
    if (key === "model") {
      if (isDefaultModel(value)) continue;
      params.set(key, serializeModel(value));
      continue;
    }
    if (key === "temperature") {
      if (value === DEFAULT_TEMPERATURE) continue;
      params.set(key, String(value));
      continue;
    }
    if (typeof value === "string") {
      if (value === "") continue;
      params.set(key, value);
      continue;
    }
    params.set(key, String(value));
  }
  return params;
};

export const multiToValues = (items) => (items || []).map(({ value }) => value);
