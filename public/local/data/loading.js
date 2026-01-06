/* global performance:false */
import { getPosts, getPostsEmbeddings } from "./api/posts.js";
import { getDb, getExtractor } from "./api/search.js";
import {
  getLlmEngine,
  setLlmProgressCallback,
  isLlmCached,
} from "./api/llm.js";
import { ALL_CHAT_MODELS } from "../../config.js";

// ==============================
// Loading Management
// ==============================

// Helper to create LLM resource entry for a model (works with any provider)
const createLlmResource = (provider, modelId) => ({
  id: `llm_${modelId}`,
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
