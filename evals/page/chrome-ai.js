// Browser-side: Chrome built-in AI (Gemini Nano) model download. See ./README.md for the rules.

/**
 * Start the on-device model download, without waiting for it to finish.
 *
 * `LanguageModel.create()` needs transient user activation, which the injector supplies via
 * `userGesture: true`. The download is browser-level and continues after the calling process
 * exits, so this kicks it off and stashes progress on `window` for polling rather than blocking
 * for what can be many minutes.
 *
 * Must run on a secure context (the app origin, or any http://127.0.0.1 page) — on `about:blank`
 * the API is not exposed at all and this would report a false negative.
 *
 * @param {{progressKey: string}} arg
 * @returns {Promise<string>} JSON string
 */
export const startAiDownload = async (arg) => {
  const key = arg.progressKey;
  if (typeof window.LanguageModel === "undefined") {
    return JSON.stringify({
      ok: false,
      reason:
        "LanguageModel API is not exposed on this page (needs a secure context + flags)",
    });
  }

  const availability = await window.LanguageModel.availability();
  if (availability === "available") {
    return JSON.stringify({ ok: true, already: true, availability });
  }
  if (availability === "unavailable") {
    return JSON.stringify({
      ok: false,
      availability,
      reason: "Chrome reports the model unavailable on this device/profile",
    });
  }

  window[key] = { loaded: 0, done: false, error: null };
  window.LanguageModel.create({
    monitor: (m) => {
      m.addEventListener("downloadprogress", (e) => {
        window[key].loaded = e.loaded;
      });
    },
  }).then(
    () => {
      window[key].done = true;
    },
    (err) => {
      window[key].error = String(err && err.message ? err.message : err);
    },
  );

  return JSON.stringify({ ok: true, started: true, availability });
};

/**
 * Read the progress object stashed by startAiDownload.
 * @param {{progressKey: string}} arg
 * @returns {string} JSON string
 */
export const readAiProgress = (arg) =>
  JSON.stringify(window[arg.progressKey] ?? {});
