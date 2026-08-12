// Browser-side: environment and app-boot probes. See ./README.md for the rules.

/**
 * Report the WebGPU adapter, Chrome built-in AI availability, and app boot state.
 *
 * The GPU adapter is recorded in every run manifest and in baseline fingerprints. A fallback
 * adapter (SwiftShader/CPU) produces latency numbers that are not comparable to a real GPU run, so
 * the harness marks such runs non-comparable rather than silently diffing them.
 *
 * @param {{base: string, bindingName: string}} arg
 * @returns {Promise<string>} JSON string
 */
export const probeEnvironment = async (arg) => {
  const out = {
    url: location.href,
    pathname: location.pathname,
    userAgent: navigator.userAgent,
    binding: typeof window[arg.bindingName] === "function",
    gpu: { available: false, isFallback: null, info: null, error: null },
    chromeAi: {
      languageModel: false,
      writer: false,
      languageModelAvailability: null,
    },
    app: { rootMounted: false, importMap: false },
  };

  // WebGPU. web-llm requires it; a missing adapter means every webLlm case will fail to load.
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        out.gpu.available = true;
        out.gpu.isFallback = adapter.isFallbackAdapter ?? null;
        const info = adapter.info ?? null;
        out.gpu.info = info
          ? {
              vendor: info.vendor ?? null,
              architecture: info.architecture ?? null,
              device: info.device ?? null,
              description: info.description ?? null,
            }
          : null;
      }
    }
  } catch (err) {
    out.gpu.error = String(err && err.message ? err.message : err);
  }

  // Chrome built-in AI. Absent unless the model has been downloaded in this profile, which is a
  // documented one-time manual step — so the harness skips those cases rather than failing them.
  try {
    out.chromeAi.languageModel = typeof window.LanguageModel !== "undefined";
    out.chromeAi.writer = typeof window.Writer !== "undefined";
    if (out.chromeAi.languageModel && window.LanguageModel.availability) {
      out.chromeAi.languageModelAvailability =
        await window.LanguageModel.availability();
    }
  } catch (err) {
    out.chromeAi.error = String(err && err.message ? err.message : err);
  }

  // App boot: a mounted root plus an import map means index.html actually ran.
  try {
    const root = document.querySelector("#root");
    out.app.rootMounted = Boolean(root && root.children.length > 0);
    out.app.importMap = Boolean(
      document.querySelector('script[type="importmap"]'),
    );
  } catch {
    // Leave the defaults.
  }

  return JSON.stringify(out);
};

/**
 * Assert that a dynamic import in this world reaches the app's own module instances.
 *
 * This is the guard for the harness's central invariant. `db` only reports "loaded" if we are
 * sharing the module registry the app booted — in an isolated world (or a second module graph) the
 * bare-specifier imports would fail outright, and even a successful import would carry empty
 * caches. If this ever returns sharedWithApp false, the pipeline driver is measuring the wrong
 * thing.
 *
 * @param {{base: string}} arg
 * @returns {Promise<string>} JSON string
 */
export const probeModuleSharing = async (arg) => {
  const out = {
    imported: false,
    statuses: {},
    sharedWithApp: false,
    error: null,
  };
  try {
    const loading = await import(`${arg.base}local/data/loading.js`);
    out.imported = true;
    for (const id of ["posts_data", "posts_embeddings", "db", "extractor"]) {
      out.statuses[id] = loading.getLoadingStatus(id);
    }
    // Anything other than "not_loaded" proves shared state: a fresh module graph would report
    // every resource as not_loaded because init() would never have run in it.
    out.sharedWithApp = Object.values(out.statuses).some(
      (s) => s !== "not_loaded",
    );
  } catch (err) {
    out.error = String(err && err.message ? err.message : err);
  }
  return JSON.stringify(out);
};
