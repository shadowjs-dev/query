/**
 * The `persist` feature: keeps the query cache in a storage (`localStorage`, IndexedDB, React Native
 * storage...) and restores it when the page loads, so a returning visitor sees data at once. It also
 * keeps the mutations that wait in the offline queue and replays them after a reload. Subpath
 * `@shadow-js/query/persist`; an app that does not import it pays nothing.
 *
 * Data is stored as JSON: plain objects, arrays, strings, finite numbers, booleans and `null`. A query
 * that holds anything else (a `Date`, a `Map`, a class instance) is not kept and is reported.
 * @packageDocumentation
 */
import { defaultRetryDelay, type MutationRecord, withRetries } from "./internal/core";
import {
  addMutationWatcher,
  addWatcher,
  featureMissing,
  type QueryFeatureHost,
} from "./internal/features";
import { hashKey, type QueryKey } from "./key";
import { jsonProblem } from "./serial";
import type {
  PersistError,
  PersistErrorKind,
  PersistedMutation,
  PersistFeature,
  PersistOptions,
  PersistStorage,
} from "./types";

export type {
  PersistError,
  PersistErrorKind,
  PersistedMutation,
  PersistFeature,
  PersistOptions,
  PersistStorage,
};

/** What was last seen of one query: its data, its time, and its stored text (`undefined`: left out). */
interface Seen {
  readonly data: unknown;
  readonly updatedAt: number;
  readonly text: string | undefined;
}

/** A mutation as it is stored. */
interface StoredMutation {
  readonly id: string;
  readonly key: QueryKey;
  readonly variables: unknown;
  readonly submittedAt: number;
}

const FORMAT = 1;
const MAX_REPORTED = 64;
const QUOTA_RETRIES = 4;

function isQuota(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, code } = error as { readonly name?: unknown; readonly code?: unknown };
  return (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    code === 22 ||
    code === 1014
  );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly then?: unknown }).then === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkNumber(value: number, name: string, allowInfinity: boolean): number {
  if (Number.isNaN(value) || value < 0 || (!allowInfinity && !Number.isFinite(value))) {
    throw new RangeError(`persist: ${name} must be a non-negative number, got ${value}`);
  }
  return value;
}

/**
 * Creates the `persist` feature: it keeps the successful queries of a client in a storage and restores
 * them when the client is created.
 *
 * - Restore: with a synchronous storage (`localStorage`) the data is in the cache when `createQueryClient`
 *   returns, so the first render shows it with no loading state, and a query that is still fresh
 *   (`staleTime`) is not fetched. With an asynchronous storage, wait for `restored` before rendering. An
 *   entry that is older than `maxAge`, written under another `buster`, tampered with, or newer data than
 *   the one the client already holds is not restored over it.
 * - Write: after a change, once per `throttleMs` (1 s), and at once when the page is hidden or closed.
 *   Errors, pending queries and mutations are never written. A write that fails, a full storage and data
 *   that is not JSON never throw into your code: they go to `onError`.
 * - Other tabs: when `BroadcastChannel` exists, a tab that writes tells the others, which read and merge
 *   what is newer.
 * - Paused mutations: list the mutations to keep in `mutations`, together with the `queue` feature
 *   (before `persist`). Calls made offline are stored and replayed after a reload (see
 *   {@link PersistedMutation}).
 *
 * One call serves one client. Call `dispose()` on a client you throw away while the page lives on.
 *
 * @param options The storage and the limits (see {@link PersistOptions}).
 * @returns The feature, to pass in `createQueryClient({ features })`, with `restored`, `flush`, `clear`
 * and `dispose`.
 * @throws RangeError when `maxAge`, `throttleMs`, `maxEntryBytes` or `maxBytes` is negative or not a
 * number (only `maxAge` may be `Infinity`).
 * @throws TypeError when a `mutationKey` in `mutations` is not plain data (see `hashKey`).
 * @throws TypeError, when the feature is installed, if `mutations` is set and the client has no `queue`
 * feature before it, or if the feature was already installed on another client.
 * @example
 * import { createQueryClient } from "@shadow-js/query";
 * import { persist } from "@shadow-js/query/persist";
 *
 * const cache = persist({ storage: localStorage, buster: "2025-10", maxAge: 6 * 3_600_000 });
 * export const client = createQueryClient({
 *   defaultOptions: { queries: { staleTime: 30_000, gcTime: 6 * 3_600_000 } },
 *   features: [cache],
 * });
 * // In a page that writes its own storage, flush before leaving: await cache.flush();
 * @see PersistedMutation
 * @since 1.0.0
 */
export function persist(options: PersistOptions): PersistFeature {
  const storage: PersistStorage = options.storage;
  const key = options.key ?? "shadow-query";
  const mutationsKey = `${key}:mutations`;
  const buster = options.buster ?? "";
  const maxAge = checkNumber(options.maxAge ?? 86_400_000, "maxAge", true);
  const throttleMs = checkNumber(options.throttleMs ?? 1000, "throttleMs", false);
  const maxEntryBytes = checkNumber(options.maxEntryBytes ?? 262_144, "maxEntryBytes", false);
  const maxBytes = checkNumber(options.maxBytes ?? 2_097_152, "maxBytes", false);
  const shouldPersist = options.shouldPersist;
  const definitions = new Map<string, PersistedMutation>();
  for (const definition of options.mutations ?? []) {
    definitions.set(hashKey(definition.mutationKey), definition);
  }
  const head = `{"v":${FORMAT},"buster":${JSON.stringify(buster)},"queries":[`;
  const tail = "]}";

  let host: QueryFeatureHost | undefined;
  let disposed = false;
  let restoring = false;
  /** The queries as they were last encoded, by hash. */
  const seen = new Map<string, Seen>();
  const reported = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  let writing: Promise<void> | undefined;
  let lastWritten: string | undefined;
  let storeMayExist = false;
  let bus: BroadcastChannel | undefined;
  let pulling = false;
  let pullAgain = false;
  const tab = Math.random().toString(36).slice(2);
  // Paused mutations: this tab's stored calls by stored id, the ones to remove, and the record each belongs to.
  const owned = new Map<string, string>();
  const gone = new Set<string>();
  const recordOf = new Map<number, string>();
  const releases = new Map<string, () => void>();
  let adopting: string | undefined;
  let mutationsQueued = false;
  let mutationsWriting: Promise<void> = Promise.resolve();
  const teardown: Array<() => void> = [];
  let resolveRestored: () => void = () => undefined;
  const restored = new Promise<void>((resolve) => {
    resolveRestored = resolve;
  });
  let outstanding = 0;
  const begin = (): void => {
    outstanding += 1;
  };
  const end = (): void => {
    outstanding -= 1;
    if (outstanding === 0) resolveRestored();
  };

  function report(kind: PersistErrorKind, message: string, cause?: unknown, id?: string): void {
    const dedupe = id ?? kind;
    if (host === undefined || reported.has(dedupe)) return;
    if (reported.size >= MAX_REPORTED) reported.clear();
    reported.add(dedupe);
    const error = Object.assign(new Error(`[shadow-query] persist: ${message}`, { cause }), {
      name: "PersistError",
      kind,
    }) satisfies PersistError;
    if (options.onError === undefined) {
      host.reportCallbackError(error);
      return;
    }
    const onError = options.onError;
    host.guard(() => onError(error));
  }

  /** Calls `fn` with the value now when it is a plain value, or when the promise settles. Never throws. */
  function whenSettled<T>(
    read: () => T | PromiseLike<T>,
    fn: (value: T) => void,
    fail: (error: unknown) => void,
  ): void {
    let value: T | PromiseLike<T>;
    try {
      value = read();
    } catch (error) {
      fail(error);
      return;
    }
    if (isThenable(value)) {
      (value as PromiseLike<T>).then(
        (resolved) => {
          try {
            fn(resolved);
          } catch (error) {
            fail(error);
          }
        },
        (error: unknown) => fail(error),
      );
      return;
    }
    try {
      fn(value);
    } catch (error) {
      fail(error);
    }
  }

  /** Removes a stored key; a failure is ignored (the next write replaces it anyway). */
  function drop(storageKey: string): void {
    whenSettled(
      () => storage.removeItem(storageKey),
      () => undefined,
      () => undefined,
    );
  }

  // ---- restore --------------------------------------------------------------------------------

  /** Reads a stored cache into the client; an entry the client holds with newer data is kept. */
  function restoreQueries(raw: string | null | undefined): void {
    if (host === undefined || disposed || raw === null || raw === undefined) return;
    storeMayExist = true;
    if (raw.length > maxBytes) {
      report("size", `the stored cache is ${raw.length} characters, over maxBytes; it is ignored`);
      drop(key);
      return;
    }
    let blob: unknown;
    try {
      blob = JSON.parse(raw);
    } catch (cause) {
      report("restore", "the stored cache is not JSON; it is ignored", cause);
      drop(key);
      return;
    }
    if (!isRecord(blob) || blob["v"] !== FORMAT || !Array.isArray(blob["queries"])) {
      report("restore", "the stored cache has another format; it is ignored");
      drop(key);
      return;
    }
    if (blob["buster"] !== buster) {
      // The data was written for another version of the app: it is dropped without a report.
      drop(key);
      storeMayExist = false;
      return;
    }
    const now = Date.now();
    restoring = true;
    try {
      for (const item of blob["queries"] as unknown[]) {
        if (!isRecord(item)) {
          report("restore", "a stored query is not an object; it is ignored", undefined, "r:shape");
          continue;
        }
        const queryKey = item["key"];
        const updatedAt = item["updatedAt"];
        if (!Array.isArray(queryKey)) {
          report("restore", "a stored query has no key; it is ignored", undefined, "r:key");
          continue;
        }
        let hash: string;
        try {
          hash = hashKey(queryKey);
        } catch (cause) {
          report("restore", "a stored query key is not plain data; it is ignored", cause, "r:key");
          continue;
        }
        if (item["hash"] !== hash) {
          report(
            "restore",
            "a stored query hash does not match its key; it is ignored",
            undefined,
            "r:hash",
          );
          continue;
        }
        if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt < 0) {
          report("restore", "a stored query time is not valid; it is ignored", undefined, "r:time");
          continue;
        }
        const data = item["data"];
        // `undefined` is not JSON: a stored entry without data is a corrupt entry.
        if (data === undefined || jsonProblem(data) !== undefined) {
          report(
            "restore",
            "a stored query holds data that is not plain JSON; it is ignored",
            undefined,
            "r:data",
          );
          continue;
        }
        if (now - updatedAt > maxAge) continue;
        const entry = host.ensure(queryKey, hash);
        const current = host.state(entry);
        const time = Math.min(updatedAt, now);
        if (current.status === "success" && current.updatedAt >= time) continue;
        host.writeData(entry, data, time);
      }
    } finally {
      restoring = false;
    }
  }

  /** Reads a stored list of mutations and puts the ones this tab can run in the queue. */
  function restoreMutations(raw: string | null | undefined): void {
    if (host === undefined || disposed || raw === null || raw === undefined) return;
    let blob: unknown;
    try {
      blob = JSON.parse(raw);
    } catch (cause) {
      report("restore", "the stored mutations are not JSON; they are ignored", cause, "m:json");
      drop(mutationsKey);
      return;
    }
    if (!isRecord(blob) || blob["v"] !== FORMAT || !Array.isArray(blob["mutations"])) {
      report(
        "restore",
        "the stored mutations have another format; they are ignored",
        undefined,
        "m:format",
      );
      drop(mutationsKey);
      return;
    }
    if (blob["buster"] !== buster) {
      drop(mutationsKey);
      return;
    }
    const now = Date.now();
    const found: StoredMutation[] = [];
    for (const item of blob["mutations"] as unknown[]) {
      if (
        !isRecord(item) ||
        typeof item["id"] !== "string" ||
        !Array.isArray(item["key"]) ||
        typeof item["submittedAt"] !== "number" ||
        !Number.isFinite(item["submittedAt"]) ||
        jsonProblem(item["variables"] ?? null) !== undefined
      ) {
        report("restore", "a stored mutation is not valid; it is ignored", undefined, "m:item");
        continue;
      }
      if (now - item["submittedAt"] > maxAge || owned.has(item["id"])) continue;
      found.push({
        id: item["id"],
        key: item["key"],
        variables: item["variables"] ?? null,
        submittedAt: item["submittedAt"],
      });
    }
    found.sort((a, b) => a.submittedAt - b.submittedAt);
    // Another live tab may hold a stored call (it is waiting in that tab's queue): the lock tells.
    let chain: Promise<void> | undefined;
    for (const stored of found) {
      const claimed = claim(stored.id);
      if (claimed === true && chain === undefined) {
        adopt(stored);
        continue;
      }
      begin();
      chain = (chain ?? Promise.resolve())
        .then(() => claimed)
        .then((ok) => {
          if (ok) adopt(stored);
        })
        .then(end, end);
    }
  }

  /** Takes the lock of a stored call (`true`), or finds it held by a live tab (`false`). */
  function claim(id: string): boolean | Promise<boolean> {
    const locks: LockManager | null | undefined =
      typeof navigator === "undefined" ? undefined : navigator.locks;
    if (!locks) return true;
    return new Promise<boolean>((resolve) => {
      locks
        .request(`${key}:mutation:${id}`, { ifAvailable: true }, (lock) => {
          if (lock === null) {
            resolve(false);
            return undefined;
          }
          resolve(true);
          return new Promise<void>((release) => {
            releases.set(id, release);
          });
        })
        .catch(() => resolve(true));
    });
  }

  /** Holds the lock of a call this tab stored, until the call is done. */
  function holdLock(id: string): void {
    void claim(id);
  }

  function adopt(stored: StoredMutation): void {
    if (host === undefined || disposed) return;
    const definition = definitions.get(hashKey(stored.key));
    const queue = host.ext.queue;
    if (definition === undefined || queue === undefined) {
      releases.get(stored.id)?.();
      releases.delete(stored.id);
      return;
    }
    adopting = stored.id;
    let id: number;
    try {
      id = host.mutations.add({
        mutationKey: stored.key,
        status: "pending",
        variables: stored.variables,
        data: undefined,
        error: undefined,
        submittedAt: stored.submittedAt,
        isPaused: true,
      });
    } finally {
      adopting = undefined;
    }
    recordOf.set(id, stored.id);
    owned.set(stored.id, JSON.stringify(stored));
    queue.adopt(id, () => {
      void replay(id, definition, stored.variables);
    });
  }

  /** Runs a restored call the way `useMutation` runs one, and records how it ended. */
  async function replay(
    id: number,
    definition: PersistedMutation,
    variables: unknown,
  ): Promise<void> {
    if (host === undefined) return;
    const target = host;
    const never = new AbortController().signal;
    const notify = (ok: boolean, data: unknown, error: unknown): void => {
      const info = target.mutations.list().find((record) => record.id === id);
      if (info === undefined) return;
      const cache = target.mutationCache;
      target.guard(() => (ok ? cache.onSuccess?.(data, info) : cache.onError?.(error, info)));
    };
    try {
      const data = await withRetries(
        () => definition.mutationFn(variables),
        {
          retry: definition.retry ?? 0,
          retryDelay: definition.retryDelay ?? defaultRetryDelay,
        },
        never,
      );
      target.mutations.update(id, { status: "success", data });
      target.guard(() => definition.onSuccess?.(data, variables));
      target.guard(() => definition.onSettled?.(data, undefined, variables));
      notify(true, data, undefined);
    } catch (error) {
      target.mutations.update(id, { status: "error", error });
      target.guard(() => definition.onError?.(error, variables));
      target.guard(() => definition.onSettled?.(undefined, error, variables));
      notify(false, undefined, error);
    }
  }

  // ---- write ----------------------------------------------------------------------------------

  /** The stored text of one query, or `undefined` when it cannot or may not be kept. */
  function encode(hash: string, queryKey: QueryKey, data: unknown, updatedAt: number): Seen {
    const problem = jsonProblem(queryKey) ?? jsonProblem(data);
    if (problem !== undefined) {
      report(
        "serialize",
        `query ${hash} holds ${problem}; it is not persisted`,
        undefined,
        `s:${hash}`,
      );
      return { data, updatedAt, text: undefined };
    }
    let text: string;
    try {
      text = JSON.stringify({ key: queryKey, hash, data, updatedAt });
    } catch (cause) {
      report(
        "serialize",
        `query ${hash} cannot be written as JSON; it is not persisted`,
        cause,
        `s:${hash}`,
      );
      return { data, updatedAt, text: undefined };
    }
    if (text.length > maxEntryBytes) {
      report(
        "size",
        `query ${hash} takes ${text.length} characters, over maxEntryBytes; it is not persisted`,
        undefined,
        `z:${hash}`,
      );
      return { data, updatedAt, text: undefined };
    }
    return { data, updatedAt, text };
  }

  /** The entries to store, oldest first. Unchanged entries reuse their text. */
  function collect(): Array<{ readonly text: string; readonly updatedAt: number }> {
    if (host === undefined) return [];
    const rows: Array<{ readonly text: string; readonly updatedAt: number }> = [];
    const alive = new Set<string>();
    for (const entry of host.entries()) {
      const state = host.state(entry);
      if (state.status !== "success" || state.data === undefined) continue;
      alive.add(entry.hash);
      let cached = seen.get(entry.hash);
      if (
        cached === undefined ||
        cached.data !== state.data ||
        cached.updatedAt !== state.updatedAt
      ) {
        cached = encode(entry.hash, entry.key, state.data, state.updatedAt);
        seen.set(entry.hash, cached);
      }
      if (cached.text === undefined) continue;
      if (shouldPersist !== undefined) {
        let keep = false;
        const info = host.info(entry);
        host.guard(() => {
          keep = shouldPersist(info) !== false;
        });
        if (!keep) continue;
      }
      rows.push({ text: cached.text, updatedAt: state.updatedAt });
    }
    for (const hash of [...seen.keys()]) if (!alive.has(hash)) seen.delete(hash);
    rows.sort((a, b) => a.updatedAt - b.updatedAt);
    return rows;
  }

  /** The text of a list of entries, with the oldest dropped until it fits `limit`. */
  function pack(
    rows: ReadonlyArray<{ readonly text: string }>,
    limit: number,
  ): { readonly text: string; readonly kept: number } {
    let first = 0;
    let size = head.length + tail.length;
    for (const row of rows) size += row.text.length + 1;
    while (first < rows.length && size > limit) {
      size -= (rows[first]?.text.length ?? 0) + 1;
      first += 1;
    }
    if (first > 0) {
      report(
        "size",
        `${first} of the oldest queries were dropped to stay under ${limit} characters`,
      );
    }
    const kept = rows.slice(first).map((row) => row.text);
    return { text: head + kept.join(",") + tail, kept: kept.length };
  }

  /**
   * Runs one storage call. Returns nothing when the storage answered at once (a synchronous storage, so
   * a write on `pagehide` is done before the event ends), else a promise of the follow-up.
   */
  function settle(
    call: () => void | PromiseLike<void>,
    ok: () => Promise<void> | undefined,
    fail: (cause: unknown) => Promise<void> | undefined,
  ): Promise<void> | undefined {
    let result: void | PromiseLike<void>;
    try {
      result = call();
    } catch (cause) {
      return fail(cause);
    }
    if (isThenable(result)) return Promise.resolve(result).then(ok, fail);
    return ok();
  }

  /** Writes the entries; a full storage is retried with the oldest half dropped. Never throws. */
  function attempt(
    rows: ReadonlyArray<{ readonly text: string }>,
    limit: number,
    tries: number,
  ): Promise<void> | undefined {
    const { text, kept } = pack(rows, limit);
    if (kept === 0) {
      if (!storeMayExist) return undefined;
      return settle(
        () => storage.removeItem(key),
        () => {
          storeMayExist = false;
          lastWritten = undefined;
          bus?.postMessage({ from: tab });
          return undefined;
        },
        (cause) => {
          report("write", "the storage refused to delete the cache", cause);
          return undefined;
        },
      );
    }
    if (text === lastWritten && storeMayExist) return undefined;
    return settle(
      () => storage.setItem(key, text),
      () => {
        lastWritten = text;
        storeMayExist = true;
        reported.delete("write");
        reported.delete("quota");
        bus?.postMessage({ from: tab });
        return undefined;
      },
      (cause) => {
        if (isQuota(cause) && tries < QUOTA_RETRIES && rows.length > 1) {
          report("quota", "the storage is full; the oldest queries are dropped to fit", cause);
          return attempt(
            rows.slice(Math.ceil(rows.length / 2)),
            Math.min(limit, text.length),
            tries + 1,
          );
        }
        report(isQuota(cause) ? "quota" : "write", "the storage refused the cache", cause);
        return undefined;
      },
    );
  }

  /** Writes what changed, then again if more changed meanwhile. Synchronous when the storage is. */
  function write(): Promise<void> {
    if (disposed || host === undefined) return Promise.resolve();
    if (writing !== undefined) return writing;
    while (dirty) {
      dirty = false;
      const pending = attempt(collect(), maxBytes, 0);
      if (pending !== undefined) {
        const run = pending.then(() => {
          writing = undefined;
          return write();
        });
        writing = run;
        return run;
      }
    }
    return Promise.resolve();
  }

  function flush(): Promise<void> {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    // The paused mutations are written on a microtask of their own: wait for that write too.
    return Promise.all([write(), Promise.resolve().then(() => mutationsWriting)]).then(
      () => undefined,
    );
  }

  function schedule(): void {
    dirty = true;
    if (timer !== undefined || disposed) return;
    timer = setTimeout(() => {
      timer = undefined;
      void write();
    }, throttleMs);
  }

  /** Writes the paused mutations of this tab, keeping the ones other tabs stored. */
  function scheduleMutations(): void {
    if (mutationsQueued || disposed) return;
    mutationsQueued = true;
    void Promise.resolve().then(() => {
      mutationsQueued = false;
      mutationsWriting = mutationsWriting.then(commitMutations);
    });
  }

  async function commitMutations(): Promise<void> {
    const removing = [...gone];
    gone.clear();
    try {
      const current = await storage.getItem(mutationsKey);
      const texts: string[] = [];
      if (typeof current === "string") {
        try {
          const blob: unknown = JSON.parse(current);
          if (isRecord(blob) && blob["v"] === FORMAT && Array.isArray(blob["mutations"])) {
            for (const item of blob["mutations"] as unknown[]) {
              if (!isRecord(item) || typeof item["id"] !== "string") continue;
              if (removing.includes(item["id"]) || owned.has(item["id"])) continue;
              texts.push(JSON.stringify(item));
            }
          }
        } catch {
          // A corrupt list is replaced by this tab's own calls.
        }
      }
      for (const text of owned.values()) texts.push(text);
      if (texts.length === 0) {
        await storage.removeItem(mutationsKey);
        return;
      }
      await storage.setItem(
        mutationsKey,
        `{"v":${FORMAT},"buster":${JSON.stringify(buster)},"mutations":[${texts.join(",")}]}`,
      );
      reported.delete("mutations");
    } catch (cause) {
      for (const id of removing) gone.add(id);
      report("write", "the storage refused the paused mutations", cause, "mutations");
    }
  }

  // ---- other tabs and the page ----------------------------------------------------------------

  function pull(): void {
    if (pulling) {
      pullAgain = true;
      return;
    }
    pulling = true;
    begin();
    const done = (): void => {
      pulling = false;
      end();
      if (pullAgain && !disposed) {
        pullAgain = false;
        pull();
      }
    };
    whenSettled(
      () => storage.getItem(key),
      (raw) => {
        if (!disposed) restoreQueries(raw);
        done();
      },
      (cause) => {
        report("restore", "the storage could not be read", cause);
        done();
      },
    );
  }

  function clear(): Promise<void> {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    dirty = false;
    lastWritten = undefined;
    storeMayExist = false;
    owned.clear();
    return Promise.all([
      Promise.resolve().then(() => storage.removeItem(key)),
      Promise.resolve().then(() => storage.removeItem(mutationsKey)),
    ]).then(
      () => undefined,
      () => undefined,
    );
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    for (const undo of teardown.splice(0)) undo();
    for (const release of releases.values()) release();
    releases.clear();
    seen.clear();
    owned.clear();
    gone.clear();
    recordOf.clear();
    reported.clear();
    resolveRestored();
  }

  return {
    name: "persist",
    restored,
    flush,
    clear,
    dispose,
    plug(target: QueryFeatureHost): void {
      if (host !== undefined) {
        throw new TypeError(
          "[shadow-query] a persist feature serves one client; call persist() again.",
        );
      }
      if (definitions.size > 0 && target.ext.queue === undefined) {
        throw featureMissing(
          "queue",
          "the mutations option of persist (list queue before persist)",
        );
      }
      host = target;
      addWatcher(target.ext, (type, entry) => {
        if (restoring || disposed) return;
        const state = target.state(entry);
        const before = seen.get(entry.hash);
        const keepable = state.status === "success" && state.data !== undefined;
        if (type === "removed" || !keepable) {
          if (before?.text !== undefined) schedule();
        } else if (
          before === undefined ||
          before.data !== state.data ||
          before.updatedAt !== state.updatedAt
        ) {
          schedule();
        }
      });
      if (definitions.size > 0) {
        addMutationWatcher(target.ext, (record: MutationRecord) => {
          if (disposed) return;
          const known = recordOf.get(record.id);
          if (record.status === "pending") {
            if (adopting !== undefined) {
              recordOf.set(record.id, adopting);
              return;
            }
            if (!record.isPaused || known !== undefined || record.mutationKey === undefined) return;
            let hash: string;
            try {
              hash = hashKey(record.mutationKey);
            } catch {
              return;
            }
            if (!definitions.has(hash)) return;
            if (jsonProblem(record.variables ?? null) !== undefined) {
              report(
                "serialize",
                `a call of mutation ${hash} holds variables that are not JSON; it is not persisted`,
                undefined,
                `s:${hash}`,
              );
              return;
            }
            const id = `${tab}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
            recordOf.set(record.id, id);
            owned.set(
              id,
              JSON.stringify({
                id,
                key: record.mutationKey,
                variables: record.variables ?? null,
                submittedAt: record.submittedAt,
              }),
            );
            holdLock(id);
            scheduleMutations();
          } else if (known !== undefined) {
            recordOf.delete(record.id);
            owned.delete(known);
            gone.add(known);
            releases.get(known)?.();
            releases.delete(known);
            scheduleMutations();
          }
        });
      }
      // The page: write when it is hidden or closed.
      const flushNow = (): void => {
        void flush();
      };
      const onVisibility = (): void => {
        if (document.visibilityState === "hidden") flushNow();
      };
      if (typeof window !== "undefined") {
        window.addEventListener("pagehide", flushNow);
        teardown.push(() => window.removeEventListener("pagehide", flushNow));
      }
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", onVisibility);
        teardown.push(() => document.removeEventListener("visibilitychange", onVisibility));
      }
      // Other tabs: read what they wrote.
      if (
        options.broadcast !== false &&
        typeof window !== "undefined" &&
        typeof BroadcastChannel === "function"
      ) {
        const channel = new BroadcastChannel(key);
        bus = channel;
        channel.onmessage = (event: MessageEvent<unknown>): void => {
          const data = event.data;
          if (isRecord(data) && data["from"] !== tab && !disposed) pull();
        };
        teardown.push(() => {
          channel.onmessage = null;
          channel.close();
          bus = undefined;
        });
      }
      // Restore. A synchronous storage answers inside these calls, before `createQueryClient` returns.
      begin();
      if (definitions.size > 0) begin();
      whenSettled(
        () => storage.getItem(key),
        (raw) => {
          try {
            restoreQueries(raw);
          } catch (cause) {
            report("restore", "the stored cache could not be restored", cause);
          } finally {
            end();
          }
        },
        (cause) => {
          report("restore", "the storage could not be read", cause);
          end();
        },
      );
      if (definitions.size > 0) {
        whenSettled(
          () => storage.getItem(mutationsKey),
          (raw) => {
            try {
              restoreMutations(raw);
            } catch (cause) {
              report("restore", "the stored mutations could not be restored", cause, "m:restore");
            } finally {
              end();
            }
          },
          (cause) => {
            report("restore", "the stored mutations could not be read", cause, "m:read");
            end();
          },
        );
      }
    },
  };
}
