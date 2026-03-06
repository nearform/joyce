/* global performance:false, navigator:false, console:false */

const RING_BUFFER_SIZE = 30;
const timeline = [];

/**
 * Get memory info from available browser APIs.
 * performance.memory is Chromium-only; navigator.deviceMemory is approximate RAM.
 * @returns {{ usedJSHeapSize: number|null, totalJSHeapSize: number|null, jsHeapSizeLimit: number|null, deviceMemory: number|null }}
 */
export const getMemoryInfo = () => {
  const mem = performance?.memory;
  return {
    usedJSHeapSize: mem?.usedJSHeapSize ?? null,
    totalJSHeapSize: mem?.totalJSHeapSize ?? null,
    jsHeapSizeLimit: mem?.jsHeapSizeLimit ?? null,
    deviceMemory: navigator?.deviceMemory ?? null,
  };
};

const toMB = (bytes) =>
  bytes != null ? (bytes / 1024 / 1024).toFixed(1) : "N/A";

/**
 * Log a memory snapshot with a label. Stores in ring buffer and logs to console.
 * @param {string} label
 */
export const logMemorySnapshot = (label) => {
  const info = getMemoryInfo();
  const snapshot = {
    label,
    timestamp: Date.now(),
    ...info,
  };

  // Ring buffer
  timeline.push(snapshot);
  if (timeline.length > RING_BUFFER_SIZE) {
    timeline.shift();
  }

  // Console output
  console.log(
    `[memory] ${label}: heap ${toMB(info.usedJSHeapSize)} / ${toMB(info.totalJSHeapSize)} MB` +
      (info.deviceMemory != null ? ` | device ${info.deviceMemory} GB` : ""),
  );
};

/**
 * Get the memory timeline ring buffer.
 * @returns {Array<{ label: string, timestamp: number, usedJSHeapSize: number|null, totalJSHeapSize: number|null, jsHeapSizeLimit: number|null, deviceMemory: number|null }>}
 */
export const getMemoryTimeline = () => [...timeline];
