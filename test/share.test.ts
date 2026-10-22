import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { structuralShare } from "../src/share";

/** Recursive comparison for test data only (depth is bounded by the generator). */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) =>
    same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

const jsonLike: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  leaf: fc.oneof(fc.integer(), fc.string({ maxLength: 4 }), fc.boolean(), fc.constant(null)),
  node: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    tie("leaf"),
    fc.array(tie("node"), { maxLength: 4 }),
    fc.dictionary(fc.string({ maxLength: 3 }), tie("node"), { maxKeys: 4 }),
  ),
})).node;

describe("structural sharing", () => {
  it("[QRY-S1] returns the previous value when the new one is equal as data", () => {
    const prev = { a: [1, { b: "x" }], c: null };
    const next = { c: null, a: [1, { b: "x" }] };
    expect(structuralShare(prev, next)).toBe(prev);
  });

  it("[QRY-S2] keeps the references of unchanged subtrees and takes the new changed ones", () => {
    const prev = { keep: { deep: [1, 2] }, change: { v: 1 } };
    const next = { keep: { deep: [1, 2] }, change: { v: 2 } };
    const out = structuralShare(prev, next);
    expect(out).not.toBe(prev);
    expect(out.keep).toBe(prev.keep);
    expect(out.change).toEqual({ v: 2 });
  });

  it("[QRY-S3] a different type or a leaf is returned as the new value", () => {
    expect(structuralShare([1], { 0: 1 })).toEqual({ 0: 1 });
    expect(structuralShare(1, 2)).toBe(2);
    const next = { x: 1 };
    expect(structuralShare(undefined, next)).toBe(next);
  });

  it("[QRY-S4] shares a DAG and rejects a cycle", () => {
    const shared = { n: 1 };
    const prev = { a: shared, b: shared };
    const next = { a: { n: 1 }, b: { n: 1 } };
    expect(structuralShare(prev, next)).toBe(prev);

    const cycle: Record<string, unknown> = { v: 1 };
    cycle["self"] = cycle;
    const before: Record<string, unknown> = { v: 0 };
    before["self"] = before;
    expect(() => structuralShare(before, cycle)).toThrow(TypeError);
  });

  it("[QRY-S5] a key named __proto__ is data, not a prototype write", () => {
    const next = JSON.parse('{"__proto__":{"polluted":true},"v":2}') as Record<string, unknown>;
    const out = structuralShare({ v: 1 }, next);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.keys(out)).toEqual(["__proto__", "v"]);
  });

  it("[QRY-S6] property: the result equals the new value, and is the previous value when they are equal", () => {
    fc.assert(
      fc.property(jsonLike, jsonLike, (a, b) => {
        const out = structuralShare(a, b);
        expect(same(out, b)).toBe(true);
        if (same(a, b) && typeof a === "object" && a !== null) expect(out).toBe(a);
      }),
      { seed: 42, numRuns: 400 },
    );
  });

  it("[QRY-S7] property: a subtree that did not change keeps its previous identity", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ maxLength: 2 }), jsonLike, { maxKeys: 5 }),
        jsonLike,
        (base, extra) => {
          const prev = { ...base, extra: { ...base } };
          const next = { ...base, extra };
          const out = structuralShare(prev, next);
          for (const key of Object.keys(base)) {
            if (
              same((prev as Record<string, unknown>)[key], (next as Record<string, unknown>)[key])
            ) {
              expect((out as Record<string, unknown>)[key]).toBe(
                (prev as Record<string, unknown>)[key],
              );
            }
          }
        },
      ),
      { seed: 42, numRuns: 300 },
    );
  });

  it("[QRY-S8] walks deep data without recursion", () => {
    let prev: unknown = 0;
    let next: unknown = 1;
    for (let i = 0; i < 20_000; i += 1) {
      prev = [prev];
      next = [next];
    }
    const out = structuralShare(prev, next);
    // Boolean checks: a failing toBe would make vitest diff 20 000 levels and overflow its own stack.
    expect(out === prev || out === next).toBe(false);
  });
});
