import { flush, renderHook } from "@shadow-js/testing";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient, useQuery } from "../src/index";
import { probe } from "./support/probe";

afterEach(() => {
  vi.useRealTimers();
});

type Op =
  | { readonly kind: "set"; readonly index: number }
  | { readonly kind: "advance"; readonly ms: number };

const ops: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("set" as const), index: fc.integer({ min: 0, max: 40 }) }),
  fc.record({ kind: fc.constant("advance" as const), ms: fc.integer({ min: 0, max: 400 }) }),
);

describe("query cache garbage collection", () => {
  it("[QRY-G1] property: unobserved entries never exceed the bound, and all of them go after gcTime", () => {
    fc.assert(
      fc.property(fc.array(ops, { minLength: 1, maxLength: 60 }), (sequence) => {
        vi.useFakeTimers();
        try {
          const qc = createQueryClient({
            queryCache: { maxQueries: 7 },
            defaultOptions: { queries: { gcTime: 1000 } },
          });
          for (const op of sequence) {
            if (op.kind === "set") qc.setCache(["k", op.index], op.index);
            else vi.advanceTimersByTime(op.ms);
            expect(qc.queryCache.size).toBeLessThanOrEqual(7);
          }
          vi.advanceTimersByTime(1001);
          expect(qc.queryCache.size).toBe(0);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          vi.useRealTimers();
        }
      }),
      { seed: 42, numRuns: 150 },
    );
  });

  it("[QRY-G3] an unobserved query whose refetch outlives gcTime is removed gcTime after that refetch settles", async () => {
    vi.useFakeTimers();
    try {
      const qc = createQueryClient({
        defaultOptions: { queries: { gcTime: 1000, retry: false } },
      });
      const fn = probe<number>();
      const hook = renderHook(() => useQuery(["late"], fn.fetch, { client: qc }));
      fn.resolve(0, 1);
      await flush();
      hook.dispose();
      void qc.refetchQueries({ key: ["late"] });
      vi.advanceTimersByTime(1001);
      expect(qc.queryCache.size).toBe(1);
      fn.resolve(1, 2);
      await flush();
      vi.advanceTimersByTime(999);
      expect(qc.queryCache.size).toBe(1);
      vi.advanceTimersByTime(1);
      expect(qc.queryCache.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("[QRY-G2] property: a mounted query survives any amount of garbage collection time", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5000 }), async (ms) => {
        vi.useFakeTimers();
        try {
          const qc = createQueryClient({
            defaultOptions: { queries: { gcTime: 10, retry: false } },
          });
          const fn = probe<number>();
          const hook = renderHook(() => useQuery(["mounted"], fn.fetch, { client: qc }));
          fn.resolve(0, 1);
          await flush();
          vi.advanceTimersByTime(ms);
          expect(qc.getCache(["mounted"])).toBe(1);
          hook.dispose();
        } finally {
          vi.useRealTimers();
        }
      }),
      { seed: 42, numRuns: 25 },
    );
  });

  it("[QRY-G4] gcTime Infinity keeps an unobserved query with no timer, until reset removes it", () => {
    const qc = createQueryClient({
      defaultOptions: { queries: { gcTime: Number.POSITIVE_INFINITY } },
    });
    vi.useFakeTimers();
    try {
      qc.setCache(["forever"], 1);
      vi.advanceTimersByTime(10 * 365 * 24 * 3600 * 1000);
      expect(qc.getCache(["forever"])).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      qc.reset();
      expect(qc.queryCache.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
