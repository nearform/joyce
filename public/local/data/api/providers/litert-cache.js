/* global caches:false,fetch:false,navigator:false,Response:false,TransformStream:false */
// Model download + cache layer for the LiteRT-LM provider.
//
// LiteRT-LM caches nothing itself — `Engine.create({ model })` just takes a URL, Blob, or
// ReadableStream and reads it once. Joyce's loading UI needs real byte-level progress plus working
// isLlmCached / unload / deleteCache, so we own the download and park the bytes in the Cache API.
//
// Model sizes here are 2 GB+, so nothing in this module may buffer a whole model in the JS heap.

import { breadcrumb } from "../../telemetry.js";

const CACHE_NAME = "joyce-litert-models-v1";

// Cache API is unavailable in some WebKit contexts (notably iOS Chrome) — the same gap web-llm
// works around with `useIndexedDBCache`. There we stream straight from the network every load.
export const litertCacheAvailable = typeof caches !== "undefined";

/**
 * Build the HuggingFace download URL for a model config entry.
 * @param {{ repo: string, file: string }} cfg - Model config with HF repo + filename
 * @returns {string} The resolve/main URL for the model file
 */
export const modelUrl = ({ repo, file }) =>
  `https://huggingface.co/${repo}/resolve/main/${file}`;

/**
 * Check whether a model's bytes are already in the cache.
 * @param {string} url - The model URL
 * @returns {Promise<boolean>}
 */
export const isCached = async (url) => {
  if (!litertCacheAvailable) return false;
  try {
    const cache = await caches.open(CACHE_NAME);
    return Boolean(await cache.match(url));
  } catch {
    return false;
  }
};

/**
 * Remove a model's bytes from the cache.
 * @param {string} url - The model URL
 * @returns {Promise<boolean>} Whether an entry was deleted
 */
export const deleteCached = async (url) => {
  if (!litertCacheAvailable) return false;
  const cache = await caches.open(CACHE_NAME);
  return cache.delete(url);
};

/**
 * Fail fast if there isn't room for the download, rather than dying part-way through a multi-GB
 * fetch with an opaque quota error. Best-effort: browsers that don't implement StorageManager
 * simply skip the check.
 * @param {number} downloadSizeMb - Expected download size in MB
 */
const assertStorageRoom = async (downloadSizeMb) => {
  if (!downloadSizeMb || !navigator.storage?.estimate) return;

  // Ask for persistent storage so a multi-GB entry isn't evicted under pressure. Chrome grants
  // this silently for engaged origins; a denial is not fatal, so we ignore the result.
  try {
    await navigator.storage.persist?.();
  } catch {
    // Not supported / denied — the download can still proceed.
  }

  const { quota, usage } = await navigator.storage.estimate();
  if (!quota) return;

  const needBytes = downloadSizeMb * 1024 * 1024;
  const freeBytes = quota - (usage ?? 0);
  if (freeBytes < needBytes) {
    const mb = (bytes) => Math.round(bytes / 1048576);
    throw new Error(
      `Not enough storage for this model: needs ~${downloadSizeMb} MB but only ` +
        `${mb(freeBytes)} MB of the ${mb(quota)} MB origin quota is free. ` +
        "Delete a cached model and try again.",
    );
  }
};

/**
 * Wrap a body stream so each chunk reports download progress.
 * @param {ReadableStream<Uint8Array>} body - The response body
 * @param {number|null} totalBytes - Expected total, or null if unknown
 * @param {Function|null} onProgress - Progress callback
 * @returns {ReadableStream<Uint8Array>}
 */
const withProgress = (body, totalBytes, onProgress) => {
  if (!onProgress) return body;

  const mb = (bytes) => Math.round(bytes / 1048576);
  let loaded = 0;
  let lastReportAt = 0;

  return body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        // Enqueue first and unconditionally — every early exit below must not be able to drop a
        // chunk, or the cached model is silently truncated.
        controller.enqueue(chunk);
        loaded += chunk.byteLength;

        // Throttle on time, not percent. These models are 2-3 GB, so a 1%-step throttle means one
        // update per ~30 MB — on a slow link that reads as a frozen 0% for minutes. Always show the
        // byte counts so a slow download is visibly distinct from a stalled one.
        const now = Date.now();
        const isLast = totalBytes && loaded >= totalBytes;
        if (now - lastReportAt < 250 && !isLast) return;
        lastReportAt = now;

        onProgress({
          text: totalBytes
            ? `Downloading model: ${mb(loaded)} / ${mb(totalBytes)} MB`
            : `Downloading model: ${mb(loaded)} MB`,
          progress: totalBytes ? loaded / totalBytes : 0,
        });
      },
    }),
  );
};

/**
 * Get a model source suitable for `Engine.create({ model })`, downloading and caching as needed.
 *
 * Cache hit  -> a Blob read back out of the Cache API (Engine streams it; no heap copy).
 * Cache miss -> stream the download into the cache with progress, then read it back as a Blob.
 *               Two disk passes, but a multi-GB model never lands in the JS heap.
 * No Cache API -> the progress-wrapped network stream, handed straight to the engine.
 *
 * @param {string} url - The model URL
 * @param {Object} [options]
 * @param {Function} [options.onProgress] - Called with { text, progress }
 * @param {number} [options.downloadSizeMb] - Expected size, used for the storage pre-check
 * @returns {Promise<Blob|ReadableStream<Uint8Array>>} Source for Engine.create
 */
export const getModelSource = async (
  url,
  { onProgress = null, downloadSizeMb = 0 } = {},
) => {
  const cache = litertCacheAvailable ? await caches.open(CACHE_NAME) : null;

  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      breadcrumb("litert.model.cache.hit", { url });
      onProgress?.({ text: "Loading cached model…", progress: 1 });
      return hit.blob();
    }
    await assertStorageRoom(downloadSizeMb);
  }

  breadcrumb("litert.model.download.start", { url, downloadSizeMb });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download model (${response.status} ${response.statusText}): ${url}`,
    );
  }

  const lengthHeader = response.headers.get("content-length");
  const totalBytes = lengthHeader ? Number(lengthHeader) : null;
  const stream = withProgress(response.body, totalBytes, onProgress);

  if (!cache) {
    // No Cache API: hand the engine the live network stream. Nothing to cache, nothing buffered.
    return stream;
  }

  // Stream the download into the cache, then read it back. `cache.put` consumes the stream, so the
  // bytes go network -> disk without ever being fully materialized in memory.
  await cache.put(url, new Response(stream, { headers: response.headers }));
  const stored = await cache.match(url);
  if (!stored) {
    throw new Error(`Model download completed but could not be cached: ${url}`);
  }
  breadcrumb("litert.model.download.done", { url, totalBytes });
  return stored.blob();
};
