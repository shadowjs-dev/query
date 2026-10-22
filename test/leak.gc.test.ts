import { setImmediate as nextTurn } from "node:timers/promises";
import { flush, renderHook } from "@shadow-js/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient, useInfiniteQuery, useQuery } from "../src/index";
import { inspection } from "../src/inspection";
import { persist } from "../src/persist";
import { probe } from "./support/probe";
import { memoryStorage } from "./support/storage";

/** A window stand-in that counts listeners, so a leak in the focus/reconnect wiring is visible. */
function countingWindow(): {
  readonly window: Record<string, unknown>;
  readonly listeners: () => number;
} {
  const table = new Map<string, Set<unknown>>();
  const window = {
    addEventListener(type: string, listener: unknown) {
      const set = table.get(type) ?? new Set<unknown>();
      set.add(listener);
      table.set(type, set);
    },
    removeEventListener(type: string, listener: unknown) {
      table.get(type)?.delete(listener);
    },
  };
  return {
    window,
    listeners: () => [...table.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("leaks", () => {
  it("[QRY-L1] 500 mounts and unmounts with new keys leave no observers, no listeners and no timers", async () => {
    vi.useFakeTimers();
    const counting = countingWindow();
    vi.stubGlobal("window", counting.window);
    const qc = createQueryClient({
      features: [inspection],
      defaultOptions: { queries: { retry: false, gcTime: 1000 } },
    });
    const timersBefore = vi.getTimerCount();
    for (let index = 0; index < 500; index += 1) {
      const fn = probe<number>();
      const hook = renderHook(() =>
        useQuery(["leak", index], fn.fetch, { client: qc, refetchInterval: 50 }),
      );
      fn.resolve(0, index);
      await flush();
      hook.dispose();
      expect(qc.queryCache.find({ key: ["leak", index] })[0]?.observers ?? 0).toBe(0);
    }
    expect(counting.listeners()).toBe(0);
    expect(qc.isFetching()).toBe(0);
    expect(qc.queryCache.size).toBeLessThanOrEqual(500);
    vi.advanceTimersByTime(1001);
    expect(qc.queryCache.size).toBe(0);
    expect(vi.getTimerCount()).toBe(timersBefore);
  });

  it("[QRY-L2] 500 mounts on one key keep a single entry and a single listener set", async () => {
    vi.useFakeTimers();
    const counting = countingWindow();
    vi.stubGlobal("window", counting.window);
    const qc = createQueryClient({
      features: [inspection],
      defaultOptions: { queries: { retry: false } },
    });
    const fn = probe<number>();
    for (let index = 0; index < 500; index += 1) {
      const hook = renderHook(() => useQuery(["same"], fn.fetch, { client: qc }));
      hook.dispose();
    }
    expect(qc.queryCache.size).toBe(1);
    expect(counting.listeners()).toBe(0);
    expect(fn.calls()).toBeLessThanOrEqual(501);
  });

  it("[QRY-L3] a focus listener is installed while a query is mounted and removed with the last one", () => {
    const counting = countingWindow();
    vi.stubGlobal("window", counting.window);
    const qc = createQueryClient({ features: [inspection] });
    const fn = probe<number>();
    const first = renderHook(() => useQuery(["a"], fn.fetch, { client: qc }));
    const second = renderHook(() => useQuery(["b"], fn.fetch, { client: qc }));
    expect(counting.listeners()).toBe(2);
    first.dispose();
    expect(counting.listeners()).toBe(2);
    second.dispose();
    expect(counting.listeners()).toBe(0);
  });

  it("[QRY-L4] 300 mounted infinite queries with page limits and cache subscribers leave no timers, listeners or pages behind", async () => {
    vi.useFakeTimers();
    const counting = countingWindow();
    vi.stubGlobal("window", counting.window);
    try {
      const qc = createQueryClient({
        features: [inspection],
        defaultOptions: { queries: { retry: false, gcTime: 1000 } },
      });
      const seen: string[] = [];
      const stop = qc.queryCache.subscribe((event) => seen.push(event.type));
      const timersBefore = vi.getTimerCount();
      for (let index = 0; index < 300; index += 1) {
        const page = probe<number>();
        const hook = renderHook(() =>
          useInfiniteQuery(
            ["paged", index],
            () => page.fetch({ signal: new AbortController().signal }),
            {
              client: qc,
              initialPageParam: 0,
              getNextPageParam: () => undefined,
              maxPages: 2,
            },
          ),
        );
        page.resolve(0, index);
        await flush();
        expect(hook.result.current.data()?.pages.length).toBe(1);
        hook.dispose();
      }
      expect(seen.length).toBeGreaterThan(300);
      stop();
      expect(counting.listeners()).toBe(0);
      vi.advanceTimersByTime(1001);
      expect(qc.queryCache.size).toBe(0);
      expect(vi.getTimerCount()).toBe(timersBefore);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  /** Runs the collector until it has had a chance to clear every weak reference. */
  async function collect(): Promise<void> {
    for (let round = 0; round < 4; round += 1) {
      await nextTurn();
      globalThis.gc?.();
    }
  }

  it("[QRY-L5] queries nobody observes are collected after gcTime: their data is released, not only their entries", async () => {
    expect(typeof globalThis.gc).toBe("function");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const qc = createQueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1000 } } });
    const refs: Array<WeakRef<object>> = [];
    // Written by prefetch and by hooks that mount and unmount: both ways leave entries behind.
    const fill = async (): Promise<void> => {
      for (let index = 0; index < 40; index += 1) {
        const data = { index, rows: Array.from({ length: 200 }, (_, row) => row) };
        refs.push(new WeakRef(data));
        qc.setCache(["gc-set", index], data);
      }
      for (let index = 0; index < 40; index += 1) {
        const fn = probe<object>();
        const hook = renderHook(() => useQuery(["gc-hook", index], fn.fetch, { client: qc }));
        const data = { index, rows: Array.from({ length: 200 }, (_, row) => row) };
        refs.push(new WeakRef(data));
        fn.resolve(0, data);
        await flush();
        hook.dispose();
      }
    };
    await fill();
    expect(qc.queryCache.size).toBe(80);
    // Not yet: gcTime has not passed, so the data is still held.
    await collect();
    expect(refs.some((ref) => ref.deref() !== undefined)).toBe(true);
    vi.advanceTimersByTime(1001);
    expect(qc.queryCache.size).toBe(0);
    await collect();
    expect(refs.filter((ref) => ref.deref() !== undefined)).toHaveLength(0);
  });

  it("[QRY-L6] a client with a disposed persist feature is collected, and leaves no listener, channel or timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const counting = countingWindow();
    const documentListeners = countingWindow();
    vi.stubGlobal("window", counting.window);
    vi.stubGlobal("document", documentListeners.window);
    let channels = 0;
    class Channel {
      onmessage: unknown = null;
      constructor() {
        channels += 1;
      }
      postMessage(): void {
        // A channel nobody listens to: the test only counts open channels.
      }
      close(): void {
        channels -= 1;
      }
    }
    vi.stubGlobal("BroadcastChannel", Channel);
    const storage = memoryStorage();
    const timersBefore = vi.getTimerCount();
    const make = async (): Promise<WeakRef<object>> => {
      const cache = persist({ storage });
      // gcTime Infinity: an unobserved entry would otherwise hold the client through its collection timer.
      const qc = createQueryClient({
        features: [cache],
        defaultOptions: { queries: { gcTime: Number.POSITIVE_INFINITY } },
      });
      qc.setCache(["leak"], { rows: Array.from({ length: 1000 }, (_, row) => row) });
      expect(counting.listeners() + documentListeners.listeners()).toBeGreaterThan(0);
      expect(channels).toBe(1);
      await cache.flush();
      qc.setCache(["leak"], { rows: [] });
      cache.dispose();
      return new WeakRef(qc);
    };
    const ref = await make();
    expect(counting.listeners()).toBe(0);
    expect(documentListeners.listeners()).toBe(0);
    expect(channels).toBe(0);
    expect(vi.getTimerCount()).toBe(timersBefore);
    await collect();
    expect(ref.deref()).toBeUndefined();
    expect(storage.data.size).toBe(1);
  });
});
