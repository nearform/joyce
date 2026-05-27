/* global navigator:false */
// Device capacity detection for in-browser LLM inference.
// Used by the wllama provider and the model picker UI to flag models that
// likely won't fit in the device's WebGPU memory budget.

const IOS_BUFFER_CAP_MB = 512;
const BUDGET_SAFETY_RATIO = 0.8;

let _budgetPromise = null;

export const hasWebGPU = () => "gpu" in navigator;

export const isIOSBrowser = () => {
  const ua = navigator.userAgent ?? "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ reports as Mac; disambiguate via touch points.
  return ua.includes("Mac") && (navigator.maxTouchPoints ?? 0) > 1;
};

const probeWebGPUBudgetMb = async () => {
  if (!hasWebGPU()) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    const maxBufferBytes = adapter.limits?.maxBufferSize ?? 0;
    const maxBufferMb = Math.floor(maxBufferBytes / (1024 * 1024));
    return isIOSBrowser()
      ? Math.min(maxBufferMb, IOS_BUFFER_CAP_MB)
      : maxBufferMb;
  } catch {
    return null;
  }
};

export const getWebGPUBudgetMb = () => {
  if (!_budgetPromise) _budgetPromise = probeWebGPUBudgetMb();
  return _budgetPromise;
};

export const getEffectiveBudgetMb = async () => {
  const budget = await getWebGPUBudgetMb();
  return budget == null ? null : Math.floor(budget * BUDGET_SAFETY_RATIO);
};

export const isModelOverBudget = async (downloadSizeMb) => {
  if (downloadSizeMb == null) return false;
  const budget = await getEffectiveBudgetMb();
  if (budget == null) return false;
  return downloadSizeMb > budget;
};
