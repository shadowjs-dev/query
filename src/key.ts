/**
 * The one key format of ShadowJS caches. A query key is an array of plain data; its hash is the
 * canonical text of that data. The text is not a digest, so two different keys never collide.
 *
 * The text is the same as the router's loader-cache key for plain data (`canonicalKey` in
 * `@shadow-js/router/core`), so a loader cache, `cache(fn, key)` and a query can name one
 * resource identically. A test checks the two stay byte-identical.
 *
 * @packageDocumentation
 * @since 1.0.0
 */

/**
 * A query key: an array of plain data (null, booleans, numbers, strings, arrays and plain objects,
 * and `undefined`) that names one cache entry. Functions, class instances, Maps, Dates, symbols and
 * bigints cannot be hashed. Prefer JSON data (no `undefined`, finite numbers): `dehydrate` refuses
 * any other key.
 * @since 1.0.0
 */
export type QueryKey = readonly unknown[];

type Work =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "exit"; readonly container: object };

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Canonical text of plain data: object keys sorted, arrays in order, strings JSON-quoted so that
 * separators inside a value cannot collide. Iterative, so nesting depth cannot exhaust the stack.
 *
 * @param value Plain data.
 * @returns The canonical text.
 * @throws TypeError for a function, symbol, bigint, non-plain object or cycle.
 * @internal
 */
export function canonicalText(value: unknown): string {
  const out: string[] = [];
  const stack: Work[] = [{ kind: "value", value }];
  const active = new Set<object>();
  while (stack.length > 0) {
    const work = stack.pop();
    if (work === undefined) break;
    if (work.kind === "text") {
      out.push(work.text);
      continue;
    }
    if (work.kind === "exit") {
      active.delete(work.container);
      continue;
    }
    const current = work.value;
    if (current === null) {
      out.push("z");
    } else if (current === undefined) {
      out.push("u");
    } else if (typeof current === "boolean") {
      out.push(current ? "T" : "F");
    } else if (typeof current === "number") {
      out.push(`n${Object.is(current, -0) ? "0" : String(current)};`);
    } else if (typeof current === "string") {
      out.push(`s${JSON.stringify(current)};`);
    } else if (typeof current === "object") {
      if (active.has(current)) {
        throw new TypeError("query key: cannot hash a cyclic value");
      }
      if (Array.isArray(current)) {
        active.add(current);
        stack.push({ kind: "exit", container: current });
        stack.push({ kind: "text", text: "]" });
        for (let index = current.length - 1; index >= 0; index -= 1) {
          if (index < current.length - 1) stack.push({ kind: "text", text: "," });
          stack.push({ kind: "value", value: current[index] });
        }
        out.push("[");
      } else {
        if (!isPlainObject(current)) {
          throw new TypeError("query key: cannot hash a non-plain object (use plain data)");
        }
        const record = current as Record<string, unknown>;
        const keys = Object.keys(record).sort();
        active.add(current);
        stack.push({ kind: "exit", container: current });
        stack.push({ kind: "text", text: "}" });
        for (let index = keys.length - 1; index >= 0; index -= 1) {
          const key = keys[index];
          if (key === undefined) continue;
          stack.push({ kind: "value", value: record[key] });
          stack.push({ kind: "text", text: `${JSON.stringify(key)}:` });
          if (index > 0) stack.push({ kind: "text", text: "," });
        }
        out.push("{");
      }
    } else {
      throw new TypeError(`query key: cannot hash a ${typeof current} value`);
    }
  }
  return out.join("");
}

/**
 * Returns the hash of a query key: its canonical text, which identifies the cache entry. Equal keys
 * (as data) give equal hashes whatever the order of object properties, `-0` and `0` are the same,
 * and the hash is stable across processes, so the server and the browser agree on it.
 *
 * @param key The key, an array of plain data.
 * @returns The hash used to find the cache entry.
 * @throws TypeError when the key holds a value that is not plain data (a function, symbol, bigint,
 * class instance or cycle).
 * @example
 * import { hashKey } from "@shadow-js/query";
 *
 * const a = hashKey(["todos", { done: false, page: 1 }]);
 * const b = hashKey(["todos", { page: 1, done: false }]);
 * console.log(a === b); // true
 * @since 1.0.0
 */
export function hashKey(key: QueryKey): string {
  return canonicalText(key);
}

/**
 * True when every element of `filter` equals the element at the same position of `key`, compared
 * by canonical text. `["todos"]` matches `["todos", 1]`; `["todos", 1]` does not match `["todos"]`.
 * Used by query filters and `useMutationState`; not exported by the package.
 *
 * @param filter The prefix.
 * @param key The key tested.
 * @returns Whether `filter` is a prefix of `key`.
 * @throws TypeError when an element compared is not plain data.
 * @internal
 */
export function matchesKeyPrefix(filter: QueryKey, key: QueryKey): boolean {
  if (filter.length > key.length) return false;
  for (let index = 0; index < filter.length; index += 1) {
    if (canonicalText(filter[index]) !== canonicalText(key[index])) return false;
  }
  return true;
}
