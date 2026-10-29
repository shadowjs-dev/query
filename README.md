<p align="center"><img src="https://raw.githubusercontent.com/shadowjs-dev/query/main/.github/banner.png" alt="ShadowJS" width="100%"></p>

# @shadow-js/query

[![npm](https://img.shields.io/npm/v/@shadow-js/query.svg)](https://www.npmjs.com/package/@shadow-js/query)
[![CI](https://github.com/shadowjs-dev/query/actions/workflows/ci.yml/badge.svg)](https://github.com/shadowjs-dev/query/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](https://github.com/shadowjs-dev/query/blob/main/LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-blue.svg)](https://www.typescriptlang.org/)

Server state for ShadowJS 1.0.0: a bounded cache of server data keyed by plain-data arrays, with
`useQuery`, `useMutation`, `useInfiniteQuery`, `useQueries` and `useMutationState`. Components that ask for
the same key share one request. Data is refreshed on mount, focus, reconnect and an interval; writes can
update the screen at once and roll back. The cache can be kept in a storage between visits, writes made offline
wait in a queue and replay in order, and the server can send the cache to the browser, streamed as it fills. It is
built only on the public API of `@shadow-js/core`.

## Install

```bash
npm install @shadow-js/query
```

Requires `@shadow-js/core` (a peer dependency).

## Quick start

```ts title="src/client.ts" run
import { createQueryClient } from "@shadow-js/query";

export const client = createQueryClient({
  defaultOptions: { queries: { staleTime: 30_000 } },
});
```

```ts title="src/todos.ts" run
import { useQuery } from "@shadow-js/query";
import { client } from "./client";

// A stand-in backend: replace with fetch().
const loadTodos = (): Promise<string[]> => Promise.resolve(["read the docs"]);

export function useTodos() {
  return useQuery(["todos"], () => loadTodos(), { client });
}
```

```ts title="src/todos.test.ts" test
import { flush, renderHook } from "@shadow-js/testing";
import { describe, expect, it } from "vitest";
import { client } from "./client";
import { useTodos } from "./todos";

describe("useTodos", () => {
  it("fetches once and shares the data", async () => {
    const view = renderHook(() => useTodos());
    expect(view.result.current.status()).toBe("pending");
    await flush();
    expect(view.result.current.data()).toEqual(["read the docs"]);
    expect(client.queryCache.find({ key: ["todos"] })[0]?.observers).toBe(1);
    view.dispose();
  });
});
```

## API

### Client

- `createQueryClient(options?)`: a client with its own cache. `defaultOptions.queries` sets `staleTime`
  (default 0), `gcTime` (300 000 ms), `retry` (3), `retryDelay`, `refetchOnWindowFocus`, `refetchOnReconnect`,
  `refetchOnMount`, `structuralSharing` and `networkMode` (`online`: wait while offline, `always`: never wait; any
  other value needs the `offline` feature).
  `queryCache.maxQueries` (500) and `mutationCache.maxMutations` (100) bound the caches.
- `client.getCache(key)` / `client.setCache(key, value | updater, { updatedAt? })`: read and write data.
- `client.invalidate(filter?, { refetchType? })`: mark stale and refetch the mounted matches.
- `client.refetchQueries(filter?)`, `client.prefetch(key, fn, options?)` (never rejects),
  `client.fetchQuery(key, fn, options?)` (rejects), `client.cancel(filter?)`, `client.reset()`,
  `client.isFetching(filter?)`.
- `client.queryCache` and `client.mutationCache`: read-only views (`size`, `find`). `queryCache.find(filter?)`
  returns snapshots with `queryKey`, `queryHash`, `status`, `fetchStatus`, `data`, `error`, `dataUpdatedAt`,
  `isInvalidated` and `observers`; `queryCache.subscribe(listener)` reports every `added`, `updated` and `removed`
  change and returns the unsubscribe function (it needs the `inspection` feature).
- `client.dehydrate(options?)` and `client.hydrate(state)`: the state for the browser (they need the `hydration` feature).
- `client.resumePausedMutations()`: replays the mutations that wait in the offline queue now and resolves when it has
  drained (needs the `queue` feature). `mutationCache.find()` marks a waiting call `isPaused: true`.
- `QueryClientContext`, `useQueryClient()` and `runWithQueryClient(client, fn)`: provide a client without
  passing it to each hook.
- `exponentialBackoff({ base, max, jitter, random })`: a `retryDelay` function (doubling, capped, optional full
  jitter with an injectable random source).
- `hashKey(key)`: the hash of a key, the same one the loader cache uses.

### Hooks

- `useQuery(key, queryFn, options?)`: `data()`, `error()`, `status()`, `fetchStatus()`, `isFetching()`,
  `isStale()`, `isPending()`, `isSuccess()`, `isError()`, `isPlaceholderData()` and `refetch()`. Options:
  `enabled`, `staleTime`, `gcTime`, `retry`, `retryDelay`, `refetchOnWindowFocus`, `refetchOnReconnect`,
  `refetchOnMount`, `structuralSharing`, `refetchInterval`, `select`, `placeholderData`, `keepPreviousData`,
  `initialData`, `initialDataUpdatedAt`, `networkMode`, `suspense`, `throwOnError`, `client`.
- `useMutation(mutationFn, options?)`: `mutate`, `mutateAsync`, `data()`, `error()`, `status()`, `isPending()`,
  `variables()`, `reset()`. Options: `mutationKey`, `scope` (`{ id }`: calls with the same id run one at a time, in
  order; needs the `scope` feature), `retry` (default 0), `retryDelay`, `client`. Callbacks:
  `onMutate`, `onSuccess`, `onError`, `onSettled`. `networkMode` (`online`, `always`) decides whether a call made offline
  waits in the queue (needs the `queue` feature).
- `useMutationState({ mutationKey?, status?, client? })`: an accessor of the matching mutation records.
- `useInfiniteQuery(key, queryFn, options)`: the query result plus `fetchNextPage()`, `fetchPreviousPage()`,
  `hasNextPage()`, `hasPreviousPage()`, `isFetchingNextPage()` and `isFetchingPreviousPage()`. Options:
  `initialPageParam`, `getNextPageParam`, `getPreviousPageParam`, `maxPages`, and the `useQueries`
  definition options below.
- `useQueries(definitions)`: one result per definition, typed in order. A definition takes `key`, `queryFn`
  and the `useQuery` options that do not refer to the data type (no `select`, `placeholderData`,
  `keepPreviousData` or `initialData`).

### Optional features

`createQueryClient({ features: [...] })` takes the optional capabilities of a client. Each is a subpath, so a
client bundles only the ones it lists. A member that needs a feature the client lacks throws a `TypeError` that
names the feature and its import.

- `offline` (`@shadow-js/query/offline`): `networkMode` other than `online`, and the wait of a request while offline.
- `scope` (`@shadow-js/query/scope`): the `scope` option of `useMutation`.
- `inspection` (`@shadow-js/query/inspection`): `queryCache.subscribe`. `queryCache.find` needs nothing.
- `hydration` (`@shadow-js/query/hydration`): `client.dehydrate()` and `client.hydrate()`.
- `queue` (`@shadow-js/query/queue`): a retry waits for the connection, a mutation made offline waits in a queue that
  replays one call at a time in call order, and `client.resumePausedMutations()`.
- `persist` (`@shadow-js/query/persist`): `persist(options)` makes a feature that keeps the cache in a storage
  (see below).
- `full` (`@shadow-js/query/full`): every export of the package and the `offline`, `scope`, `inspection` and
  `hydration` features in one list (`features: full`). `queue` and `persist` are listed on their own.

### `@shadow-js/query/persist`

- `persist({ storage, key?, buster?, maxAge?, throttleMs?, shouldPersist?, maxEntryBytes?, maxBytes?, mutations?,
  broadcast?, onError? })`: a feature that writes the successful queries to `storage` (the three calls of
  `localStorage`, each may return a promise) and reads them back when the client is created. It returns the
  feature with `restored` (a promise that settles once the stored cache is in), `flush()`, `clear()` and `dispose()`.
- `buster` drops stored data of another version; `maxAge` (24 h) skips old entries; `throttleMs` (1 s) spaces writes,
  which also happen when the page is hidden or closed; `maxEntryBytes` (256 KiB) and `maxBytes` (2 MiB) bound the
  store, dropping the oldest entries first; `shouldPersist(query)` narrows what is kept. Errors, pending queries and
  mutations are never written by default.
- Storage problems (a full or failing storage, data JSON cannot hold, a corrupt or tampered store) go to
  `onError(error)` with `error.kind` of `restore`, `write`, `quota`, `serialize` or `size`; they never throw into your
  code. Where `BroadcastChannel` exists, tabs read each other's writes.
- `mutations: [{ mutationKey, mutationFn, ... }]` (with `queue` listed before `persist`) keeps calls that wait offline
  and replays them after a reload, at least once, in call order.

### `@shadow-js/query/server`

- `dehydrateScript(state, id?)`: the state as an escaped `<script type="application/json">` element.
- `hydrateFromDocument(client, id?)`: seeds the client from that element in the browser.
- `createDehydrationStream(client, options?)`: for a streamed response; `next()` renders the queries that finished
  since the last call as one script element, or an empty string.
- `hydrateFromStream(client, options?)`: reads those elements in the browser as the parser adds them; returns a
  function that stops watching.

## Limits

- Nothing is fetched on the server; prefetch in the request handler and dehydrate.
- Keys and dehydrated data are plain JSON data (see the contract).
- A query whose last observer leaves is aborted and its late answer is dropped.
- While the browser is offline a request waits (`fetchStatus` `"paused"`) and is sent on the `online` event, unless
  `networkMode` is `"always"`. A promise that waits settles when its request runs or is canceled. Both need the
  `offline` feature: without it a query runs and fails like `fetch`.
- The `queue` feature holds retries and mutations while offline. The queue replays one call at a time; a call that
  never settles holds it. It is in memory unless `persist` stores it, where delivery is at least once (use an
  idempotency key) and a replayed call does not run `onMutate`.
- `persist` stores JSON only (a `Date`, `Map` or class instance is skipped and reported) in a storage with a limit; it
  does not encrypt, so filter private data with `shouldPersist`. A failed write is retried at the next change.
- A time stamped ahead of this clock in a hydrated or restored entry counts as now.
- `setCache` with `undefined` writes nothing, so a rollback cannot return to "no data"; start optimistic updates
  from the data you hold.
- Failed fetches retry with backoff, then report their error.

## Production error codes

A production build keeps a short code instead of the development explanation, so message text never reaches user bundles. Search this table for the code. In the explanation, `…` stands for a value the development message names. A code followed by a word names the option at fault.

| Code | Development explanation |
| --- | --- |
| `QUERY_LIMIT` | createQueryClient: … must be a positive integer, got …. |

## Links

- [ShadowJS documentation](https://shadowjs.net): guides and the API reference.

## Dependencies

- Runtime: none.
- Peers: `@shadow-js/core` `^1.0.0`: reactive state for the query hooks.

## Types

- Names from the root: `QueryKey`, `QueryDefinition`, `QueryResults`, `QueryClientContext`, `useQuery`, `useQueries`, `useInfiniteQuery`.
- Type tests in `test-types/` are compile-time checks; `npm run typecheck:types` runs them.

## Support

- Node.js `>=22.12.0`. ESM only: use `import`; `require` is not supported.
- Browsers: current evergreen releases.
- Versioning: every `@shadow-js/*` package releases together at one version. Upgrade them as one set.
- Documentation: [ShadowJS documentation](https://shadowjs.net).

## Using, changing and contributing

- **Use the package** (a person or a coding agent that builds with it): this README, and [SKILL.md](SKILL.md), the short page an agent reads first.
- **Change the package** (fix a bug, add a feature): [AGENTS.md](AGENTS.md) says how the repository is laid out, how to implement and test a change, and how a pull request is reviewed. It is written for people and coding agents alike.
- **Take part**: [CONTRIBUTING.md](CONTRIBUTING.md) is the short guide; [SECURITY.md](SECURITY.md) is for vulnerabilities.
