// Cache function for memoizing async operations
export const getAndCache = (fn) => {
  let cache;
  return () => {
    if (!cache) {
      cache = fn();
    }

    return cache;
  };
};

// Format bytes to human-readable size (e.g., 4294967296 -> "4 GB")
export const formatBytes = (bytes) => {
  if (bytes == null) return "N/A";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
};

// Format integer with locale (e.g., 1234567 -> "1,234,567")
export const formatInt = (num) =>
  (num ?? 0).toLocaleString("en-US", { maximumFractionDigits: 0 });

// Format float with 2 decimal places (e.g., 1.5 -> "1.50")
export const formatFloat = (num) =>
  (num ?? 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

// Format elapsed time (e.g., 1500 -> "1.50s", 500 -> "500ms")
export const formatElapsed = (elapsed) => {
  if (elapsed === null || elapsed === undefined) return "";
  if (elapsed < 1000) return `${elapsed.toFixed(0)}ms`;
  return `${(elapsed / 1000).toFixed(2)}s`;
};
