import { type Context, createContext, useContext } from "@shadow-js/core";
import { runWithContext } from "@shadow-js/core/extend";
import type { QueryClient } from "./types";

/**
 * The context that provides a client to the hooks whose options name none. Render
 * `QueryClientContext.Provider` (or call {@link runWithQueryClient}) around the app; on the server,
 * give every request its own client so data never leaks between users. Its default is `null`: no
 * client.
 * @example
 * import { createQueryClient, QueryClientContext } from "@shadow-js/query";
 *
 * const client = createQueryClient();
 *
 * function TodoList() {
 *   return <p>The query hooks in here use the provided client.</p>;
 * }
 *
 * const app = <QueryClientContext.Provider value={client}><TodoList /></QueryClientContext.Provider>;
 * @see useQueryClient
 * @see runWithQueryClient
 * @since 1.0.0
 */
export const QueryClientContext: Context<QueryClient | null> = createContext<QueryClient | null>(
  null,
  { name: "QueryClient" },
);

/**
 * Returns the client provided by the nearest `QueryClientContext.Provider` (or
 * {@link runWithQueryClient}), for a component that calls client methods such as `invalidate`. Call
 * it while the component runs, not in an event handler.
 *
 * @returns The provided client.
 * @throws Error ("no QueryClient") when no client is provided above the current owner.
 * @example
 * import { useQueryClient } from "@shadow-js/query";
 *
 * function RefreshButton() {
 *   const client = useQueryClient();
 *   return <button onClick={() => void client.invalidate({ key: ["todos"] })}>Refresh</button>;
 * }
 * @see QueryClientContext
 * @since 1.0.0
 */
export function useQueryClient(): QueryClient {
  const client = useContext(QueryClientContext);
  if (client === null) {
    throw new Error(
      "@shadow-js/query: no QueryClient. Pass { client } to the hook or render QueryClientContext.Provider above it.",
    );
  }
  return client;
}

/**
 * Runs `fn` with `client` provided, as `QueryClientContext.Provider` does, for code that builds a
 * subtree without JSX (a test, a custom renderer). `fn` runs once, synchronously and untracked, in a
 * new child owner of the current owner; the hooks it calls use `client`.
 *
 * @param client The client to provide.
 * @param fn Runs once, synchronously.
 * @returns What `fn` returns.
 * @example
 * import { createRoot } from "@shadow-js/core";
 * import { createQueryClient, runWithQueryClient, useQuery } from "@shadow-js/query";
 *
 * const client = createQueryClient();
 * const todos = createRoot(() =>
 *   runWithQueryClient(client, () => useQuery(["todos"], () => ["read the docs"])),
 * );
 * @see QueryClientContext
 * @since 1.0.0
 */
export function runWithQueryClient<R>(client: QueryClient, fn: () => R): R {
  return runWithContext(QueryClientContext, client, fn);
}
