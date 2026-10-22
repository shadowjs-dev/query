import { useRenderEffect } from "@shadow-js/core";
import { flush, renderHook } from "@shadow-js/testing";
import { render } from "@shadow-js/testing/dom";
import { describe, expect, it, vi } from "vitest";
import { hydration } from "../src/hydration";
import { createQueryClient, useQuery } from "../src/index";
import { dehydrateScript, hydrateFromDocument } from "../src/server";
import { probe } from "./support/probe";

describe("query in the browser", () => {
  it("[QRY-F1] window focus refetches a stale query, and leaves a fresh one alone", async () => {
    const qc = createQueryClient({
      features: [hydration],
      defaultOptions: { queries: { retry: false } },
    });
    const stale = probe<number>();
    const fresh = probe<number>();
    const staleView = renderHook(() => useQuery(["focus-stale"], stale.fetch, { client: qc }));
    const freshView = renderHook(() =>
      useQuery(["focus-fresh"], fresh.fetch, { client: qc, staleTime: 60_000 }),
    );
    stale.resolve(0, 1);
    fresh.resolve(0, 1);
    await flush();
    window.dispatchEvent(new Event("focus"));
    expect(stale.calls()).toBe(2);
    expect(fresh.calls()).toBe(1);
    stale.resolve(1, 2);
    await flush();
    expect(staleView.result.current.data()).toBe(2);
    staleView.dispose();
    freshView.dispose();
  });

  it("[QRY-F2] a query with refetchOnWindowFocus false is not refetched on focus", async () => {
    const qc = createQueryClient({
      features: [hydration],
      defaultOptions: { queries: { retry: false } },
    });
    const fn = probe<number>();
    const view = renderHook(() =>
      useQuery(["no-focus"], fn.fetch, { client: qc, refetchOnWindowFocus: false }),
    );
    fn.resolve(0, 1);
    await flush();
    window.dispatchEvent(new Event("focus"));
    expect(fn.calls()).toBe(1);
    view.dispose();
  });

  it("[QRY-F3] the browser coming back online refetches stale queries", async () => {
    const qc = createQueryClient({
      features: [hydration],
      defaultOptions: { queries: { retry: false } },
    });
    const fn = probe<number>();
    const view = renderHook(() => useQuery(["online"], fn.fetch, { client: qc }));
    fn.resolve(0, 1);
    await flush();
    window.dispatchEvent(new Event("online"));
    expect(fn.calls()).toBe(2);
    fn.resolve(1, 1);
    await flush();
    view.dispose();
  });

  it("[QRY-F5] staleTime Infinity: a focus event leaves the data alone, and a stale query is refetched once even with several observers", async () => {
    const qc = createQueryClient({
      features: [hydration],
      defaultOptions: { queries: { retry: false } },
    });
    const fresh = probe<number>();
    const view = renderHook(() =>
      useQuery(["focus-forever"], fresh.fetch, {
        client: qc,
        staleTime: Number.POSITIVE_INFINITY,
      }),
    );
    fresh.resolve(0, 1);
    await flush();
    window.dispatchEvent(new Event("focus"));
    expect(fresh.calls()).toBe(1);
    view.dispose();
    const stale = probe<number>();
    const first = renderHook(() => useQuery(["focus-many"], stale.fetch, { client: qc }));
    const second = renderHook(() => useQuery(["focus-many"], stale.fetch, { client: qc }));
    stale.resolve(0, 1);
    await flush();
    window.dispatchEvent(new Event("focus"));
    expect(stale.calls()).toBe(2);
    stale.resolve(1, 2);
    await flush();
    first.dispose();
    second.dispose();
  });

  it("[QRY-F4] focus listeners are added with the first observer and removed with the last", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const qc = createQueryClient({ features: [hydration] });
    const fn = probe<number>();
    const first = renderHook(() => useQuery(["l1"], fn.fetch, { client: qc }));
    const second = renderHook(() => useQuery(["l2"], fn.fetch, { client: qc }));
    const added = add.mock.calls.filter(([type]) => type === "focus" || type === "online").length;
    expect(added).toBe(2);
    first.dispose();
    second.dispose();
    const removed = remove.mock.calls.filter(
      ([type]) => type === "focus" || type === "online",
    ).length;
    expect(removed).toBe(2);
  });

  it("[QRY-DOM1] the DOM reflects the query as it loads, through a render effect", async () => {
    const qc = createQueryClient({
      features: [hydration],
      defaultOptions: { queries: { retry: false } },
    });
    const fn = probe<string>();
    const view = render(() => {
      const query = useQuery(["dom"], fn.fetch, { client: qc });
      const node = document.createTextNode("loading");
      useRenderEffect(
        () => query.data() ?? "loading",
        (text) => {
          node.data = text;
        },
      );
      return node;
    });
    expect(view.container.textContent).toBe("loading");
    fn.resolve(0, "Ada");
    await flush();
    expect(view.container.textContent).toBe("Ada");
    view.unmount();
  });

  it("[QRY-W1] hydrateFromDocument seeds the client from the script element", () => {
    const qc = createQueryClient({ features: [hydration] });
    const source = createQueryClient({ features: [hydration] });
    source.setCache(["page", 1], { title: "Hello </script>" });
    const element = document.createElement("div");
    element.innerHTML = dehydrateScript(source.dehydrate());
    document.body.appendChild(element);
    try {
      hydrateFromDocument(qc);
      expect(qc.getCache(["page", 1])).toEqual({ title: "Hello </script>" });
    } finally {
      element.remove();
    }
  });

  it("[QRY-W2] hydrateFromDocument throws when the element is missing", () => {
    const qc = createQueryClient({ features: [hydration] });
    expect(() => hydrateFromDocument(qc, "absent-state")).toThrow("no element #absent-state");
  });
});
