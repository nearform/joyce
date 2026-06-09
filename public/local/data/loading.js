/* global performance:false */
import { getPosts, getPostsEmbeddings } from "./api/posts.js";
import { getDb, getExtractor } from "./api/search.js";
import {
  getLlmEngine,
  setLlmProgressCallback,
  unloadLlmEngine,
  deleteModelCache,
  isLlmCached,
} from "./api/llm.js";
import { ALL_CHAT_MODELS } from "../../config.js";
import { breadcrumb, mergeSnapshot } from "./telemetry.js";
import { getSettings } from "../../app/hooks/use-settings.js";

// ==============================
// Loading Management
// ==============================

// Helper to create LLM resource entry for a model (works with any provider). `provider`/`modelId`/
// `kind` are carried so the single-model eviction policy can identify web-llm chat resources.
const createLlmResource = (provider, modelId) => ({
  id: `llm_${modelId}`,
  kind: "llm",
  provider,
  modelId,
  get: async () => {
    setLlmProgressCallback(provider, modelId, (p) =>
      setLoadingProgress(`llm_${modelId}`, p),
    );
    return getLlmEngine({ provider, model: modelId });
  },
  checkCached: () => isLlmCached(provider, modelId),
});

// Generate LLM resource key from model ID (e.g., "SmolLM2-360M-Instruct-q4f16_1-MLC" -> "LLM_SMOLLM2_360M_INSTRUCT")
const modelToResourceKey = (modelId) => {
  const baseName = modelId.split("-q4f16")[0];
  return "LLM_" + baseName.toUpperCase().replace(/-/g, "_").replace(/\./g, "_");
};

// Dynamically create LLM resources from ALL providers (web-llm AND chrome)
const LLM_RESOURCES = Object.fromEntries(
  ALL_CHAT_MODELS.flatMap(({ provider, models }) =>
    models.map((modelCfg) => [
      modelToResourceKey(modelCfg.model),
      createLlmResource(provider, modelCfg.model),
    ]),
  ),
);

export const RESOURCES = {
  POSTS_DATA: {
    id: "posts_data",
    get: getPosts,
  },
  POSTS_EMBEDDINGS: {
    id: "posts_embeddings",
    get: getPostsEmbeddings,
  },
  DB: {
    id: "db",
    get: getDb,
    deps: ["posts_data", "posts_embeddings"],
  },
  EXTRACTOR: {
    id: "extractor",
    get: getExtractor,
  },
  ...LLM_RESOURCES,
};

/**
 * Find a resource by its ID
 * @param {string} resourceId
 * @returns {{ id: string, get: () => Promise<any> } | undefined}
 */
export const findResourceById = (resourceId) => {
  return Object.values(RESOURCES).find((r) => r.id === resourceId);
};

/**
 * Register an LLM resource dynamically for any model ID
 * @param {string} provider - The provider key (e.g., "webLlm", "chrome")
 * @param {string} modelId - The model ID to register
 */
export const registerLlmResource = (provider, modelId) => {
  const resourceId = `llm_${modelId}`;
  if (findResourceById(resourceId)) return; // Already exists
  RESOURCES[modelToResourceKey(modelId)] = createLlmResource(provider, modelId);
};

const loadingStatus = new Map();
const loadingCallbacks = new Map();
const loadedData = new Map();
const loadingProgress = new Map();
const progressCallbacks = new Map();
// Serializes default-mode web-llm loads. Clicking a second model while the first is still downloading
// queues it (waits) instead of aborting the first's download, so several models can be cached to disk
// back-to-back. Each runs single-model eviction when its turn comes (evict-after-settle), so only one
// model stays resident. experimentalMultipleModels bypasses this (concurrent loads, no eviction).
let webLlmLoadQueue = Promise.resolve();

/**
 * Get loading status for a resource
 * @param {string} resourceId
 * @returns {"not_loaded" | "loading" | "loaded" | "error"}
 */
export const getLoadingStatus = (resourceId) => {
  return loadingStatus.get(resourceId) || "not_loaded";
};

/**
 * Get loaded data for a resource (sync)
 * @param {string} resourceId
 * @returns {any | null} The loaded data or null if not loaded
 */
export const getLoadedData = (resourceId) => {
  return loadedData.get(resourceId) ?? null;
};

/**
 * Get loading progress for a resource
 * @param {string} resourceId
 * @returns {{ text: string, progress: number } | null} Progress info or null
 */
export const getLoadingProgress = (resourceId) => {
  return loadingProgress.get(resourceId) ?? null;
};

/**
 * Set loading progress for a resource
 * @param {string} resourceId
 * @param {{ text: string, progress: number }} progress
 */
export const setLoadingProgress = (resourceId, progress) => {
  loadingProgress.set(resourceId, progress);
  // Notify progress subscribers
  const callbacks = [...(progressCallbacks.get(resourceId) || [])];
  callbacks.forEach((cb) => cb(progress));
};

/**
 * Subscribe to loading progress changes
 * @param {string} resourceId
 * @param {Function} callback
 * @returns {Function} Unsubscribe function
 */
export const subscribeLoadingProgress = (resourceId, callback) => {
  if (!progressCallbacks.has(resourceId)) {
    progressCallbacks.set(resourceId, []);
  }
  progressCallbacks.get(resourceId).push(callback);
  return () => {
    const callbacks = progressCallbacks.get(resourceId);
    const index = (callbacks || []).indexOf(callback);
    if (index > -1) {
      callbacks.splice(index, 1);
    }
  };
};

/**
 * Set loading status for a resource
 * @param {string} resourceId
 * @param {"not_loaded" | "loading" | "loaded" | "error"} status
 * @param {{ error?: Error, elapsed?: number }} options
 */
const setLoadingStatus = (
  resourceId,
  status,
  { error = null, elapsed = null } = {},
) => {
  loadingStatus.set(resourceId, status);
  breadcrumb(`load:${status}`, {
    resource: resourceId,
    ...(elapsed != null ? { elapsedMs: Math.round(elapsed) } : {}),
    ...(error ? { error: String(error?.message ?? error).slice(0, 200) } : {}),
  });
  mergeSnapshot({ resources: Object.fromEntries(loadingStatus) });
  // Copy array before iterating to avoid issues if callbacks unsubscribe during iteration
  const callbacks = [...(loadingCallbacks.get(resourceId) || [])];
  callbacks.forEach((cb) => cb(status, { error, elapsed }));
};

/**
 * Wait for a load to complete
 * @param {string} resourceId
 * @returns {Promise<void>} Resolves when loaded, rejects on error
 */
const waitForLoading = (resourceId) => {
  return new Promise((resolve, reject) => {
    const status = loadingStatus.get(resourceId);
    if (status === "loaded") return resolve();
    if (status === "error")
      return reject(new Error(`Dependency ${resourceId} failed`));

    const unsubscribe = subscribeLoadingStatus(resourceId, (newStatus) => {
      if (newStatus === "loaded") {
        unsubscribe();
        resolve();
      } else if (newStatus === "error") {
        unsubscribe();
        reject(new Error(`Dependency ${resourceId} failed`));
      }
    });
  });
};

/**
 * Subscribe to loading status changes
 * @param {string} resourceId
 * @param {Function} callback
 * @returns {Function} Unsubscribe function
 */
export const subscribeLoadingStatus = (resourceId, callback) => {
  if (!loadingCallbacks.has(resourceId)) {
    loadingCallbacks.set(resourceId, []);
  }
  loadingCallbacks.get(resourceId).push(callback);
  return () => {
    const callbacks = loadingCallbacks.get(resourceId);
    const index = (callbacks || []).indexOf(callback);
    if (index > -1) {
      callbacks.splice(index, 1);
    }
  };
};

/**
 * Single-model policy: free other RESIDENT web-llm chat models before loading a new one, so only one
 * stays in memory (each is unloaded synchronously to avoid a both-resident peak; it stays cached on
 * disk). Because default-mode loads are serialized (see startLoading/webLlmLoadQueue), there is never
 * another web-llm load in flight here — only fully-loaded models are evicted. Scoped to web-llm chat
 * models — the embeddings extractor and Chrome built-in AI are never touched.
 * @param {string} keepId      Resource id we're keeping (the one being loaded)
 * @param {string} keepModelId Its model id (for the breadcrumb)
 */
const evictOtherWebLlmModels = async (keepId, keepModelId) => {
  for (const resource of Object.values(RESOURCES)) {
    if (resource.kind !== "llm" || resource.provider !== "webLlm") continue;
    if (resource.id === keepId) continue;
    if (getLoadingStatus(resource.id) !== "loaded") continue;

    breadcrumb("llm.evict", { unloaded: resource.modelId, for: keepModelId });
    await freeResidentModel(resource);
  }
};

/**
 * Free a resident model from memory: reflect it as not-loaded (its bytes stay cached on disk, so the
 * 3-state badge shows "Cached") and tear down the provider engine. Shared by single-model eviction
 * and manual unload so they can't drift. LLM-only unload; status/bookkeeping applies to any resource.
 * @param {{ id: string, kind?: string, provider?: string, modelId?: string }} resource
 */
const freeResidentModel = async (resource) => {
  loadedData.delete(resource.id);
  loadingProgress.delete(resource.id);
  setLoadingStatus(resource.id, "not_loaded");
  if (resource.kind === "llm") {
    await unloadLlmEngine(resource.provider, resource.modelId).catch(() => {});
  }
};

/**
 * Manually unload a resident model from memory (frees GPU/RAM; bytes stay cached on disk → badge
 * drops Loaded → Cached, reload is fast). Triggered from the AI Models pane / loading button. No-op
 * if the resource isn't found or isn't an LLM.
 * @param {string} resourceId
 */
export const unloadResource = async (resourceId) => {
  const resource = findResourceById(resourceId);
  if (!resource || resource.kind !== "llm") return;
  breadcrumb("llm.unload", { model: resource.modelId });
  await freeResidentModel(resource);
};

/**
 * Delete a model's bytes from disk (Cache API / IndexedDB), unloading from memory first. Leaves the
 * resource Not loaded; callers should re-probe checkCached so the badge drops Cached → Not loaded.
 * No-op if the resource isn't found or isn't an LLM.
 * @param {string} resourceId
 */
export const deleteResourceCache = async (resourceId) => {
  const resource = findResourceById(resourceId);
  if (!resource || resource.kind !== "llm") return;
  breadcrumb("llm.cache.delete", { model: resource.modelId });
  loadedData.delete(resource.id);
  loadingProgress.delete(resource.id);
  setLoadingStatus(resource.id, "not_loaded");
  await deleteModelCache(resource.provider, resource.modelId).catch(() => {});
};

/**
 * Run a single load: evict resident web-llm models (single-model policy), wait for deps, then load.
 * Assumes the caller already set status to "loading" and (for web-llm) serialized via the queue.
 * @param {{ id: string, get: () => Promise<any>, deps?: string[], kind?: string, provider?: string, modelId?: string }} resource
 */
const runLoad = async (resource) => {
  const { id, get, deps } = resource;

  // Single-model policy (default): free other resident web-llm chat models before allocating this
  // one. The experimentalMultipleModels setting overrides it to allow stacking.
  if (
    resource.kind === "llm" &&
    resource.provider === "webLlm" &&
    !getSettings().experimentalMultipleModels
  ) {
    await evictOtherWebLlmModels(id, resource.modelId);
  }

  // Wait for dependencies before starting the timer
  if (deps?.length) {
    await Promise.all(deps.map((depId) => waitForLoading(depId)));
  }

  // TODO(BUG): Occasionally elapsed is `null` upstream. Not fixed yet.
  const start = performance.now();
  try {
    const result = await get();
    loadedData.set(id, result);
    const elapsed = performance.now() - start;
    setLoadingStatus(id, "loaded", { elapsed });
  } catch (error) {
    const elapsed = performance.now() - start;
    setLoadingStatus(id, "error", { error, elapsed });
  }
};

/**
 * Start loading a resource. Default-mode web-llm loads are serialized through webLlmLoadQueue so a
 * second click doesn't abort the first's in-flight download — each finishes caching to disk, then
 * single-model eviction frees the previous from memory before the next allocates. Other resources
 * (and multiple-models mode) load directly/concurrently.
 * @param {{ id: string, get: () => Promise<any>, deps?: string[] }} resource
 */
export const startLoading = async (resource) => {
  const { id } = resource;
  // Check and set must remain synchronous (no await between) to prevent races
  const status = loadingStatus.get(id);
  if (status === "loading" || status === "loaded") {
    return;
  }
  setLoadingStatus(id, "loading");

  const serialize =
    resource.kind === "llm" &&
    resource.provider === "webLlm" &&
    !getSettings().experimentalMultipleModels;
  if (serialize) {
    const next = webLlmLoadQueue.then(() => runLoad(resource));
    // Keep the queue alive even if one load rejects, so later queued loads still run.
    webLlmLoadQueue = next.catch(() => {});
    return next;
  }
  return runLoad(resource);
};

/**
 * Initialize loading system and start default loads
 */
export const init = () => {
  startLoading(RESOURCES.POSTS_DATA);
  startLoading(RESOURCES.POSTS_EMBEDDINGS);
  startLoading(RESOURCES.DB);
  startLoading(RESOURCES.EXTRACTOR);

  // Auto-load LLM models that have autoLoad: true (from all providers)
  ALL_CHAT_MODELS.forEach(({ models }) => {
    models.forEach((modelCfg) => {
      if (modelCfg.autoLoad) {
        const resourceKey = modelToResourceKey(modelCfg.model);
        startLoading(RESOURCES[resourceKey]);
      }
    });
  });
};
