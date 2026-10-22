import { flush, renderHook } from "@shadow-js/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient, hashKey, useMutation } from "../src/index";
import { type PersistError, type PersistedMutation, persist } from "../src/persist";
import { queue } from "../src/queue";
import { type MemoryStorage, memoryStorage } from "./support/storage";

const KEY = "shadow-query";

function setOnline(online: boolean): void {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
  window.dispatchEvent(new Event(online ? "online" : "offline"));
}

/** A BroadcastChannel stand-in: every channel of one name hears the others, on a later turn. */
class FakeChannel {
  static readonly open = new Map<string, Set<FakeChannel>>();
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  readonly name: string;
  constructor(name: string) {
    this.name = name;
    const set = FakeChannel.open.get(name) ?? new Set<FakeChannel>();
    set.add(this);
    FakeChannel.open.set(name, set);
  }
  postMessage(data: unknown): void {
    for (const other of FakeChannel.open.get(this.name) ?? []) {
      if (other === this) continue;
      queueMicrotask(() => other.onmessage?.({ data }));
    }
  }
  close(): void {
    FakeChannel.open.get(this.name)?.delete(this);
  }
  static count(): number {
    return [...FakeChannel.open.values()].reduce((sum, set) => sum + set.size, 0);
  }
}

/** Web Locks stand-in: `ifAvailable` answers `null` while another holder has the name. */
function fakeLocks(): {
  readonly request: (
    name: string,
    options: { readonly ifAvailable?: boolean },
    callback: (lock: object | null) => unknown,
  ) => Promise<unknown>;
  readonly held: Set<string>;
} {
  const held = new Set<string>();
  return {
    held,
    request: (name, options, callback) => {
      if (options.ifAvailable === true && held.has(name)) return Promise.resolve(callback(null));
      held.add(name);
      return Promise.resolve(callback({ name })).finally(() => held.delete(name));
    },
  };
}

beforeEach(() => {
  // The real channel of Node reaches other test files running at the same time; these tests use none.
  vi.stubGlobal("BroadcastChannel", undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeChannel.open.clear();
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
  Reflect.deleteProperty(navigator, "locks");
});

describe("persist: the page and other tabs", () => {
  it("[QRY-P21] the store is written at once when the page is hidden or closed, not when it becomes visible", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const cache = persist({ storage });
    const qc = createQueryClient({ features: [cache] });
    qc.setCache(["a"], 1);
    expect(storage.sets()).toBe(0);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(storage.sets()).toBe(0);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(storage.sets()).toBe(1);
    qc.setCache(["b"], 2);
    window.dispatchEvent(new Event("pagehide"));
    expect(storage.sets()).toBe(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    cache.dispose();
  });

  it("[QRY-P22] dispose removes the listeners and the channel and stops writing; stored data stays", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    const storage = memoryStorage();
    const addWindow = vi.spyOn(window, "addEventListener");
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const addDocument = vi.spyOn(document, "addEventListener");
    const removeDocument = vi.spyOn(document, "removeEventListener");
    const cache = persist({ storage });
    const qc = createQueryClient({ features: [cache] });
    expect(FakeChannel.count()).toBe(1);
    qc.setCache(["a"], 1);
    await cache.flush();
    expect(storage.sets()).toBe(1);
    qc.setCache(["b"], 2);
    cache.dispose();
    expect(FakeChannel.count()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    window.dispatchEvent(new Event("pagehide"));
    expect(storage.sets()).toBe(1);
    expect(storage.data.has(KEY)).toBe(true);
    const names = (spy: typeof addWindow): string[] =>
      spy.mock.calls
        .map((call) => String(call[0]))
        .filter((name) => name === "pagehide" || name === "visibilitychange");
    expect(names(removeWindow).sort()).toEqual(names(addWindow).sort());
    expect(names(removeDocument).sort()).toEqual(names(addDocument).sort());
    // Only the garbage collection timers of the two cached queries are left; the feature owns none.
    expect(vi.getTimerCount()).toBe(qc.queryCache.size);
  });

  it("[QRY-P23] a tab that writes tells the others, which read and keep the newer entries, and do not write back", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    const storage = memoryStorage();
    const first = persist({ storage });
    const a = createQueryClient({ features: [first] });
    const second = persist({ storage });
    const b = createQueryClient({ features: [second] });
    b.setCache(["shared"], "from-b");
    await second.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(a.getCache(["shared"])).toBe("from-b");
    vi.setSystemTime(Date.now() + 5000);
    a.setCache(["shared"], "from-a");
    a.setCache(["only-a"], 1);
    await first.flush();
    await vi.advanceTimersByTimeAsync(0);
    // B read the write of A: the newer value of "shared" and the new key.
    expect(b.getCache(["shared"])).toBe("from-a");
    expect(b.getCache(["only-a"])).toBe(1);
    // Neither tab changed anything since, so neither writes: the merge is not echoed.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(storage.sets()).toBe(2);
    // An older value in the store does not replace a newer one.
    const older = {
      v: 1,
      buster: "",
      queries: [{ key: ["shared"], hash: hashKey(["shared"]), data: "ancient", updatedAt: 1 }],
    };
    storage.data.set(KEY, JSON.stringify(older));
    new FakeChannel(KEY).postMessage({ from: "someone else" });
    await vi.advanceTimersByTimeAsync(0);
    expect(a.getCache(["shared"])).toBe("from-a");
    expect(b.getCache(["shared"])).toBe("from-a");
    first.dispose();
    second.dispose();
  });

  it("[QRY-P24] persist can be turned off for other tabs with broadcast: false", () => {
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    const cache = persist({ storage: memoryStorage(), broadcast: false });
    createQueryClient({ features: [cache] });
    expect(FakeChannel.count()).toBe(0);
    cache.dispose();
  });
});

describe("persist: paused mutations", () => {
  /** A definition whose function the test settles by hand. */
  function definition(log: string[]): {
    readonly definition: PersistedMutation;
    readonly resolve: (index: number) => void;
    readonly reject: (index: number, error: unknown) => void;
    readonly calls: () => number;
  } {
    const open: Array<{ resolve: (value: string) => void; reject: (error: unknown) => void }> = [];
    return {
      definition: {
        mutationKey: ["save"],
        mutationFn: (variables) =>
          new Promise<string>((resolve, reject) => {
            log.push(`run:${String(variables)}`);
            open.push({ resolve, reject });
          }),
        onSuccess: (data, variables) => log.push(`success:${String(variables)}:${String(data)}`),
        onError: (error, variables) =>
          log.push(`error:${String(variables)}:${(error as Error).message}`),
        onSettled: (_data, _error, variables) => log.push(`settled:${String(variables)}`),
      },
      resolve: (index) => open[index]?.resolve(`ok${index}`),
      reject: (index, error) => open[index]?.reject(error),
      calls: () => open.length,
    };
  }

  function writer(storage: MemoryStorage, definitions: readonly PersistedMutation[]) {
    const cache = persist({ storage, mutations: definitions });
    const client = createQueryClient({ features: [queue, cache] });
    const hook = renderHook(() =>
      useMutation((name: string) => Promise.resolve(name), { client, mutationKey: ["save"] }),
    );
    return { cache, client, hook };
  }

  const stored = (storage: MemoryStorage): Array<{ id: string; variables: unknown }> => {
    const text = storage.data.get(`${KEY}:mutations`);
    return text === undefined ? [] : (JSON.parse(text) as { mutations: [] }).mutations;
  };

  it("[QRY-P25] mutations made offline are stored, replayed in call order after a reload and on reconnect, and removed when done", async () => {
    setOnline(false);
    const storage = memoryStorage();
    const log: string[] = [];
    const first = definition(log);
    const a = writer(storage, [first.definition]);
    a.hook.result.current.mutate("one");
    a.hook.result.current.mutate("two");
    await flush();
    expect(stored(storage).map((item) => item.variables)).toEqual(["one", "two"]);
    // The page reloads: a new client reads the store.
    a.hook.dispose();
    a.cache.dispose();
    const second = definition(log);
    const b = writer(storage, [second.definition]);
    expect(
      b.client.mutationCache.find().map((record) => [record.variables, record.isPaused]),
    ).toEqual([
      ["one", true],
      ["two", true],
    ]);
    expect(second.calls()).toBe(0);
    setOnline(true);
    await flush();
    expect(log).toEqual(["run:one"]);
    second.resolve(0);
    await flush();
    expect(log).toEqual(["run:one", "success:one:ok0", "settled:one", "run:two"]);
    // The first call is done: it left the store, the second is still there.
    expect(stored(storage).map((item) => item.variables)).toEqual(["two"]);
    second.reject(1, new Error("boom"));
    await flush();
    expect(log.slice(-2)).toEqual(["error:two:boom", "settled:two"]);
    expect(storage.data.has(`${KEY}:mutations`)).toBe(false);
    expect(b.client.mutationCache.find().map((record) => record.status)).toEqual([
      "success",
      "error",
    ]);
    b.hook.dispose();
    b.cache.dispose();
  });

  it("[QRY-P26] a call that was replayed from the store runs before a call made offline after the reload", async () => {
    setOnline(false);
    const storage = memoryStorage();
    const log: string[] = [];
    const first = definition(log);
    const a = writer(storage, [first.definition]);
    a.hook.result.current.mutate("old");
    await flush();
    a.hook.dispose();
    a.cache.dispose();
    const second = definition(log);
    const cache = persist({ storage, mutations: [second.definition] });
    const client = createQueryClient({ features: [queue, cache] });
    const hook = renderHook(() =>
      useMutation(
        (name: string) =>
          new Promise<string>((resolve) => {
            log.push(`hook:${name}`);
            resolve(name);
          }),
        { client, mutationKey: ["save"] },
      ),
    );
    hook.result.current.mutate("new");
    await flush();
    setOnline(true);
    await flush();
    expect(log).toEqual(["run:old"]);
    second.resolve(0);
    await flush();
    expect(log.filter((line) => line.startsWith("run:") || line.startsWith("hook:"))).toEqual([
      "run:old",
      "hook:new",
    ]);
    hook.dispose();
    cache.dispose();
  });

  it("[QRY-P27] only mutations named in `mutations` and with JSON variables are stored; the rest run as usual", async () => {
    setOnline(false);
    const storage = memoryStorage();
    const errors: PersistError[] = [];
    const cache = persist({
      storage,
      onError: (error) => errors.push(error),
      mutations: [{ mutationKey: ["save"], mutationFn: () => undefined }],
    });
    const client = createQueryClient({ features: [queue, cache] });
    const other = renderHook(() =>
      useMutation((name: string) => Promise.resolve(name), { client, mutationKey: ["other"] }),
    );
    const unnamed = renderHook(() =>
      useMutation((name: string) => Promise.resolve(name), { client }),
    );
    const dates = renderHook(() =>
      useMutation((when: Date) => Promise.resolve(when), { client, mutationKey: ["save"] }),
    );
    other.result.current.mutate("x");
    unnamed.result.current.mutate("y");
    dates.result.current.mutate(new Date(0));
    await flush();
    expect(storage.data.has(`${KEY}:mutations`)).toBe(false);
    expect(errors.map((error) => error.kind)).toEqual(["serialize"]);
    expect(client.mutationCache.find().every((record) => record.isPaused)).toBe(true);
    other.dispose();
    unnamed.dispose();
    dates.dispose();
    cache.dispose();
  });

  it("[QRY-P28] the mutations option needs the queue feature before persist, and says so", () => {
    const cache = persist({
      storage: memoryStorage(),
      mutations: [{ mutationKey: ["save"], mutationFn: () => undefined }],
    });
    expect(() => createQueryClient({ features: [cache] })).toThrow(/queue feature/);
  });

  it("[QRY-P29] a stored call that another live tab holds is left to that tab; a free one is replayed", async () => {
    const locks = fakeLocks();
    Object.defineProperty(navigator, "locks", { configurable: true, value: locks });
    setOnline(false);
    const storage = memoryStorage();
    const log: string[] = [];
    const first = definition(log);
    const a = writer(storage, [first.definition]);
    a.hook.result.current.mutate("mine");
    await flush();
    // Tab A holds the lock of its stored call.
    const [entry] = stored(storage);
    expect(entry).toBeDefined();
    expect(locks.held.has(`${KEY}:mutation:${entry?.id}`)).toBe(true);
    // Tab B loads while A is alive: it does not take the call.
    const second = definition(log);
    const b = writer(storage, [second.definition]);
    await b.cache.restored;
    expect(b.client.mutationCache.find()).toHaveLength(0);
    // Tab A closes (its lock goes): the next load takes the call.
    a.cache.dispose();
    a.hook.dispose();
    await flush();
    expect(locks.held.size).toBe(0);
    const third = definition(log);
    const c = writer(storage, [third.definition]);
    await c.cache.restored;
    expect(c.client.mutationCache.find().map((record) => record.variables)).toEqual(["mine"]);
    expect(locks.held.size).toBe(1);
    b.hook.dispose();
    b.cache.dispose();
    c.hook.dispose();
    c.cache.dispose();
  });

  it("[QRY-P30] a tab keeps the stored calls of other tabs when it writes its own", async () => {
    setOnline(false);
    const storage = memoryStorage();
    const log: string[] = [];
    const first = definition(log);
    const a = writer(storage, [first.definition]);
    const second = definition(log);
    const b = writer(storage, [second.definition]);
    a.hook.result.current.mutate("from-a");
    await flush();
    b.hook.result.current.mutate("from-b");
    await flush();
    expect(
      stored(storage)
        .map((item) => item.variables)
        .sort(),
    ).toEqual(["from-a", "from-b"]);
    a.hook.dispose();
    b.hook.dispose();
    a.cache.dispose();
    b.cache.dispose();
  });
});
