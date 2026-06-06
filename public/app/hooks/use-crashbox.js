import { useSyncExternalStore } from "react";
import { subscribe, getCrashboxSnapshot } from "../../local/data/telemetry.js";

/**
 * Subscribe to crashbox telemetry and re-render when a crash is recovered/dismissed, a live warning
 * fires, or crashbox is bootstrapped/torn down. Returns the current `{ recovered, status }` snapshot,
 * read tear-free via `useSyncExternalStore` — replacing the hand-rolled `subscribe` + tick boilerplate.
 * @returns {ReturnType<typeof getCrashboxSnapshot>}
 */
export const useCrashbox = () =>
  useSyncExternalStore(subscribe, getCrashboxSnapshot);
