import { renderHook } from "@shadow-js/testing";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient, exponentialBackoff, useQuery } from "../src/index";
import { probe } from "./support/probe";

afterEach(() => {
  vi.useRealTimers();
});

describe("retry backoff", () => {
  it("[QRY-B1] property: without jitter the delay doubles from the base, never exceeds the max and never shrinks", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 0, max: 500_000 }),
        (base, extra) => {
          const max = base + extra;
          const delay = exponentialBackoff({ base, max });
          let previous = 0;
          for (let failures = 1; failures <= 60; failures += 1) {
            const value = delay(failures, new Error("x"));
            expect(value).toBeLessThanOrEqual(max);
            expect(value).toBeGreaterThanOrEqual(previous);
            previous = value;
          }
          expect(delay(1, undefined)).toBe(base);
          expect(delay(2, undefined)).toBe(Math.min(2 * base, max));
          expect(delay(60, undefined)).toBe(max);
        },
      ),
      { seed: 42, numRuns: 200 },
    );
  });

  it("[QRY-B2] with jitter the delay is the random share of the capped delay, from the injected random source", () => {
    const random = vi.fn(() => 0.25);
    const delay = exponentialBackoff({ base: 1000, max: 30_000, jitter: true, random });
    expect(delay(1, undefined)).toBe(250);
    expect(delay(3, undefined)).toBe(1000);
    random.mockReturnValue(0.999);
    expect(delay(20, undefined)).toBeLessThan(30_000);
    expect(delay(20, undefined)).toBeGreaterThan(29_000);
    expect(random).toHaveBeenCalledTimes(4);
  });

  it("[QRY-B3] base and max must be finite, positive, with base not above max and max within a timer's range", () => {
    expect(() => exponentialBackoff({ base: 0 })).toThrow(RangeError);
    expect(() => exponentialBackoff({ base: Number.NaN })).toThrow(RangeError);
    expect(() => exponentialBackoff({ max: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(() => exponentialBackoff({ base: 5000, max: 1000 })).toThrow(RangeError);
    // setTimeout fires at once for a delay above 2^31 - 1 ms, so such a cap is refused.
    expect(() => exponentialBackoff({ max: 2 ** 31 })).toThrow(RangeError);
  });

  it("[QRY-B4] a retry function that refuses an error stops at once: one call, the error stored, no timer", async () => {
    vi.useFakeTimers();
    class NotFound extends Error {}
    const qc = createQueryClient({
      defaultOptions: {
        queries: { retry: (count, error) => !(error instanceof NotFound) && count < 5 },
      },
    });
    const fn = probe<number>();
    const hook = renderHook(() => useQuery(["missing"], fn.fetch, { client: qc }));
    fn.reject(0, new NotFound("gone"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fn.calls()).toBe(1);
    expect(hook.result.current.error()).toBeInstanceOf(NotFound);
    expect(hook.result.current.status()).toBe("error");
    expect(vi.getTimerCount()).toBe(0);
    hook.dispose();
  });

  it("[QRY-B5] the retry function receives the failure count and the error of each failure", async () => {
    vi.useFakeTimers();
    const seen: [number, unknown][] = [];
    const qc = createQueryClient({
      defaultOptions: {
        queries: {
          retry: (count, error) => {
            seen.push([count, error]);
            return count < 2;
          },
        },
      },
    });
    const fn = probe<number>();
    const hook = renderHook(() => useQuery(["counted"], fn.fetch, { client: qc }));
    fn.reject(0, "first");
    await vi.advanceTimersByTimeAsync(1000);
    fn.reject(1, "second");
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([
      [1, "first"],
      [2, "second"],
    ]);
    expect(fn.calls()).toBe(2);
    expect(hook.result.current.error()).toBe("second");
    hook.dispose();
  });

  it("[QRY-B6] the default delays double from 1 s and stay at the 30 s cap for every later retry", async () => {
    vi.useFakeTimers();
    const qc = createQueryClient({ defaultOptions: { queries: { retry: 7 } } });
    const fn = probe<number>();
    const hook = renderHook(() => useQuery(["capped"], fn.fetch, { client: qc }));
    const delays = [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000];
    for (let index = 0; index < delays.length; index += 1) {
      fn.reject(index, new Error(`failure ${index}`));
      const wait = delays[index] ?? 0;
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(fn.calls()).toBe(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fn.calls()).toBe(index + 2);
    }
    fn.reject(delays.length, new Error("last"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fn.calls()).toBe(delays.length + 1);
    expect(hook.result.current.status()).toBe("error");
    hook.dispose();
  });

  it("[QRY-B7] retry true keeps retrying at the capped delay until a fetch succeeds", async () => {
    vi.useFakeTimers();
    const qc = createQueryClient({
      defaultOptions: {
        queries: { retry: true, retryDelay: exponentialBackoff({ base: 100, max: 400 }) },
      },
    });
    const fn = probe<number>();
    const hook = renderHook(() => useQuery(["forever"], fn.fetch, { client: qc }));
    const waits = [100, 200, 400, 400, 400, 400];
    for (let index = 0; index < waits.length; index += 1) {
      fn.reject(index, new Error("down"));
      await vi.advanceTimersByTimeAsync(waits[index] ?? 0);
      expect(fn.calls()).toBe(index + 2);
    }
    fn.resolve(waits.length, 11);
    await vi.advanceTimersByTimeAsync(0);
    expect(hook.result.current.data()).toBe(11);
    expect(hook.result.current.status()).toBe("success");
    hook.dispose();
  });
});
