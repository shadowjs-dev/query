import { flush, renderHook } from "@shadow-js/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createQueryClient, useQuery } from "../src/index";

type Op =
  | { readonly kind: "mount"; readonly slot: number }
  | { readonly kind: "unmount"; readonly slot: number }
  | { readonly kind: "settle" }
  | { readonly kind: "cancel" };

const SLOTS = 6;

const ops: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({ kind: fc.constant("mount" as const), slot: fc.nat(SLOTS - 1) }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant("unmount" as const), slot: fc.nat(SLOTS - 1) }),
  },
  { weight: 2, arbitrary: fc.constant({ kind: "settle" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "cancel" as const }) },
);

/**
 * A fetch the test settles by hand that also counts what the engine did with each call: started,
 * settled by the test, and aborted by the engine.
 */
function counting() {
  const live: Array<{ readonly resolve: (value: number) => void; readonly signal: AbortSignal }> =
    [];
  const tally = { started: 0, settled: 0, aborted: 0 };
  return {
    tally,
    fetch: ({ signal }: { readonly signal: AbortSignal }): Promise<number> => {
      tally.started += 1;
      return new Promise<number>((resolve) => {
        const call = { resolve, signal };
        live.push(call);
        signal.addEventListener("abort", () => {
          tally.aborted += 1;
        });
      });
    },
    /** Calls that have neither been settled nor aborted. */
    open: (): number => tally.started - tally.settled - tally.aborted,
    /** Resolves the oldest call that is still open. Returns false when there is none. */
    settleOne: (value: number): boolean => {
      const index = live.findIndex((call) => !call.signal.aborted);
      if (index < 0) return false;
      const [call] = live.splice(index, 1);
      call?.resolve(value);
      tally.settled += 1;
      return true;
    },
  };
}

describe("request dedupe across components", () => {
  it("[QRY-R12] property: whatever the order of mounts, unmounts, cancels and settles, a key has at most one request in flight, and fresh data is never fetched again", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(ops, { minLength: 1, maxLength: 40 }), async (sequence) => {
        const qc = createQueryClient({ defaultOptions: { queries: { retry: false } } });
        const fn = counting();
        const disposers = new Map<number, () => void>();
        const options = { client: qc, staleTime: Number.POSITIVE_INFINITY };
        let frozen: number | undefined;
        for (const op of sequence) {
          if (op.kind === "mount" && !disposers.has(op.slot)) {
            // The same key written two ways (object property order): one query.
            const key = op.slot % 2 === 0 ? ["shared", { a: 1, b: 2 }] : ["shared", { b: 2, a: 1 }];
            disposers.set(op.slot, renderHook(() => useQuery(key, fn.fetch, options)).dispose);
          } else if (op.kind === "unmount") {
            disposers.get(op.slot)?.();
            disposers.delete(op.slot);
          } else if (op.kind === "settle") {
            if (fn.settleOne(7) && frozen === undefined) frozen = fn.tally.started;
          } else if (op.kind === "cancel") {
            qc.cancel({ key: ["shared"] });
          }
          await flush();
          // One request at a time for the whole key, however many components ask.
          expect(fn.open()).toBeLessThanOrEqual(1);
          // Once data arrived it is fresh for ever: no component starts another request.
          if (frozen !== undefined) expect(fn.tally.started).toBe(frozen);
        }
        // One more mount shares what is there: it joins an open request, or reads the data, or (when the
        // last one was canceled and nothing is held) starts exactly one.
        const hadData = qc.getCache(["shared", { a: 1, b: 2 }]) !== undefined;
        const startedBefore = fn.tally.started;
        const openBefore = fn.open();
        const last = renderHook(() => useQuery(["shared", { b: 2, a: 1 }], fn.fetch, options));
        await flush();
        if (hadData) expect(fn.tally.started).toBe(startedBefore);
        else if (openBefore === 1) expect(fn.tally.started).toBe(startedBefore);
        else expect(fn.tally.started).toBe(startedBefore + 1);
        expect(fn.open()).toBeLessThanOrEqual(1);
        fn.settleOne(9);
        await flush();
        expect(last.result.current.data()).toBeDefined();
        last.dispose();
        for (const dispose of disposers.values()) dispose();
      }),
      { seed: 42, numRuns: 120 },
    );
  });

  it("[QRY-R13] a second component that mounts while the first one's request is in flight joins it, and both get the data", async () => {
    const qc = createQueryClient({ defaultOptions: { queries: { retry: false } } });
    const fn = counting();
    const first = renderHook(() => useQuery(["joined"], fn.fetch, { client: qc }));
    const second = renderHook(() => useQuery(["joined"], fn.fetch, { client: qc }));
    await flush();
    expect(fn.tally.started).toBe(1);
    fn.settleOne(5);
    await flush();
    expect(first.result.current.data()).toBe(5);
    expect(second.result.current.data()).toBe(5);
    first.dispose();
    second.dispose();
  });
});
