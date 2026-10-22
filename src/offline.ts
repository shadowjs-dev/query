/**
 * The `offline` feature: a query whose `networkMode` is not `online` (and the pause of an `online`
 * query while the browser reports no connection) waits for the `online` event instead of failing.
 * Subpath `@shadow-js/query/offline`. Without it a query runs and fails like `fetch` when offline,
 * and a `networkMode` other than `online` throws a `TypeError` that names this feature.
 * @packageDocumentation
 */
import type { QueryFeatureHost } from "./internal/features";
import type { QueryFeature } from "./types";

/**
 * The `offline` feature: install it in `createQueryClient({ features: [offline] })`.
 *
 * @example
 * ```ts
 * import { createQueryClient } from "@shadow-js/query";
 * import { offline } from "@shadow-js/query/offline";
 *
 * const client = createQueryClient({ features: [offline] });
 * ```
 * @see {@link QueryFeature}
 * @since 1.0.0
 */
export const offline: QueryFeature<"offline"> = {
  name: "offline",
  plug(host: QueryFeatureHost): void {
    /** Flights waiting for the network, with the function that starts each one. */
    const paused = new Map<object, () => void>();
    let watching = false;
    const isOffline = (): boolean => typeof navigator !== "undefined" && navigator.onLine === false;
    /** Starts every paused flight. Each one is still current: a flight that ended left the map. */
    const resume = (): void => {
      unwatch();
      const waiting = [...paused.values()];
      paused.clear();
      for (const begin of waiting) begin();
    };
    const watch = (): void => {
      if (watching || typeof window === "undefined") return;
      watching = true;
      window.addEventListener("online", resume);
    };
    function unwatch(): void {
      if (!watching) return;
      watching = false;
      if (typeof window !== "undefined") window.removeEventListener("online", resume);
    }
    host.ext.offline = {
      hold(entry, flight, begin, networkMode): boolean {
        if (networkMode !== "online" || !isOffline()) return false;
        // The request waits for the `online` event; nothing is counted as fetching meanwhile.
        host.setState(entry, { fetchStatus: "paused" });
        paused.set(flight, begin);
        watch();
        return true;
      },
      forget(flight): void {
        if (!paused.delete(flight) || paused.size > 0) return;
        unwatch();
      },
    };
  },
};
