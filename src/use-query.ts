import { type Accessor, untrack, useMemo } from "@shadow-js/core";
import { useQueryClient } from "./context";
import type { QueryEntry } from "./internal/core";
import { accessorOf, createObserver } from "./internal/observer";
import { coreOf } from "./internal/registry";
import type { QueryKey } from "./key";
import type {
  NetworkMode,
  QueryFunction,
  QueryKeyInput,
  QueryOptions,
  QueryResult,
  QueryStatus,
} from "./types";

interface Shown<T> {
  readonly value: T | undefined;
  readonly placeholder: boolean;
}

/**
 * Subscribes a component to a query: the data for `key`, fetched by `queryFn`, shared by every
 * component that asks for the same key. The fetch starts when the component mounts (or when the key
 * or `enabled` changes) and is skipped while the cached data is fresh. Concurrent mounts share one
 * request. The request is aborted when no component needs it any more.
 *
 * Reading `data()` tracks it; the result is an object of accessors. Nothing is fetched on the
 * server: a value seeded by `hydrate` or `prefetch` is rendered, otherwise `data()` is `undefined`.
 * In development, calling it outside any owner warns `NO_OWNER_EFFECT` (from its render effects).
 *
 * @param key The query key (plain data, see {@link hashKey}), or a tracked accessor returning it;
 * `false`, `null` or `undefined` from the accessor disables the query.
 * @param queryFn The fetch. It receives `{ queryKey, signal }` and runs untracked.
 * @param options See {@link QueryOptions}. Undefined uses the client defaults and the provided
 * client.
 * @returns A {@link QueryResult}.
 * @throws Error ("no QueryClient") when `options.client` is undefined and no client is provided by
 * `QueryClientContext`.
 * @throws TypeError when the client was not made by {@link createQueryClient}.
 * @example
 * import { useQuery } from "@shadow-js/query";
 *
 * interface Todo { id: number; title: string }
 *
 * function TodoList() {
 *   const todos = useQuery<Todo[]>(["todos"], ({ signal }) =>
 *     fetch("/api/todos", { signal }).then((r) => r.json() as Promise<Todo[]>),
 *   );
 *   return <ul>{todos.data()?.map((todo) => <li>{todo.title}</li>)}</ul>;
 * }
 * @see useInfiniteQuery
 * @see useMutation
 * @since 1.0.0
 */
export function useQuery<T, U = T>(
  key: QueryKeyInput,
  queryFn: QueryFunction<T>,
  options: QueryOptions<T, U> = {},
): QueryResult<T, U> {
  const core = coreOf(options.client ?? useQueryClient());
  const policy = core.policyWith(options);
  const enabled = accessorOf<boolean>(options.enabled ?? true);
  const interval =
    options.refetchInterval === undefined
      ? undefined
      : accessorOf<number | false>(options.refetchInterval);
  const initial = options.initialData;
  const seed =
    initial === undefined
      ? undefined
      : (entry: QueryEntry): void => {
          const state = core.state(entry);
          if (state.status !== "pending" || state.data !== undefined) return;
          const value = typeof initial === "function" ? (initial as () => T)() : initial;
          core.writeData(entry, value, options.initialDataUpdatedAt);
        };
  const observer = createObserver({
    core,
    key,
    enabled,
    policy,
    runnerFor: (_entry, queryKey: QueryKey) => (signal) => queryFn({ queryKey, signal }),
    interval,
    suspense: options.suspense === true,
    seed,
  });

  // The data shown: the query's own, else the previous data (keepPreviousData), else the placeholder.
  let lastData: T | undefined;
  const shown: Accessor<Shown<T>> = useMemo<Shown<T>>(
    () => {
      const state = observer.snapshot();
      const own = state?.data as T | undefined;
      if (own !== undefined) {
        lastData = own;
        return { value: own, placeholder: false };
      }
      if (options.keepPreviousData === true && lastData !== undefined) {
        return { value: lastData, placeholder: true };
      }
      const placeholder = options.placeholderData;
      if (placeholder !== undefined) {
        const value =
          typeof placeholder === "function"
            ? untrack(() => (placeholder as (previous: T | undefined) => T | undefined)(lastData))
            : placeholder;
        if (value !== undefined) return { value, placeholder: true };
      }
      return { value: undefined, placeholder: false };
    },
    {
      equals: (a, b) => a.value === b.value && a.placeholder === b.placeholder,
    },
  );
  const selected = useMemo<U | undefined>(() => {
    const raw = shown().value;
    if (raw === undefined) return undefined;
    const pick = options.select;
    return pick === undefined ? (raw as unknown as U) : untrack(() => pick(raw));
  });
  const throwOnError = options.throwOnError === true;
  const statusOf = (): QueryStatus => observer.snapshot()?.status ?? "pending";

  return {
    data: () => {
      observer.holdIfPending();
      const state = observer.snapshot();
      if (throwOnError && state?.status === "error") throw state.error;
      return selected();
    },
    error: () => observer.snapshot()?.error,
    status: statusOf,
    fetchStatus: () => observer.snapshot()?.fetchStatus ?? "idle",
    isPending: () => statusOf() === "pending",
    isSuccess: () => statusOf() === "success",
    isError: () => statusOf() === "error",
    isFetching: () => observer.snapshot()?.fetchStatus === "fetching",
    isStale: () => {
      const state = observer.snapshot();
      return state === undefined || core.isStale(state, policy.staleTime);
    },
    isPlaceholderData: () => shown().placeholder,
    refetch: () =>
      observer.refetch().then((outcome) => (outcome.ok ? (outcome.value as T) : undefined)),
  };
}

/**
 * One query of {@link useQueries}: the key, the fetch, and the options of {@link useQuery} that do
 * not refer to the data type (no `select`, placeholder or initial data). Each option means what it
 * means in {@link QueryOptions}.
 * @since 1.0.0
 */
export interface QueryDefinition<T> {
  /** The query key, or a tracked accessor returning it (see {@link QueryKeyInput}). */
  readonly key: QueryKeyInput;
  /** The fetch. It receives `{ queryKey, signal }` and runs untracked. */
  readonly queryFn: QueryFunction<T>;
  /**
   * The client to use.
   * @default the client of the nearest `QueryClientContext` provider (or {@link runWithQueryClient})
   */
  readonly client?: QueryOptions<T>["client"] | undefined;
  /**
   * Whether the query may fetch; an accessor is tracked.
   * @default true
   */
  readonly enabled?: QueryOptions<T>["enabled"] | undefined;
  /**
   * Milliseconds a fetched value counts as fresh.
   * @default the client's `defaultOptions.queries.staleTime` (0)
   */
  readonly staleTime?: number | undefined;
  /**
   * Milliseconds an unobserved entry is kept.
   * @default the client's `defaultOptions.queries.gcTime` (300000)
   */
  readonly gcTime?: number | undefined;
  /**
   * Retries of a failed fetch.
   * @default the client's `defaultOptions.queries.retry` (3)
   */
  readonly retry?: QueryOptions<T>["retry"] | undefined;
  /**
   * Delay before each retry.
   * @default the client's `defaultOptions.queries.retryDelay` (1000 ms doubling, capped at 30000 ms)
   */
  readonly retryDelay?: QueryOptions<T>["retryDelay"] | undefined;
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
   * When a fetch may be sent: `online` waits while the browser is offline (see {@link NetworkMode}).
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
   * Poll every this many milliseconds while mounted and enabled; `false` or `0` stops polling.
   * @default undefined (no polling)
   */
  readonly refetchInterval?: QueryOptions<T>["refetchInterval"] | undefined;
  /**
   * Hold the nearest `<Suspense>` boundary during a pending first load. Ignored on the server.
   * @default false
   */
  readonly suspense?: boolean | undefined;
  /**
   * Reading the data while the query is in error throws the error.
   * @default false
   */
  readonly throwOnError?: boolean | undefined;
}

/**
 * The results of {@link useQueries}: a tuple with one {@link QueryResult} per definition, in order,
 * each typed by its definition's query function.
 * @since 1.0.0
 */
export type QueryResults<Defs extends readonly QueryDefinition<unknown>[]> = {
  /** The result of the definition at the same index. */
  readonly [I in keyof Defs]: Defs[I] extends QueryDefinition<infer V> ? QueryResult<V> : never;
};

/**
 * Subscribes to several queries at once, as if {@link useQuery} were called once per definition.
 * The list is fixed when the component is created; for a list that changes, render one component
 * per item instead.
 *
 * @param definitions One definition per query (see {@link QueryDefinition}).
 * @returns One {@link QueryResult} per definition, in the same order, typed per definition.
 * @throws Error ("no QueryClient") when a definition names no client and none is provided by
 * `QueryClientContext`.
 * @throws TypeError when a client was not made by {@link createQueryClient}.
 * @example
 * import { useQueries } from "@shadow-js/query";
 *
 * function Profile(props: { id: number }) {
 *   const [user, posts] = useQueries([
 *     { key: ["user", props.id], queryFn: () => ({ name: "Ada" }) },
 *     { key: ["posts", props.id], queryFn: () => ["Hello"] },
 *   ]);
 *   return <p>{user.data()?.name} wrote {posts.data()?.length ?? 0} posts</p>;
 * }
 * @see useQuery
 * @since 1.0.0
 */
export function useQueries<const Defs extends readonly QueryDefinition<unknown>[]>(
  definitions: Defs,
): QueryResults<Defs> {
  const results = definitions.map((definition) =>
    useQuery<unknown>(definition.key, definition.queryFn, definition),
  );
  return results as unknown as QueryResults<Defs>;
}
