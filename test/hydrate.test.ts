import { flush, renderHook } from "@shadow-js/testing";
import { describe, expect, it } from "vitest";
import { hydration } from "../src/hydration";
import { createQueryClient, hashKey, useInfiniteQuery, useQuery } from "../src/index";
import { probe } from "./support/probe";

describe("dehydrate and hydrate", () => {
  it("[QRY-D1] dehydrate sends the successful queries; hydrate seeds a client that renders them without a fetch", async () => {
    const server = createQueryClient({
      features: [hydration],
      defaultOptions: { queries: { retry: false } },
    });
    await server.prefetch(["user", 1], () => ({ name: "Ada" }));
    server.setCache(["pending-only"], undefined);
    const failing = probe<number>();
    const failed = server.prefetch(["broken"], failing.fetch);
    failing.reject(0, new Error("x"));
    await failed;
    const state = server.dehydrate();
    expect(state.version).toBe(1);
    expect(state.queries.map((query) => query.hash)).toEqual([hashKey(["user", 1])]);

    const wire = JSON.parse(JSON.stringify(state)) as unknown;
    const browser = createQueryClient({ features: [hydration] });
    browser.hydrate(wire);
    const fetcher = probe<{ name: string }>();
    const view = renderHook(() =>
      useQuery(["user", 1], fetcher.fetch, { client: browser, staleTime: 60_000 }),
    );
    expect(view.result.current.data()).toEqual({ name: "Ada" });
    expect(fetcher.calls()).toBe(0);
    view.dispose();
  });

  it("[QRY-D2] hydrate keeps an entry that is newer than the one sent", () => {
    const client = createQueryClient({ features: [hydration] });
    client.setCache(["n"], "local", { updatedAt: 2000 });
    client.hydrate({
      version: 1,
      queries: [{ key: ["n"], hash: hashKey(["n"]), data: "server", updatedAt: 1000 }],
    });
    expect(client.getCache(["n"])).toBe("local");
    client.hydrate({
      version: 1,
      queries: [{ key: ["n"], hash: hashKey(["n"]), data: "newer", updatedAt: 3000 }],
    });
    expect(client.getCache(["n"])).toBe("newer");
  });

  it("[QRY-D3] hydrate refuses input that is not a dehydrated state", () => {
    const client = createQueryClient({ features: [hydration] });
    const key = ["k"];
    const good = { key, hash: hashKey(key), data: 1, updatedAt: 1 };
    const cases: unknown[] = [
      null,
      [],
      { version: 2, queries: [] },
      { version: 1 },
      { version: 1, queries: [{ ...good, hash: "forged" }] },
      { version: 1, queries: [{ ...good, data: undefined }] },
      { version: 1, queries: [{ ...good, data: Number.NaN }] },
      { version: 1, queries: [{ ...good, data: new Date(0) }] },
      { version: 1, queries: [{ ...good, updatedAt: -1 }] },
      { version: 1, queries: [{ ...good, key: "k" }] },
      { version: 1, queries: ["not an object"] },
    ];
    for (const input of cases) expect(() => client.hydrate(input)).toThrow(TypeError);
    expect(client.queryCache.size).toBe(0);
  });

  it("[QRY-D4] dehydrate refuses data that would not survive JSON", () => {
    const client = createQueryClient({ features: [hydration] });
    client.setCache(["date"], { at: new Date(0) });
    expect(() => client.dehydrate()).toThrow(TypeError);
    const other = createQueryClient({ features: [hydration] });
    other.setCache(["undef"], { value: undefined });
    expect(() => other.dehydrate()).toThrow(/undefined/);
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const third = createQueryClient({ features: [hydration] });
    third.setCache(["cycle"], cyclic);
    expect(() => third.dehydrate()).toThrow(/cycle/);
  });

  it("[QRY-D5] a key named __proto__ in hydrated data is data, not a prototype write", () => {
    const client = createQueryClient({ features: [hydration] });
    const data = JSON.parse('{"__proto__":{"admin":true},"v":1}') as unknown;
    client.hydrate({
      version: 1,
      queries: [{ key: ["p"], hash: hashKey(["p"]), data, updatedAt: 1 }],
    });
    expect(({} as Record<string, unknown>)["admin"]).toBeUndefined();
    expect(Object.getPrototypeOf(client.getCache(["p"]))).toBe(Object.prototype);
  });

  it("[QRY-D6] dehydrate accepts a custom selection", () => {
    const client = createQueryClient({ features: [hydration] });
    client.setCache(["keep"], 1);
    client.setCache(["drop"], 2);
    const state = client.dehydrate({ shouldDehydrate: (query) => query.queryKey[0] === "keep" });
    expect(state.queries.map((query) => query.key)).toEqual([["keep"]]);
  });

  it("[QRY-D7] dehydrate skips a query whose last fetch failed and one that is still pending", async () => {
    const server = createQueryClient({
      features: [hydration],
      defaultOptions: { queries: { retry: false } },
    });
    await server.prefetch(["kept"], () => 1);
    await server.prefetch(["failed-after-data"], () => 2);
    // A refetch that fails keeps the old data, but the query is in error and is not sent.
    const failing = probe<number>();
    const attempt = server.fetchQuery(["failed-after-data"], failing.fetch).catch(() => undefined);
    failing.reject(0, new Error("server said no"));
    await attempt;
    expect(server.getCache(["failed-after-data"])).toBe(2);
    const pending = probe<number>();
    void server.prefetch(["pending"], pending.fetch);
    const hashes = server.dehydrate().queries.map((query) => query.hash);
    expect(hashes).toEqual([hashKey(["kept"])]);
  });

  it("[QRY-D8] an infinite query's pages and page parameters survive the wire, and render without a fetch", async () => {
    const server = createQueryClient({ features: [hydration] });
    server.setCache(["feed"], { pages: [["a"], ["b"]], pageParams: [0, 1] });
    const wire = JSON.parse(JSON.stringify(server.dehydrate())) as unknown;
    const browser = createQueryClient({ features: [hydration] });
    browser.hydrate(wire);
    const fetcher = probe<string[]>();
    const view = renderHook(() =>
      useInfiniteQuery(["feed"], () => fetcher.fetch({ signal: new AbortController().signal }), {
        client: browser,
        staleTime: 60_000,
        initialPageParam: 0,
        getNextPageParam: () => undefined,
      }),
    );
    expect(view.result.current.data()?.pages).toEqual([["a"], ["b"]]);
    expect(view.result.current.data()?.pageParams).toEqual([0, 1]);
    expect(fetcher.calls()).toBe(0);
    view.dispose();
  });

  it("[QRY-D9] hydrate refuses an entry whose hash is not the hash of its key", () => {
    const client = createQueryClient({ features: [hydration] });
    expect(() =>
      client.hydrate({
        version: 1,
        queries: [{ key: ["a"], hash: hashKey(["b"]), data: 1, updatedAt: 1 }],
      }),
    ).toThrow(/hash does not match/);
    expect(client.queryCache.size).toBe(0);
  });

  it("[QRY-D10] the server's fetch time counts toward staleTime: data hydrated stale is shown at once and refetched on mount", async () => {
    const now = Date.now();
    const browser = createQueryClient({
      features: [hydration],
      defaultOptions: { queries: { retry: false } },
    });
    browser.hydrate({
      version: 1,
      queries: [
        { key: ["old"], hash: hashKey(["old"]), data: "from server", updatedAt: now - 10_000 },
      ],
    });
    const fetcher = probe<string>();
    const view = renderHook(() =>
      useQuery(["old"], fetcher.fetch, { client: browser, staleTime: 1000 }),
    );
    expect(view.result.current.data()).toBe("from server");
    expect(fetcher.calls()).toBe(1);
    fetcher.resolve(0, "fresh");
    await flush();
    expect(view.result.current.data()).toBe("fresh");
    view.dispose();
  });

  it("[QRY-D11] a fetch time in the future (the server clock ran ahead) counts as now, so the data is fresh for staleTime and no longer", async () => {
    const browser = createQueryClient({ features: [hydration] });
    const before = Date.now();
    browser.hydrate({
      version: 1,
      queries: [
        { key: ["skew"], hash: hashKey(["skew"]), data: "x", updatedAt: before + 86_400_000 },
      ],
    });
    const info = browser.queryCache.find({ key: ["skew"] })[0];
    expect(info?.dataUpdatedAt).toBeGreaterThanOrEqual(before);
    expect(info?.dataUpdatedAt).toBeLessThanOrEqual(Date.now());
    const fn = probe<string>();
    const view = renderHook(() =>
      useQuery(["skew"], fn.fetch, { client: browser, staleTime: 60_000 }),
    );
    expect(view.result.current.data()).toBe("x");
    expect(fn.calls()).toBe(0);
    view.dispose();
  });
});
