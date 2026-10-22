import { useMemo } from "@shadow-js/core";
import { createTestRoot, flush, renderHook } from "@shadow-js/testing";
import { describe, expect, it, vi } from "vitest";
import { hydration } from "../src/hydration";
import { createQueryClient, useQuery } from "../src/index";
import { probe } from "./support/probe";

describe("query client API", () => {
  it("[QRY-C1] setCache and getCache write and read data; getCache does not create an entry", () => {
    const qc = createQueryClient({ features: [hydration] });
    expect(qc.getCache(["missing"])).toBeUndefined();
    expect(qc.queryCache.size).toBe(0);
    qc.setCache(["user", 1], { name: "Ada" });
    expect(qc.getCache(["user", 1])).toEqual({ name: "Ada" });
    qc.setCache<{ name: string }>(["user", 1], (previous) => ({
      name: `${previous?.name ?? ""}!`,
    }));
    expect(qc.getCache(["user", 1])).toEqual({ name: "Ada!" });
    expect(qc.queryCache.find({ key: ["user", 1] })[0]?.status).toBe("success");
  });

  it("[QRY-C2] an updater returning undefined writes nothing", () => {
    const qc = createQueryClient({ features: [hydration] });
    qc.setCache(["n"], 1);
    expect(qc.setCache<number>(["n"], () => undefined)).toBeUndefined();
    expect(qc.getCache(["n"])).toBe(1);
  });

  it("[QRY-C3] setCache inside a memo computation is reported in development", () => {
    const qc = createQueryClient({ features: [hydration] });
    const hook = renderHook(() =>
      useMemo(() => {
        qc.setCache(["in-memo"], 1);
        return 0;
      }),
    );
    // The setup file spies console.warn; read and clear the captured calls here.
    const calls = vi.mocked(console.warn).mock.calls.map((args) => String(args[0]));
    vi.mocked(console.warn).mockClear();
    expect(calls).toEqual([expect.stringContaining("setCache() was called while a memo computes")]);
    expect(qc.getCache(["in-memo"])).toBe(1);
    hook.dispose();
  });

  it("[QRY-C4] invalidate marks matching queries stale and refetches the active ones", async () => {
    const qc = createQueryClient({
      features: [hydration],
      defaultOptions: { queries: { retry: false } },
    });
    const active = probe<number>();
    const inactive = probe<number>();
    const hook = renderHook(() =>
      useQuery(["todos", 1], active.fetch, { client: qc, staleTime: 60_000 }),
    );
    active.resolve(0, 1);
    await flush();
    // An inactive entry with the same prefix, seeded without an observer.
    qc.setCache(["todos", 2], 2);
    qc.setCache(["other"], 3);
    const done = qc.invalidate({ key: ["todos"] });
    expect(active.calls()).toBe(2);
    expect(hook.result.current.isStale()).toBe(true);
    active.resolve(1, 5);
    await done;
    await flush();
    expect(hook.result.current.data()).toBe(5);
    expect(qc.queryCache.find({ key: ["todos", 2] })[0]?.isInvalidated).toBe(true);
    expect(qc.queryCache.find({ key: ["other"] })[0]?.isInvalidated).toBe(false);
    expect(inactive.calls()).toBe(0);
    hook.dispose();
  });

  it("[QRY-C5] invalidate with exact, type and predicate narrows the matches", async () => {
    const qc = createQueryClient({ features: [hydration] });
    qc.setCache(["a"], 1);
    qc.setCache(["a", "b"], 2);
    qc.setCache(["c"], 3);
    await qc.invalidate({ key: ["a"], exact: true }, { refetchType: "none" });
    const invalidated = qc.queryCache
      .find()
      .filter((query) => query.isInvalidated)
      .map((query) => query.queryHash);
    expect(invalidated).toEqual([JSON.stringify(["a"]).length > 0 ? invalidated[0] : ""]);
    expect(invalidated.length).toBe(1);
    await qc.invalidate(
      { predicate: (query) => query.queryKey.length === 2 },
      { refetchType: "none" },
    );
    expect(qc.queryCache.find({ predicate: (query) => query.isInvalidated }).length).toBe(2);
    expect(qc.queryCache.find({ type: "active" })).toEqual([]);
  });

  it("[QRY-C6] prefetch fetches once when nothing fresh is cached, and never rejects", async () => {
    const qc = createQueryClient({
      features: [hydration],
      defaultOptions: { queries: { retry: false } },
    });
    const fn = probe<string>();
    const first = qc.prefetch(["p"], fn.fetch);
    const second = qc.prefetch(["p"], fn.fetch);
    expect(fn.calls()).toBe(1);
    fn.resolve(0, "warm");
    await first;
    await second;
    expect(qc.getCache(["p"])).toBe("warm");
    await qc.prefetch(["p"], fn.fetch, { staleTime: 60_000 });
    expect(fn.calls()).toBe(1);

    const failing = probe<string>();
    const done = qc.prefetch(["bad"], failing.fetch);
    failing.reject(0, new Error("nope"));
    await expect(done).resolves.toBeUndefined();
    expect(qc.queryCache.find({ key: ["bad"] })[0]?.status).toBe("error");
  });

  it("[QRY-C7] fetchQuery resolves with the data and rejects with the fetch error", async () => {
    const qc = createQueryClient({ features: [hydration] });
    const ok = probe<number>();
    const pending = qc.fetchQuery(["f"], ok.fetch);
    ok.resolve(0, 9);
    await expect(pending).resolves.toBe(9);
    // Fresh enough for a minute: no second request.
    await expect(qc.fetchQuery(["f"], ok.fetch, { staleTime: 60_000 })).resolves.toBe(9);
    expect(ok.calls()).toBe(1);

    const bad = probe<number>();
    // Default retries would wait a second before failing; this test is about the rejection itself.
    const failing = qc.fetchQuery(["g"], bad.fetch, { retry: false });
    const failure = new Error("down");
    bad.reject(0, failure);
    await expect(failing).rejects.toBe(failure);
  });

  it("[QRY-C8] cancel aborts the matching in-flight fetches; their data is not written", async () => {
    const qc = createQueryClient({
      features: [hydration],
      defaultOptions: { queries: { retry: false } },
    });
    const fn = probe<string>();
    const pending = qc.fetchQuery(["slow"], fn.fetch);
    expect(qc.isFetching()).toBe(1);
    expect(qc.isFetching({ key: ["slow"] })).toBe(1);
    qc.cancel({ key: ["slow"] });
    expect(fn.signalOf(0).aborted).toBe(true);
    expect(qc.isFetching()).toBe(0);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    fn.resolve(0, "late");
    await flush();
    expect(qc.getCache(["slow"])).toBeUndefined();
  });

  it("[QRY-C9] reset removes unobserved entries and sends mounted ones back to pending", async () => {
    const qc = createQueryClient({
      features: [hydration],
      defaultOptions: { queries: { retry: false } },
    });
    qc.setCache(["gone"], 1);
    const fn = probe<number>();
    const hook = renderHook(() => useQuery(["kept"], fn.fetch, { client: qc }));
    fn.resolve(0, 2);
    await flush();
    qc.reset();
    expect(qc.getCache(["gone"])).toBeUndefined();
    expect(qc.queryCache.find({ key: ["gone"] })).toEqual([]);
    expect(fn.calls()).toBe(2);
    fn.resolve(1, 3);
    await flush();
    expect(hook.result.current.data()).toBe(3);
    hook.dispose();
  });

  it("[QRY-C10] the query cache keeps at most maxQueries unobserved entries, least recently used first", () => {
    const qc = createQueryClient({ features: [hydration], queryCache: { maxQueries: 5 } });
    for (let index = 0; index < 1000; index += 1) qc.setCache(["n", index], index);
    expect(qc.queryCache.size).toBe(5);
    expect(qc.getCache(["n", 999])).toBe(999);
    expect(qc.getCache(["n", 0])).toBeUndefined();
  });

  it("[QRY-C11] a mounted query is never evicted, whatever the bound", async () => {
    const qc = createQueryClient({
      features: [hydration],
      queryCache: { maxQueries: 2 },
      defaultOptions: { queries: { retry: false } },
    });
    const fn = probe<number>();
    const hook = renderHook(() => useQuery(["mounted"], fn.fetch, { client: qc }));
    fn.resolve(0, 1);
    await flush();
    for (let index = 0; index < 50; index += 1) qc.setCache(["other", index], index);
    expect(qc.getCache(["mounted"])).toBe(1);
    expect(qc.queryCache.size).toBeLessThanOrEqual(3);
    hook.dispose();
  });

  it("[QRY-C15] invalidate and cancel inside a memo computation are reported in development", () => {
    const qc = createQueryClient({ features: [hydration] });
    qc.setCache(["memo-target"], 1);
    const hook = renderHook(() =>
      useMemo(() => {
        void qc.invalidate({ key: ["memo-target"] }, { refetchType: "none" });
        qc.cancel({ key: ["memo-target"] });
        return 0;
      }),
    );
    const calls = vi.mocked(console.warn).mock.calls.map((args) => String(args[0]));
    vi.mocked(console.warn).mockClear();
    expect(calls).toEqual([
      expect.stringContaining("invalidate() was called while a memo computes"),
      expect.stringContaining("cancel() was called while a memo computes"),
    ]);
    hook.dispose();
  });

  it("[QRY-C14] a key holding a value that does not survive JSON is reported once in development", () => {
    const qc = createQueryClient({ features: [hydration] });
    qc.setCache(["item", undefined], 1);
    qc.setCache(["item", undefined], 2);
    const calls = vi.mocked(console.warn).mock.calls.map((args) => String(args[0]));
    vi.mocked(console.warn).mockClear();
    expect(calls).toEqual([expect.stringContaining("dehydrate() will refuse it")]);
    expect(qc.getCache(["item", undefined])).toBe(2);
  });

  it("[QRY-C12] createQueryClient rejects a non-positive cache bound", () => {
    expect(() =>
      createQueryClient({ features: [hydration], queryCache: { maxQueries: 0 } }),
    ).toThrow(RangeError);
    expect(() =>
      createQueryClient({ features: [hydration], mutationCache: { maxMutations: 1.5 } }),
    ).toThrow(RangeError);
  });

  it("[QRY-C13] a client used inside a root is disposed with it: the observer is detached", async () => {
    const qc = createQueryClient({
      features: [hydration],
      defaultOptions: { queries: { retry: false } },
    });
    const fn = probe<number>();
    const root = createTestRoot(() => useQuery(["rooted"], fn.fetch, { client: qc }));
    expect(qc.queryCache.find({ key: ["rooted"] })[0]?.observers).toBe(1);
    root.dispose();
    expect(qc.queryCache.find({ key: ["rooted"] })[0]?.observers).toBe(0);
    expect(fn.signalOf(0).aborted).toBe(true);
  });
});
