import { flush, renderHook } from "@shadow-js/testing";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient, type QueryCacheEvent, useQuery } from "../src/index";
import { inspection } from "../src/inspection";
import { probe } from "./support/probe";

describe("query cache inspection", () => {
  it("[QRY-IN1] find reports each query's key, state, observers and dataUpdatedAt", async () => {
    const qc = createQueryClient({
      features: [inspection],
      defaultOptions: { queries: { retry: false } },
    });
    const fn = probe<number>();
    const hook = renderHook(() => useQuery(["inspect", 1], fn.fetch, { client: qc }));
    const [loading] = qc.queryCache.find({ key: ["inspect", 1] });
    expect(loading).toMatchObject({
      queryKey: ["inspect", 1],
      status: "pending",
      fetchStatus: "fetching",
      data: undefined,
      observers: 1,
      dataUpdatedAt: 0,
    });
    fn.resolve(0, 7);
    await flush();
    const [loaded] = qc.queryCache.find({ key: ["inspect", 1] });
    expect(loaded?.status).toBe("success");
    expect(loaded?.fetchStatus).toBe("idle");
    expect(loaded?.data).toBe(7);
    expect(loaded?.dataUpdatedAt).toBeGreaterThan(0);
    expect(loaded).not.toHaveProperty("updatedAt");
    hook.dispose();
  });

  it("[QRY-IN2] subscribe reports added, updated and removed queries in order, each with a snapshot", () => {
    vi.useFakeTimers();
    try {
      const qc = createQueryClient({
        features: [inspection],
        queryCache: { maxQueries: 500 },
        defaultOptions: { queries: { gcTime: 100 } },
      });
      const events: QueryCacheEvent[] = [];
      const stop = qc.queryCache.subscribe((event) => events.push(event));
      qc.setCache(["watched"], 1);
      vi.advanceTimersByTime(100);
      expect(events.map((event) => event.type)).toEqual(["added", "updated", "removed"]);
      expect(events[0]?.query.queryHash).toBe(events[2]?.query.queryHash);
      expect(events[0]?.query.data).toBeUndefined();
      expect(events[1]?.query.data).toBe(1);
      expect(events[2]?.query.data).toBe(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("[QRY-IN3] unsubscribe stops the events, and subscribing one listener twice has one effect", () => {
    const qc = createQueryClient({ features: [inspection] });
    const seen: string[] = [];
    const listener = (event: QueryCacheEvent): void => {
      seen.push(event.type);
    };
    const stop = qc.queryCache.subscribe(listener);
    qc.queryCache.subscribe(listener);
    qc.setCache(["a"], 1);
    expect(seen).toEqual(["added", "updated"]);
    stop();
    stop();
    seen.length = 0;
    qc.setCache(["a"], 2);
    expect(seen).toEqual([]);
  });

  it("[QRY-IN4] a listener that throws does not change the query or stop the other listeners", () => {
    const qc = createQueryClient({ features: [inspection] });
    const queued: (() => void)[] = [];
    const spy = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
      queued.push(callback as () => void);
    });
    const later = vi.fn();
    qc.queryCache.subscribe(() => {
      throw new Error("listener failed");
    });
    qc.queryCache.subscribe(later);
    qc.setCache(["resilient"], 3);
    spy.mockRestore();
    expect(qc.getCache(["resilient"])).toBe(3);
    expect(later).toHaveBeenCalled();
    expect(queued.length).toBeGreaterThan(0);
    expect(() => {
      for (const callback of queued) callback();
    }).toThrow("listener failed");
  });

  it("[QRY-IN5] a listener runs untracked: reading the cache inside it does not subscribe a memo", () => {
    const qc = createQueryClient({ features: [inspection] });
    const stop = qc.queryCache.subscribe(() => {
      qc.queryCache.find();
    });
    qc.setCache(["untracked"], 1);
    expect(qc.getCache(["untracked"])).toBe(1);
    stop();
  });
});
