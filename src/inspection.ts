/**
 * The `inspection` feature: `queryCache.subscribe` tells a listener about every query that is
 * added, updated or removed, which devtools and logs use. Subpath `@shadow-js/query/inspection`.
 * Without it the cache's `find` still works, and `subscribe` throws a `TypeError` that names this
 * feature.
 * @packageDocumentation
 */
import { untrack } from "@shadow-js/core";
import type { QueryFeatureHost } from "./internal/features";
import type { QueryCacheEvent, QueryFeature } from "./types";

/**
 * The `inspection` feature: install it in `createQueryClient({ features: [inspection] })`.
 *
 * @example
 * ```ts
 * import { createQueryClient } from "@shadow-js/query";
 * import { inspection } from "@shadow-js/query/inspection";
 *
 * const client = createQueryClient({ features: [inspection] });
 * const stop = client.queryCache.subscribe((event) => console.log(event.type));
 * ```
 * @see {@link QueryFeature}
 * @since 1.0.0
 */
export const inspection: QueryFeature<"inspection"> = {
  name: "inspection",
  plug(host: QueryFeatureHost): void {
    const listeners = new Set<(event: QueryCacheEvent) => void>();
    host.ext.inspection = {
      subscribe(listener): () => void {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    // Runs after the watchers installed before it (a feature that follows the cache, such as persist).
    const previous = host.ext.watch;
    host.ext.watch = (type, entry) => {
      previous?.(type, entry);
      if (listeners.size === 0) return;
      const event: QueryCacheEvent = { type, query: host.info(entry) };
      for (const listener of [...listeners]) {
        try {
          untrack(() => listener(event));
        } catch (listenerError) {
          host.reportCallbackError(listenerError);
        }
      }
    };
  },
};
