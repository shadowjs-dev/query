/**
 * Structural sharing: when fresh data arrives, every part that did not change keeps the reference it
 * had, so memoized selectors and `Object.is` checks in the UI see no change. Iterative (explicit
 * stack), so the depth of the data cannot exhaust the call stack.
 *
 * @packageDocumentation
 * @internal
 */

const PENDING = 0;
const VISITING = 1;
const DONE = 2;

interface Pair {
  readonly prev: object;
  readonly next: object;
  state: number;
  readonly kids: Map<string, Pair>;
  result: unknown;
}

interface Frame {
  readonly pair: Pair;
  expanded: boolean;
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Plain objects and arrays are shared structurally; every other value is compared by identity. */
function isContainer(value: unknown): value is object {
  return (
    typeof value === "object" && value !== null && (Array.isArray(value) || isPlainObject(value))
  );
}

function hasOwn(target: object, key: string): boolean {
  return Object.hasOwn(target, key);
}

function pairFor(pairs: Map<object, Map<object, Pair>>, prev: object, next: object): Pair {
  let byPrev = pairs.get(next);
  if (byPrev === undefined) {
    byPrev = new Map<object, Pair>();
    pairs.set(next, byPrev);
  }
  let pair = byPrev.get(prev);
  if (pair === undefined) {
    pair = { prev, next, state: PENDING, kids: new Map<string, Pair>(), result: undefined };
    byPrev.set(prev, pair);
  }
  return pair;
}

/** Decides the result of one container once every child has its result. */
function finalize(pair: Pair): void {
  const prev = pair.prev as Record<string, unknown>;
  const next = pair.next as Record<string, unknown>;
  const keys = Object.keys(next);
  let changed = Object.keys(prev).length !== keys.length;
  const values: Array<readonly [string, unknown]> = [];
  for (const key of keys) {
    const kid = pair.kids.get(key);
    const value = kid === undefined ? next[key] : kid.result;
    if (!hasOwn(prev, key) || !Object.is(prev[key], value)) changed = true;
    values.push([key, value]);
  }
  if (!changed) {
    pair.result = pair.prev;
    return;
  }
  const out: Record<string, unknown> | unknown[] = Array.isArray(pair.next) ? [] : {};
  // defineProperty, not assignment: a key named "__proto__" is data, not a prototype write.
  for (const [key, value] of values) {
    Object.defineProperty(out, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  pair.result = out;
}

/**
 * Returns `next`, except that every part equal (as data) to the same part of `prev` is replaced by
 * the `prev` reference, and a container equal to `prev` as a whole is `prev` itself.
 *
 * Only plain objects and arrays are walked; other values are compared with `Object.is`. A shared
 * object referenced twice is walked once. A cycle is rejected with a TypeError, since it has no
 * finite data to compare.
 *
 * @param prev The value currently held.
 * @param next The freshly fetched value.
 * @returns A value deep-equal to `next` that reuses the references of `prev` wherever possible.
 * @throws TypeError when `next` contains a cycle.
 * @internal
 */
export function structuralShare<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) return next;
  if (!isContainer(prev) || !isContainer(next) || Array.isArray(prev) !== Array.isArray(next)) {
    return next;
  }
  const pairs = new Map<object, Map<object, Pair>>();
  const root = pairFor(pairs, prev, next);
  const stack: Frame[] = [{ pair: root, expanded: false }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top === undefined) break;
    const pair = top.pair;
    if (!top.expanded) {
      top.expanded = true;
      if (pair.state === DONE) {
        stack.pop();
        continue;
      }
      pair.state = VISITING;
      const next = pair.next as Record<string, unknown>;
      const prevRecord = pair.prev as Record<string, unknown>;
      for (const key of Object.keys(next)) {
        const value = next[key];
        if (!hasOwn(prevRecord, key)) continue;
        const before = prevRecord[key];
        if (Object.is(before, value)) continue;
        if (!isContainer(before) || !isContainer(value)) continue;
        if (Array.isArray(before) !== Array.isArray(value)) continue;
        const child = pairFor(pairs, before, value);
        if (child.state === VISITING) {
          throw new TypeError("structuralShare: cannot compare a cyclic value");
        }
        pair.kids.set(key, child);
        if (child.state === PENDING) stack.push({ pair: child, expanded: false });
      }
    } else {
      stack.pop();
      finalize(pair);
      pair.state = DONE;
    }
  }
  return root.result as T;
}
