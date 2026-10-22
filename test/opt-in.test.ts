import { renderHook } from "@shadow-js/testing";
import { describe, expect, it } from "vitest";
import { full } from "../src/full";
import { hydration } from "../src/hydration";
import { createQueryClient, useMutation, useQuery } from "../src/index";
import { inspection } from "../src/inspection";
import { offline } from "../src/offline";
import { scope } from "../src/scope";

/**
 * The three optional capabilities of a client: offline pause and resume (`networkMode` other than
 * `online`), mutation scopes (the `scope` option) and cache subscriptions (`queryCache.subscribe`).
 * A client without a capability refuses the option or the method with a TypeError that names the
 * feature and its import; the default client keeps everything the core does.
 */
describe("optional features of a query client", () => {
  it("[QRY-F1] networkMode other than online without the offline feature throws a TypeError that names it", () => {
    expect(() =>
      createQueryClient({ defaultOptions: { queries: { networkMode: "always" } } }),
    ).toThrow(TypeError);
    expect(() =>
      createQueryClient({ defaultOptions: { queries: { networkMode: "always" } } }),
    ).toThrow(/the offline feature.*"@shadow-js\/query\/offline"/);
  });

  it("[QRY-F2] a query option networkMode other than online is refused at the hook without the offline feature", () => {
    const client = createQueryClient();
    expect(() =>
      renderHook(() =>
        useQuery(["f2"], () => Promise.resolve(1), { client, networkMode: "always" }),
      ),
    ).toThrow(/the offline feature/);
  });

  it("[QRY-F3] a mutation scope without the scope feature throws a TypeError that names it", () => {
    const client = createQueryClient();
    expect(() =>
      renderHook(() => useMutation(() => Promise.resolve(1), { client, scope: { id: "ledger" } })),
    ).toThrow(/the scope feature.*"@shadow-js\/query\/scope"/);
  });

  it("[QRY-F4] queryCache.subscribe without the inspection feature throws a TypeError that names it; find still works", () => {
    const client = createQueryClient();
    expect(() => client.queryCache.subscribe(() => undefined)).toThrow(
      /the inspection feature.*"@shadow-js\/query\/inspection"/,
    );
    expect(client.queryCache.find()).toEqual([]);
  });

  it("[QRY-F5] a feature listed twice counts once; a non-feature, or two different features of one name, throw", () => {
    expect(() => createQueryClient({ features: [offline, offline] })).not.toThrow();
    expect(() => createQueryClient({ features: [{ name: "nope" } as never] })).toThrow(TypeError);
    const impostor = { name: "offline", plug: () => undefined } as never;
    expect(() => createQueryClient({ features: [offline, impostor] })).toThrow(
      /two different "offline" features/,
    );
  });

  it("[QRY-F6] the features the scope and inspection add work when listed", () => {
    const client = createQueryClient({ features: [offline, scope, inspection] });
    const events: string[] = [];
    const stop = client.queryCache.subscribe((event) => events.push(event.type));
    expect(() =>
      createQueryClient({
        defaultOptions: { queries: { networkMode: "always" } },
        features: [offline],
      }),
    ).not.toThrow();
    void client.prefetch(["f6"], () => Promise.resolve(1));
    stop();
    // Adding the query starts its fetch, so the cache reports the new entry and its fetch state.
    expect(events).toEqual(["added", "updated"]);
  });

  it("[QRY-F8] dehydrate and hydrate without the hydration feature throw a TypeError that names it", () => {
    const client = createQueryClient();
    expect(() => client.dehydrate()).toThrow(
      /dehydrate\(\) needs the hydration feature.*"@shadow-js\/query\/hydration"/,
    );
    expect(() => client.hydrate({ version: 1, queries: [] })).toThrow(
      /hydrate\(\) needs the hydration feature/,
    );
    const withIt = createQueryClient({ features: [hydration] });
    expect(withIt.dehydrate()).toEqual({ version: 1, queries: [] });
  });

  it("[QRY-F7] the full preset lists every feature once, in order, and frozen", () => {
    expect(full.map((feature) => feature.name)).toEqual([
      "offline",
      "scope",
      "inspection",
      "hydration",
    ]);
    expect(Object.isFrozen(full)).toBe(true);
    expect(() =>
      createQueryClient({ defaultOptions: { queries: { networkMode: "always" } }, features: full }),
    ).not.toThrow();
  });
});
