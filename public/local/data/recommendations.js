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
  // Unknown VRAM requirement (web-llm leaves vram_required_MB null for some entries, e.g. the
  // Ministral-3-3B builds). Every size check below is guarded by `need`, so a null would otherwise
  // skip them all and fall through as "safe" — exactly how a huge model got recommended on iOS.
  // We can't verify it fits, so treat it as unsupported and keep it out of recommendations.
  if (!(need > 0)) {
    tier = "blocked";
    reasons.push(
      "VRAM requirement unknown — can't verify it fits this device.",
    );
  }
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

// --- capability ranking ------------------------------------------------------------------------
// "Best" is NOT "biggest file". Raw VRAM rewards bloated quants (e.g. an old phi-2 in fp32 beats a
// far better modern model in fp16). We rank by capability instead, with the user's tie-breakers.

/**
 * Parameter count in billions, parsed from a web-llm model id — the primary capability proxy.
 * Matches a `-<n>B-`/`-<n>M-` token (e.g. `Qwen2.5-3B` → 3, `Qwen3-0.6B` → 0.6,
 * `SmolLM2-360M` → 0.36). Anchored on the leading `-` so quant tokens like `q4f16_1` and
 * version numbers like `Qwen2.5` / `Llama-3.2` aren't misread. Unknown (e.g. `phi-2`) → 0, which
 * intentionally ranks unlabelled legacy models below anything with a stated size.
 * @param {string} id
 * @returns {number}
 */
const paramsB = (id = "") => {
  const b = id.match(/-(\d+(?:\.\d+)?)b(?:[-_]|$)/i);
  if (b) return parseFloat(b[1]);
  const m = id.match(/-(\d+(?:\.\d+)?)m(?:[-_]|$)/i);
  if (m) return parseFloat(m[1]) / 1000;
  return 0;
};

/** Prefer q4f16_1 (half the footprint of q4f32 at ~equal quality), then q4f32_1, then the rest. */
const quantRank = (q) => (q === "q4f16_1" ? 2 : q === "q4f32_1" ? 1 : 0);

/** Qwen generation number (Qwen3 → 3, Qwen2.5 → 2.5); 0 for non-Qwen. Higher is newer/better. */
const qwenVersion = (id = "") => {
  const m = id.match(/qwen(\d+(?:\.\d+)?)/i);
  return m ? parseFloat(m[1]) : 0;
};

/**
 * Lexicographic capability vector, compared descending: params first (capability), then prefer
 * q4f16_1, then favor higher-number Qwen, then larger VRAM as a final tiebreak.
 * @param {{ model?: string, quantization?: string | null, vramMb?: number | null }} m
 * @returns {number[]}
 */
const capabilityScore = (m) => [
  paramsB(m.model ?? ""),
  quantRank(m.quantization),
  qwenVersion(m.model ?? ""),
  m.vramMb ?? 0,
];

/** Compare two equal-length score vectors, descending (for Array.sort). */
const byScoreDesc = (a, b) => {
  const sa = capabilityScore(a.model);
  const sb = capabilityScore(b.model);
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) return sb[i] - sa[i];
  }
  return 0;
};

/**
 * Pick the best model for the current device. Among models that pass the safety check, returns the
 * most *capable* (params → q4f16_1 → higher Qwen → VRAM), not merely the largest. Falls back to the
 * smallest `risky` model (least likely to crash) if nothing is safe.
 * @param {Array<{ vramMb?: number | null }>} models
 * @param {FitCtx} ctx
 * @returns {{ model: object, fit: Fit } | null}
 */
export const pickBestModel = (models, ctx) => {
  if (!models?.length) return null;
  const scored = models.map((m) => ({ model: m, fit: assessModelFit(m, ctx) }));
  const safe = scored.filter((s) => s.fit.tier === "safe");
  if (safe.length) {
    return safe.sort(byScoreDesc)[0];
  }
  const risky = scored.filter((s) => s.fit.tier === "risky");
  if (risky.length) {
    // Nothing safe — smallest risky wins (least crash risk), capability breaking ties.
    return risky.sort(
      (a, b) =>
        (a.model.vramMb ?? Infinity) - (b.model.vramMb ?? Infinity) ||
        byScoreDesc(a, b),
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
