import { type Accessor, useSignal } from "@shadow-js/core";
import { useQueryClient } from "./context";
import type { QueryEntry, Runner } from "./internal/core";
import { accessorOf, createObserver } from "./internal/observer";
import { coreOf } from "./internal/registry";
import type { QueryKey } from "./key";
import type { QueryFunctionContext, QueryKeyInput, QueryResult } from "./types";
import type { QueryDefinition } from "./use-query";

/**
 * The data of an infinite query: the pages in order, and the parameter each page was fetched with.
 * The two arrays always have the same length.
 * @since 1.0.0
 */
export interface InfiniteData<TPage, TParam = unknown> {
  /** The loaded pages, first to last. */
  readonly pages: readonly TPage[];
  /** The parameter of each page, at the same index as the page. */
  readonly pageParams: readonly TParam[];
}

/**
 * What the page function of {@link useInfiniteQuery} receives: the query context plus the parameter
 * of the page to fetch.
 * @since 1.0.0
 */
export interface InfiniteQueryFunctionContext<TParam> extends QueryFunctionContext {
  /** The parameter of the page to fetch (the cursor or offset). */
  readonly pageParam: TParam;
}

/**
 * Options of {@link useInfiniteQuery}: how to find the parameter of each page, plus the options of
 * {@link QueryDefinition} (client, enabled, staleTime, retries, polling, `suspense`,
 * `throwOnError`...).
 * @since 1.0.0
 */
export interface InfiniteQueryOptions<TPage, TParam>
  extends Omit<QueryDefinition<InfiniteData<TPage, TParam>>, "key" | "queryFn"> {
  /** The parameter of the first page, fetched by the first load. */
  readonly initialPageParam: TParam;
  /**
   * Returns the parameter of the page after the last one, or `undefined`/`null` when there is none
   * (then `hasNextPage()` is false and `fetchNextPage()` does nothing).
   */
  readonly getNextPageParam: (
    lastPage: TPage,
    pages: readonly TPage[],
    lastPageParam: TParam,
    pageParams: readonly TParam[],
  ) => TParam | undefined | null;
  /**
   * Returns the parameter of the page before the first one, or `undefined`/`null` when there is
   * none.
   * @default undefined (no previous pages: `hasPreviousPage()` is false and `fetchPreviousPage()`
   * does nothing)
   */
  readonly getPreviousPageParam?: (
    firstPage: TPage,
    pages: readonly TPage[],
    firstPageParam: TParam,
    pageParams: readonly TParam[],
  ) => TParam | undefined | null;
  /**
   * Most pages kept: past it, the pages farthest from the direction of the load are dropped (the
   * first ones when loading forward, the last ones when loading backward). Must be a positive
   * integer.
   * @default undefined (every page is kept)
   */
  readonly maxPages?: number | undefined;
}

/**
 * What {@link useInfiniteQuery} returns: the query result (its data is an {@link InfiniteData}) plus
 * paging controls. `isPlaceholderData()` is always false: the hook has no placeholder.
 * @since 1.0.0
 */
export interface InfiniteQueryResult<TPage, TParam>
  extends QueryResult<InfiniteData<TPage, TParam>> {
  /**
   * Fetches the page after the last one and appends it. Resolves when it is stored, or at once when
   * there is no data or no next page. While another load runs, it waits for that load instead and
   * fetches nothing. Never rejects: a failure is in `error()`.
   */
  readonly fetchNextPage: () => Promise<void>;
  /**
   * Fetches the page before the first one and prepends it, under the same rules as
   * `fetchNextPage`.
   */
  readonly fetchPreviousPage: () => Promise<void>;
  /** There is data and `getNextPageParam` returns a parameter for its last page. */
  readonly hasNextPage: Accessor<boolean>;
  /** There is data and `getPreviousPageParam` returns a parameter for its first page. */
  readonly hasPreviousPage: Accessor<boolean>;
  /** A load started by `fetchNextPage` is running. */
  readonly isFetchingNextPage: Accessor<boolean>;
  /** A load started by `fetchPreviousPage` is running. */
  readonly isFetchingPreviousPage: Accessor<boolean>;
}

type Direction = "forward" | "backward" | "refetch" | undefined;

/**
 * Subscribes to a paged list: the pages fetched so far, in order, and controls to fetch the next or
 * the previous page. The first load fetches `initialPageParam`; a refetch (on mount, focus,
 * invalidation or `refetch()`) re-fetches every loaded page in order with its parameter, one after
 * the other. Calls made while a load runs share it. Like {@link useQuery}, it fetches nothing on the
 * server.
 *
 * @param key The query key, or a tracked accessor returning it. It must not be shared with a
 * non-paged query.
 * @param queryFn Fetches one page. It receives `{ queryKey, signal, pageParam }` and runs untracked.
 * @param options The page parameters and the query options (see {@link InfiniteQueryOptions}).
 * @returns An {@link InfiniteQueryResult}.
 * @throws RangeError when `maxPages` is not a positive integer.
 * @throws Error ("no QueryClient") when `options.client` is undefined and no client is provided by
 * `QueryClientContext`.
 * @throws TypeError when the client was not made by {@link createQueryClient}.
 * @example
 * import { useInfiniteQuery } from "@shadow-js/query";
 *
 * interface Page { items: string[]; nextCursor: number | null }
 * const loadFeed = (cursor: number): Promise<Page> =>
 *   fetch(`/api/feed?cursor=${cursor}`).then((r) => r.json() as Promise<Page>);
 *
 * function Feed() {
 *   const feed = useInfiniteQuery(["feed"], ({ pageParam }) => loadFeed(pageParam), {
 *     initialPageParam: 0,
 *     getNextPageParam: (last) => last.nextCursor,
 *   });
 *   return <button onClick={() => void feed.fetchNextPage()}>More</button>;
 * }
 * @see useQuery
 * @since 1.0.0
 */
export function useInfiniteQuery<TPage, TParam>(
  key: QueryKeyInput,
  queryFn: (context: InfiniteQueryFunctionContext<TParam>) => TPage | PromiseLike<TPage>,
  options: InfiniteQueryOptions<TPage, TParam>,
): InfiniteQueryResult<TPage, TParam> {
  const core = coreOf(options.client ?? useQueryClient());
  const policy = core.policyWith(options);
  const enabled = accessorOf<boolean>(options.enabled ?? true);
  const interval =
    options.refetchInterval === undefined
      ? undefined
      : accessorOf<number | false>(options.refetchInterval);
  const maxPages = options.maxPages;
  if (maxPages !== undefined && (!Number.isInteger(maxPages) || maxPages < 1)) {
    throw new RangeError("useInfiniteQuery: maxPages must be a positive integer");
  }
  const [direction, setDirection] = useSignal<Direction>(undefined);

  type Data = InfiniteData<TPage, TParam>;
  const keep = (data: Data, from: "start" | "end"): Data => {
    if (maxPages === undefined || data.pages.length <= maxPages) return data;
    const drop = data.pages.length - maxPages;
    return from === "start"
      ? { pages: data.pages.slice(drop), pageParams: data.pageParams.slice(drop) }
      : { pages: data.pages.slice(0, maxPages), pageParams: data.pageParams.slice(0, maxPages) };
  };
  const storedOf = (entry: QueryEntry): Data | undefined =>
    core.state(entry).data as Data | undefined;

  /** First load and refetch: every loaded page, in order, with its parameter. */
  const loadAll = async (
    entry: QueryEntry,
    queryKey: QueryKey,
    signal: AbortSignal,
  ): Promise<Data> => {
    const stored = storedOf(entry);
    const params: readonly TParam[] =
      stored === undefined || stored.pageParams.length === 0
        ? [options.initialPageParam]
        : stored.pageParams;
    const pages: TPage[] = [];
    const used: TParam[] = [];
    for (const pageParam of params) {
      const page = await queryFn({ queryKey, signal, pageParam });
      pages.push(page);
      used.push(pageParam);
    }
    return keep({ pages, pageParams: used }, "start");
  };

  const observer = createObserver({
    core,
    key,
    enabled,
    policy,
    runnerFor:
      (entry, queryKey): Runner =>
      (signal) =>
        loadAll(entry, queryKey, signal),
    interval,
    suspense: options.suspense === true,
    seed: undefined,
  });

  const throwOnError = options.throwOnError === true;
  const data = (): Data | undefined => {
    observer.holdIfPending();
    const state = observer.snapshot();
    if (throwOnError && state?.status === "error") throw state.error;
    return state?.data as Data | undefined;
  };

  // A page parameter may itself be undefined (the common `initialPageParam: undefined`), so the
  // presence of a page is tested by its position, never by the value of its parameter.
  const nextParam = (current: Data): TParam | undefined | null => {
    const last = current.pages.length - 1;
    if (last < 0 || last >= current.pageParams.length) return undefined;
    return options.getNextPageParam(
      current.pages[last] as TPage,
      current.pages,
      current.pageParams[last] as TParam,
      current.pageParams,
    );
  };
  const previousParam = (current: Data): TParam | undefined | null => {
    if (current.pages.length === 0 || current.pageParams.length === 0) return undefined;
    if (options.getPreviousPageParam === undefined) return undefined;
    return options.getPreviousPageParam(
      current.pages[0] as TPage,
      current.pages,
      current.pageParams[0] as TParam,
      current.pageParams,
    );
  };

  /** Fetches one page beside the loaded ones, unless a load is already running (then it is shared). */
  const extend = (from: "forward" | "backward"): Promise<void> => {
    const entry = observer.entry();
    const current = entry === undefined ? undefined : storedOf(entry);
    if (entry === undefined || current === undefined) return Promise.resolve();
    const param = from === "forward" ? nextParam(current) : previousParam(current);
    if (param === undefined || param === null) return Promise.resolve();
    const runner: Runner = async (signal) => {
      const page = await queryFn({ queryKey: entry.key, signal, pageParam: param });
      const now = storedOf(entry) ?? current;
      return from === "forward"
        ? keep({ pages: [...now.pages, page], pageParams: [...now.pageParams, param] }, "start")
        : keep({ pages: [page, ...now.pages], pageParams: [param, ...now.pageParams] }, "end");
    };
    const shared = entry.flight !== undefined;
    if (!shared) setDirection(from);
    return core.startFetch(entry, runner, policy, false).then(() => {
      if (!shared) setDirection(undefined);
    });
  };

  return {
    data,
    error: () => observer.snapshot()?.error,
    status: () => observer.snapshot()?.status ?? "pending",
    fetchStatus: () => observer.snapshot()?.fetchStatus ?? "idle",
    isPending: () => (observer.snapshot()?.status ?? "pending") === "pending",
    isSuccess: () => observer.snapshot()?.status === "success",
    isError: () => observer.snapshot()?.status === "error",
    isFetching: () => observer.snapshot()?.fetchStatus === "fetching",
    isStale: () => {
      const state = observer.snapshot();
      return state === undefined || core.isStale(state, policy.staleTime);
    },
    isPlaceholderData: () => false,
    refetch: () =>
      observer.refetch().then((outcome) => (outcome.ok ? (outcome.value as Data) : undefined)),
    fetchNextPage: () => extend("forward"),
    fetchPreviousPage: () => extend("backward"),
    hasNextPage: () => {
      const current = observer.snapshot()?.data as Data | undefined;
      if (current === undefined) return false;
      const param = nextParam(current);
      return param !== undefined && param !== null;
    },
    hasPreviousPage: () => {
      const current = observer.snapshot()?.data as Data | undefined;
      if (current === undefined) return false;
      const param = previousParam(current);
      return param !== undefined && param !== null;
    },
    isFetchingNextPage: () =>
      direction() === "forward" && observer.snapshot()?.fetchStatus === "fetching",
    isFetchingPreviousPage: () =>
      direction() === "backward" && observer.snapshot()?.fetchStatus === "fetching",
  };
}
