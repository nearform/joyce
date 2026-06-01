// Device-aware model fit recommendations. Pure functions — no I/O, no DOM, safe to import
// from anywhere. Inputs are the system/device facts already gathered at app boot plus
// optional crashbox live state. Outputs are tier badges with one-line reasons used by the
// Data tab (System summary + AI Models Fit column).

/**
 * @typedef {Object} FitCtx
 * @property {Object} systemInfo Result of `getSystemInfo()`.
 * @property {Object} deviceInfo Result of `getDeviceInfo()`.
 * @property {Array<{ kind: string, info?: object, t: number }>} [warnings] crashbox warnings.
 * @property {{ reason: string } | null} [recovered] crashbox recovered crash record.
 */

/**
 * @typedef {Object} Fit
 * @property {"safe" | "risky" | "blocked"} tier
 * @property {string[]} reasons Human-readable reasons; always at least one entry.
 */

// Mobile model size beyond which iPhone Safari starts evicting / risking tab kill. Empirical.
const MOBILE_RISK_MB = 800;
// Headroom factor: a model needing more than 0.6× device RAM is too tight (leaves room for
// extractor + Orama chunks DB + browser overhead).
const RAM_HEADROOM_FACTOR = 0.6;
// GPU buffer pressure: a model whose weights alone consume more than this fraction of the
// GPU's `maxBufferSize` is risky because inference still needs KV cache + activations on top.
const GPU_BUFFER_CAUTION_FRACTION = 0.7;
// How many in-session memory-pressure warnings before we flag the device as constrained.
const MEMORY_PRESSURE_THRESHOLD = 2;

const tierWeight = { safe: 0, risky: 1, blocked: 2 };

/**
 * Combine two fit tiers — the more severe wins.
 * @param {Fit["tier"]} a
 * @param {Fit["tier"]} b
 * @returns {Fit["tier"]}
 */
const escalate = (a, b) => (tierWeight[b] > tierWeight[a] ? b : a);

/**
 * Score a single model for the current device.
 * @param {{ model?: string, vramMb?: number | null, provider?: string }} model
 * @param {FitCtx} ctx
 * @returns {Fit}
 */
export const assessModelFit = (model, ctx) => {
  const { systemInfo, deviceInfo, warnings, recovered } = ctx;
  const reasons = [];
  let tier = "safe";

  const need = model.vramMb;
  const maxBuf = systemInfo?.limits?.maxBufferSize ?? null;
  const ram = systemInfo?.ramGb ?? null;
  const onMobile = !!deviceInfo?.isMobile;
  const fallbackGPU = !!systemInfo?.webgpu?.isFallback;
  const noWebGPU = !systemInfo?.webgpu?.adapterAvailable;
  // MODELS entries from public/config.js have no `provider` field; treat them as web-llm.
  const isWebLlm = model.provider === undefined || model.provider === "webLlm";

  // Hard blocks.
  if (need && maxBuf && need * 1024 * 1024 > maxBuf) {
    tier = "blocked";
    reasons.push(
      `Needs ${need} MB; GPU max buffer is ${Math.round(maxBuf / 1048576)} MB.`,
    );
  }
  if (isWebLlm && noWebGPU) {
    tier = escalate(tier, "blocked");
    reasons.push("web-llm requires WebGPU; not available here.");
  }

  if (tier !== "blocked") {
    if (
      need &&
      maxBuf &&
      need * 1024 * 1024 > maxBuf * GPU_BUFFER_CAUTION_FRACTION
    ) {
      tier = escalate(tier, "risky");
      const needFraction = Math.round(((need * 1024 * 1024) / maxBuf) * 100);
      reasons.push(
        `Weights need ~${needFraction}% of the GPU max buffer; inference also needs KV cache + activations.`,
      );
    }
    if (need && ram && need > ram * 1024 * RAM_HEADROOM_FACTOR) {
      tier = escalate(tier, "risky");
      reasons.push(
        `Needs ${need} MB; device RAM ≈ ${ram} GB (tight headroom).`,
      );
    }
    if (need && onMobile && need > MOBILE_RISK_MB) {
      tier = escalate(tier, "risky");
      reasons.push("Large model on a mobile device — Safari may kill the tab.");
    }
    if (fallbackGPU) {
      tier = escalate(tier, "risky");
      reasons.push("WebGPU is using a software fallback adapter.");
    }
    if (recovered?.reason === "webgpu-device-lost" && isWebLlm) {
      tier = escalate(tier, "risky");
      reasons.push("Previous session crashed with a WebGPU device loss.");
    }
    if (recovered?.reason === "oom") {
      tier = escalate(tier, "risky");
      reasons.push(
        "Previous session hit OOM — same model class may be too large.",
      );
    }
    const memWarnings = (warnings ?? []).filter(
      (w) => w.kind === "memory-pressure",
    ).length;
    if (memWarnings >= MEMORY_PRESSURE_THRESHOLD) {
      tier = escalate(tier, "risky");
      reasons.push(`${memWarnings} memory-pressure events this session.`);
    }
  }

  if (reasons.length === 0) {
    reasons.push("Should run cleanly on this device.");
  }
  return { tier, reasons };
};

/**
 * Pick the best model for the current device. Returns the largest `safe` model (more capable
 * within a safe envelope); falls back to the smallest `risky` model if nothing is safe.
 * @param {Array<{ vramMb?: number | null }>} models
 * @param {FitCtx} ctx
 * @returns {{ model: object, fit: Fit } | null}
 */
export const pickBestModel = (models, ctx) => {
  if (!models?.length) return null;
  const scored = models.map((m) => ({ model: m, fit: assessModelFit(m, ctx) }));
  const safe = scored.filter((s) => s.fit.tier === "safe");
  if (safe.length) {
    return safe.sort(
      (a, b) => (b.model.vramMb ?? 0) - (a.model.vramMb ?? 0),
    )[0];
  }
  const risky = scored.filter((s) => s.fit.tier === "risky");
  if (risky.length) {
    return risky.sort(
      (a, b) => (a.model.vramMb ?? Infinity) - (b.model.vramMb ?? Infinity),
    )[0];
  }
  return null;
};

/**
 * CSS class for the status-badge based on the tier. Reuses existing system badge styles.
 * @param {Fit["tier"]} tier
 */
export const tierClass = (tier) =>
  tier === "safe"
    ? "status-supported"
    : tier === "risky"
      ? "status-warning"
      : "status-unsupported";

/**
 * Human label for the tier badge. The internal tier names (safe/risky/blocked) are kept for
 * clarity in the code; the UI labels are softened.
 * @param {Fit["tier"]} tier
 */
export const tierLabel = (tier) =>
  tier === "safe" ? "Safe" : tier === "risky" ? "Caution" : "Unsupported";
