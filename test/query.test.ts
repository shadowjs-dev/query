import { useSignal } from "@shadow-js/core";
import { flush, renderHook } from "@shadow-js/testing";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient, hashKey, runWithQueryClient, useQueries, useQuery } from "../src/index";
import { probe } from "./support/probe";

function client(options: Parameters<typeof createQueryClient>[0] = {}) {
  return createQueryClient({ defaultOptions: { queries: { retry: false } }, ...options });
}

describe("useQuery: lifecycle", () => {
  it("[QRY-Q1] mounting fetches once, and the data is shown after the fetch settles", async () => {
    const qc = client();
    const fn = probe<string>();
    const hook = renderHook(() => useQuery(["greeting"], fn.fetch, { client: qc }));
    const q = hook.result.current;
    expect(fn.calls()).toBe(1);
    expect(q.status()).toBe("pending");
    expect(q.isFetching()).toBe(true);
    expect(q.data()).toBeUndefined();

    fn.resolve(0, "hello");
    await flush();
    expect(q.data()).toBe("hello");
    expect(q.status()).toBe("success");
    expect(q.isFetching()).toBe(false);
    expect(q.isStale()).toBe(true);
    hook.dispose();
  });

  it("[QRY-Q2] a fetch that rejects becomes an error with the data kept", async () => {
    const qc = client();
    const fn = probe<number>();
    const hook = renderHook(() => useQuery(["n"], fn.fetch, { client: qc }));
    fn.resolve(0, 1);
    await flush();
    const failure = new Error("offline");
    qc.invalidate({ key: ["n"] });
    fn.reject(1, failure);
    await flush();
    expect(hook.result.current.status()).toBe("error");
    expect(hook.result.current.error()).toBe(failure);
    expect(hook.result.current.data()).toBe(1);
    hook.dispose();
  });

  it("[QRY-Q3] two components on one key share one request", async () => {
    const qc = client();
    const fn = probe<string>();
    const first = renderHook(() => useQuery(["shared"], fn.fetch, { client: qc }));
    const second = renderHook(() => useQuery(["shared"], fn.fetch, { client: qc }));
    expect(fn.calls()).toBe(1);
    fn.resolve(0, "one");
    await flush();
    expect(first.result.current.data()).toBe("one");
    expect(second.result.current.data()).toBe("one");
    first.dispose();
    second.dispose();
  });

  it("[QRY-Q4] fresh data (staleTime) is not fetched again on mount; stale data is", async () => {
    vi.useFakeTimers();
    try {
      const qc = client();
      const fn = probe<string>();
      const first = renderHook(() =>
        useQuery(["fresh"], fn.fetch, { client: qc, staleTime: 1000 }),
      );
      fn.resolve(0, "v1");
      await flush();
      first.dispose();
      const again = renderHook(() =>
        useQuery(["fresh"], fn.fetch, { client: qc, staleTime: 1000 }),
      );
      expect(fn.calls()).toBe(1);
      expect(again.result.current.isStale()).toBe(false);
      again.dispose();

      vi.advanceTimersByTime(1001);
      const late = renderHook(() => useQuery(["fresh"], fn.fetch, { client: qc, staleTime: 1000 }));
      expect(fn.calls()).toBe(2);
      expect(late.result.current.data()).toBe("v1");
      fn.resolve(1, "v2");
      await flush();
      expect(late.result.current.data()).toBe("v2");
      late.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("[QRY-Q5] enabled false does not fetch; turning it on fetches once", async () => {
    const qc = client();
    const fn = probe<number>();
    const hook = renderHook(() => {
      const [on, setOn] = useSignal(false);
      const query = useQuery(["gated"], fn.fetch, { client: qc, enabled: on });
      return { query, setOn };
    });
    expect(fn.calls()).toBe(0);
    expect(hook.result.current.query.status()).toBe("pending");
    hook.result.current.setOn(true);
    await flush();
    expect(fn.calls()).toBe(1);
    fn.resolve(0, 4);
    await flush();
    expect(hook.result.current.query.data()).toBe(4);
    hook.dispose();
  });

  it("[QRY-Q6] a key accessor returning false disables; a key then fetches the key it names", async () => {
    const qc = client();
    const seen: string[] = [];
    const hook = renderHook(() => {
      const [id, setId] = useSignal<string | undefined>(undefined);
      const query = useQuery(
        () => (id() === undefined ? false : ["item", id()]),
        ({ queryKey }) => {
          seen.push(JSON.stringify(queryKey));
          return Promise.resolve(`value of ${String(queryKey[1])}`);
        },
        { client: qc },
      );
      return { query, setId };
    });
    await flush();
    expect(seen).toEqual([]);
    expect(hook.result.current.query.status()).toBe("pending");
    hook.result.current.setId("a");
    await flush();
    expect(seen).toEqual(['["item","a"]']);
    expect(hook.result.current.query.data()).toBe("value of a");
    hook.result.current.setId("b");
    await flush();
    expect(seen).toEqual(['["item","a"]', '["item","b"]']);
    expect(hook.result.current.query.data()).toBe("value of b");
    hook.dispose();
  });

  it("[QRY-Q7] select runs on the data and is memoized on it", async () => {
    const qc = client();
    const fn = probe<number[]>();
    const select = vi.fn((list: number[]) => list.length);
    const hook = renderHook(() => useQuery(["list"], fn.fetch, { client: qc, select }));
    fn.resolve(0, [1, 2, 3]);
    await flush();
    expect(hook.result.current.data()).toBe(3);
    expect(hook.result.current.data()).toBe(3);
    expect(select).toHaveBeenCalledTimes(1);
    hook.dispose();
  });

  it("[QRY-Q8] placeholderData and keepPreviousData are flagged as placeholder data", async () => {
    const qc = client();
    const fn = probe<string>();
    const hook = renderHook(() =>
      useQuery(["ph"], fn.fetch, { client: qc, placeholderData: "loading..." }),
    );
    expect(hook.result.current.data()).toBe("loading...");
    expect(hook.result.current.isPlaceholderData()).toBe(true);
    fn.resolve(0, "done");
    await flush();
    expect(hook.result.current.data()).toBe("done");
    expect(hook.result.current.isPlaceholderData()).toBe(false);
    hook.dispose();
  });

  it("[QRY-Q9] initialData is shown at once and, when fresh, is not fetched", async () => {
    const qc = client();
    const fn = probe<string>();
    const hook = renderHook(() =>
      useQuery(["init"], fn.fetch, { client: qc, initialData: "seeded", staleTime: 60_000 }),
    );
    expect(hook.result.current.data()).toBe("seeded");
    expect(hook.result.current.status()).toBe("success");
    expect(fn.calls()).toBe(0);
    hook.dispose();
  });

  it("[QRY-Q10] refetch keeps the data visible and resolves with the new value", async () => {
    const qc = client();
    const fn = probe<number>();
    const hook = renderHook(() => useQuery(["r"], fn.fetch, { client: qc }));
    fn.resolve(0, 1);
    await flush();
    const next = hook.result.current.refetch();
    expect(hook.result.current.data()).toBe(1);
    expect(hook.result.current.fetchStatus()).toBe("fetching");
    fn.resolve(1, 2);
    await expect(next).resolves.toBe(2);
    await flush();
    expect(hook.result.current.data()).toBe(2);
    hook.dispose();
  });

  it("[QRY-Q11] retry repeats a failed fetch with backoff, then stores the error", async () => {
    vi.useFakeTimers();
    try {
      const qc = createQueryClient();
      const fn = probe<number>();
      const hook = renderHook(() =>
        useQuery(["retry"], fn.fetch, { client: qc, retry: 2, retryDelay: 100 }),
      );
      fn.reject(0, new Error("a"));
      await vi.advanceTimersByTimeAsync(0);
      expect(fn.calls()).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(fn.calls()).toBe(2);
      fn.reject(1, new Error("b"));
      await vi.advanceTimersByTimeAsync(99);
      expect(fn.calls()).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(fn.calls()).toBe(3);
      fn.reject(2, new Error("c"));
      await vi.advanceTimersByTimeAsync(0);
      expect(hook.result.current.status()).toBe("error");
      hook.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("[QRY-Q12] the default backoff doubles: 1 s, then 2 s", async () => {
    vi.useFakeTimers();
    try {
      const qc = createQueryClient({ defaultOptions: { queries: { retry: 2 } } });
      const fn = probe<number>();
      const hook = renderHook(() => useQuery(["backoff"], fn.fetch, { client: qc }));
      fn.reject(0, new Error("x"));
      await vi.advanceTimersByTimeAsync(999);
      expect(fn.calls()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fn.calls()).toBe(2);
      fn.reject(1, new Error("y"));
      await vi.advanceTimersByTimeAsync(1999);
      expect(fn.calls()).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(fn.calls()).toBe(3);
      fn.resolve(2, 7);
      await vi.advanceTimersByTimeAsync(0);
      expect(hook.result.current.data()).toBe(7);
      hook.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("[QRY-Q13] throwOnError makes reading the data throw the error", async () => {
    const qc = client();
    const fn = probe<number>();
    const hook = renderHook(() => useQuery(["boom"], fn.fetch, { client: qc, throwOnError: true }));
    fn.reject(0, new Error("kaput"));
    await flush();
    expect(() => hook.result.current.data()).toThrow("kaput");
    hook.dispose();
  });

  it("[QRY-Q14] polling with refetchInterval refetches while mounted and stops on dispose", async () => {
    vi.useFakeTimers();
    try {
      const qc = client();
      const fn = probe<number>();
      const hook = renderHook(() =>
        useQuery(["poll"], fn.fetch, { client: qc, refetchInterval: 1000 }),
      );
      fn.resolve(0, 1);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(fn.calls()).toBe(2);
      fn.resolve(1, 2);
      await vi.advanceTimersByTimeAsync(0);
      hook.dispose();
      await vi.advanceTimersByTimeAsync(5000);
      expect(fn.calls()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("[QRY-Q15] keepPreviousData shows the previous key's data while the next key loads", async () => {
    const qc = client();
    const fn = probe<string>();
    const hook = renderHook(() => {
      const [id, setId] = useSignal("one");
      const query = useQuery(
        () => ["kp", id()],
        ({ queryKey }) =>
          fn
            .fetch({ signal: new AbortController().signal })
            .then((v) => `${String(queryKey[1])}:${v}`),
        {
          client: qc,
          keepPreviousData: true,
        },
      );
      return { query, setId };
    });
    fn.resolve(0, "x");
    await flush();
    expect(hook.result.current.query.data()).toBe("one:x");
    hook.result.current.setId("two");
    await flush();
    expect(hook.result.current.query.data()).toBe("one:x");
    expect(hook.result.current.query.isPlaceholderData()).toBe(true);
    fn.resolve(1, "y");
    await flush();
    expect(hook.result.current.query.data()).toBe("two:y");
    expect(hook.result.current.query.isPlaceholderData()).toBe(false);
    hook.dispose();
  });

  it("[QRY-Q16] an equal refetch keeps the data reference (structural sharing)", async () => {
    const qc = client();
    const fn = probe<{
      readonly items: readonly number[];
      readonly meta: { readonly n: number };
    }>();
    const hook = renderHook(() => useQuery(["share"], fn.fetch, { client: qc }));
    fn.resolve(0, { items: [1, 2], meta: { n: 1 } });
    await flush();
    const first = hook.result.current.data();
    const again = hook.result.current.refetch();
    fn.resolve(1, { items: [1, 2], meta: { n: 1 } });
    await again;
    await flush();
    expect(hook.result.current.data()).toBe(first);
    const changed = hook.result.current.refetch();
    fn.resolve(2, { items: [1, 2], meta: { n: 2 } });
    await changed;
    await flush();
    expect(hook.result.current.data()).not.toBe(first);
    expect(hook.result.current.data()?.items).toBe(first?.items);
    hook.dispose();
  });

  it("[QRY-Q17] useQueries returns one result per definition, in order", async () => {
    const qc = client();
    const a = probe<number>();
    const b = probe<string>();
    const hook = renderHook(() =>
      useQueries([
        { key: ["qa"], queryFn: a.fetch, client: qc },
        { key: ["qb"], queryFn: b.fetch, client: qc },
      ]),
    );
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
    b.resolve(0, "bee");
    a.resolve(0, 1);
    await flush();
    const [first, second] = hook.result.current;
    expect(first?.data()).toBe(1);
    expect(second?.data()).toBe("bee");
    hook.dispose();
  });

  it("[QRY-Q18] without a client option or a provider, a hook fails with a clear error", () => {
    expect(() => renderHook(() => useQuery(["none"], () => 1))).toThrow("no QueryClient");
  });

  it("[QRY-Q19] a client provided by runWithQueryClient is used when no option names one", async () => {
    const qc = client();
    const fn = probe<number>();
    const hook = renderHook(() => runWithQueryClient(qc, () => useQuery(["ctx"], fn.fetch)));
    expect(fn.calls()).toBe(1);
    fn.resolve(0, 3);
    await flush();
    expect(qc.getCache(["ctx"])).toBe(3);
    hook.dispose();
  });

  it("[QRY-DT1] state changes are reported to the devtools hook with the key as the name", async () => {
    const reports: Array<readonly unknown[]> = [];
    const key = "__SHADOWJS_DEVTOOLS_HOOK__";
    Reflect.set(globalThis, key, {
      version: 1,
      report: (...args: unknown[]) => reports.push(args),
    });
    try {
      const qc = client();
      const fn = probe<number>();
      const hook = renderHook(() => useQuery(["devtools", 1], fn.fetch, { client: qc }));
      fn.resolve(0, 1);
      await flush();
      const states = reports.filter(
        (args) => args[0] === 10 && args[3] === hashKey(["devtools", 1]),
      );
      expect(states.map((args) => args[2])).toEqual(["fetching", "success"]);
      hook.dispose();
    } finally {
      Reflect.deleteProperty(globalThis, key);
    }
  });

  it("[QRY-Q20] staleTime Infinity keeps data fresh through a remount; only an invalidation refetches it", async () => {
    const qc = createQueryClient({ defaultOptions: { queries: { retry: false } } });
    const fn = probe<number>();
    const view = renderHook(() =>
      useQuery(["forever-fresh"], fn.fetch, { client: qc, staleTime: Number.POSITIVE_INFINITY }),
    );
    fn.resolve(0, 1);
    await flush();
    view.dispose();
    const again = renderHook(() =>
      useQuery(["forever-fresh"], fn.fetch, { client: qc, staleTime: Number.POSITIVE_INFINITY }),
    );
    expect(fn.calls()).toBe(1);
    expect(again.result.current.isStale()).toBe(false);
    void qc.invalidate({ key: ["forever-fresh"] });
    expect(fn.calls()).toBe(2);
    fn.resolve(1, 2);
    await flush();
    again.dispose();
  });

  it("[QRY-Q21] refetchOnMount false does not fetch a query that already holds data, but fetches one without data", async () => {
    const qc = createQueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setCache(["held"], "old");
    const held = probe<string>();
    const view = renderHook(() =>
      useQuery(["held"], held.fetch, { client: qc, refetchOnMount: false }),
    );
    expect(held.calls()).toBe(0);
    expect(view.result.current.data()).toBe("old");
    view.dispose();
    const empty = probe<string>();
    const emptyView = renderHook(() =>
      useQuery(["empty"], empty.fetch, { client: qc, refetchOnMount: false }),
    );
    expect(empty.calls()).toBe(1);
    empty.resolve(0, "new");
    await flush();
    emptyView.dispose();
  });

  it("[QRY-Q22] throwOnError stops throwing once a refetch succeeds: the error is cleared with the new data", async () => {
    const qc = createQueryClient({ defaultOptions: { queries: { retry: false } } });
    const fn = probe<number>();
    const view = renderHook(() =>
      useQuery(["recover"], fn.fetch, { client: qc, throwOnError: true }),
    );
    fn.reject(0, new Error("down"));
    await flush();
    expect(() => view.result.current.data()).toThrow("down");
    void view.result.current.refetch();
    fn.resolve(1, 5);
    await flush();
    expect(view.result.current.error()).toBeUndefined();
    expect(view.result.current.data()).toBe(5);
    view.dispose();
  });
});
