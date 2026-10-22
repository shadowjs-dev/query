import { flush, renderHook } from "@shadow-js/testing";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient, hashKey, useQuery } from "../src/index";
import { type PersistError, persist } from "../src/persist";
import { probe } from "./support/probe";
import { type MemoryStorage, memoryStorage } from "./support/storage";

const KEY = "shadow-query";

interface Stored {
  readonly v: number;
  readonly buster: string;
  readonly queries: ReadonlyArray<{
    readonly key: unknown[];
    readonly hash: string;
    readonly data: unknown;
    readonly updatedAt: number;
  }>;
}

function stored(storage: MemoryStorage, key = KEY): Stored {
  const text = storage.data.get(key);
  if (text === undefined) throw new Error(`nothing stored under ${key}`);
  return JSON.parse(text) as Stored;
}

beforeEach(() => {
  // The real channel of Node reaches other test files running at the same time; these tests use none.
  vi.stubGlobal("BroadcastChannel", undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("persist: writing", () => {
  it("[QRY-P1] a successful query is written after the throttle, once, with its key, hash, data and time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const storage = memoryStorage();
    const cache = persist({ storage });
    const qc = createQueryClient({ features: [cache] });
    qc.setCache(["todos"], ["a"]);
    qc.setCache(["todos"], ["a", "b"]);
    expect(storage.sets()).toBe(0);
    await vi.advanceTimersByTimeAsync(999);
    expect(storage.sets()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(storage.sets()).toBe(1);
    const blob = stored(storage);
    expect(blob.v).toBe(1);
    expect(blob.queries).toEqual([
      { key: ["todos"], hash: hashKey(["todos"]), data: ["a", "b"], updatedAt: 1_000_000 },
    ]);
    // Nothing changed since: no further write.
    await vi.advanceTimersByTimeAsync(5000);
    expect(storage.sets()).toBe(1);
    cache.dispose();
  });

  it("[QRY-P2] writes are throttled: many changes in one interval make one write; flush writes at once", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const cache = persist({ storage, throttleMs: 200 });
    const qc = createQueryClient({ features: [cache] });
    for (let index = 0; index < 20; index += 1) qc.setCache(["n", index], index);
    await vi.advanceTimersByTimeAsync(199);
    expect(storage.sets()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(storage.sets()).toBe(1);
    expect(stored(storage).queries).toHaveLength(20);
    qc.setCache(["late"], 1);
    await cache.flush();
    expect(storage.sets()).toBe(2);
    expect(stored(storage).queries).toHaveLength(21);
    // The timer of the change was canceled by the flush: nothing more is written.
    await vi.advanceTimersByTimeAsync(1000);
    expect(storage.sets()).toBe(2);
    cache.dispose();
  });

  it("[QRY-P3] errors, pending queries and a filtered-out query are never written; shouldPersist narrows further", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const cache = persist({
      storage,
      shouldPersist: (query) => query.queryKey[0] !== "secret",
    });
    const qc = createQueryClient({
      features: [cache],
      defaultOptions: { queries: { retry: false } },
    });
    qc.setCache(["public"], 1);
    qc.setCache(["secret"], 2);
    const failing = probe<number>();
    const failed = qc.prefetch(["broken"], failing.fetch);
    failing.reject(0, new Error("x"));
    await failed;
    const slow = probe<number>();
    void qc.prefetch(["slow"], slow.fetch);
    await cache.flush();
    expect(stored(storage).queries.map((query) => query.key)).toEqual([["public"]]);
    cache.dispose();
  });

  it("[QRY-P4] a query that becomes a failure or is removed leaves the stored copy at the next write", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const cache = persist({ storage });
    const qc = createQueryClient({
      features: [cache],
      defaultOptions: { queries: { gcTime: 100 } },
    });
    qc.setCache(["a"], 1);
    qc.setCache(["b"], 2);
    await cache.flush();
    expect(stored(storage).queries).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(101);
    // Both entries were garbage collected: the store is emptied, not left with stale copies.
    await cache.flush();
    expect(storage.data.has(KEY)).toBe(false);
    cache.dispose();
  });

  it("[QRY-P5] a data value that is not JSON is not written and is reported; the other queries are", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const errors: PersistError[] = [];
    const cache = persist({ storage, onError: (error) => errors.push(error) });
    const qc = createQueryClient({ features: [cache] });
    qc.setCache(["date"], new Date(0));
    qc.setCache(["ok"], { fine: true });
    await cache.flush();
    expect(stored(storage).queries.map((query) => query.key)).toEqual([["ok"]]);
    expect(errors.map((error) => error.kind)).toEqual(["serialize"]);
    expect(errors[0]?.message).toContain(hashKey(["date"]));
    // The same query is reported once, not on every write.
    qc.setCache(["ok"], { fine: false });
    await cache.flush();
    expect(errors).toHaveLength(1);
    cache.dispose();
  });

  it("[QRY-P6] size caps: an entry over maxEntryBytes is skipped; over maxBytes the oldest go first", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const errors: PersistError[] = [];
    const cache = persist({
      storage,
      maxEntryBytes: 300,
      maxBytes: 900,
      onError: (error) => errors.push(error),
    });
    const qc = createQueryClient({ features: [cache] });
    qc.setCache(["huge"], "x".repeat(1000));
    for (let index = 0; index < 8; index += 1) {
      vi.setSystemTime(10_000 + index);
      qc.setCache(["row", index], "y".repeat(100));
    }
    await cache.flush();
    const keys = stored(storage).queries.map((query) => query.key[1]);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.length).toBeLessThan(8);
    // The newest rows survive, the oldest were dropped.
    expect(keys.at(-1)).toBe(7);
    expect(keys).toEqual([...keys].sort((a, b) => Number(a) - Number(b)));
    expect(storage.data.get(KEY)?.length).toBeLessThanOrEqual(900);
    expect(errors.some((error) => error.kind === "size")).toBe(true);
    cache.dispose();
  });

  it("[QRY-P7] a write that fails never throws into the app: it is reported once as write, and the next change retries", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const errors: PersistError[] = [];
    const cache = persist({ storage, onError: (error) => errors.push(error) });
    const qc = createQueryClient({ features: [cache] });
    storage.failWrites(new Error("disk is gone"), 2);
    qc.setCache(["a"], 1);
    await expect(cache.flush()).resolves.toBeUndefined();
    qc.setCache(["a"], 2);
    await expect(cache.flush()).resolves.toBeUndefined();
    expect(errors.map((error) => error.kind)).toEqual(["write"]);
    expect((errors[0]?.cause as Error | undefined)?.message).toBe("disk is gone");
    qc.setCache(["a"], 3);
    await cache.flush();
    expect(stored(storage).queries[0]?.data).toBe(3);
    cache.dispose();
  });

  it("[QRY-P8] a quota error drops the oldest entries and retries, and ends with a smaller store", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const errors: PersistError[] = [];
    const cache = persist({ storage, onError: (error) => errors.push(error) });
    const qc = createQueryClient({ features: [cache] });
    for (let index = 0; index < 8; index += 1) {
      vi.setSystemTime(5000 + index);
      qc.setCache(["q", index], index);
    }
    const quota = new Error("full");
    quota.name = "QuotaExceededError";
    storage.failWrites(quota, 1);
    await cache.flush();
    const keys = stored(storage).queries.map((query) => query.key[1]);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.length).toBeLessThan(8);
    expect(keys.at(-1)).toBe(7);
    expect(errors.map((error) => error.kind)).toEqual(["quota"]);
    cache.dispose();
  });

  it("[QRY-P9] without onError a failure reaches the global error handler on a microtask, never the caller", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const cache = persist({ storage });
    const qc = createQueryClient({ features: [cache] });
    const thrown: unknown[] = [];
    const queue = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((task) => {
      try {
        task();
      } catch (error) {
        thrown.push(error);
      }
    });
    storage.failWrites(new Error("nope"), 1);
    qc.setCache(["a"], 1);
    await expect(cache.flush()).resolves.toBeUndefined();
    queue.mockRestore();
    expect(thrown).toHaveLength(1);
    expect((thrown[0] as PersistError).kind).toBe("write");
    cache.dispose();
  });
});

describe("persist: restoring", () => {
  function seeded(
    storage: MemoryStorage,
    queries: Stored["queries"],
    options: { readonly buster?: string; readonly v?: number } = {},
  ): void {
    const blob: Stored = { v: options.v ?? 1, buster: options.buster ?? "", queries };
    storage.data.set(KEY, JSON.stringify(blob));
  }
  const entry = (key: unknown[], data: unknown, updatedAt: number) => ({
    key,
    hash: hashKey(key as never),
    data,
    updatedAt,
  });

  it("[QRY-P10] with a synchronous storage the data is in the cache when the client is created: no loading state, no fetch while fresh", () => {
    const storage = memoryStorage();
    seeded(storage, [entry(["todos"], ["restored"], Date.now() - 1000)]);
    const qc = createQueryClient({ features: [persist({ storage })] });
    const fn = probe<string[]>();
    const view = renderHook(() => useQuery(["todos"], fn.fetch, { client: qc, staleTime: 60_000 }));
    expect(view.result.current.status()).toBe("success");
    expect(view.result.current.data()).toEqual(["restored"]);
    expect(fn.calls()).toBe(0);
    view.dispose();
  });

  it("[QRY-P11] restored data older than staleTime is shown at once and refetched in the background", async () => {
    const storage = memoryStorage();
    seeded(storage, [entry(["todos"], ["old"], Date.now() - 120_000)]);
    const qc = createQueryClient({ features: [persist({ storage })] });
    const fn = probe<string[]>();
    const view = renderHook(() => useQuery(["todos"], fn.fetch, { client: qc, staleTime: 60_000 }));
    expect(view.result.current.data()).toEqual(["old"]);
    expect(view.result.current.status()).toBe("success");
    expect(view.result.current.fetchStatus()).toBe("fetching");
    fn.resolve(0, ["new"]);
    await flush();
    expect(view.result.current.data()).toEqual(["new"]);
    view.dispose();
  });

  it("[QRY-P12] with an asynchronous storage `restored` resolves once the data is in; a fresher fetch is not overwritten", async () => {
    const storage = memoryStorage({ async: true });
    seeded(storage, [
      entry(["a"], "stored-a", Date.now() - 5000),
      entry(["b"], "stored-b", Date.now() - 5000),
    ]);
    const cache = persist({ storage });
    const qc = createQueryClient({ features: [cache] });
    expect(qc.getCache(["a"])).toBeUndefined();
    // A newer value is written before the storage answers.
    qc.setCache(["b"], "fresh-b");
    await cache.restored;
    expect(qc.getCache(["a"])).toBe("stored-a");
    expect(qc.getCache(["b"])).toBe("fresh-b");
    cache.dispose();
  });

  it("[QRY-P13] maxAge: entries older than it are not restored", () => {
    const storage = memoryStorage();
    const now = Date.now();
    seeded(storage, [entry(["old"], 1, now - 10_000), entry(["young"], 2, now - 1000)]);
    const qc = createQueryClient({ features: [persist({ storage, maxAge: 5000 })] });
    expect(qc.getCache(["old"])).toBeUndefined();
    expect(qc.getCache(["young"])).toBe(2);
  });

  it("[QRY-P14] a different buster drops the stored data: nothing is restored and the store is emptied", () => {
    const storage = memoryStorage();
    seeded(storage, [entry(["todos"], [1], Date.now())], { buster: "v1" });
    const qc = createQueryClient({ features: [persist({ storage, buster: "v2" })] });
    expect(qc.getCache(["todos"])).toBeUndefined();
    expect(storage.data.has(KEY)).toBe(false);
    const same = memoryStorage();
    seeded(same, [entry(["todos"], [1], Date.now())], { buster: "v2" });
    const kept = createQueryClient({ features: [persist({ storage: same, buster: "v2" })] });
    expect(kept.getCache(["todos"])).toEqual([1]);
  });

  it("[QRY-P15] a store that is corrupt, of another version, or tampered with is ignored, never thrown, and reported", () => {
    const errors: PersistError[] = [];
    const run = (setup: (storage: MemoryStorage) => void): ReturnType<typeof createQueryClient> => {
      const storage = memoryStorage();
      setup(storage);
      return createQueryClient({
        features: [persist({ storage, onError: (error) => errors.push(error) })],
      });
    };
    const now = Date.now();
    expect(run((storage) => storage.data.set(KEY, "{not json")).queryCache.size).toBe(0);
    expect(run((storage) => seeded(storage, [], { v: 2 })).queryCache.size).toBe(0);
    const badHash = run((storage) =>
      seeded(storage, [{ key: ["a"], hash: "tampered", data: 1, updatedAt: now }]),
    );
    expect(badHash.getCache(["a"])).toBeUndefined();
    const badShape = run((storage) =>
      storage.data.set(KEY, JSON.stringify({ v: 1, buster: "", queries: [null, 1, { key: "a" }] })),
    );
    expect(badShape.queryCache.size).toBe(0);
    const badTime = run((storage) =>
      seeded(storage, [entry(["a"], 1, Number.NaN), entry(["b"], 1, -5)]),
    );
    expect(badTime.queryCache.size).toBe(0);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((error) => error.kind === "restore")).toBe(true);
  });

  it("[QRY-P16] stored data with a __proto__ key is data: nothing is polluted and the prototype stays Object.prototype", () => {
    const storage = memoryStorage();
    const text = `{"v":1,"buster":"","queries":[{"key":["p"],"hash":${JSON.stringify(
      hashKey(["p"]),
    )},"data":{"__proto__":{"admin":true},"constructor":{"prototype":{"polluted":true}},"n":1},"updatedAt":${Date.now()}}]}`;
    storage.data.set(KEY, text);
    const qc = createQueryClient({ features: [persist({ storage })] });
    const data = qc.getCache<Record<string, unknown>>(["p"]);
    expect(data?.["n"]).toBe(1);
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["admin"]).toBeUndefined();
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.keys(data ?? {})).toContain("__proto__");
  });

  it("[QRY-P17] a time stamped in the future is clamped to now, so a clock that ran fast cannot keep data fresh forever", () => {
    const storage = memoryStorage();
    seeded(storage, [entry(["future"], 1, Date.now() + 10 * 86_400_000)]);
    const qc = createQueryClient({ features: [persist({ storage })] });
    const info = qc.queryCache.find({ key: ["future"] })[0];
    expect(info?.dataUpdatedAt).toBeLessThanOrEqual(Date.now());
  });

  it("[QRY-P18] a storage that throws or rejects on read is reported as restore and the client works", async () => {
    const errors: PersistError[] = [];
    const sync = memoryStorage();
    sync.failReads(new Error("locked"));
    const a = createQueryClient({
      features: [persist({ storage: sync, onError: (error) => errors.push(error) })],
    });
    expect(a.queryCache.size).toBe(0);
    const later = memoryStorage({ async: true });
    later.failReads(new Error("rejected"));
    const cache = persist({ storage: later, onError: (error) => errors.push(error) });
    const b = createQueryClient({ features: [cache] });
    await cache.restored;
    expect(b.queryCache.size).toBe(0);
    expect(errors.map((error) => error.kind)).toEqual(["restore", "restore"]);
    b.setCache(["still"], "works");
    expect(b.getCache(["still"])).toBe("works");
    cache.dispose();
  });

  it("[QRY-P19] a persist feature serves one client, and clear removes what is stored", async () => {
    const storage = memoryStorage();
    storage.data.set(`${KEY}:mutations`, "{}");
    const cache = persist({ storage });
    const qc = createQueryClient({ features: [cache] });
    qc.setCache(["a"], 1);
    await cache.flush();
    expect(storage.data.has(KEY)).toBe(true);
    expect(() => createQueryClient({ features: [cache] })).toThrow(TypeError);
    await cache.clear();
    expect(storage.data.has(KEY)).toBe(false);
    expect(storage.data.has(`${KEY}:mutations`)).toBe(false);
    cache.dispose();
  });

  it("[QRY-P31] restoring is not a change: nothing is written back after the data is read, and a bad option is refused", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    seeded(storage, [entry(["todos"], ["restored"], Date.now() - 1000)]);
    const cache = persist({ storage });
    const qc = createQueryClient({ features: [cache] });
    expect(qc.getCache(["todos"])).toEqual(["restored"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(storage.sets()).toBe(0);
    cache.dispose();
    const storageOptions = { storage: memoryStorage() };
    expect(() => persist({ ...storageOptions, maxAge: -1 })).toThrow(RangeError);
    expect(() => persist({ ...storageOptions, throttleMs: Number.NaN })).toThrow(RangeError);
    expect(() => persist({ ...storageOptions, maxBytes: Number.POSITIVE_INFINITY })).toThrow(
      RangeError,
    );
    expect(() => persist({ ...storageOptions, maxAge: Number.POSITIVE_INFINITY })).not.toThrow();
  });

  it("[QRY-P32] a restore that answers after dispose writes nothing into the client, and restored still settles", async () => {
    const storage = memoryStorage({ async: true });
    seeded(storage, [entry(["late"], 1, Date.now())]);
    const cache = persist({ storage });
    const qc = createQueryClient({ features: [cache] });
    cache.dispose();
    await cache.restored;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(qc.getCache(["late"])).toBeUndefined();
  });

  it("[QRY-P20] property: whatever JSON data and keys are written come back equal in a new client", async () => {
    const keyArb = fc.array(fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)), {
      minLength: 1,
      maxLength: 3,
    });
    const jsonArb = fc.jsonValue().map((value) => JSON.parse(JSON.stringify(value)) as unknown);
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(keyArb, jsonArb), { maxLength: 12 }), async (rows) => {
        const storage = memoryStorage();
        const writer = persist({ storage });
        const first = createQueryClient({ features: [writer] });
        const expected = new Map<string, unknown>();
        for (const [key, value] of rows) {
          first.setCache(key, value);
          expected.set(hashKey(key), value);
        }
        await writer.flush();
        writer.dispose();
        const second = createQueryClient({ features: [persist({ storage })] });
        expect(second.queryCache.size).toBe(expected.size);
        for (const info of second.queryCache.find()) {
          expect(info.data).toEqual(expected.get(info.queryHash));
        }
      }),
      { seed: 42, numRuns: 40 },
    );
  });
});
