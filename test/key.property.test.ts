import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { hashKey, matchesKeyPrefix } from "../src/key";

/** Plain data with bounded depth: the shapes a query key can take. */
const plain: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  leaf: fc.oneof(
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.string({ maxLength: 4 }),
    fc.boolean(),
    fc.constant(null),
  ),
  node: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    tie("leaf"),
    fc.array(tie("node"), { maxLength: 3 }),
    fc.dictionary(fc.string({ maxLength: 3 }), tie("node"), { maxKeys: 3 }),
  ),
})).node;

/** Rebuilds an object with its keys in reverse insertion order. */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).reverse()) {
      out[key] = reversed((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

describe("query key properties", () => {
  it("[QRY-K8] property: the hash is the same for equal data whatever the property order", () => {
    fc.assert(
      fc.property(fc.array(plain, { maxLength: 4 }), (key) => {
        expect(hashKey(key)).toBe(hashKey(reversed(key) as unknown[]));
      }),
      { seed: 42, numRuns: 300 },
    );
  });

  it("[QRY-K9] property: different data gives different hashes (no collisions in a sample)", () => {
    fc.assert(
      fc.property(fc.array(plain, { maxLength: 3 }), fc.array(plain, { maxLength: 3 }), (a, b) => {
        const same = JSON.stringify(a) === JSON.stringify(b);
        if (!same) expect(hashKey(a) === hashKey(b)).toBe(false);
      }),
      { seed: 42, numRuns: 300 },
    );
  });

  it("[QRY-K10] property: every prefix of a key matches it", () => {
    fc.assert(
      fc.property(fc.array(plain, { maxLength: 5 }), fc.nat({ max: 5 }), (key, cut) => {
        const length = Math.min(cut, key.length);
        expect(matchesKeyPrefix(key.slice(0, length), key)).toBe(true);
      }),
      { seed: 42, numRuns: 200 },
    );
  });
});
