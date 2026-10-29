/**
 * Review round: timer delays that a runtime cannot honor. `setTimeout` and `setInterval` fire at once
 * for a delay above 2^31 - 1 ms, so a long `gcTime`, a long `retryDelay` or a huge `refetchInterval`
 * must not turn into "now".
 */
import { flush, renderHook } from "@shadow-js/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient, useMutation, useQuery } from "../src/index";
import { probe } from "./support/probe";

afterEach(() => {
  vi.useRealTimers();
});

const THIRTY_DAYS = 30 * 24 * 3_600_000;

describe("query timers beyond the range of a timer", () => {
  it("[QRY-REV-1] a gcTime above 2^31 - 1 ms keeps an unobserved entry instead of removing it at once", () => {
    vi.useFakeTimers();
    const qc = createQueryClient({ defaultOptions: { queries: { gcTime: THIRTY_DAYS } } });
    qc.setCache(["long"], 1);
    vi.advanceTimersByTime(60_000);
    expect(qc.queryCache.size).toBe(1);
    expect(qc.getCache(["long"])).toBe(1);
    // The delay is capped at the longest a timer can wait, so the entry still goes eventually.
    vi.advanceTimersByTime(2 ** 31);
    expect(qc.queryCache.size).toBe(0);
  });

  it("[QRY-REV-2] a refetchInterval of Infinity does not poll, and one above 2^31 - 1 ms does not poll at once", async () => {
    vi.useFakeTimers();
    const qc = createQueryClient({ defaultOptions: { queries: { retry: false } } });
    const never = probe<number>();
    const hookNever = renderHook(() =>
      useQuery(["never"], never.fetch, { client: qc, refetchInterval: Number.POSITIVE_INFINITY }),
    );
    never.resolve(0, 1);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(never.calls()).toBe(1);
    hookNever.dispose();

    const long = probe<number>();
    const hookLong = renderHook(() =>
      useQuery(["long"], long.fetch, { client: qc, refetchInterval: THIRTY_DAYS }),
    );
    long.resolve(0, 1);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(long.calls()).toBe(1);
    hookLong.dispose();
  });

  it("[QRY-REV-3] a retryDelay above 2^31 - 1 ms waits instead of retrying at once", async () => {
    vi.useFakeTimers();
    const qc = createQueryClient({
      defaultOptions: { queries: { retry: 1, retryDelay: THIRTY_DAYS } },
    });
    const fn = probe<number>();
    const hook = renderHook(() => useQuery(["slow-retry"], fn.fetch, { client: qc }));
    fn.reject(0, new Error("down"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fn.calls()).toBe(1);
    hook.dispose();
  });
});

describe("mutation reset", () => {
  it("[QRY-REV-7] a call that settles after reset() leaves the state idle", async () => {
    const qc = createQueryClient();
    let finish: (value: string) => void = () => undefined;
    const hook = renderHook(() =>
      useMutation(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
        { client: qc },
      ),
    );
    hook.result.current.mutate(undefined);
    await flush();
    expect(hook.result.current.status()).toBe("pending");
    hook.result.current.reset();
    expect(hook.result.current.status()).toBe("idle");
    finish("late");
    await flush();
    expect(hook.result.current.status()).toBe("idle");
    expect(hook.result.current.data()).toBeUndefined();
    // A call made after the reset shows again.
    hook.result.current.mutate(undefined);
    await flush();
    expect(hook.result.current.status()).toBe("pending");
    finish("next");
    await flush();
    expect(hook.result.current.data()).toBe("next");
    hook.dispose();
  });
});
