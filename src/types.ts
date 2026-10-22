import type { Accessor } from "@shadow-js/core";
import type { QueryFeatureHost } from "./internal/features";
import type { QueryKey } from "./key";

/**
 * Public types of `@shadow-js/query`. Every type a caller names is declared here.
 * @packageDocumentation
 * @since 1.0.0
 */

/**
 * Where a query is in its lifecycle: `pending` until the first fetch (or write) settles, then
 * `success` or `error`. An error keeps the data of the last success.
 * @since 1.0.0
 */
export type QueryStatus = "pending" | "success" | "error";

/**
 * Whether a fetch is running for a query: `fetching` while one runs, `paused` while one waits for
 * the network (see {@link NetworkMode}), else `idle`. It is independent of {@link QueryStatus}: a
 * successful query that refetches is `success` and `fetching`.
 * @since 1.0.0
 */
export type FetchStatus = "idle" | "fetching" | "paused";

/**
 * When a query may send its request. `online` (the default) waits while the browser reports no
 * connection (`navigator.onLine` is false) and sends the request when the `online` event fires; the
 * query shows `fetchStatus` `paused` meanwhile. `always` sends the request whatever the browser
 * reports (the request fails if the network is really down).
 * @since 1.0.0
 */
export type NetworkMode = "online" | "always";

/**
 * How many times, or on which failures, a failed fetch or mutation is retried. A number is the
 * count of retries after the first attempt (`3` means at most four attempts); `true` retries until
 * the call succeeds or is canceled; `false` never retries. A function receives the failure count
 * (1 after the first failure) and the error, and returns whether to retry.
 * @since 1.0.0
 */
export type RetryOption = boolean | number | ((failureCount: number, error: unknown) => boolean);

/**
 * Delay in milliseconds before a retry: a fixed number, or a function of the failure count (1 after
 * the first failure) and the error. A canceled fetch stops waiting at once.
 * @since 1.0.0
 */
export type RetryDelayOption = number | ((failureCount: number, error: unknown) => number);

/**
 * The key a hook takes: a key, or an accessor returning one. The accessor is tracked, so the hook
 * follows the key as it changes. `false`, `null` or `undefined` from the accessor disables the query
 * until it returns a key.
 * @since 1.0.0
 */
export type QueryKeyInput = QueryKey | Accessor<QueryKey | false | null | undefined>;

/**
 * What a query function receives.
 * @since 1.0.0
 */
export interface QueryFunctionContext {
  /** The key of the query being fetched. */
  readonly queryKey: QueryKey;
  /**
   * Aborted when the fetch is superseded, canceled, or no observer needs it any more. Pass it to
   * `fetch` so the request stops too; a result that arrives after the abort is discarded.
   */
  readonly signal: AbortSignal;
}

/**
 * A query function: fetches the data for `context.queryKey`. It runs untracked. A rejection (or a
 * throw) is a failed fetch, retried as {@link RetryOption} says.
 * @since 1.0.0
 */
export type QueryFunction<T> = (context: QueryFunctionContext) => T | PromiseLike<T>;

/**
 * Defaults every query of a client inherits unless the hook or call sets its own option.
 * @since 1.0.0
 */
export interface QueryDefaults {
  /**
   * Milliseconds a fetched value counts as fresh; a fresh query is not fetched again on mount,
   * focus or reconnect. `0` makes data stale at once; `Infinity` keeps it fresh until invalidated.
   * @default 0
   */
  readonly staleTime?: number | undefined;
  /**
   * Milliseconds an entry with no observer is kept before it is removed from the cache. `Infinity`
   * keeps it until `maxQueries` evicts it or `reset()` runs.
   * @default 300000 (five minutes)
   */
  readonly gcTime?: number | undefined;
  /**
   * Retries of a failed fetch (see {@link RetryOption}).
   * @default 3
   */
  readonly retry?: RetryOption | undefined;
  /**
   * Delay before each retry (see {@link RetryDelayOption}).
   * @default 1000 ms after the first failure, doubling each time, capped at 30000 ms
   */
  readonly retryDelay?: RetryDelayOption | undefined;
  /**
   * Refetch the stale queries that have an enabled observer when the window regains focus (the
   * `focus` event, or the document becoming visible).
   * @default true
   */
  readonly refetchOnWindowFocus?: boolean | undefined;
  /**
   * Refetch the stale queries that have an enabled observer when the browser comes back online
   * (the `online` event).
   * @default true
   */
  readonly refetchOnReconnect?: boolean | undefined;
  /**
   * When a fetch may be sent: `online` waits while the browser is offline (see {@link NetworkMode}).
   * @default "online"
   */
  readonly networkMode?: NetworkMode | undefined;
  /**
   * Refetch a stale query when a component mounts on it. With `false`, a query that already holds
   * data is not fetched on mount; one without data still is.
   * @default true
   */
  readonly refetchOnMount?: boolean | undefined;
  /**
   * Keep the references of the parts of fetched data that did not change, so memos and `Object.is`
   * checks see no change. Applies to plain objects and arrays.
   * @default true
   */
  readonly structuralSharing?: boolean | undefined;
}

/**
 * Defaults every mutation of a client inherits. Retries of a mutation are off unless set: a write
 * is not repeated silently.
 * @since 1.0.0
 */
export interface MutationDefaults {
  /**
   * Retries of a failed mutation (see {@link RetryOption}).
   * @default 0
   */
  readonly retry?: RetryOption | undefined;
  /**
   * Delay before each retry (see {@link RetryDelayOption}).
   * @default 1000 ms after the first failure, doubling each time, capped at 30000 ms
   */
  readonly retryDelay?: RetryDelayOption | undefined;
}

/**
 * The `defaultOptions` of {@link QueryClientOptions}: the defaults of queries and of mutations.
 * @since 1.0.0
 */
export interface DefaultOptions {
  /**
   * Defaults of every query of the client.
   * @default {} (each option takes the default documented on {@link QueryDefaults})
   */
  readonly queries?: QueryDefaults | undefined;
  /**
   * Defaults of every mutation of the client.
   * @default {} (each option takes the default documented on {@link MutationDefaults})
   */
  readonly mutations?: MutationDefaults | undefined;
}

/**
 * A read-only snapshot of one query, as passed to filters, cache callbacks and `shouldDehydrate`,
 * and returned by `queryCache.find`. It does not change after it is taken.
 * @since 1.0.0
 */
export interface QueryInfo {
  /** The key of the query. */
  readonly queryKey: QueryKey;
  /** The hash of the key (see {@link hashKey}), which identifies the cache entry. */
  readonly queryHash: string;
  /** Where the query is in its lifecycle. */
  readonly status: QueryStatus;
  /** Whether a fetch is running. */
  readonly fetchStatus: FetchStatus;
  /** The stored data, or `undefined` while there is none. An error keeps the previous data. */
  readonly data: unknown;
  /** The error of the last failed fetch, or `undefined` after a success or a write. */
  readonly error: unknown;
  /**
   * Time (ms since epoch) of the last successful fetch or write, the age that `staleTime` measures;
   * `0` while there was none.
   */
  readonly dataUpdatedAt: number;
  /** True after `invalidate` until the next successful fetch or write. */
  readonly isInvalidated: boolean;
  /** Mounted observers, and pins held by prefetches that have not settled. */
  readonly observers: number;
}

/**
 * The `queryCache` options of {@link QueryClientOptions}: the bound of the cache and callbacks that
 * see every fetch.
 * @since 1.0.0
 */
export interface QueryCacheOptions {
  /**
   * Most unobserved entries kept. When a new entry would exceed it, the least recently used
   * unobserved entries are removed first. Mounted queries and running fetches are never removed.
   * Must be a positive integer.
   * @default 500
   */
  readonly maxQueries?: number | undefined;
  /**
   * Called, untracked, with each fetch that failed for good (after its retries); a canceled fetch
   * is not reported. A throw is rethrown on a microtask and does not change the query.
   * @default undefined (no callback)
   */
  readonly onError?: (error: unknown, query: QueryInfo) => void | undefined;
  /**
   * Called, untracked, with the value of each successful fetch. A throw is rethrown on a microtask
   * and does not change the query.
   * @default undefined (no callback)
   */
  readonly onSuccess?: (data: unknown, query: QueryInfo) => void | undefined;
}

/**
 * A read-only snapshot of one mutation call, as listed by `mutationCache.find` and
 * {@link useMutationState}.
 * @since 1.0.0
 */
export interface MutationInfo {
  /** The `mutationKey` of the mutation, or `undefined` when it has none. */
  readonly mutationKey: QueryKey | undefined;
  /** `pending` while the call runs, then `success` or `error` (a record is never `idle`). */
  readonly status: MutationStatus;
  /** The variables the call was made with. */
  readonly variables: unknown;
  /** The data of a successful call, else `undefined`. */
  readonly data: unknown;
  /** The error of a failed call, else `undefined`. */
  readonly error: unknown;
  /** Time (ms since epoch) the call was made. */
  readonly submittedAt: number;
  /**
   * True while the call waits in the offline queue (the `queue` feature): it has not run yet, and runs
   * when the connection returns or `resumePausedMutations()` is called. Always false without that feature.
   */
  readonly isPaused: boolean;
}

/**
 * Where a mutation is in its lifecycle: `idle` before the first call (and after `reset`), then
 * `pending`, then `success` or `error`.
 * @since 1.0.0
 */
export type MutationStatus = "idle" | "pending" | "success" | "error";

/**
 * The `mutationCache` options of {@link QueryClientOptions}: the bound of the mutation records and
 * callbacks that see every mutation.
 * @since 1.0.0
 */
export interface MutationCacheOptions {
  /**
   * Most mutation records kept; the oldest settled ones are dropped first, a pending one never.
   * Must be a positive integer.
   * @default 100
   */
  readonly maxMutations?: number | undefined;
  /**
   * Called, untracked, with each mutation that failed for good (after its retries), after the
   * mutation's own callbacks. A throw is rethrown on a microtask.
   * @default undefined (no callback)
   */
  readonly onError?: (error: unknown, mutation: MutationInfo) => void | undefined;
  /**
   * Called, untracked, with each successful mutation, after the mutation's own callbacks. A throw
   * is rethrown on a microtask.
   * @default undefined (no callback)
   */
  readonly onSuccess?: (data: unknown, mutation: MutationInfo) => void | undefined;
}

/**
 * Options of {@link createQueryClient}: the defaults of queries and mutations, and the bounds and
 * callbacks of the two caches.
 * @since 1.0.0
 */
export interface QueryClientOptions {
  /**
   * Defaults of every query and mutation of the client.
   * @default {} (see {@link QueryDefaults} and {@link MutationDefaults})
   */
  readonly defaultOptions?: DefaultOptions | undefined;
  /**
   * Bound and callbacks of the query cache.
   * @default {} (see {@link QueryCacheOptions})
   */
  readonly queryCache?: QueryCacheOptions | undefined;
  /**
   * Bound and callbacks of the mutation cache.
   * @default {} (see {@link MutationCacheOptions})
   */
  readonly mutationCache?: MutationCacheOptions | undefined;
  /**
   * The optional features of the client (see {@link QueryFeature}): `offline` (a `networkMode` other
   * than `online`, pause and resume, and a queue of mutations made offline), `scope` (the `scope` option
   * of `useMutation`), `inspection` (`queryCache.subscribe`), `hydration` (`dehydrate` and `hydrate`),
   * `queue` (retries and mutations wait for the connection; mutations made offline replay in order) and
   * `persist` (the cache kept in a storage; made by `persist()` from `@shadow-js/query/persist`). Each is a
   * subpath; a member that needs a feature the client lacks throws a `TypeError` that names it. The list
   * of `offline`, `scope`, `inspection` and `hydration` is `full` (`@shadow-js/query/full`).
   * @default undefined (no optional feature)
   */
  readonly features?: readonly QueryFeature[] | undefined;
}

/**
 * The optional features of a query client: the names the package knows.
 * @since 1.0.0
 */
export type QueryFeatureName =
  | "offline"
  | "scope"
  | "inspection"
  | "hydration"
  | "queue"
  | "persist";

/**
 * An optional capability of a client, passed in `createQueryClient({ features })`. Each feature is a
 * plain object exported by its own subpath (`persist(...)` makes one from your options), so a client that
 * does not list it does not bundle it: `offline` (`@shadow-js/query/offline`), `scope`
 * (`@shadow-js/query/scope`), `inspection` (`@shadow-js/query/inspection`), `hydration`
 * (`@shadow-js/query/hydration`), `queue` (`@shadow-js/query/queue`) and `persist`
 * (`@shadow-js/query/persist`).
 * @since 1.0.0
 */
export interface QueryFeature<N extends QueryFeatureName = QueryFeatureName> {
  /** The feature's name; a client holds at most one feature of each name. */
  readonly name: N;
  /** Internal: what the feature plugs into the engine. Not part of the public contract. */
  readonly plug: (host: QueryFeatureHost) => void;
}

/**
 * Selects queries for `invalidate`, `cancel`, `refetchQueries`, `isFetching` and
 * `queryCache.find`. A query must pass every condition that is set; an empty filter selects all.
 * @since 1.0.0
 */
export interface QueryFilter {
  /**
   * A key (plain data, like any key). With `exact` false it matches every query whose key starts
   * with it, element by element: `["todos"]` matches `["todos", 1]`.
   * @default undefined (every key matches)
   */
  readonly key?: QueryKey | undefined;
  /**
   * Match `key` exactly instead of as a prefix.
   * @default false
   */
  readonly exact?: boolean | undefined;
  /**
   * `active`: queries with at least one observer (mounted, or pinned by a running prefetch);
   * `inactive`: queries with none; `all`: both.
   * @default "all"
   */
  readonly type?: "all" | "active" | "inactive" | undefined;
  /**
   * An extra test on a {@link QueryInfo} snapshot; a query must pass it too.
   * @default undefined (no extra test)
   */
  readonly predicate?: (query: QueryInfo) => boolean | undefined;
}

/**
 * A read-only view of the query cache of a client, for devtools and tests.
 * @since 1.0.0
 */
export interface QueryCacheView {
  /** Number of entries held, observed or not. Untracked. */
  readonly size: number;
  /**
   * The queries matching `filter`, as snapshots, least recently used first. Untracked.
   * @param filter Which queries. By default (undefined), every query.
   * @returns One {@link QueryInfo} per matching entry.
   */
  find(filter?: QueryFilter): readonly QueryInfo[];
  /**
   * Calls `listener` for every change of the cache: an entry added, its state changed (a fetch
   * starts or ends, data is written, it is invalidated) or an entry removed (by `gcTime`, the bound,
   * or `reset`). Listeners run untracked and in subscription order; a throw is rethrown on a
   * microtask and does not change the cache or stop the other listeners.
   * @param listener Called with a {@link QueryCacheEvent}. Subscribing the same function again has no
   * further effect.
   * @returns A function that unsubscribes the listener. Calling it twice is harmless.
   * @example
   * const stop = client.queryCache.subscribe((event) => {
   *   console.log(event.type, event.query.queryHash, event.query.fetchStatus);
   * });
   * // later
   * stop();
   * @since 1.0.0
   */
  subscribe(listener: (event: QueryCacheEvent) => void): () => void;
}

/**
 * One change seen by {@link QueryCacheView.subscribe}: what happened and the query after the change
 * (for `removed`, the query as it was when it was removed).
 * @since 1.0.0
 */
export interface QueryCacheEvent {
  /** `added`: a new entry; `updated`: its state changed; `removed`: it left the cache. */
  readonly type: "added" | "updated" | "removed";
  /** The query as it is after the change. */
  readonly query: QueryInfo;
}

/**
 * A read-only view of the mutation cache of a client, for devtools and tests.
 * @since 1.0.0
 */
export interface MutationCacheView {
  /**
   * Number of mutation records held: at most `maxMutations`, unless more calls than that are
   * pending. Untracked.
   */
  readonly size: number;
  /**
   * The mutation records, oldest first. Untracked; use {@link useMutationState} to follow them.
   * @returns One {@link MutationInfo} per record.
   */
  find(): readonly MutationInfo[];
}

/**
 * Options of {@link QueryClient.prefetch} and {@link QueryClient.fetchQuery}.
 * @since 1.0.0
 */
export interface PrefetchOptions {
  /**
   * Skip the fetch while the cached value is younger than this many milliseconds.
   * @default the staleTime of the entry: the client default, or the one of the hook last mounted on it
   */
  readonly staleTime?: number | undefined;
  /**
   * Retries of a failed fetch (see {@link RetryOption}).
   * @default the retry of the entry: the client default, or the one of the hook last mounted on it
   */
  readonly retry?: RetryOption | undefined;
  /**
   * Delay before each retry (see {@link RetryDelayOption}).
   * @default the retryDelay of the entry: the client default, or the one of the hook last mounted on it
   */
  readonly retryDelay?: RetryDelayOption | undefined;
}

/**
 * The serializable state a server sends to the browser (see {@link QueryClient.dehydrate}). It is
 * plain JSON data, so `JSON.stringify` and `JSON.parse` keep it unchanged.
 * @since 1.0.0
 */
export interface DehydratedState {
  /** The format version. Always `1`; `hydrate` refuses any other value. */
  readonly version: 1;
  /** The queries sent, in cache order. */
  readonly queries: readonly DehydratedQuery[];
}

/**
 * One query of a {@link DehydratedState}.
 * @since 1.0.0
 */
export interface DehydratedQuery {
  /** The query key (plain JSON data). */
  readonly key: QueryKey;
  /** The hash of `key`. `hydrate` recomputes it and refuses a query whose hash does not match. */
  readonly hash: string;
  /** The data of the query (plain JSON data). */
  readonly data: unknown;
  /** Time (ms since epoch) the data was fetched; a finite number, `0` or more. */
  readonly updatedAt: number;
}

/**
 * Options of {@link QueryClient.dehydrate}.
 * @since 1.0.0
 */
export interface DehydrateOptions {
  /**
   * Which queries to send. A query without data is never sent, whatever this returns.
   * @default the successful queries that hold data
   */
  readonly shouldDehydrate?: (query: QueryInfo) => boolean | undefined;
}

/**
 * The shared cache and its operations. Create one with {@link createQueryClient}: a server render
 * needs one per request so that data never leaks between users. Pass it to the hooks, or provide
 * it with {@link QueryClientContext}.
 *
 * In development, calling `setCache`, `invalidate`, `refetchQueries`, `prefetch`, `fetchQuery`,
 * `cancel` or `reset` while a memo computes warns once (`[shadow-query] ... was called while a memo
 * computes`): call them from an event handler or an effect.
 * @since 1.0.0
 */
export interface QueryClient {
  /** The query cache (read-only view). */
  readonly queryCache: QueryCacheView;
  /** The mutation cache (read-only view). */
  readonly mutationCache: MutationCacheView;
  /**
   * Reads the data of a query, untracked. Never creates an entry.
   * @param key The query key.
   * @returns The data, or `undefined` when there is none.
   * @throws TypeError when `key` holds a value that is not plain data (see {@link hashKey}).
   */
  getCache<T = unknown>(key: QueryKey): T | undefined;
  /**
   * Writes data for a key, creating the entry if needed. The write marks the entry successful,
   * fresh and not invalidated, and clears its error. Structural sharing applies.
   * @param key The query key.
   * @param updater The data, or a function that receives the previous data (`undefined` when there
   * is none) and returns the new data. Returning `undefined` from it writes nothing.
   * @param options `updatedAt`: when the data was fetched (ms since epoch). Undefined means now.
   * @returns The stored data, or `undefined` when nothing was written.
   * @throws TypeError when `key` holds a value that is not plain data (see {@link hashKey}).
   */
  setCache<T>(
    key: QueryKey,
    updater: T | ((previous: T | undefined) => T | undefined),
    options?: { readonly updatedAt?: number },
  ): T | undefined;
  /**
   * Marks the matching queries stale and refetches the ones selected by `refetchType`, canceling
   * a fetch they already run. Only queries whose query function is known are refetched.
   * @param filter Which queries. By default (undefined), every query.
   * @param options `refetchType`: `active` (default: queries with an enabled mounted observer),
   * `inactive` (the others), `all`, or `none` (mark stale only).
   * @returns A promise that resolves when those refetches settle; it never rejects.
   */
  invalidate(
    filter?: QueryFilter,
    options?: { readonly refetchType?: "active" | "inactive" | "all" | "none" },
  ): Promise<void>;
  /**
   * Refetches the matching queries whose query function is known, fresh or not, enabled or not. A
   * fetch already running is canceled and started again.
   * @param filter Which queries. By default (undefined), every query.
   * @returns A promise that resolves when the refetches settle; it never rejects.
   */
  refetchQueries(filter?: QueryFilter): Promise<void>;
  /**
   * Fetches a key into the cache unless the cached value is fresh, for example on the server before
   * a render. A fetch already running for the key is shared. The entry is kept while the fetch runs.
   * @param key The query key.
   * @param queryFn The fetch.
   * @param options Freshness and retries for this call. By default (undefined), the entry's own.
   * @returns A promise that resolves when the fetch settles. It never rejects: a failure is
   * recorded on the entry.
   * @throws TypeError, synchronously, when `key` holds a value that is not plain data.
   */
  prefetch<T>(key: QueryKey, queryFn: QueryFunction<T>, options?: PrefetchOptions): Promise<void>;
  /**
   * Like {@link QueryClient.prefetch}, but resolves with the data: the cached value when it is
   * fresh, else the fetched one.
   * @param key The query key.
   * @param queryFn The fetch.
   * @param options Freshness and retries for this call. By default (undefined), the entry's own.
   * @returns A promise of the data. It rejects with the fetch error (after retries), with an
   * `Error` named `AbortError` when the fetch is canceled, or with a `TypeError` when `key` is not
   * plain data.
   */
  fetchQuery<T>(key: QueryKey, queryFn: QueryFunction<T>, options?: PrefetchOptions): Promise<T>;
  /**
   * Aborts the running fetches of the matching queries. Their data and status are kept, and the
   * aborted results are never written.
   * @param filter Which queries. By default (undefined), every query.
   */
  cancel(filter?: QueryFilter): void;
  /**
   * Returns every query to its initial state: running fetches are aborted, unobserved entries are
   * removed, and mounted ones show `pending` and refetch when an enabled observer holds them.
   */
  reset(): void;
  /**
   * Counts the fetches running for the matching queries. With no filter the read is tracked, so a
   * computation that reads it re-runs when the count changes; with a filter it is untracked.
   * @param filter Which queries. By default (undefined), every query.
   * @returns The number of running fetches.
   */
  isFetching(filter?: QueryFilter): number;
  /**
   * Returns the serializable state of the cache, for the browser. Write it into the page with
   * `dehydrateScript` from `@shadow-js/query/server`.
   * @param options Which queries to send. By default (undefined), the successful queries that
   * hold data.
   * @returns The state, plain JSON data.
   * @throws TypeError when a sent key or value is not plain JSON data (`undefined`, a non-finite
   * number, a class instance, a cycle...): it would arrive different from what was rendered.
   */
  dehydrate(options?: DehydrateOptions): DehydratedState;
  /**
   * Seeds the cache from a {@link DehydratedState}, for example one parsed from the page. An entry
   * that already holds successful data at least as recent is kept; the others are written with the
   * sent `updatedAt`.
   * @param state The state, usually from `JSON.parse`. It is validated, and every hash recomputed.
   * @throws TypeError when `state` is not a version 1 dehydrated state, a hash does not match its
   * key, an `updatedAt` is not a non-negative number, or data is not plain JSON data.
   */
  hydrate(state: unknown): void;
  /**
   * Replays the mutations that wait in the offline queue now, without waiting for the `online` event:
   * one at a time, in the order they were made (those restored from storage first). A failed call does
   * not stop the ones behind it. The connection state is not checked, so use it for a "retry now"
   * button; the queue otherwise drains by itself on the `online` event.
   * @returns A promise that resolves when the queue has drained. It never rejects: a failure is in
   * `mutationCache` and in the callbacks of the call.
   * @throws TypeError when the client was created without the `queue` feature.
   */
  resumePausedMutations(): Promise<void>;
}

/**
 * Options of {@link useQuery}. Every option is optional; the client defaults fill the rest.
 * @since 1.0.0
 */
export interface QueryOptions<T, U = T> {
  /**
   * The client to use.
   * @default the client of the nearest `QueryClientContext` provider (or {@link runWithQueryClient})
   */
  readonly client?: QueryClient | undefined;
  /**
   * Whether the hook may fetch (on mount, on key change, on focus, reconnect and polling). An
   * accessor is tracked: turning it on fetches when there is no data or it is stale. A disabled
   * query still shows cached data.
   * @default true
   */
  readonly enabled?: boolean | Accessor<boolean> | undefined;
  /**
   * Milliseconds a fetched value counts as fresh (see {@link QueryDefaults.staleTime}).
   * @default the client's `defaultOptions.queries.staleTime` (0)
   */
  readonly staleTime?: number | undefined;
  /**
   * Milliseconds an unobserved entry is kept (see {@link QueryDefaults.gcTime}).
   * @default the client's `defaultOptions.queries.gcTime` (300000)
   */
  readonly gcTime?: number | undefined;
  /**
   * Retries of a failed fetch (see {@link RetryOption}).
   * @default the client's `defaultOptions.queries.retry` (3)
   */
  readonly retry?: RetryOption | undefined;
  /**
   * Delay before each retry (see {@link RetryDelayOption}).
   * @default the client's `defaultOptions.queries.retryDelay` (1000 ms doubling, capped at 30000 ms)
   */
  readonly retryDelay?: RetryDelayOption | undefined;
  /**
   * Refetch when the window regains focus and the data is stale.
   * @default the client's `defaultOptions.queries.refetchOnWindowFocus` (true)
   */
  readonly refetchOnWindowFocus?: boolean | undefined;
  /**
   * Refetch when the browser comes back online and the data is stale.
   * @default the client's `defaultOptions.queries.refetchOnReconnect` (true)
   */
  readonly refetchOnReconnect?: boolean | undefined;
  /**
   * When a fetch may be sent (see {@link NetworkMode}).
   * @default the client's `defaultOptions.queries.networkMode` ("online")
   */
  readonly networkMode?: NetworkMode | undefined;
  /**
   * Refetch on mount when the data is stale.
   * @default the client's `defaultOptions.queries.refetchOnMount` (true)
   */
  readonly refetchOnMount?: boolean | undefined;
  /**
   * Keep the references of unchanged parts of fetched data.
   * @default the client's `defaultOptions.queries.structuralSharing` (true)
   */
  readonly structuralSharing?: boolean | undefined;
  /**
   * Poll: refetch every this many milliseconds while the hook is mounted and enabled, fresh or not.
   * An accessor is tracked. `false`, `0` or a negative number stops polling. Never polls on the
   * server.
   * @default undefined (no polling)
   */
  readonly refetchInterval?: number | false | Accessor<number | false> | undefined;
  /**
   * Derives the value `data()` returns from the data. It runs untracked, and again only when the
   * data reference changes.
   * @default undefined (`data()` returns the data itself)
   */
  readonly select?: (data: T) => U | undefined;
  /**
   * Shown while the query has no data: a value, or a function of the last data of the query this
   * hook showed (`undefined` at first), which runs untracked. It is never written to the cache;
   * `isPlaceholderData()` is true while it is shown.
   * @default undefined (no placeholder)
   */
  readonly placeholderData?: T | ((previous: T | undefined) => T | undefined);
  /**
   * While a new key loads, keep showing the data of the previous key (`isPlaceholderData()` is true
   * meanwhile).
   * @default false
   */
  readonly keepPreviousData?: boolean | undefined;
  /**
   * Data written to the entry when the hook attaches to an entry that is still pending with no
   * data, so the first read has a value; when it is fresh, no fetch is needed. A function is called
   * at that moment only. Not applied on the server, where the hook only reads the cache.
   * @default undefined (no initial data)
   */
  readonly initialData?: T | (() => T) | undefined;
  /**
   * When `initialData` was fetched (ms since epoch), which decides whether it is fresh.
   * @default the time it is written (it counts as just fetched)
   */
  readonly initialDataUpdatedAt?: number | undefined;
  /**
   * Inside a `<Suspense>` boundary, reading `data()` during a pending first load holds the boundary
   * in its fallback until the load settles. Ignored on the server.
   * @default false
   */
  readonly suspense?: boolean | undefined;
  /**
   * Reading `data()` while the query is in error throws the error, so the nearest error boundary
   * catches it.
   * @default false
   */
  readonly throwOnError?: boolean | undefined;
}

/**
 * What {@link useQuery} returns. Every member is an accessor (call it to read; the read is tracked)
 * except `refetch`.
 * @since 1.0.0
 */
export interface QueryResult<T, U = T> {
  /**
   * The data (after `select`), the placeholder or previous data while there is none, or
   * `undefined`. Throws the error with `throwOnError`; holds the Suspense boundary with `suspense`.
   */
  readonly data: Accessor<U | undefined>;
  /** The error of the last failed fetch, or `undefined`. */
  readonly error: Accessor<unknown>;
  /** Where the query is in its lifecycle; `pending` while the key accessor disables the query. */
  readonly status: Accessor<QueryStatus>;
  /** Whether a fetch is running for the query. */
  readonly fetchStatus: Accessor<FetchStatus>;
  /** `status() === "pending"`: no data and no error yet. */
  readonly isPending: Accessor<boolean>;
  /** `status() === "success"`. */
  readonly isSuccess: Accessor<boolean>;
  /** `status() === "error"`. The data of the last success, if any, is still in `data()`. */
  readonly isError: Accessor<boolean>;
  /** A fetch is running (`fetchStatus() === "fetching"`). */
  readonly isFetching: Accessor<boolean>;
  /**
   * The query has no successful data (or no key), its data is older than `staleTime`, or it was
   * invalidated.
   */
  readonly isStale: Accessor<boolean>;
  /** The data shown is `placeholderData` or `keepPreviousData`, not the query's own. */
  readonly isPlaceholderData: Accessor<boolean>;
  /**
   * Fetches again now, canceling a fetch in flight and keeping the data visible meanwhile.
   * Resolves with the fetched data (before `select`), or `undefined` on failure, on cancellation,
   * or while the query has no key. Never rejects.
   */
  readonly refetch: () => Promise<T | undefined>;
}

/**
 * Options of {@link useMutation}. Every option is optional; the client's mutation defaults fill
 * the retries.
 * @since 1.0.0
 */
export interface MutationOptions<TData, TVariables, TContext> {
  /**
   * The client to use.
   * @default the client of the nearest `QueryClientContext` provider (or {@link runWithQueryClient})
   */
  readonly client?: QueryClient | undefined;
  /**
   * Groups the calls of this mutation for {@link useMutationState}.
   * @default undefined (the records have no key and a key filter never matches them)
   */
  readonly mutationKey?: QueryKey | undefined;
  /**
   * Runs the calls of this mutation one at a time, in the order they were made, for every mutation
   * of the client that names the same `id`. A call starts (its `onMutate` included) only when the
   * call before it has settled, so an optimistic update and its rollback cannot interleave with
   * another call's. A failed call does not block the calls queued behind it. Calls with no scope,
   * or with another id, do not wait.
   * @default undefined (calls run concurrently)
   */
  readonly scope?: { readonly id: string } | undefined;
  /**
   * When a call may be sent. With the `queue` feature, `online` makes a call made while the browser is
   * offline wait in a queue (see {@link MutationInfo.isPaused}), replayed in call order when the connection
   * returns, and makes a retry wait for the connection; `always` sends at once. Setting this option needs
   * the `queue` feature; without the feature a call is never held.
   * @default "online"
   */
  readonly networkMode?: NetworkMode | undefined;
  /**
   * Retries of a failed call (see {@link RetryOption}).
   * @default the client's `defaultOptions.mutations.retry` (0)
   */
  readonly retry?: RetryOption | undefined;
  /**
   * Delay before each retry (see {@link RetryDelayOption}).
   * @default the client's `defaultOptions.mutations.retryDelay` (1000 ms doubling, capped at 30000 ms)
   */
  readonly retryDelay?: RetryDelayOption | undefined;
  /**
   * Runs, untracked and awaited, before the mutation function. Its result is the context passed to
   * the other callbacks, so an optimistic update returns what it must roll back to. A throw counts
   * as a failed call, and the mutation function does not run.
   * @default undefined (the context is `undefined`)
   */
  readonly onMutate?: (variables: TVariables) => TContext | PromiseLike<TContext> | undefined;
  /**
   * Runs, untracked, when the call succeeds. A throw counts as a failed call.
   * @default undefined (no callback)
   */
  readonly onSuccess?: (data: TData, variables: TVariables, context: TContext | undefined) => void;
  /**
   * Runs, untracked, when the call fails for good (after retries). Use it to roll back. A throw is
   * rethrown on a microtask.
   * @default undefined (no callback)
   */
  readonly onError?: (error: unknown, variables: TVariables, context: TContext | undefined) => void;
  /**
   * Runs, untracked, once the call has settled, after `onSuccess` or `onError`. `data` is
   * `undefined` on failure.
   * @default undefined (no callback)
   */
  readonly onSettled?: (
    data: TData | undefined,
    error: unknown,
    variables: TVariables,
    context: TContext | undefined,
  ) => void;
}

/**
 * What {@link useMutation} returns. The state members are tracked accessors of the latest call.
 * @since 1.0.0
 */
export interface MutationResult<TData, TVariables> {
  /** Starts a call; never rejects (the error is in `error()` and in `onError`). */
  readonly mutate: (variables: TVariables) => void;
  /** Starts a call and resolves with its data, or rejects with its error. */
  readonly mutateAsync: (variables: TVariables) => Promise<TData>;
  /** The data of the latest call once it succeeded, else `undefined`. */
  readonly data: Accessor<TData | undefined>;
  /** The error of the latest call once it failed, else `undefined`. */
  readonly error: Accessor<unknown>;
  /** Where the latest call is: `idle` before any call and after `reset()`. */
  readonly status: Accessor<MutationStatus>;
  /** `status() === "pending"`: the latest call is running. */
  readonly isPending: Accessor<boolean>;
  /** The variables of the latest call, or `undefined` before any call and after `reset()`. */
  readonly variables: Accessor<TVariables | undefined>;
  /**
   * Returns the state to `idle`. Calls in flight are not canceled: when the latest one settles, its
   * result is shown.
   */
  readonly reset: () => void;
}

/**
 * One entry of {@link useMutationState}: a snapshot of one mutation call.
 * @since 1.0.0
 */
export type MutationState = MutationInfo;

/**
 * Options of {@link useMutationState}. An empty object lists every mutation of the client.
 * @since 1.0.0
 */
export interface MutationStateOptions {
  /**
   * Only mutations whose `mutationKey` starts with this key (prefix match, as in
   * {@link QueryFilter}); mutations without a key are left out.
   * @default undefined (no key filter)
   */
  readonly mutationKey?: QueryKey | undefined;
  /**
   * Only mutations in this status.
   * @default undefined (every status)
   */
  readonly status?: MutationStatus | undefined;
  /**
   * The client to read.
   * @default the client of the nearest `QueryClientContext` provider (or {@link runWithQueryClient})
   */
  readonly client?: QueryClient | undefined;
}

/**
 * Where `persist` keeps the cache: the three calls of `localStorage`, which may also answer later
 * (a promise), so IndexedDB wrappers and React Native's async storage fit. Values are strings.
 * @since 1.0.0
 */
export interface PersistStorage {
  /**
   * Reads one value.
   * @param key The storage key.
   * @returns The stored string, or `null` (or `undefined`) when there is none; or a promise of it.
   */
  getItem(key: string): string | null | undefined | PromiseLike<string | null | undefined>;
  /**
   * Writes one value, replacing the one under `key`.
   * @param key The storage key.
   * @param value The text to store.
   * @returns Nothing, or a promise that settles when the value is stored. A throw or a rejection is
   * a failed write (a quota error is told apart by its name).
   */
  setItem(key: string, value: string): void | PromiseLike<void>;
  /**
   * Deletes one value.
   * @param key The storage key.
   * @returns Nothing, or a promise that settles when it is gone.
   */
  removeItem(key: string): void | PromiseLike<void>;
}

/**
 * What went wrong in {@link PersistOptions.storage}, told apart by `kind`.
 * - `restore`: the stored text could not be read, parsed or trusted (corrupt, other version, tampered).
 * - `write`: the storage refused a write.
 * - `quota`: the storage was full; the oldest entries were dropped to fit.
 * - `serialize`: a query holds data that JSON cannot carry; that query is not persisted.
 * - `size`: an entry was over `maxEntryBytes`, or old entries were dropped to stay under `maxBytes`.
 * @since 1.0.0
 */
export type PersistErrorKind = "restore" | "write" | "quota" | "serialize" | "size";

/**
 * An error of the `persist` feature, passed to {@link PersistOptions.onError}. It is never thrown into
 * application code.
 * @since 1.0.0
 */
export interface PersistError extends Error {
  /** What kind of problem this is. */
  readonly kind: PersistErrorKind;
}

/**
 * A mutation that `persist` may keep while it waits in the offline queue, and run again after a reload.
 * A function cannot be stored, so the code names the mutation again here, by its `mutationKey`: the
 * stored call (key, variables, time) is matched to this definition when the page loads. Only calls of
 * a mutation listed here are stored, and only when their variables are plain JSON data.
 * @since 1.0.0
 */
export interface PersistedMutation {
  /** The `mutationKey` of the `useMutation` calls this definition replays (matched by its hash). */
  readonly mutationKey: QueryKey;
  /**
   * The write, given the variables of the stored call as they came back from JSON. It should be safe
   * to run twice (a call may be replayed again if the page closed while it ran): send an idempotency
   * key in the variables.
   */
  mutationFn(variables: unknown): unknown;
  /** Retries of a replayed call (see {@link RetryOption}). @default 0 */
  readonly retry?: RetryOption | undefined;
  /** Delay before each retry (see {@link RetryDelayOption}). @default 1000 ms doubling, capped at 30000 ms */
  readonly retryDelay?: RetryDelayOption | undefined;
  /** Runs, untracked, when a replayed call succeeds. A throw is rethrown on a microtask. */
  onSuccess?(data: unknown, variables: unknown): void;
  /** Runs, untracked, when a replayed call fails for good. A throw is rethrown on a microtask. */
  onError?(error: unknown, variables: unknown): void;
  /** Runs, untracked, after `onSuccess` or `onError`. A throw is rethrown on a microtask. */
  onSettled?(data: unknown, error: unknown, variables: unknown): void;
}

/**
 * Options of `persist`.
 * @since 1.0.0
 */
export interface PersistOptions {
  /** Where to keep the cache. */
  readonly storage: PersistStorage;
  /**
   * The storage key of the cache; paused mutations are kept under `<key>:mutations`.
   * @default "shadow-query"
   */
  readonly key?: string | undefined;
  /**
   * A version of the data format. Stored data written under another buster is dropped when the
   * page loads. Change it when the shape of cached data changes (for example with each release).
   * @default "" (no version)
   */
  readonly buster?: string | undefined;
  /**
   * Milliseconds a stored query counts as usable, from the time its data was fetched. Older entries
   * are not restored. A number of `0` or more; `Infinity` keeps entries for ever.
   * @default 86400000 (24 hours)
   */
  readonly maxAge?: number | undefined;
  /**
   * Milliseconds between writes: after a change the store is written once this long later, with
   * everything that changed meanwhile. A number of `0` or more. The store is also written when the
   * page is hidden or closed (`visibilitychange`, `pagehide`).
   * @default 1000
   */
  readonly throttleMs?: number | undefined;
  /**
   * Narrows what is kept. Called with each successful query that holds data when the store is written;
   * return `false` to leave a query out. Errors and pending queries are never kept, whatever this
   * returns. A throw is rethrown on a microtask and counts as `false`.
   * @default undefined (every successful query that holds data)
   */
  readonly shouldPersist?: ((query: QueryInfo) => boolean | undefined) | undefined;
  /**
   * The most characters one stored query may take (its JSON text). A larger query is not kept.
   * @default 262144
   */
  readonly maxEntryBytes?: number | undefined;
  /**
   * The most characters the whole stored cache may take. When it is larger, the entries fetched
   * longest ago are dropped until it fits.
   * @default 2097152
   */
  readonly maxBytes?: number | undefined;
  /**
   * The mutations that may be kept while they wait offline and replayed after a reload (see
   * {@link PersistedMutation}). Needs the `queue` feature, listed before `persist`.
   * @default undefined (mutations are never stored)
   */
  readonly mutations?: readonly PersistedMutation[] | undefined;
  /**
   * Tells other tabs of the same origin, through a `BroadcastChannel`, when this tab wrote the store,
   * and reads what they wrote. Without a `window` and a `BroadcastChannel` (on the server, for example)
   * nothing happens.
   * @default true
   */
  readonly broadcast?: boolean | undefined;
  /**
   * Receives every problem with the storage (see {@link PersistError}). Called at most once per
   * problem until a write succeeds. A throw is rethrown on a microtask.
   * @default undefined (the error is rethrown on a microtask, so the global error handler sees it)
   */
  readonly onError?: ((error: PersistError) => void) | undefined;
}

/**
 * The feature made by `persist`: pass it in `createQueryClient({ features })`, and keep it to wait for
 * the restore, write at once, or stop. It serves one client.
 * @since 1.0.0
 */
export interface PersistFeature extends QueryFeature<"persist"> {
  /**
   * Settles when the stored cache has been read into the client. It never rejects. With a synchronous
   * storage (`localStorage`) it is already settled when the client is created and the data is in; with
   * an asynchronous one, wait for it before the first render to avoid a loading state.
   */
  readonly restored: Promise<void>;
  /**
   * Writes what changed to the storage now, without waiting for the throttle.
   * @returns A promise that settles when the write is done. It never rejects: a failure goes to
   * `onError`.
   */
  flush(): Promise<void>;
  /**
   * Deletes the stored cache and the stored mutations.
   * @returns A promise that settles when both are gone. It never rejects.
   */
  clear(): Promise<void>;
  /**
   * Stops persisting: cancels the timer, removes the page listeners and closes the channel. Data
   * already stored stays. Call `flush()` first to keep the latest changes.
   */
  dispose(): void;
}

/**
 * Options of `createDehydrationStream` (`@shadow-js/query/server`).
 * @since 1.0.0
 */
export interface DehydrationStreamOptions {
  /**
   * The name that ties the chunks to `hydrateFromStream`: a letter or `_`, then letters, digits, `_` or `-`.
   * @default "__shadow_query_state__"
   */
  readonly id?: string | undefined;
  /**
   * Which queries to send (see {@link DehydrateOptions.shouldDehydrate}). A query is sent once, and again
   * only when its data changes.
   * @default the successful queries that hold data
   */
  readonly shouldDehydrate?: ((query: QueryInfo) => boolean | undefined) | undefined;
}

/**
 * The server half of a streamed query state: call `next()` each time the response can take more, and
 * write what it returns into the page.
 * @since 1.0.0
 */
export interface DehydrationStream {
  /**
   * Renders the queries that finished, or changed, since the last call as one `<script>` element.
   * @returns The element followed by a newline (so a browser can tell it is complete), or an empty
   * string when there is nothing new.
   * @throws TypeError when a sent key or value is not plain JSON data (as `dehydrate` does), or when the
   * client was created without the `hydration` feature.
   */
  next(): string;
}

/**
 * Options of `hydrateFromStream` (`@shadow-js/query/server`).
 * @since 1.0.0
 */
export interface HydrateStreamOptions {
  /**
   * The name used by `createDehydrationStream`.
   * @default "__shadow_query_state__"
   */
  readonly id?: string | undefined;
}
