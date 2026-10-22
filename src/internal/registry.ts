import type { QueryClient } from "../types";
import type { Core } from "./core";

/**
 * Maps the public client to its engine. A WeakMap, so a client that is no longer used is collected.
 * @internal
 */
const engines = new WeakMap<QueryClient, Core>();

/** @internal */
export function registerCore(client: QueryClient, core: Core): void {
  engines.set(client, core);
}

/**
 * The engine of a client made by `createQueryClient`.
 * @throws TypeError for an object that is not such a client.
 * @internal
 */
export function coreOf(client: QueryClient): Core {
  const core = engines.get(client);
  if (core === undefined) {
    throw new TypeError(
      "@shadow-js/query: the object is not a QueryClient from createQueryClient()",
    );
  }
  return core;
}
