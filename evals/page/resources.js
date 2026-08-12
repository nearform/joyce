// Browser-side: drive and observe the app's resource loading system. See ./README.md for rules.

/**
 * Wait for one app resource to reach a terminal state, reporting progress over the binding.
 *
 * Do NOT be tempted to simply `await startLoading(resource)`. Two things make that wrong, and both
 * present as a mysterious hang or a false success:
 *
 *  - `startLoading` returns `undefined` immediately when the resource is already "loading" or
 *    "loaded", so awaiting it can resolve before the work is done — or resolve instantly while the
 *    real load is still in flight from the app's own init().
 *  - `runLoad` catches failures internally and records status "error" rather than rejecting, so an
 *    awaited `startLoading` also resolves on failure.
 *
 * The status subscription is therefore the only trustworthy signal. `startLoading` is invoked
 * fire-and-forget purely to kick off a load that isn't already running.
 *
 * Resource ids: "posts_data", "posts_embeddings", "db", "extractor", and "llm_<modelId>".
 *
 * @param {{base: string, bindingName: string, resourceId: string, timeoutMs: number}} arg
 * @returns {Promise<string>} JSON string with {status, elapsedMs, progress}
 */
export const waitForResource = async (arg) => {
  const send = (event) => window[arg.bindingName](JSON.stringify(event));
  const loading = await import(`${arg.base}local/data/loading.js`);

  const resource = loading.findResourceById(arg.resourceId);
  if (!resource) {
    return JSON.stringify({ status: "missing", resourceId: arg.resourceId });
  }

  const startedAt = performance.now();
  const current = loading.getLoadingStatus(arg.resourceId);
  if (current === "loaded") {
    return JSON.stringify({
      status: "loaded",
      elapsedMs: 0,
      alreadyLoaded: true,
    });
  }

  const unsubProgress = loading.subscribeLoadingProgress(
    arg.resourceId,
    (p) => {
      send({
        type: "progress",
        resourceId: arg.resourceId,
        text: (p && p.text) || "",
        progress: (p && p.progress) || 0,
      });
    },
  );

  const settled = new Promise((resolve) => {
    const status = loading.getLoadingStatus(arg.resourceId);
    if (status === "loaded" || status === "error") {
      resolve(status);
      return;
    }
    const unsub = loading.subscribeLoadingStatus(arg.resourceId, (next) => {
      if (next === "loaded" || next === "error") {
        unsub();
        resolve(next);
      }
    });
  });

  // Fire-and-forget: see the note above on why the return value is useless here.
  try {
    Promise.resolve(loading.startLoading(resource)).catch(() => {});
  } catch {
    // A synchronous throw still leaves the subscription as the source of truth.
  }

  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), arg.timeoutMs);
  });

  const status = await Promise.race([settled, timeout]);
  clearTimeout(timer);
  unsubProgress();

  return JSON.stringify({
    status,
    elapsedMs: Math.round(performance.now() - startedAt),
    progress: loading.getLoadingProgress(arg.resourceId) || null,
  });
};

/**
 * Read the status of several resources at once, without starting any load.
 * @param {{base: string, resourceIds: string[]}} arg
 * @returns {Promise<string>} JSON string mapping resourceId -> status
 */
export const readResourceStatuses = async (arg) => {
  const loading = await import(`${arg.base}local/data/loading.js`);
  const out = {};
  for (const id of arg.resourceIds) {
    out[id] = loading.getLoadingStatus(id);
  }
  return JSON.stringify(out);
};

/**
 * Register an uncurated web-llm model for this session so it can be evaluated.
 *
 * `addChatModel` mutates the in-memory config only (nothing is persisted), and
 * `registerLlmResource` creates the matching `llm_<modelId>` resource. Together these mean any
 * prebuilt web-llm model can be passed via --model without touching app source. Curated models are
 * already registered, so this is a no-op for them.
 *
 * @param {{base: string, provider: string, model: string}} arg
 * @returns {Promise<string>} JSON string
 */
export const registerModel = async (arg) => {
  const out = {
    registered: false,
    resourceId: `llm_${arg.model}`,
    error: null,
  };
  try {
    const config = await import(`${arg.base}config.js`);
    const loading = await import(`${arg.base}local/data/loading.js`);
    if (!loading.findResourceById(out.resourceId)) {
      if (typeof config.addChatModel === "function") {
        config.addChatModel(arg.provider, arg.model);
      }
      loading.registerLlmResource(arg.provider, arg.model);
      out.registered = true;
    }
  } catch (err) {
    out.error = String(err && err.message ? err.message : err);
  }
  return JSON.stringify(out);
};
