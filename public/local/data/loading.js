/* global performance:false */
import { getPosts, getPostsEmbeddings } from "./api/posts.js";
import { getDb, getExtractor } from "./api/search.js";
import {
  getLlmEngine,
  setLlmProgressCallback,
  unloadLlmEngine,
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
// Resource ids torn down mid-load by single-model eviction. Their in-flight load settles into
// not_loaded (not "error" or "loaded") — see startLoading.
const evicting = new Set();

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
 * Single-model policy: free other resident web-llm chat models before loading a new one. A fully
 * loaded model is unloaded synchronously (await) so its memory is freed before we allocate the new
 * one; an in-flight model is torn down best-effort without blocking (and marked `evicting` so its
 * pending load settles to not_loaded instead of "error"). Scoped to web-llm chat models — the
 * embeddings extractor and Chrome built-in AI are never touched.
 * @param {string} keepId      Resource id we're keeping (the one being loaded)
 * @param {string} keepModelId Its model id (for the breadcrumb)
 */
const evictOtherWebLlmModels = async (keepId, keepModelId) => {
  for (const resource of Object.values(RESOURCES)) {
    if (resource.kind !== "llm" || resource.provider !== "webLlm") continue;
    if (resource.id === keepId) continue;
    const st = getLoadingStatus(resource.id);
    if (st !== "loaded" && st !== "loading") continue;

    breadcrumb("llm.evict", { unloaded: resource.modelId, for: keepModelId });
    loadedData.delete(resource.id);
    loadingProgress.delete(resource.id);
    setLoadingStatus(resource.id, "not_loaded");

    if (st === "loading") {
      // Don't block the new load on tearing down an in-flight one (device teardown can be slow);
      // neutralize its pending settle so it doesn't flip to "error".
      evicting.add(resource.id);
      unloadLlmEngine(resource.provider, resource.modelId).catch(() => {});
    } else {
      // Loaded: free it before we allocate, to avoid a peak where both are resident.
      await unloadLlmEngine(resource.provider, resource.modelId).catch(
        () => {},
      );
    }
  }
};

/**
 * Start loading a resource
 * @param {{ id: string, get: () => Promise<any>, deps?: string[] }} resource
 */
export const startLoading = async (resource) => {
  const { id, get, deps } = resource;
  // Check and set must remain synchronous (no await between) to prevent races
  const status = loadingStatus.get(id);
  if (status === "loading" || status === "loaded") {
    return;
  }
  setLoadingStatus(id, "loading");

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
    // If a newer load evicted this one mid-flight, settle as not_loaded (still cached on disk) —
    // don't record the torn-down engine as loaded.
    if (evicting.has(id)) {
      evicting.delete(id);
      setLoadingStatus(id, "not_loaded");
      return;
    }
    loadedData.set(id, result);
    const elapsed = performance.now() - start;
    setLoadingStatus(id, "loaded", { elapsed });
  } catch (error) {
    // An eviction teardown makes the in-flight load reject — that's not a real error.
    if (evicting.has(id)) {
      evicting.delete(id);
      setLoadingStatus(id, "not_loaded");
      return;
    }
    const elapsed = performance.now() - start;
    setLoadingStatus(id, "error", { error, elapsed });
  }
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
