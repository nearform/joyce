// Browser-side: drive and observe the app's resource loading system. See ./README.md for rules.
//
// IMPORTANT DESIGN NOTE: these functions all return immediately. Node polls them; the page never
// holds a long-lived promise open on the harness's behalf.
//
// The obvious alternative — one `Runtime.evaluate` with `awaitPromise: true` that resolves when
// the resource finishes — is a trap. A pending evaluate dies with "Promise was collected" if the
// execution context is disturbed at all, which happens routinely when the tab is backgrounded in
// an attached browser. It fails intermittently, and it fails worse the longer the wait: a web-llm
// model download is tens of minutes. Polling short-lived evaluates from Node has none of that
// fragility, and page-timer throttling can't affect it either, because the clock lives in Node.

/**
 * Start loading a resource if it isn't already going, and report its current state.
 *
 * Do NOT be tempted to await `startLoading`. Two things make that useless, and both present as a
 * mysterious hang or a false success:
 *
 *  - it returns `undefined` immediately when the resource is already "loading" or "loaded", so
 *    awaiting it can resolve long before the work is done;
 *  - `runLoad` catches failures internally and records status "error" rather than rejecting, so an
 *    awaited `startLoading` also resolves on failure.
 *
 * Status is therefore the only trustworthy signal, and it's what Node polls.
 *
 * Resource ids: "posts_data", "posts_embeddings", "db", "extractor", and "llm_<modelId>".
 *
 * @param {{base: string, resourceId: string}} arg
 * @returns {Promise<string>} JSON string with {found, status, progress}
 */
export const startResourceLoad = async (arg) => {
  const loading = await import(`${arg.base}local/data/loading.js`);
  const resource = loading.findResourceById(arg.resourceId);
  if (!resource) {
    return JSON.stringify({ found: false, resourceId: arg.resourceId });
  }

  const status = loading.getLoadingStatus(arg.resourceId);
  if (status !== "loaded" && status !== "loading") {
    // Fire-and-forget: the return value carries no useful information (see above), and awaiting it
    // here would recreate the long-lived-promise problem this module exists to avoid.
    try {
      Promise.resolve(loading.startLoading(resource)).catch(() => {});
    } catch {
      // A synchronous throw still leaves polled status as the source of truth.
    }
  }

  return JSON.stringify({
    found: true,
    status: loading.getLoadingStatus(arg.resourceId),
    progress: loading.getLoadingProgress(arg.resourceId) || null,
  });
};

/**
 * Read one resource's status and progress. Never starts a load.
 * @param {{base: string, resourceId: string}} arg
 * @returns {Promise<string>} JSON string
 */
export const readResourceState = async (arg) => {
  const loading = await import(`${arg.base}local/data/loading.js`);
  return JSON.stringify({
    status: loading.getLoadingStatus(arg.resourceId),
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
