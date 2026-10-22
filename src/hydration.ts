/**
 * The `hydration` feature: `dehydrate` and `hydrate`, which carry the successful queries of the server
 * to the browser as plain JSON (`dehydrateScript` and `hydrateFromDocument` in `@shadow-js/query/server`
 * use them). Subpath `@shadow-js/query/hydration`. Without it those two methods throw a `TypeError` that
 * names this feature, and the parsing code is not bundled.
 * @packageDocumentation
 */

import type { QueryFeatureHost } from "./internal/features";
import { hashKey } from "./key";
import { jsonProblem } from "./serial";
import type {
  DehydratedQuery,
  DehydratedState,
  DehydrateOptions,
  QueryFeature,
  QueryInfo,
} from "./types";

/** Validates the input of `hydrate` and recomputes every hash, so a tampered hash is refused. */
function parseDehydrated(input: unknown): DehydratedState {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("hydrate: expected a dehydrated state object");
  }
  const record = input as Record<string, unknown>;
  if (record["version"] !== 1) throw new TypeError("hydrate: unsupported state version");
  const list = record["queries"];
  if (!Array.isArray(list)) throw new TypeError("hydrate: queries must be an array");
  const queries: DehydratedQuery[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null)
      throw new TypeError("hydrate: a query is not an object");
    const entry = item as Record<string, unknown>;
    const key = entry["key"];
    if (!Array.isArray(key)) throw new TypeError("hydrate: a query key is not an array");
    const hash = hashKey(key);
    if (entry["hash"] !== hash) throw new TypeError("hydrate: a query hash does not match its key");
    const updatedAt = entry["updatedAt"];
    if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt < 0) {
      throw new TypeError("hydrate: updatedAt must be a non-negative number");
    }
    const data = entry["data"];
    const problem = jsonProblem(data);
    if (problem !== undefined) throw new TypeError(`hydrate: data holds ${problem}`);
    queries.push({ key, hash, data, updatedAt });
  }
  return { version: 1, queries };
}

/**
 * The `hydration` feature: install it in `createQueryClient({ features: [hydration] })`.
 *
 * @example
 * ```ts
 * import { createQueryClient } from "@shadow-js/query";
 * import { hydration } from "@shadow-js/query/hydration";
 *
 * const server = createQueryClient({ features: [hydration] });
 * const state = server.dehydrate(); // plain JSON, ready for dehydrateScript
 * ```
 * @see {@link QueryFeature}
 * @since 1.0.0
 */
export const hydration: QueryFeature<"hydration"> = {
  name: "hydration",
  plug(host: QueryFeatureHost): void {
    host.ext.hydration = {
      dehydrate(options: DehydrateOptions | undefined): DehydratedState {
        const should =
          options?.shouldDehydrate ??
          ((info: QueryInfo): boolean => info.status === "success" && info.data !== undefined);
        const out: DehydratedQuery[] = [];
        for (const entry of host.entries()) {
          const info = host.info(entry);
          if (info.data === undefined || !should(info)) continue;
          const problem = jsonProblem(entry.key) ?? jsonProblem(info.data);
          if (problem !== undefined) {
            throw new TypeError(
              `dehydrate: query ${entry.hash} holds ${problem}; send plain JSON data`,
            );
          }
          out.push({
            key: entry.key,
            hash: entry.hash,
            data: info.data,
            updatedAt: info.dataUpdatedAt,
          });
        }
        return { version: 1, queries: out };
      },
      hydrate(input: unknown): void {
        const parsed = parseDehydrated(input);
        for (const item of parsed.queries) {
          const entry = host.ensure(item.key, item.hash);
          const current = host.state(entry);
          if (current.status === "success" && current.updatedAt >= item.updatedAt) continue;
          // A time ahead of this clock (the server's ran fast) counts as now: the data must not stay fresh for ever.
          host.writeData(entry, item.data, Math.min(item.updatedAt, Date.now()));
        }
      },
    };
  },
};
