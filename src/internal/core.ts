/**
 * The engine behind {@link createQueryClient}: entries, flights, retries, garbage collection,
 * focus and reconnect refetching, and the client API. Hooks reach it through `coreOf` (see
 * `registry.ts`); the public surface is `QueryClient` alone.
 *
 * Every entry keeps its state in ONE signal cell, so a reader subscribes to the entry and is
 * notified once per change. The state is immutable: every change stores a new object.
 *
 * @packageDocumentation
 * @internal
 */
import { batch, untrack } from "@shadow-js/core";
import {
  createSignalNode,
  currentOwner,
  DEVTOOLS_EVENT,
  devtoolsReport,
  isComputingMemo,
  readSignal,
  type SignalNode,
  writeSignal,
} from "@shadow-js/core/extend";
import { hashKey, matchesKeyPrefix, type QueryKey } from "../key";
import { jsonProblem } from "../serial";
import { structuralShare } from "../share";
import type {
  DefaultOptions,
  DehydratedState,
  DehydrateOptions,
  FetchStatus,
  MutationCacheOptions,
  MutationDefaults,
  MutationInfo,
  NetworkMode,
  PrefetchOptions,
  QueryCacheEvent,
  QueryCacheOptions,
  QueryClient,
  QueryClientOptions,
  QueryDefaults,
  QueryFeatureName,
  QueryFilter,
  QueryFunction,
  QueryInfo,
  QueryStatus,
  RetryDelayOption,
  RetryOption,
} from "../types";
import {
  checkNetworkMode,
  collectFeatures,
  type Extensions,
  featureMissing,
  type QueryFeatureHost,
} from "./features";

/** The settled state of one fetch. It never rejects: failures and cancellations are values. @internal */
export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown; readonly canceled: boolean };

/** What a fetch runs: the query function bound to its key, or an infinite-query runner. @internal */
export type Runner = (signal: AbortSignal) => unknown;

/** Resolved options that govern an entry. @internal */
export interface Policy {
  readonly staleTime: number;
  readonly gcTime: number;
  readonly retry: RetryOption;
  readonly retryDelay: RetryDelayOption;
  readonly refetchOnWindowFocus: boolean;
  readonly refetchOnReconnect: boolean;
  readonly refetchOnMount: boolean;
  readonly structuralSharing: boolean;
  readonly networkMode: NetworkMode;
}

/** The immutable state of an entry. @internal */
export interface QueryState {
  readonly status: QueryStatus;
  readonly fetchStatus: FetchStatus;
  readonly data: unknown;
  readonly error: unknown;
  readonly updatedAt: number;
  readonly invalidated: boolean;
}

interface Flight {
  readonly controller: AbortController;
  readonly outcome: Promise<Outcome<unknown>>;
  /** Settles `outcome`. Called on completion and on abort, so a canceled fetch never waits on its user. */
  readonly settle: (outcome: Outcome<unknown>) => void;
  /** True once the function runs. A paused flight is not running and is not counted as fetching. */
  running: boolean;
}

/** One cache entry. @internal */
export class QueryEntry {
  readonly hash: string;
  readonly key: QueryKey;
  readonly cell: SignalNode<QueryState>;
  /** Mounted observers plus pins held by prefetches. */
  observers = 0;
  /** Observers that are enabled and so may start a fetch. */
  fetchable = 0;
  runner: Runner | undefined;
  flight: Flight | undefined;
  gcTimer: ReturnType<typeof setTimeout> | undefined;
  policy: Policy;

  constructor(hash: string, key: QueryKey, state: QueryState, policy: Policy) {
    this.hash = hash;
    this.key = key;
    this.cell = createSignalNode<QueryState>(state, false);
    this.policy = policy;
  }
}

/** A mutation record in the mutation cache. @internal */
export interface MutationRecord extends MutationInfo {
  readonly id: number;
}

/** What the engine exposes to the hooks, and (through {@link QueryFeatureHost}) to the features. @internal */
export interface Core extends QueryFeatureHost {
  readonly api: QueryClient;
  readonly defaultPolicy: Policy;
  readonly defaultMutation: { readonly retry: RetryOption; readonly retryDelay: RetryDelayOption };
  attach(
    entry: QueryEntry,
    observer: { readonly fetchable: boolean; readonly runner: Runner; readonly policy: Policy },
  ): void;
  detach(entry: QueryEntry, fetchable: boolean): void;
  enable(entry: QueryEntry, runner: Runner): void;
  disable(entry: QueryEntry): void;
  refetch(entry: QueryEntry, cancelRefetch: boolean): Promise<Outcome<unknown>>;
  startFetch(
    entry: QueryEntry,
    runner: Runner,
    policy: Policy,
    cancelRefetch: boolean,
  ): Promise<Outcome<unknown>>;
  /** The state, tracked: a reader subscribes to the entry. */
  read(entry: QueryEntry): QueryState;
  isStale(state: QueryState, staleTime: number): boolean;
  policyWith(overrides: QueryDefaults): Policy;
  warnIfComputing(method: string): void;
  devWarn(message: string): void;
  /** The slot of a feature; throws the `TypeError` that names the feature and `what` needed it. */
  need<N extends Exclude<QueryFeatureName, "persist">>(
    name: N,
    what: string,
  ): NonNullable<Extensions[N]>;
  /** Runs a user callback untracked; a throw is reported on a microtask, not rethrown. */
  guard(callback: () => void): void;
}

/** The longest delay a timer can wait: a longer one fires at once. @internal */
export const MAX_TIMER_DELAY: number = 2 ** 31 - 1;

/**
 * A delay a timer can honor: below zero or NaN is zero, above the longest wait is that wait. A
 * `setTimeout` of more than 2^31 - 1 ms would otherwise fire at once.
 * @internal
 */
export function timerDelay(ms: number): number {
  return ms > 0 ? Math.min(ms, MAX_TIMER_DELAY) : 0;
}

/** Default backoff: 1 s, 2 s, 4 s... capped at 30 s. @internal */
export function defaultRetryDelay(failureCount: number): number {
  return Math.min(1000 * 2 ** (failureCount - 1), 30_000);
}

const INITIAL_STATE: QueryState = {
  status: "pending",
  fetchStatus: "idle",
  data: undefined,
  error: undefined,
  updatedAt: 0,
  invalidated: false,
};

const MAX_WARNINGS = 64;

function boundedInt(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`createQueryClient: ${name} must be a positive integer, got ${value}`);
  }
  return value;
}

function abortError(): Error {
  const error = new Error("The query was canceled.");
  error.name = "AbortError";
  return error;
}

/** Resolves when `signal` is aborted early, or after `ms`. Rejects with an AbortError when aborted. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, timerDelay(ms));
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function retryAllowed(retry: RetryOption, failureCount: number, error: unknown): boolean {
  if (typeof retry === "function") return retry(failureCount, error);
  if (typeof retry === "boolean") return retry;
  return failureCount <= retry;
}

function retryDelayOf(delay: RetryDelayOption, failureCount: number, error: unknown): number {
  return typeof delay === "number" ? delay : delay(failureCount, error);
}

/**
 * Calls `attempt` until it succeeds, a retry is refused, or `signal` aborts (then the last error
 * is thrown). Used for queries and for mutations.
 * @internal
 */
export async function withRetries<T>(
  attempt: () => T | PromiseLike<T>,
  policy: Pick<Policy, "retry" | "retryDelay">,
  signal: AbortSignal,
): Promise<T> {
  let failureCount = 0;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      failureCount += 1;
      if (signal.aborted || !retryAllowed(policy.retry, failureCount, error)) throw error;
      await sleep(retryDelayOf(policy.retryDelay, failureCount, error), signal);
    }
  }
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  // The executor runs synchronously, so `resolve` is replaced before this returns.
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (value) => settle(value) };
}

const CANCELED: Outcome<unknown> = { ok: false, error: undefined, canceled: true };

/**
 * Creates the engine and the public client that wraps it.
 * @param options The client options (validated here).
 * @returns The engine.
 * @internal
 */
export function createCore(options: QueryClientOptions): Core {
  const queryDefaults: DefaultOptions["queries"] = options.defaultOptions?.queries;
  // The slots the features fill when they are installed, at the end of this function (see `Extensions`).
  const ext: Extensions = {};
  const defaultNetwork = queryDefaults?.networkMode ?? "online";
  const defaultPolicy: Policy = {
    staleTime: queryDefaults?.staleTime ?? 0,
    gcTime: queryDefaults?.gcTime ?? 300_000,
    retry: queryDefaults?.retry ?? 3,
    retryDelay: queryDefaults?.retryDelay ?? defaultRetryDelay,
    refetchOnWindowFocus: queryDefaults?.refetchOnWindowFocus ?? true,
    refetchOnReconnect: queryDefaults?.refetchOnReconnect ?? true,
    refetchOnMount: queryDefaults?.refetchOnMount ?? true,
    structuralSharing: queryDefaults?.structuralSharing ?? true,
    networkMode: defaultNetwork,
  };
  const mutationDefaults: MutationDefaults | undefined = options.defaultOptions?.mutations;
  const defaultMutation = {
    retry: mutationDefaults?.retry ?? 0,
    retryDelay: mutationDefaults?.retryDelay ?? defaultRetryDelay,
  };
  const queryCacheOptions: QueryCacheOptions = options.queryCache ?? {};
  const mutationCacheOptions: MutationCacheOptions = options.mutationCache ?? {};
  const maxQueries = boundedInt(queryCacheOptions.maxQueries ?? 500, "queryCache.maxQueries");
  const maxMutations = boundedInt(
    mutationCacheOptions.maxMutations ?? 100,
    "mutationCache.maxMutations",
  );

  const queries = new Map<string, QueryEntry>();
  const fetching = createSignalNode<number>(0, false);
  const mutationRecords = createSignalNode<readonly MutationRecord[]>([], false);
  let mutationIds = 0;
  let totalObservers = 0;
  let listening = false;
  const warned = new Set<string>();

  const devWarn = (message: string): void => {
    if (!__DEV__) return;
    if (warned.has(message) || warned.size >= MAX_WARNINGS) return;
    warned.add(message);
    console.warn(`[shadow-query] ${message}`);
  };

  const warnIfComputing = (method: string): void => {
    if (__DEV__ && isComputingMemo()) {
      devWarn(
        `${method}() was called while a memo computes. Call it from an event handler or an effect.`,
      );
    }
  };

  const reportCallbackError = (error: unknown): void => {
    // A user callback failed after the state was already stored: surface it as an uncaught error
    // (the global handler sees it) without changing the query state.
    queueMicrotask(() => {
      throw error;
    });
  };

  /** The slot of a feature, or the `TypeError` that names the feature and what needed it. */
  const need = <N extends Exclude<QueryFeatureName, "persist">>(
    name: N,
    what: string,
  ): NonNullable<Extensions[N]> => {
    const slot = ext[name];
    if (slot === undefined) throw featureMissing(name, what);
    return slot as NonNullable<Extensions[N]>;
  };

  /** Runs a user callback untracked; a throw is reported, never rethrown into the engine. */
  const guard = (callback: () => void): void => {
    try {
      untrack(callback);
    } catch (callbackError) {
      reportCallbackError(callbackError);
    }
  };

  const policyWith = (overrides: QueryDefaults): Policy => {
    checkNetworkMode(overrides.networkMode ?? defaultPolicy.networkMode, ext);
    return {
      staleTime: overrides.staleTime ?? defaultPolicy.staleTime,
      gcTime: overrides.gcTime ?? defaultPolicy.gcTime,
      retry: overrides.retry ?? defaultPolicy.retry,
      retryDelay: overrides.retryDelay ?? defaultPolicy.retryDelay,
      refetchOnWindowFocus: overrides.refetchOnWindowFocus ?? defaultPolicy.refetchOnWindowFocus,
      refetchOnReconnect: overrides.refetchOnReconnect ?? defaultPolicy.refetchOnReconnect,
      refetchOnMount: overrides.refetchOnMount ?? defaultPolicy.refetchOnMount,
      structuralSharing: overrides.structuralSharing ?? defaultPolicy.structuralSharing,
      networkMode: overrides.networkMode ?? defaultPolicy.networkMode,
    };
  };

  const state = (entry: QueryEntry): QueryState => untrack(() => readSignal(entry.cell));

  const setState = (entry: QueryEntry, patch: Partial<QueryState>): void => {
    const next: QueryState = { ...state(entry), ...patch };
    writeSignal(entry.cell, next, { allowInMemo: true });
    emit("updated", entry);
    if (__DEV__) {
      devtoolsReport(
        DEVTOOLS_EVENT.RESOURCE_STATE,
        entry,
        next.fetchStatus === "fetching" ? "fetching" : next.status,
        entry.hash,
        currentOwner(),
      );
    }
  };

  const isStale = (current: QueryState, staleTime: number): boolean =>
    current.status !== "success" ||
    current.invalidated ||
    Date.now() - current.updatedAt >= staleTime;

  const writeData = (entry: QueryEntry, data: unknown, updatedAt?: number): void => {
    const previous = state(entry).data;
    const stored = entry.policy.structuralSharing ? structuralShare(previous, data) : data;
    setState(entry, {
      status: "success",
      data: stored,
      error: undefined,
      updatedAt: updatedAt ?? Date.now(),
      invalidated: false,
    });
  };

  const adjustFetching = (delta: number): void => {
    const count = untrack(() => readSignal(fetching));
    writeSignal(fetching, count + delta, { allowInMemo: true });
  };

  /**
   * Tells the cache subscribers about one change. Nothing is built when nobody listens. A listener
   * runs untracked; a throw is reported like a callback error, so the cache is not affected.
   */
  const emit = (type: QueryCacheEvent["type"], entry: QueryEntry): void => {
    ext.watch?.(type, entry);
  };

  const clearGc = (entry: QueryEntry): void => {
    if (entry.gcTimer !== undefined) {
      clearTimeout(entry.gcTimer);
      entry.gcTimer = undefined;
    }
  };

  const removeEntry = (entry: QueryEntry): void => {
    clearGc(entry);
    if (queries.get(entry.hash) !== entry) return;
    queries.delete(entry.hash);
    emit("removed", entry);
  };

  /**
   * Starts the removal countdown of an entry nobody observes and no fetch runs for. It is called again
   * when the last fetch of an unobserved entry ends, so a refetch that outlives `gcTime` does not keep
   * the entry forever.
   */
  const scheduleGc = (entry: QueryEntry): void => {
    clearGc(entry);
    if (entry.observers > 0 || entry.flight !== undefined) return;
    if (entry.policy.gcTime === Infinity) return;
    entry.gcTimer = setTimeout(() => {
      entry.gcTimer = undefined;
      if (entry.observers === 0 && entry.flight === undefined) removeEntry(entry);
      // A gcTime above the longest timer wait would remove the entry at once, so it waits the longest.
    }, timerDelay(entry.policy.gcTime));
  };

  /** Keeps at most `maxQueries` unobserved entries: the least recently used go first. */
  const evict = (keep: QueryEntry): void => {
    if (queries.size <= maxQueries) return;
    for (const entry of queries.values()) {
      if (queries.size <= maxQueries) break;
      if (entry === keep || entry.observers > 0 || entry.flight !== undefined) continue;
      removeEntry(entry);
    }
  };

  const ensure = (key: QueryKey, hash: string): QueryEntry => {
    const existing = queries.get(hash);
    if (existing !== undefined) {
      // Re-insert to mark it most recently used.
      queries.delete(hash);
      queries.set(hash, existing);
      return existing;
    }
    if (__DEV__) {
      // A key that does not survive JSON would make dehydrate() refuse the query and make the browser
      // compute a different hash. Say so once per key, where the key is first used.
      const problem = jsonProblem(key);
      if (problem !== undefined) {
        devWarn(
          `query key ${hash} holds ${problem}: dehydrate() will refuse it. Use null instead.`,
        );
      }
    }
    const entry = new QueryEntry(hash, key, INITIAL_STATE, defaultPolicy);
    queries.set(hash, entry);
    emit("added", entry);
    evict(entry);
    if (entry.observers === 0) scheduleGc(entry);
    return entry;
  };

  const abortFlight = (entry: QueryEntry, flight: Flight): void => {
    flight.controller.abort();
    clearFlight(entry, flight);
    flight.settle(CANCELED);
  };

  /**
   * Ends a flight that is still the entry's current one, with one state write: the outcome's patch
   * and `fetchStatus: idle` together. A flight that was superseded or canceled writes nothing.
   */
  const finishFlight = (entry: QueryEntry, flight: Flight, patch: Partial<QueryState>): void => {
    if (entry.flight !== flight) return;
    entry.flight = undefined;
    ext.offline?.forget(flight);
    if (flight.running) adjustFetching(-1);
    setState(entry, { ...patch, fetchStatus: "idle" });
    scheduleGc(entry);
  };

  const clearFlight = (entry: QueryEntry, flight: Flight): void => finishFlight(entry, flight, {});

  async function execute(
    entry: QueryEntry,
    flight: Flight,
    runner: Runner,
    policy: Pick<Policy, "retry" | "retryDelay" | "networkMode">,
  ): Promise<Outcome<unknown>> {
    const signal = flight.controller.signal;
    try {
      const value = await withRetries(
        () => {
          // The `queue` feature holds an attempt while the connection is down.
          const held = ext.queue?.pause(entry, signal, policy.networkMode);
          const run = (): unknown => untrack(() => runner(signal));
          return held === undefined ? run() : held.then(run);
        },
        policy,
        signal,
      );
      if (signal.aborted || entry.flight !== flight) return CANCELED;
      const previous = state(entry).data;
      const data = entry.policy.structuralSharing ? structuralShare(previous, value) : value;
      finishFlight(entry, flight, {
        status: "success",
        data,
        error: undefined,
        updatedAt: Date.now(),
        invalidated: false,
      });
      guard(() => queryCacheOptions.onSuccess?.(value, toInfo(entry)));
      return { ok: true, value };
    } catch (error) {
      if (signal.aborted || entry.flight !== flight) return CANCELED;
      finishFlight(entry, flight, { status: "error", error });
      guard(() => queryCacheOptions.onError?.(error, toInfo(entry)));
      return { ok: false, error, canceled: false };
    } finally {
      clearFlight(entry, flight);
    }
  }

  const startFetch = (
    entry: QueryEntry,
    runner: Runner,
    policy: Policy,
    cancelRefetch: boolean,
  ): Promise<Outcome<unknown>> => {
    const current = entry.flight;
    if (current !== undefined && !cancelRefetch) return current.outcome;
    if (current !== undefined) abortFlight(entry, current);
    const outcome = deferred<Outcome<unknown>>();
    const flight: Flight = {
      controller: new AbortController(),
      outcome: outcome.promise,
      settle: outcome.resolve,
      running: false,
    };
    entry.flight = flight;
    const begin = (): void => {
      flight.running = true;
      adjustFetching(1);
      setState(entry, { fetchStatus: "fetching" });
      void execute(entry, flight, runner, policy).then(flight.settle);
    };
    if (ext.offline?.hold(entry, flight, begin, policy.networkMode) !== true) begin();
    return outcome.promise;
  };

  const shouldFetch = (entry: QueryEntry): boolean => {
    const current = state(entry);
    return (
      current.status !== "success" ||
      (entry.policy.refetchOnMount && isStale(current, entry.policy.staleTime))
    );
  };

  const refetch = (entry: QueryEntry, cancelRefetch: boolean): Promise<Outcome<unknown>> => {
    const runner = entry.runner;
    if (runner === undefined) return Promise.resolve(CANCELED);
    return startFetch(entry, runner, entry.policy, cancelRefetch);
  };

  const attach: Core["attach"] = (entry, observer) => {
    entry.observers += 1;
    entry.runner = observer.runner;
    entry.policy = observer.policy;
    clearGc(entry);
    totalObservers += 1;
    if (totalObservers === 1) listen();
    if (observer.fetchable) {
      entry.fetchable += 1;
      if (shouldFetch(entry)) void startFetch(entry, observer.runner, entry.policy, false);
    }
  };

  const detach = (entry: QueryEntry, fetchable: boolean): void => {
    entry.observers -= 1;
    if (fetchable) entry.fetchable -= 1;
    totalObservers -= 1;
    if (totalObservers === 0) unlisten();
    if (entry.observers === 0) {
      // Nobody wants the data any more: stop the request and schedule the removal.
      if (entry.flight !== undefined) abortFlight(entry, entry.flight);
      scheduleGc(entry);
    }
  };

  const enable = (entry: QueryEntry, runner: Runner): void => {
    entry.fetchable += 1;
    entry.runner = runner;
    if (shouldFetch(entry)) void startFetch(entry, runner, entry.policy, false);
  };

  const disable = (entry: QueryEntry): void => {
    entry.fetchable -= 1;
  };

  const refetchMatching = (predicate: (entry: QueryEntry) => boolean): void => {
    for (const entry of [...queries.values()]) {
      if (entry.fetchable === 0 || entry.runner === undefined) continue;
      if (!predicate(entry)) continue;
      if (!isStale(state(entry), entry.policy.staleTime)) continue;
      void startFetch(entry, entry.runner, entry.policy, false);
    }
  };

  const onFocus = (): void => refetchMatching((entry) => entry.policy.refetchOnWindowFocus);

  const onVisibility = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") onFocus();
  };
  const onOnline = (): void => refetchMatching((entry) => entry.policy.refetchOnReconnect);

  function listen(): void {
    if (listening) return;
    listening = true;
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onFocus);
      window.addEventListener("online", onOnline);
    }
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", onVisibility);
  }

  function unlisten(): void {
    if (!listening) return;
    listening = false;
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
    }
  }

  const toInfo = (entry: QueryEntry): QueryInfo => {
    const current = state(entry);
    return {
      queryKey: entry.key,
      queryHash: entry.hash,
      status: current.status,
      fetchStatus: current.fetchStatus,
      data: current.data,
      error: current.error,
      dataUpdatedAt: current.updatedAt,
      isInvalidated: current.invalidated,
      observers: entry.observers,
    };
  };

  const matches = (entry: QueryEntry, filter: QueryFilter | undefined): boolean => {
    if (filter === undefined) return true;
    if (filter.key !== undefined) {
      const sameKey =
        filter.exact === true
          ? entry.hash === hashKey(filter.key)
          : matchesKeyPrefix(filter.key, entry.key);
      if (!sameKey) return false;
    }
    if (filter.type === "active" && entry.observers === 0) return false;
    if (filter.type === "inactive" && entry.observers > 0) return false;
    if (filter.predicate !== undefined && !filter.predicate(toInfo(entry))) return false;
    return true;
  };

  const select = (filter: QueryFilter | undefined): QueryEntry[] =>
    [...queries.values()].filter((entry) => matches(entry, filter));

  const unpin = (entry: QueryEntry): void => {
    entry.observers -= 1;
    if (entry.observers === 0) scheduleGc(entry);
  };

  /** Runs a fetch for an entry that a prefetch pins for its duration. */
  const pinnedFetch = (
    entry: QueryEntry,
    runner: Runner,
    policy: Policy,
  ): Promise<Outcome<unknown>> => {
    entry.observers += 1;
    clearGc(entry);
    if (entry.runner === undefined) entry.runner = runner;
    return startFetch(entry, runner, policy, false).then((outcome) => {
      unpin(entry);
      return outcome;
    });
  };

  /** The entry's policy with the per-call retry and staleTime options applied. */
  const prefetchPolicy = (entry: QueryEntry, options: PrefetchOptions | undefined): Policy => ({
    ...entry.policy,
    staleTime: options?.staleTime ?? entry.policy.staleTime,
    retry: options?.retry ?? entry.policy.retry,
    retryDelay: options?.retryDelay ?? entry.policy.retryDelay,
  });

  const mutationList = (): readonly MutationRecord[] => readSignal(mutationRecords);

  const api: QueryClient = {
    queryCache: {
      get size(): number {
        return queries.size;
      },
      find: (filter?: QueryFilter): readonly QueryInfo[] => select(filter).map(toInfo),
      subscribe(listener: (event: QueryCacheEvent) => void): () => void {
        return need("inspection", "queryCache.subscribe").subscribe(listener);
      },
    },
    mutationCache: {
      get size(): number {
        return untrack(() => mutationList().length);
      },
      find: (): readonly MutationInfo[] => untrack(() => mutationList()),
    },

    getCache<T = unknown>(key: QueryKey): T | undefined {
      const entry = queries.get(hashKey(key));
      return entry === undefined ? undefined : (state(entry).data as T | undefined);
    },

    setCache<T>(
      key: QueryKey,
      updater: T | ((previous: T | undefined) => T | undefined),
      writeOptions?: { readonly updatedAt?: number },
    ): T | undefined {
      warnIfComputing("setCache");
      const entry = ensure(key, hashKey(key));
      const previous = state(entry).data as T | undefined;
      const next =
        typeof updater === "function"
          ? (updater as (previous: T | undefined) => T | undefined)(previous)
          : updater;
      if (next === undefined) return undefined;
      writeData(entry, next, writeOptions?.updatedAt);
      return state(entry).data as T;
    },

    invalidate(
      filter?: QueryFilter,
      invalidateOptions?: { readonly refetchType?: "active" | "inactive" | "all" | "none" },
    ): Promise<void> {
      warnIfComputing("invalidate");
      const refetchType = invalidateOptions?.refetchType ?? "active";
      const found = select(filter);
      batch(() => {
        for (const entry of found) setState(entry, { invalidated: true });
      });
      if (refetchType === "none") return Promise.resolve();
      const targets = found.filter((entry) => {
        if (entry.runner === undefined) return false;
        if (refetchType === "all") return true;
        if (refetchType === "active") return entry.fetchable > 0;
        return entry.fetchable === 0;
      });
      return Promise.all(targets.map((entry) => refetch(entry, true))).then(() => undefined);
    },

    refetchQueries(filter?: QueryFilter): Promise<void> {
      warnIfComputing("refetchQueries");
      const targets = select(filter).filter((entry) => entry.runner !== undefined);
      return Promise.all(targets.map((entry) => refetch(entry, true))).then(() => undefined);
    },

    prefetch<T>(
      key: QueryKey,
      queryFn: QueryFunction<T>,
      prefetchOptions?: PrefetchOptions,
    ): Promise<void> {
      warnIfComputing("prefetch");
      const entry = ensure(key, hashKey(key));
      const policy = prefetchPolicy(entry, prefetchOptions);
      const current = state(entry);
      if (current.status === "success" && !isStale(current, policy.staleTime)) {
        return Promise.resolve();
      }
      const runner: Runner = (signal) => queryFn({ queryKey: key, signal });
      return pinnedFetch(entry, runner, policy).then(() => undefined);
    },

    async fetchQuery<T>(
      key: QueryKey,
      queryFn: QueryFunction<T>,
      prefetchOptions?: PrefetchOptions,
    ): Promise<T> {
      warnIfComputing("fetchQuery");
      const entry = ensure(key, hashKey(key));
      const policy = prefetchPolicy(entry, prefetchOptions);
      const current = state(entry);
      if (current.status === "success" && !isStale(current, policy.staleTime)) {
        return current.data as T;
      }
      const runner: Runner = (signal) => queryFn({ queryKey: key, signal });
      const outcome = await pinnedFetch(entry, runner, policy);
      if (outcome.ok) return outcome.value as T;
      throw outcome.canceled ? abortError() : outcome.error;
    },

    cancel(filter?: QueryFilter): void {
      warnIfComputing("cancel");
      for (const entry of select(filter)) {
        if (entry.flight !== undefined) abortFlight(entry, entry.flight);
      }
    },

    reset(): void {
      warnIfComputing("reset");
      const all = [...queries.values()];
      for (const entry of all) {
        if (entry.flight !== undefined) abortFlight(entry, entry.flight);
      }
      batch(() => {
        for (const entry of all) {
          if (entry.observers === 0) {
            removeEntry(entry);
            continue;
          }
          setState(entry, { ...INITIAL_STATE });
        }
      });
      for (const entry of all) {
        if (entry.observers > 0 && entry.fetchable > 0 && entry.runner !== undefined) {
          void startFetch(entry, entry.runner, entry.policy, false);
        }
      }
    },

    isFetching(filter?: QueryFilter): number {
      if (filter === undefined) return readSignal(fetching);
      return select(filter).filter((entry) => entry.flight?.running === true).length;
    },

    dehydrate(dehydrateOptions?: DehydrateOptions): DehydratedState {
      return need("hydration", "dehydrate()").dehydrate(dehydrateOptions);
    },

    hydrate(input: unknown): void {
      need("hydration", "hydrate()").hydrate(input);
    },

    resumePausedMutations(): Promise<void> {
      return need("queue", "resumePausedMutations()").resume();
    },
  };

  /** Keeps at most `maxMutations` records; the oldest settled ones go first, a pending one never. */
  const pruneMutations = (list: MutationRecord[]): MutationRecord[] => {
    let index = 0;
    while (list.length > maxMutations && index < list.length) {
      const oldest = list[index];
      if (oldest !== undefined && oldest.status !== "pending") list.splice(index, 1);
      else index += 1;
    }
    return list;
  };

  const mutations: Core["mutations"] = {
    list: mutationList,
    add(record: Omit<MutationRecord, "id">): number {
      mutationIds += 1;
      const id = mutationIds;
      const added = { ...record, id };
      const next = pruneMutations([...untrack(() => mutationList()), added]);
      writeSignal(mutationRecords, next, { allowInMemo: true });
      ext.watchMutation?.(added);
      return id;
    },
    update(id: number, patch: Partial<Omit<MutationRecord, "id">>): void {
      let changed: MutationRecord | undefined;
      const next = pruneMutations(
        untrack(() => mutationList()).map((record) => {
          if (record.id !== id) return record;
          changed = { ...record, ...patch };
          return changed;
        }),
      );
      writeSignal(mutationRecords, next, { allowInMemo: true });
      if (changed !== undefined) ext.watchMutation?.(changed);
    },
  };

  // The features come last: they may read the caches (a persisted cache is restored while they install).
  const core: Core = {
    api,
    ext,
    defaultPolicy,
    defaultMutation,
    ensure,
    attach,
    detach,
    enable,
    disable,
    refetch,
    startFetch,
    state,
    read: (entry) => readSignal(entry.cell),
    writeData,
    setState,
    isStale,
    policyWith,
    warnIfComputing,
    devWarn,
    reportCallbackError,
    guard,
    need,
    mutationCache: mutationCacheOptions,
    mutations,
    info: toInfo,
    entries: () => queries.values(),
  };
  // The features come last: they may read the caches (a persisted cache is restored while they install).
  for (const feature of collectFeatures(options.features)) feature.plug(core);
  checkNetworkMode(defaultNetwork, ext);
  return core;
}
