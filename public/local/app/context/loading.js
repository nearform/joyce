import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import { html } from "../../../app/util/html.js";
import {
  RESOURCES,
  getLoadingStatus,
  getLoadingProgress,
  subscribeLoadingStatus,
  subscribeLoadingProgress,
  startLoading,
  findResourceById,
  registerLlmResource,
} from "../../data/loading.js";
import { getProviderForModel } from "../../../config.js";

// Create the context with a default value
const LoadingContext = createContext(null);

/**
 * Provider component that manages loading state
 */
export const LoadingProvider = ({ children }) => {
  const [statuses, setStatuses] = useState(new Map());
  const [errors, setErrors] = useState(new Map());
  const [elapsedTimes, setElapsedTimes] = useState(new Map());
  const [progressMap, setProgressMap] = useState(new Map());
  // resourceId -> on-disk-cached? (downloaded but not necessarily in memory). Drives the 3-state
  // Not loaded / Cached / Loaded badge. Probed async via resource.checkCached().
  const [cachedMap, setCachedMap] = useState(new Map());

  // Update status for a resource
  const updateStatus = useCallback(
    (resourceId, status, { error = null, elapsed = null } = {}) => {
      setStatuses((prev) => {
        const next = new Map(prev);
        next.set(resourceId, status);
        return next;
      });
      if (error) {
        setErrors((prev) => {
          const next = new Map(prev);
          next.set(resourceId, error);
          return next;
        });
      } else {
        setErrors((prev) => {
          const next = new Map(prev);
          next.delete(resourceId);
          return next;
        });
      }
      if (elapsed !== null) {
        setElapsedTimes((prev) => {
          const next = new Map(prev);
          next.set(resourceId, elapsed);
          return next;
        });
      }
    },
    [],
  );

  // Update progress for a resource
  const updateProgress = useCallback((resourceId, progress) => {
    setProgressMap((prev) => {
      const next = new Map(prev);
      next.set(resourceId, progress);
      return next;
    });
  }, []);

  // Probe whether a resource's bytes are on disk (Cache API / IndexedDB). Cheap and idempotent;
  // only updates state when the value actually changes (avoids render churn).
  const probeCached = useCallback((resource) => {
    if (!resource?.checkCached) return;
    resource
      .checkCached()
      .then((cached) => {
        setCachedMap((prev) => {
          if ((prev.get(resource.id) || false) === !!cached) return prev;
          const next = new Map(prev);
          next.set(resource.id, !!cached);
          return next;
        });
      })
      .catch(() => {});
  }, []);

  // Subscribe to status changes and initialize from current state
  // Note: We subscribe first, then check current status to avoid race conditions
  // where a load completes between checking status and subscribing
  useEffect(() => {
    const resources = Object.values(RESOURCES);
    const unsubscribes = resources.flatMap((resource) => {
      // Subscribe to status changes
      const unsubStatus = subscribeLoadingStatus(
        resource.id,
        (status, { error, elapsed }) => {
          updateStatus(resource.id, status, { error, elapsed });
          // A model that just unloaded (e.g. eviction) is now cached-not-loaded — re-probe.
          if (status === "not_loaded") probeCached(resource);
        },
      );
      // Check current status after subscribing to catch any updates we missed
      const currentStatus = getLoadingStatus(resource.id);
      updateStatus(resource.id, currentStatus);
      probeCached(resource); // initial on-disk-cached probe

      // Subscribe to progress changes
      const unsubProgress = subscribeLoadingProgress(
        resource.id,
        (progress) => {
          updateProgress(resource.id, progress);
        },
      );
      // Check current progress after subscribing
      const currentProgress = getLoadingProgress(resource.id);
      if (currentProgress) {
        updateProgress(resource.id, currentProgress);
      }

      return [unsubStatus, unsubProgress];
    });

    return () => {
      unsubscribes.forEach((unsub) => unsub());
    };
  }, [updateStatus, updateProgress, probeCached]);

  const handleStartLoading = useCallback(
    (resourceId) => {
      let resource = findResourceById(resourceId);

      // Auto-register LLM resources if they don't exist
      // Look up the correct provider for the model
      if (!resource && resourceId.startsWith("llm_")) {
        const modelId = resourceId.replace(/^llm_/, "");
        const provider = getProviderForModel(modelId);
        if (provider) {
          registerLlmResource(provider, modelId);
          resource = findResourceById(resourceId);

          // Subscribe to status/progress changes for the newly registered resource
          if (resource) {
            const res = resource;
            subscribeLoadingStatus(res.id, (status, { error, elapsed }) => {
              updateStatus(res.id, status, { error, elapsed });
              if (status === "not_loaded") probeCached(res);
            });
            subscribeLoadingProgress(res.id, (progress) => {
              updateProgress(res.id, progress);
            });
            probeCached(res);
          }
        }
      }

      if (resource) {
        startLoading(resource);
      }
    },
    [updateStatus, updateProgress, probeCached],
  );

  const value = useMemo(
    () => ({
      getStatus: (resourceId) => statuses.get(resourceId) || "not_loaded",
      getError: (resourceId) => errors.get(resourceId) || null,
      getElapsed: (resourceId) => elapsedTimes.get(resourceId) ?? null,
      getProgress: (resourceId) => progressMap.get(resourceId) ?? null,
      getCached: (resourceId) => cachedMap.get(resourceId) || false,
      startLoading: handleStartLoading,
    }),
    [
      statuses,
      errors,
      elapsedTimes,
      progressMap,
      cachedMap,
      handleStartLoading,
    ],
  );

  return html`
    <${LoadingContext.Provider} value=${value}>
      ${children}
    </${LoadingContext.Provider}>
  `;
};

/**
 * Hook to use the loading context
 */
export const useLoading = () => {
  const context = useContext(LoadingContext);
  if (!context) {
    throw new Error("useLoading must be used within a LoadingProvider");
  }
  return context;
};
