import { createCore } from "./internal/core";
import { registerCore } from "./internal/registry";
import type { QueryClient, QueryClientOptions } from "./types";

/**
 * Creates a query client: a bounded keyed cache of server data plus the operations on it. Create
 * one per app in the browser, and one per request on the server, so data never leaks between users.
 * Nothing is fetched until a hook or a client method asks for a key.
 *
 * @param options Defaults of queries and mutations, and the bounds and callbacks of the query and
 * mutation caches (see {@link QueryClientOptions}). Undefined or `{}` uses every default: data is
 * stale at once, kept 5 minutes unobserved, fetches retry 3 times, mutations never.
 * @returns The client. Pass it to the hooks' `client` option or provide it with
 * {@link QueryClientContext}.
 * @throws RangeError when `queryCache.maxQueries` or `mutationCache.maxMutations` is not a positive
 * integer.
 * @example
 * import { createQueryClient } from "@shadow-js/query";
 *
 * const client = createQueryClient({
 *   defaultOptions: { queries: { staleTime: 30_000 } },
 *   queryCache: { onError: (error) => console.error("query failed", error) },
 * });
 * @see QueryClientContext
 * @since 1.0.0
 */
export function createQueryClient(options: QueryClientOptions = {}): QueryClient {
  const core = createCore(options);
  registerCore(core.api, core);
  return core.api;
}
