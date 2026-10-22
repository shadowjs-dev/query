import { useSignal } from "@shadow-js/core";
import { flush, renderHook } from "@shadow-js/testing";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient, useInfiniteQuery, useQuery } from "../src/index";
import { probe } from "./support/probe";

const noRetry = { retry: false } as const;

describe("concurrency and races", () => {
  it("[QRY-R1] an older response that arrives after a newer one never overwrites it", async () => {
    const qc = createQueryClient({ defaultOptions: { queries: noRetry } });
    const fn = probe<string>();
    const hook = renderHook(() => useQuery(["race"], fn.fetch, { client: qc }));
    const second = hook.result.current.refetch();
    expect(fn.signalOf(0).aborted).toBe(true);
    fn.resolve(1, "new");
    await expect(second).resolves.toBe("new");
    fn.resolve(0, "old");
    await flush();
    expect(hook.result.current.data()).toBe("new");
    hook.dispose();
  });

  it("[QRY-R2] a response that arrives after its fetch was aborted is discarded and its promise resolves undefined", async () => {
    const qc = createQueryClient({ defaultOptions: { queries: noRetry } });
    const fn = probe<string>();
    const pending = qc.prefetch(["abort"], fn.fetch);
    qc.cancel({ key: ["abort"] });
    await pending;
    fn.resolve(0, "too late");
    await flush();
    expect(qc.getCache(["abort"])).toBeUndefined();
    expect(qc.queryCache.find({ key: ["abort"] })[0]?.fetchStatus).toBe("idle");
  });

  it("[QRY-R3] unmounting during a fetch aborts it, and a later mount starts a fresh request", async () => {
    const qc = createQueryClient({ defaultOptions: { queries: noRetry } });
    const fn = probe<number>();
    const first = renderHook(() => useQuery(["unmount"], fn.fetch, { client: qc }));
    first.dispose();
    expect(fn.signalOf(0).aborted).toBe(true);
    fn.resolve(0, 1);
    await flush();
    const second = renderHook(() => useQuery(["unmount"], fn.fetch, { client: qc }));
    expect(fn.calls()).toBe(2);
    fn.resolve(1, 2);
    await flush();
    expect(second.result.current.data()).toBe(2);
    second.dispose();
  });

  it("[QRY-R4] switching keys during a fetch: the old key's response stays with its own entry", async () => {
    const qc = createQueryClient({ defaultOptions: { queries: noRetry } });
    const calls: string[] = [];
    const pending = new Map<string, (value: string) => void>();
    const hook = renderHook(() => {
      const [id, setId] = useSignal("a");
      const query = useQuery(
        () => ["item", id()],
        ({ queryKey }) => {
          const name = String(queryKey[1]);
          calls.push(name);
          return new Promise<string>((resolve) => pending.set(name, resolve));
        },
        { client: qc },
      );
      return { query, setId };
    });
    hook.result.current.setId("b");
    await flush();
    pending.get("b")?.("B");
    await flush();
    expect(hook.result.current.query.data()).toBe("B");
    pending.get("a")?.("A");
    await flush();
    expect(hook.result.current.query.data()).toBe("B");
    // The key "a" lost its last observer, so its request was aborted: its late answer is dropped.
    expect(qc.getCache(["item", "a"])).toBeUndefined();
    expect(calls).toEqual(["a", "b"]);
    hook.dispose();
  });

  it("[QRY-R5] a retry that is waiting for its backoff does not run once the fetch is canceled", async () => {
    vi.useFakeTimers();
    try {
      const qc = createQueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 500 } } });
      const fn = probe<number>();
      const pending = qc.fetchQuery(["backoff"], fn.fetch);
      fn.reject(0, new Error("first"));
      await vi.advanceTimersByTimeAsync(10);
      qc.cancel({ key: ["backoff"] });
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(5000);
      expect(fn.calls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("[QRY-R6] a fetch whose function never settles is still canceled promptly", async () => {
    const qc = createQueryClient({ defaultOptions: { queries: noRetry } });
    const fn = probe<number>();
    const pending = qc.fetchQuery(["stuck"], fn.fetch);
    qc.cancel();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(qc.isFetching()).toBe(0);
  });

  it("[QRY-R7] an invalidate during a fetch supersedes it: the superseded response is ignored", async () => {
    const qc = createQueryClient({ defaultOptions: { queries: noRetry } });
    const fn = probe<number>();
    const hook = renderHook(() => useQuery(["inv"], fn.fetch, { client: qc }));
    const done = qc.invalidate({ key: ["inv"] });
    expect(fn.signalOf(0).aborted).toBe(true);
    fn.resolve(1, 2);
    await done;
    fn.resolve(0, 1);
    await flush();
    expect(hook.result.current.data()).toBe(2);
    hook.dispose();
  });

  it("[QRY-R8] a fetch started by a second observer while the first runs is shared, not repeated", async () => {
    const qc = createQueryClient({ defaultOptions: { queries: noRetry } });
    const fn = probe<number>();
    const first = renderHook(() => useQuery(["shared-flight"], fn.fetch, { client: qc }));
    const second = renderHook(() =>
      useQuery(["shared-flight"], fn.fetch, { client: qc, staleTime: 0 }),
    );
    expect(fn.calls()).toBe(1);
    fn.resolve(0, 7);
    await flush();
    expect(second.result.current.data()).toBe(7);
    first.dispose();
    second.dispose();
  });

  it("[QRY-R9] property: any number of mounts on one key at once make one request, and every mount gets its data", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 12 }), async (mounts) => {
        const qc = createQueryClient({ defaultOptions: { queries: noRetry } });
        const fn = probe<number>();
        const views = Array.from({ length: mounts }, () =>
          renderHook(() => useQuery(["dedupe"], fn.fetch, { client: qc })),
        );
        expect(fn.calls()).toBe(1);
        fn.resolve(0, 99);
        await flush();
        for (const view of views) expect(view.result.current.data()).toBe(99);
        for (const view of views) view.dispose();
      }),
      { seed: 42, numRuns: 25 },
    );
  });

  it("[QRY-R10] unmounting an infinite query during fetchNextPage aborts the page request", async () => {
    const qc = createQueryClient({ defaultOptions: { queries: noRetry } });
    const page = probe<string>();
    const view = renderHook(() =>
      useInfiniteQuery(
        ["paged-abort"],
        ({ signal, pageParam }) => {
          void pageParam;
          return page.fetch({ signal });
        },
        {
          client: qc,
          initialPageParam: 0,
          getNextPageParam: () => 1,
        },
      ),
    );
    page.resolve(0, "first");
    await flush();
    void view.result.current.fetchNextPage();
    expect(page.calls()).toBe(2);
    expect(page.signalOf(1).aborted).toBe(false);
    view.dispose();
    expect(page.signalOf(1).aborted).toBe(true);
  });

  it("[QRY-R11] a fetchQuery canceled by cancel rejects with an AbortError, and its data is not stored", async () => {
    const qc = createQueryClient({ defaultOptions: { queries: noRetry } });
    const fn = probe<number>();
    const pending = qc.fetchQuery(["cancel-me"], fn.fetch);
    const outcome = pending.then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.name : "other"),
    );
    await flush();
    qc.cancel({ key: ["cancel-me"] });
    expect(await outcome).toBe("AbortError");
    expect(qc.getCache(["cancel-me"])).toBeUndefined();
  });
});
