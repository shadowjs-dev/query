/**
 * The optional capabilities of a client: what a feature plugs into the engine, the order and
 * duplicates of the `features` option, and the error of a member the client was created without.
 * @packageDocumentation
 */

import type { QueryKey } from "../key";
import type {
  DehydratedState,
  DehydrateOptions,
  MutationCacheOptions,
  NetworkMode,
  QueryCacheEvent,
  QueryFeature,
  QueryFeatureName,
  QueryInfo,
} from "../types";
import type { MutationRecord, QueryEntry, QueryState } from "./core";

/**
 * The slots the engine reads. A feature fills the slot it owns when it is installed; a slot that is
 * empty means the feature is not installed, and the members that need it throw.
 * @internal
 */
export interface Extensions {
  /** Offline pause and resume (feature `offline`). */
  offline?: OfflineExtension;
  /** Retries and mutations that wait for the connection, and the replay queue (feature `queue`). */
  queue?: QueueExtension;
  /** Mutation scopes: the calls of one scope run one at a time (feature `scope`). */
  scope?: ScopeExtension;
  /** Cache subscriptions (feature `inspection`). */
  inspection?: InspectionExtension;
  /** Called after every change of a query entry: a feature that follows the cache adds a watcher (see {@link addWatcher}). */
  watch?: CacheWatcher;
  /** Called after a mutation record is added or changed: a feature adds a watcher (see {@link addMutationWatcher}). */
  watchMutation?: MutationWatcher;
  /** Dehydrate and hydrate, the state a server sends to the browser (feature `hydration`). */
  hydration?: HydrationExtension;
}

/** Follows the query cache: `entry` was added, updated or removed. @internal */
export type CacheWatcher = (type: QueryCacheEvent["type"], entry: QueryEntry) => void;

/** Follows the mutation cache: `record` was just added or changed. @internal */
export type MutationWatcher = (record: MutationRecord) => void;

/**
 * Adds a watcher of the query cache next to the ones already installed; all of them run, in the order
 * they were added. A feature calls it once when it is installed.
 * @internal
 */
export function addWatcher(ext: Extensions, watcher: CacheWatcher): void {
  const previous = ext.watch;
  ext.watch =
    previous === undefined
      ? watcher
      : (type, entry): void => {
          previous(type, entry);
          watcher(type, entry);
        };
}

/** Like {@link addWatcher}, for the mutation cache. @internal */
export function addMutationWatcher(ext: Extensions, watcher: MutationWatcher): void {
  const previous = ext.watchMutation;
  ext.watchMutation =
    previous === undefined
      ? watcher
      : (record): void => {
          previous(record);
          watcher(record);
        };
}

/** What the `hydration` feature provides to the engine. @internal */
export interface HydrationExtension {
  /** The state of the successful queries, as plain JSON data. */
  dehydrate(options: DehydrateOptions | undefined): DehydratedState;
  /** Seeds the queries from a dehydrated state; a value that is not one throws a TypeError. */
  hydrate(input: unknown): void;
}

/** What the `offline` feature provides to the engine. @internal */
export interface OfflineExtension {
  /**
   * Holds a flight the network cannot serve now: `begin` starts it when the connection returns.
   * Returns `false` when the flight runs now.
   */
  hold(entry: QueryEntry, flight: object, begin: () => void, networkMode: NetworkMode): boolean;
  /** Forgets a flight that ended while it waited. */
  forget(flight: object): void;
}

/** What the `queue` feature provides to the engine. @internal */
export interface QueueExtension {
  /**
   * Called before each attempt of a query: while the connection is down it returns a promise that
   * settles when the connection returns (it rejects when `signal` aborts first), so a retry does not
   * run offline. Returns `undefined` when the attempt may run.
   */
  pause(
    entry: QueryEntry,
    signal: AbortSignal,
    networkMode: NetworkMode,
  ): Promise<void> | undefined;
  /**
   * Called before each attempt of a mutation: the first one is admitted to the replay queue when the
   * connection is down or a replay is running, a retry waits for the connection. Returns `undefined`
   * when the attempt may run.
   */
  gate(id: number, networkMode: NetworkMode): Promise<void> | undefined;
  /**
   * Adds a mutation restored from storage (its record is `id`) to the front of the replay queue, in
   * the order of the calls; `start` runs it. The replay starts at once when the connection is up.
   */
  adopt(id: number, start: () => void): void;
  /** Replays the queue now (see `QueryClient.resumePausedMutations`). */
  resume(): Promise<void>;
}

/** What the `scope` feature provides to the engine. @internal */
export interface ScopeExtension {
  /** Runs `task` after the calls of `id` made before it have settled. `task` must not reject. */
  run<T>(id: string, task: () => Promise<T>): Promise<T>;
}

/** What the `inspection` feature provides to the engine. @internal */
export interface InspectionExtension {
  /** Adds a listener; the returned function removes it. */
  subscribe(listener: (event: QueryCacheEvent) => void): () => void;
}

/**
 * What a feature is given when it is installed: the slots it fills and the engine parts it may use.
 * @internal
 */
export interface QueryFeatureHost {
  /** The slots (see {@link Extensions}). */
  readonly ext: Extensions;
  /** Stores a state patch of one entry; readers and cache listeners see it. */
  readonly setState: (entry: QueryEntry, patch: Partial<QueryState>) => void;
  /** The snapshot of one entry, as a cache listener receives it. */
  readonly info: (entry: QueryEntry) => QueryInfo;
  /** Reports an error that a user callback threw. */
  readonly reportCallbackError: (error: unknown) => void;
  /** Every entry of the cache, most recently used last. */
  readonly entries: () => Iterable<QueryEntry>;
  /** The entry of a key (created when missing). */
  readonly ensure: (key: QueryKey, hash: string) => QueryEntry;
  /** The state of one entry, untracked. */
  readonly state: (entry: QueryEntry) => QueryState;
  /** Writes successful data to one entry, with the time it was fetched. */
  readonly writeData: (entry: QueryEntry, data: unknown, updatedAt?: number) => void;
  /** The mutation records: list, add and change. */
  readonly mutations: {
    /** Every record, oldest first. */
    list(): readonly MutationRecord[];
    /** Adds a record; returns its id. */
    add(record: Omit<MutationRecord, "id">): number;
    /** Changes a record. */
    update(id: number, patch: Partial<Omit<MutationRecord, "id">>): void;
  };
  /** The `mutationCache` options the client was created with (its callbacks). */
  readonly mutationCache: MutationCacheOptions;
  /** Runs a user callback untracked; a throw is reported on a microtask, not rethrown. */
  readonly guard: (callback: () => void) => void;
}

/**
 * The error of a member or option that needs a feature the client was created without: it names the
 * feature and the subpath it is imported from.
 * @internal
 */
export function featureMissing(name: QueryFeatureName, what: string): TypeError {
  return new TypeError(
    `[shadow-query] ${what} needs the ${name} feature: import { ${name} } from "@shadow-js/query/${name}".`,
  );
}

/**
 * Refuses a network mode the client cannot honor: anything but `online` needs the `offline`
 * feature. Called for the default options and for each query.
 * @internal
 */
export function checkNetworkMode(mode: NetworkMode, ext: Extensions): void {
  if (mode !== "online" && ext.offline === undefined) {
    throw featureMissing("offline", `networkMode "${mode}"`);
  }
}

/**
 * Reads the `features` option: the features in the order given, a feature listed twice counted
 * once. A value that is not a feature, or two different features of one name, throws.
 * @internal
 */
export function collectFeatures(
  features: readonly QueryFeature[] | undefined,
): readonly QueryFeature[] {
  const out: QueryFeature[] = [];
  const byName = new Map<string, QueryFeature>();
  for (const feature of features ?? []) {
    if (typeof feature?.plug !== "function") {
      throw new TypeError("[shadow-query] features must hold query features, such as offline.");
    }
    const known = byName.get(feature.name);
    if (known === feature) continue;
    if (known !== undefined) {
      throw new TypeError(`[shadow-query] two different "${feature.name}" features were passed.`);
    }
    byName.set(feature.name, feature);
    out.push(feature);
  }
  return out;
}
