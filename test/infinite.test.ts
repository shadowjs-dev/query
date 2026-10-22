import { flush, renderHook } from "@shadow-js/testing";
import { describe, expect, it } from "vitest";
import { createQueryClient, useInfiniteQuery } from "../src/index";
import { probe } from "./support/probe";

const noRetry = { retry: false } as const;

describe("useInfiniteQuery", () => {
  it("[QRY-I1] the first page loads with initialPageParam; fetchNextPage appends until getNextPageParam ends", async () => {
    const qc = createQueryClient({ defaultOptions: { queries: noRetry } });
    const fn = probe<{ items: string[]; next: number | null }>();
    const hook = renderHook(() =>
      useInfiniteQuery(
        ["feed"],
        ({ pageParam }) =>
          fn
            .fetch({ signal: new AbortController().signal })
            .then((page) => ({ ...page, requested: pageParam })),
        {
          client: qc,
          initialPageParam: 0,
          getNextPageParam: (last) => (last.next === null ? undefined : last.next),
        },
      ),
    );
    expect(fn.calls()).toBe(1);
    fn.resolve(0, { items: ["a"], next: 1 });
    await flush();
    expect(hook.result.current.data()?.pageParams).toEqual([0]);
    expect(hook.result.current.hasNextPage()).toBe(true);

    const more = hook.result.current.fetchNextPage();
    expect(fn.calls()).toBe(2);
    fn.resolve(1, { items: ["b"], next: null });
    await more;
    await flush();
    expect(hook.result.current.data()?.pages.map((page) => page.items)).toEqual([["a"], ["b"]]);
    expect(hook.result.current.data()?.pageParams).toEqual([0, 1]);
    expect(hook.result.current.hasNextPage()).toBe(false);
    await hook.result.current.fetchNextPage();
    expect(fn.calls()).toBe(2);
    hook.dispose();
  });

  it("[QRY-I2] fetchPreviousPage prepends using getPreviousPageParam", async () => {
    const qc = createQueryClient({ defaultOptions: { queries: noRetry } });
    const fn = probe<string>();
    const hook = renderHook(() =>
      useInfiniteQuery(["history"], () => fn.fetch({ signal: new AbortController().signal }), {
        client: qc,
        initialPageParam: 10,
        getNextPageParam: () => undefined,
        getPreviousPageParam: (_first, _pages, param) => (param > 0 ? param - 5 : undefined),
      }),
    );
    fn.resolve(0, "page10");
    await flush();
    expect(hook.result.current.hasPreviousPage()).toBe(true);
    const back = hook.result.current.fetchPreviousPage();
    fn.resolve(1, "page5");
    await back;
    await flush();
    expect(hook.result.current.data()?.pages).toEqual(["page5", "page10"]);
    expect(hook.result.current.data()?.pageParams).toEqual([5, 10]);
    hook.dispose();
  });

  it("[QRY-I3] maxPages drops the pages farthest from the direction of the load", async () => {
    const qc = createQueryClient({ defaultOptions: { queries: noRetry } });
    const fn = probe<number>();
    const hook = renderHook(() =>
      useInfiniteQuery(["bounded"], () => fn.fetch({ signal: new AbortController().signal }), {
        client: qc,
        initialPageParam: 0,
        maxPages: 2,
        getNextPageParam: (_last, _pages, param) => param + 1,
      }),
    );
    fn.resolve(0, 0);
    await flush();
    for (let index = 1; index <= 3; index += 1) {
      const next = hook.result.current.fetchNextPage();
      fn.resolve(index, index);
      await next;
      await flush();
    }
    expect(hook.result.current.data()?.pages).toEqual([2, 3]);
    expect(hook.result.current.data()?.pageParams).toEqual([2, 3]);
    hook.dispose();
  });

  it("[QRY-I4] refetch loads every loaded page again, in order, with its own parameter", async () => {
    const qc = createQueryClient({ defaultOptions: { queries: noRetry } });
    const requested: number[] = [];
    const fn = probe<number>();
    const hook = renderHook(() =>
      useInfiniteQuery(
        ["again"],
        ({ pageParam }) => {
          requested.push(pageParam);
          return fn.fetch({ signal: new AbortController().signal });
        },
        {
          client: qc,
          initialPageParam: 1,
          getNextPageParam: (_last, _pages, param) => param + 1,
        },
      ),
    );
    fn.resolve(0, 100);
    await flush();
    const next = hook.result.current.fetchNextPage();
    fn.resolve(1, 200);
    await next;
    await flush();
    expect(requested).toEqual([1, 2]);
    // Pages reload one after another: the second request starts when the first has answered.
    const again = hook.result.current.refetch();
    fn.resolve(2, 101);
    await flush();
    fn.resolve(3, 201);
    await again;
    await flush();
    expect(requested).toEqual([1, 2, 1, 2]);
    expect(hook.result.current.data()?.pages).toEqual([101, 201]);
    hook.dispose();
  });

  it("[QRY-I5] a second fetchNextPage while one runs shares it, and isFetchingNextPage is true meanwhile", async () => {
    const qc = createQueryClient({ defaultOptions: { queries: noRetry } });
    const fn = probe<number>();
    const hook = renderHook(() =>
      useInfiniteQuery(["shared-next"], () => fn.fetch({ signal: new AbortController().signal }), {
        client: qc,
        initialPageParam: 0,
        getNextPageParam: (_last, _pages, param) => param + 1,
      }),
    );
    fn.resolve(0, 0);
    await flush();
    const first = hook.result.current.fetchNextPage();
    const second = hook.result.current.fetchNextPage();
    expect(hook.result.current.isFetchingNextPage()).toBe(true);
    expect(fn.calls()).toBe(2);
    fn.resolve(1, 1);
    await Promise.all([first, second]);
    await flush();
    expect(hook.result.current.isFetchingNextPage()).toBe(false);
    expect(hook.result.current.data()?.pages).toEqual([0, 1]);
    hook.dispose();
  });

  it("[QRY-I6] maxPages must be a positive integer", () => {
    const qc = createQueryClient();
    expect(() =>
      renderHook(() =>
        useInfiniteQuery(["bad"], () => 1, {
          client: qc,
          initialPageParam: 0,
          maxPages: 0,
          getNextPageParam: () => undefined,
        }),
      ),
    ).toThrow(RangeError);
  });

  it("[QRY-I7] throwOnError makes reading the pages throw the error, as in useQuery", async () => {
    const qc = createQueryClient({ defaultOptions: { queries: noRetry } });
    const fn = probe<number>();
    const hook = renderHook(() =>
      useInfiniteQuery(["broken-feed"], () => fn.fetch({ signal: new AbortController().signal }), {
        client: qc,
        initialPageParam: 0,
        getNextPageParam: () => undefined,
        throwOnError: true,
      }),
    );
    fn.reject(0, new Error("kaput"));
    await flush();
    expect(hook.result.current.status()).toBe("error");
    expect(() => hook.result.current.data()).toThrow("kaput");
    hook.dispose();
  });

  it("[QRY-I8] a first page parameter of undefined still pages: getNextPageParam reads the first page", async () => {
    const qc = createQueryClient({ defaultOptions: { queries: noRetry } });
    const fn = probe<{ items: string[]; cursor: string | null }>();
    const hook = renderHook(() =>
      useInfiniteQuery(["cursor-feed"], () => fn.fetch({ signal: new AbortController().signal }), {
        client: qc,
        initialPageParam: undefined,
        getNextPageParam: (last) => last.cursor ?? undefined,
      }),
    );
    fn.resolve(0, { items: ["a"], cursor: "c2" });
    await flush();
    expect(hook.result.current.hasNextPage()).toBe(true);
    const more = hook.result.current.fetchNextPage();
    expect(fn.calls()).toBe(2);
    fn.resolve(1, { items: ["b"], cursor: null });
    await more;
    await flush();
    expect(hook.result.current.data()?.pageParams).toEqual([undefined, "c2"]);
    expect(hook.result.current.data()?.pages.map((page) => page.items)).toEqual([["a"], ["b"]]);
    hook.dispose();
  });

  it("[QRY-I9] an undefined first page parameter still pages backward through getPreviousPageParam", async () => {
    const qc = createQueryClient({ defaultOptions: { queries: noRetry } });
    const fn = probe<string>();
    const hook = renderHook(() =>
      useInfiniteQuery<string, string | undefined>(
        ["back-feed"],
        () => fn.fetch({ signal: new AbortController().signal }),
        {
          client: qc,
          initialPageParam: undefined,
          getNextPageParam: () => undefined,
          getPreviousPageParam: (_first, _pages, param) =>
            param === undefined ? "older" : undefined,
        },
      ),
    );
    fn.resolve(0, "newest");
    await flush();
    expect(hook.result.current.hasPreviousPage()).toBe(true);
    const back = hook.result.current.fetchPreviousPage();
    fn.resolve(1, "older-page");
    await back;
    await flush();
    expect(hook.result.current.data()?.pages).toEqual(["older-page", "newest"]);
    expect(hook.result.current.data()?.pageParams).toEqual(["older", undefined]);
    hook.dispose();
  });

  it("[QRY-I10] maxPages drops the last pages when loading backward, and the first ones when loading forward", async () => {
    const qc = createQueryClient({ defaultOptions: { queries: noRetry } });
    const fn = probe<number>();
    const hook = renderHook(() =>
      useInfiniteQuery(["both-ways"], () => fn.fetch({ signal: new AbortController().signal }), {
        client: qc,
        initialPageParam: 5,
        getNextPageParam: (_last, _pages, param) => (param < 9 ? param + 1 : undefined),
        getPreviousPageParam: (_first, _pages, param) => (param > 0 ? param - 1 : undefined),
        maxPages: 3,
      }),
    );
    fn.resolve(0, 50);
    await flush();
    const forward = hook.result.current.fetchNextPage();
    fn.resolve(1, 60);
    await forward;
    const forward2 = hook.result.current.fetchNextPage();
    fn.resolve(2, 70);
    await forward2;
    await flush();
    expect(hook.result.current.data()?.pageParams).toEqual([5, 6, 7]);
    const backward = hook.result.current.fetchPreviousPage();
    fn.resolve(3, 40);
    await backward;
    await flush();
    expect(hook.result.current.data()?.pageParams).toEqual([4, 5, 6]);
    expect(hook.result.current.data()?.pages).toEqual([40, 50, 60]);
    hook.dispose();
  });
});
