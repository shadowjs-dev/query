import { flush, renderHook } from "@shadow-js/testing";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient, useMutation, useQuery } from "../src/index";
import { offline } from "../src/offline";
import { queue } from "../src/queue";
import { probe } from "./support/probe";

/** Makes `navigator.onLine` report `online`, and fires the matching browser event. */
function setOnline(online: boolean): void {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
  window.dispatchEvent(new Event(online ? "online" : "offline"));
}

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
});

/** A mutation hook whose function is a probe, so the test settles each call by hand. */
function mutationOn(
  client: ReturnType<typeof createQueryClient>,
  fn: ReturnType<typeof probe<string>>,
  options: { readonly networkMode?: "online" | "always"; readonly retry?: number } = {},
) {
  return renderHook(() =>
    useMutation(
      (name: string) =>
        fn.fetch({ signal: new AbortController().signal }).then((value) => `${value}:${name}`),
      { client, mutationKey: ["save"], retryDelay: 10, ...options },
    ),
  );
}

describe("offline mutations", () => {
  it("[QRY-O10] while offline a mutation is paused: onMutate ran, the function did not, and the record says paused", async () => {
    setOnline(false);
    const qc = createQueryClient({ features: [offline, queue] });
    const fn = probe<string>();
    const seen: string[] = [];
    const hook = renderHook(() =>
      useMutation(
        (name: string) =>
          fn.fetch({ signal: new AbortController().signal }).then((v) => `${v}:${name}`),
        { client: qc, mutationKey: ["save"], onMutate: (name) => void seen.push(name) },
      ),
    );
    hook.result.current.mutate("a");
    await flush();
    expect(seen).toEqual(["a"]);
    expect(fn.calls()).toBe(0);
    expect(hook.result.current.status()).toBe("pending");
    const [record] = qc.mutationCache.find();
    expect(record?.status).toBe("pending");
    expect(record?.isPaused).toBe(true);
    hook.dispose();
  });

  it("[QRY-O11] the online event replays paused mutations one at a time, in call order, even when a later call would settle first", async () => {
    setOnline(false);
    const qc = createQueryClient({ features: [offline, queue] });
    const fn = probe<string>();
    const hook = mutationOn(qc, fn);
    const first = hook.result.current.mutateAsync("first");
    const second = hook.result.current.mutateAsync("second");
    const third = hook.result.current.mutateAsync("third");
    await flush();
    expect(fn.calls()).toBe(0);
    setOnline(true);
    await flush();
    expect(fn.calls()).toBe(1);
    expect(qc.mutationCache.find().map((record) => record.isPaused)).toEqual([false, true, true]);
    fn.resolve(0, "A");
    await expect(first).resolves.toBe("A:first");
    await flush();
    expect(fn.calls()).toBe(2);
    fn.resolve(1, "B");
    await expect(second).resolves.toBe("B:second");
    await flush();
    fn.resolve(2, "C");
    await expect(third).resolves.toBe("C:third");
    expect(qc.mutationCache.find().every((record) => !record.isPaused)).toBe(true);
    hook.dispose();
  });

  it("[QRY-O12] a failed replay does not block the mutations queued behind it", async () => {
    setOnline(false);
    const qc = createQueryClient({ features: [offline, queue] });
    const fn = probe<string>();
    const hook = mutationOn(qc, fn);
    const first = hook.result.current.mutateAsync("first");
    const rejected = expect(first).rejects.toThrow("nope");
    const second = hook.result.current.mutateAsync("second");
    await flush();
    setOnline(true);
    await flush();
    fn.reject(0, new Error("nope"));
    await rejected;
    await flush();
    expect(fn.calls()).toBe(2);
    fn.resolve(1, "B");
    await expect(second).resolves.toBe("B:second");
    hook.dispose();
  });

  it("[QRY-O13] resumePausedMutations replays now and resolves when the queue has drained", async () => {
    setOnline(false);
    const qc = createQueryClient({ features: [offline, queue] });
    const fn = probe<string>();
    const hook = mutationOn(qc, fn);
    const first = hook.result.current.mutateAsync("first");
    const second = hook.result.current.mutateAsync("second");
    await flush();
    let drained = false;
    const done = qc.resumePausedMutations().then(() => {
      drained = true;
    });
    await flush();
    expect(fn.calls()).toBe(1);
    fn.resolve(0, "A");
    await first;
    await flush();
    expect(drained).toBe(false);
    fn.resolve(1, "B");
    await second;
    await done;
    expect(drained).toBe(true);
    // The queue is empty, but the browser still reports no connection: a new call waits again.
    const third = hook.result.current.mutateAsync("third");
    await flush();
    expect(fn.calls()).toBe(2);
    expect(qc.mutationCache.find().at(-1)?.isPaused).toBe(true);
    void qc.resumePausedMutations();
    await flush();
    expect(fn.calls()).toBe(3);
    fn.resolve(2, "C");
    await third;
    hook.dispose();
  });

  it("[QRY-O14] a mutation made while a replay runs waits behind it", async () => {
    setOnline(false);
    const qc = createQueryClient({ features: [offline, queue] });
    const fn = probe<string>();
    const hook = mutationOn(qc, fn);
    const first = hook.result.current.mutateAsync("first");
    await flush();
    setOnline(true);
    await flush();
    expect(fn.calls()).toBe(1);
    const late = hook.result.current.mutateAsync("late");
    await flush();
    expect(fn.calls()).toBe(1);
    fn.resolve(0, "A");
    await first;
    await flush();
    expect(fn.calls()).toBe(2);
    fn.resolve(1, "B");
    await expect(late).resolves.toBe("B:late");
    hook.dispose();
  });

  it("[QRY-O15] online mutations still run concurrently, and networkMode always runs while offline", async () => {
    const qc = createQueryClient({ features: [offline, queue] });
    const fn = probe<string>();
    const hook = mutationOn(qc, fn);
    const a = hook.result.current.mutateAsync("a");
    const b = hook.result.current.mutateAsync("b");
    await flush();
    expect(fn.calls()).toBe(2);
    fn.resolve(0, "A");
    fn.resolve(1, "B");
    await Promise.all([a, b]);
    hook.dispose();

    setOnline(false);
    const always = probe<string>();
    const eager = mutationOn(qc, always, { networkMode: "always" });
    const c = eager.result.current.mutateAsync("c");
    await flush();
    expect(always.calls()).toBe(1);
    always.resolve(0, "C");
    await c;
    eager.dispose();
  });

  it("[QRY-O16] a retry waits while the browser is offline and runs on the online event", async () => {
    vi.useFakeTimers();
    const qc = createQueryClient({ features: [offline, queue] });
    const fn = probe<number>();
    const view = renderHook(() =>
      useQuery(["flaky"], fn.fetch, { client: qc, retry: 2, retryDelay: 100 }),
    );
    expect(fn.calls()).toBe(1);
    fn.reject(0, new Error("down"));
    await vi.advanceTimersByTimeAsync(0);
    setOnline(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(fn.calls()).toBe(1);
    expect(view.result.current.fetchStatus()).toBe("paused");
    setOnline(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fn.calls()).toBe(2);
    expect(view.result.current.fetchStatus()).toBe("fetching");
    fn.resolve(1, 7);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.result.current.data()).toBe(7);
    view.dispose();
  });

  it("[QRY-O17] unmounting a query that waits between retries drops it: no run, no listener", async () => {
    vi.useFakeTimers();
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const qc = createQueryClient({ features: [offline, queue] });
    const fn = probe<number>();
    const view = renderHook(() =>
      useQuery(["flaky-unmount"], fn.fetch, { client: qc, retry: 2, retryDelay: 100 }),
    );
    fn.reject(0, new Error("down"));
    await vi.advanceTimersByTimeAsync(0);
    setOnline(false);
    await vi.advanceTimersByTimeAsync(500);
    view.dispose();
    setOnline(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(fn.calls()).toBe(1);
    const online = (spy: typeof added): number =>
      spy.mock.calls.filter((call) => call[0] === "online").length;
    // Every "online" listener this client added is gone again (the client's own refetch listener
    // and the feature's wait listener come and go with their users).
    expect(online(removed)).toBe(online(added));
  });

  it("[QRY-O18] a mutation retry waits while offline", async () => {
    vi.useFakeTimers();
    const qc = createQueryClient({ features: [offline, queue] });
    const fn = probe<string>();
    const hook = mutationOn(qc, fn, { retry: 1 });
    const done = hook.result.current.mutateAsync("x");
    await vi.advanceTimersByTimeAsync(0);
    expect(fn.calls()).toBe(1);
    fn.reject(0, new Error("down"));
    setOnline(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn.calls()).toBe(1);
    setOnline(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fn.calls()).toBe(2);
    fn.resolve(1, "ok");
    await expect(done).resolves.toBe("ok:x");
    hook.dispose();
  });

  it("[QRY-O19] without the queue feature a mutation runs while offline, and resumePausedMutations names the feature", async () => {
    setOnline(false);
    const qc = createQueryClient();
    const fn = probe<string>();
    const hook = mutationOn(qc, fn);
    void hook.result.current.mutateAsync("x").catch(() => undefined);
    await flush();
    expect(fn.calls()).toBe(1);
    expect(() => qc.resumePausedMutations()).toThrow(/queue feature/);
    expect(() => mutationOn(qc, fn, { networkMode: "always" })).toThrow(/queue feature/);
    hook.dispose();
  });

  it("[QRY-O20] property: mutations made offline start once each, in call order, never two at a time, whatever the order of offline, online, settles and resumes", async () => {
    type Step = "call" | "offline" | "online" | "settle" | "resume";
    const steps: fc.Arbitrary<Step> = fc.constantFrom(
      "call",
      "offline",
      "online",
      "settle",
      "resume",
    );
    await fc.assert(
      fc.asyncProperty(fc.array(steps, { minLength: 1, maxLength: 24 }), async (sequence) => {
        setOnline(true);
        const qc = createQueryClient({ features: [offline, queue] });
        const started: string[] = [];
        const queued = new Set<string>();
        const running = new Set<string>();
        const open: Array<() => void> = [];
        let overlap = false;
        const hook = renderHook(() =>
          useMutation(
            (name: string) =>
              new Promise<string>((resolve) => {
                started.push(name);
                if (queued.has(name)) {
                  if ([...running].some((other) => queued.has(other))) overlap = true;
                }
                running.add(name);
                open.push(() => {
                  running.delete(name);
                  resolve(name);
                });
              }),
            { client: qc },
          ),
        );
        let calls = 0;
        let isOffline = false;
        const issued: string[] = [];
        const settleOne = (): void => {
          open.shift()?.();
        };
        for (const step of sequence) {
          if (step === "call") {
            const name = `m${calls}`;
            calls += 1;
            issued.push(name);
            if (isOffline) queued.add(name);
            void hook.result.current.mutateAsync(name).catch(() => undefined);
          } else if (step === "offline") {
            isOffline = true;
            setOnline(false);
          } else if (step === "online") {
            isOffline = false;
            setOnline(true);
          } else if (step === "resume") {
            void qc.resumePausedMutations();
          } else {
            settleOne();
          }
          await flush();
        }
        isOffline = false;
        setOnline(true);
        await flush();
        for (let guard = 0; guard < 100 && (open.length > 0 || running.size > 0); guard += 1) {
          settleOne();
          await flush();
        }
        expect([...started].sort()).toEqual([...issued].sort());
        const order = started.filter((name) => queued.has(name));
        expect(order).toEqual(issued.filter((name) => queued.has(name)));
        expect(overlap).toBe(false);
        expect(running.size).toBe(0);
        hook.dispose();
      }),
      { seed: 42, numRuns: 60 },
    );
  });
});
