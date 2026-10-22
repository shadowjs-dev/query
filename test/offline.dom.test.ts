import { flush, renderHook } from "@shadow-js/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient, useQuery } from "../src/index";
import { offline } from "../src/offline";
import { probe } from "./support/probe";

/** Makes `navigator.onLine` report `online`, and fires the matching browser event. */
function goOnline(online: boolean): void {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
  window.dispatchEvent(new Event(online ? "online" : "offline"));
}

afterEach(() => {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
});

describe("offline pause and resume", () => {
  it("[QRY-O1] while offline a mounted query is paused: its function is not called and fetchStatus says so", async () => {
    goOnline(false);
    const qc = createQueryClient({
      features: [offline],
      defaultOptions: { queries: { retry: false } },
    });
    const fn = probe<number>();
    const view = renderHook(() => useQuery(["offline-mount"], fn.fetch, { client: qc }));
    await flush();
    expect(fn.calls()).toBe(0);
    expect(view.result.current.fetchStatus()).toBe("paused");
    expect(view.result.current.isFetching()).toBe(false);
    expect(qc.isFetching()).toBe(0);
    expect(view.result.current.status()).toBe("pending");
    view.dispose();
    goOnline(true);
  });

  it("[QRY-O2] the online event resumes a paused query: it fetches once and its data is shown", async () => {
    goOnline(false);
    const qc = createQueryClient({
      features: [offline],
      defaultOptions: { queries: { retry: false } },
    });
    const fn = probe<number>();
    const view = renderHook(() => useQuery(["offline-resume"], fn.fetch, { client: qc }));
    await flush();
    expect(fn.calls()).toBe(0);
    goOnline(true);
    expect(fn.calls()).toBe(1);
    expect(view.result.current.fetchStatus()).toBe("fetching");
    fn.resolve(0, 42);
    await flush();
    expect(view.result.current.data()).toBe(42);
    expect(view.result.current.fetchStatus()).toBe("idle");
    view.dispose();
  });

  it("[QRY-O3] several requests made offline become one request when the connection returns", async () => {
    goOnline(false);
    const qc = createQueryClient({
      features: [offline],
      defaultOptions: { queries: { retry: false } },
    });
    const fn = probe<number>();
    const view = renderHook(() => useQuery(["offline-many"], fn.fetch, { client: qc }));
    await flush();
    void view.result.current.refetch();
    void qc.invalidate({ key: ["offline-many"] });
    void qc.refetchQueries({ key: ["offline-many"] });
    expect(fn.calls()).toBe(0);
    goOnline(true);
    expect(fn.calls()).toBe(1);
    fn.resolve(0, 1);
    await flush();
    view.dispose();
  });

  it("[QRY-O5] without the offline feature a query runs while the browser reports offline, as fetch would", async () => {
    goOnline(false);
    const qc = createQueryClient({ defaultOptions: { queries: { retry: false } } });
    const fn = probe<number>();
    const view = renderHook(() => useQuery(["no-offline"], fn.fetch, { client: qc }));
    await flush();
    expect(fn.calls()).toBe(1);
    expect(view.result.current.fetchStatus()).toBe("fetching");
    fn.resolve(0, 7);
    await flush();
    expect(view.result.current.data()).toBe(7);
    view.dispose();
    goOnline(true);
  });

  it("[QRY-O4] networkMode always fetches while offline, as the browser allows the request", async () => {
    goOnline(false);
    const qc = createQueryClient({
      features: [offline],
      defaultOptions: { queries: { retry: false, networkMode: "always" } },
    });
    const fn = probe<number>();
    const view = renderHook(() => useQuery(["offline-always"], fn.fetch, { client: qc }));
    expect(fn.calls()).toBe(1);
    expect(view.result.current.fetchStatus()).toBe("fetching");
    fn.resolve(0, 5);
    await flush();
    view.dispose();
    goOnline(true);
  });

  it("[QRY-O5] unmounting a paused query drops its request: the function never runs, and the listener is removed", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    goOnline(false);
    const qc = createQueryClient({
      features: [offline],
      defaultOptions: { queries: { retry: false } },
    });
    const fn = probe<number>();
    const view = renderHook(() => useQuery(["offline-unmount"], fn.fetch, { client: qc }));
    await flush();
    const onlineAdds = add.mock.calls.filter(([name]) => name === "online").length;
    view.dispose();
    goOnline(true);
    expect(fn.calls()).toBe(0);
    const onlineRemoves = remove.mock.calls.filter(([name]) => name === "online").length;
    expect(onlineRemoves).toBeGreaterThanOrEqual(onlineAdds);
    add.mockRestore();
    remove.mockRestore();
  });

  it("[QRY-O6] cancel on a paused query rejects its fetchQuery and never calls the function", async () => {
    goOnline(false);
    const qc = createQueryClient({
      features: [offline],
      defaultOptions: { queries: { retry: false } },
    });
    const fn = probe<number>();
    const pending = qc.fetchQuery(["offline-cancel"], fn.fetch);
    const rejected = expect(pending).rejects.toThrow("canceled");
    await flush();
    qc.cancel({ key: ["offline-cancel"] });
    await rejected;
    goOnline(true);
    expect(fn.calls()).toBe(0);
  });

  it("[QRY-O7] a paused prefetch resumes on the online event and resolves when its data is stored", async () => {
    goOnline(false);
    const qc = createQueryClient({
      features: [offline],
      defaultOptions: { queries: { retry: false } },
    });
    const fn = probe<number>();
    const done = qc.fetchQuery(["offline-prefetch"], fn.fetch);
    await flush();
    expect(fn.calls()).toBe(0);
    goOnline(true);
    expect(fn.calls()).toBe(1);
    fn.resolve(0, 9);
    await expect(done).resolves.toBe(9);
  });

  it("[QRY-O8] a paused query refetches once on reconnect even when refetchOnReconnect is false", async () => {
    goOnline(false);
    const qc = createQueryClient({
      features: [offline],
      defaultOptions: { queries: { retry: false, refetchOnReconnect: false } },
    });
    const fn = probe<number>();
    const view = renderHook(() => useQuery(["offline-no-reconnect"], fn.fetch, { client: qc }));
    await flush();
    expect(fn.calls()).toBe(0);
    goOnline(true);
    expect(fn.calls()).toBe(1);
    fn.resolve(0, 3);
    await flush();
    view.dispose();
  });
});
