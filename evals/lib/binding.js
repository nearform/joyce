// Page -> Node event streaming over Runtime.addBinding.
//
// Design rule: the binding carries only small, ordered, latency-sensitive events (search started,
// first token, delta heartbeats, finish reason, done). The large terminal payload — usage.prompt,
// usage.context, searchData, chunkTexts — comes back as the Runtime.evaluate promise's single JSON
// string instead. A generated answer produces hundreds of deltas, so streaming full payloads over
// the binding would be both slow and prone to returnByValue serialization limits.

/** Max payload per binding call before chunking. Well under any practical frame limit. */
export const MAX_BINDING_PAYLOAD = 60_000;

/**
 * Reassemble chunked binding messages and dispatch complete events.
 *
 * @param {Object} conn - connection from connectCdp
 * @param {import("./cdp.js").CdpSession} session
 * @param {Object} options
 * @param {(event: Object) => void} options.onEvent
 * @param {number} [options.stallMs] - emit a __stall event after this long with no traffic
 * @returns {{stop: () => void, touch: () => void, lastAt: () => number}}
 */
export const createBindingStream = (
  conn,
  session,
  { onEvent, stallMs = 90_000 },
) => {
  /** @type {Map<string, {total: number, parts: string[], seen: number}>} */
  const partial = new Map();
  let lastAt = Date.now();
  let stopped = false;

  const off = conn.onBinding(session.sessionId, (payload) => {
    lastAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(payload);
    } catch {
      onEvent({ type: "__malformed", payload: String(payload).slice(0, 200) });
      return;
    }

    if (!msg.__chunk) {
      onEvent(msg);
      return;
    }

    const { id, i, total, s } = msg.__chunk;
    const slot = partial.get(id) ?? { total, parts: new Array(total), seen: 0 };
    if (slot.parts[i] === undefined) slot.seen += 1;
    slot.parts[i] = s;
    partial.set(id, slot);
    if (slot.seen === slot.total) {
      partial.delete(id);
      try {
        onEvent(JSON.parse(slot.parts.join("")));
      } catch {
        onEvent({ type: "__malformed", payload: "chunked reassembly failed" });
      }
    }
  });

  const timer = setInterval(() => {
    if (stopped) return;
    const idle = Date.now() - lastAt;
    if (idle > stallMs) {
      stopped = true;
      clearInterval(timer);
      onEvent({ type: "__stall", idleMs: idle });
    }
  }, 1_000);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      off();
    },
    touch: () => {
      lastAt = Date.now();
    },
    lastAt: () => lastAt,
  };
};
