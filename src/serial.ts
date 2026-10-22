/**
 * Checks that a value survives JSON unchanged: plain objects, arrays, finite numbers, strings,
 * booleans and null, with no cycles. The server sends dehydrated data as JSON, so anything else
 * would arrive different from what was rendered.
 *
 * @packageDocumentation
 * @internal
 */

interface Frame {
  readonly value: unknown;
  readonly exit: boolean;
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Describes the first value that does not survive JSON, or returns `undefined` when all of `value`
 * does. Iterative: the depth of the data cannot exhaust the stack. A shared object (not a cycle) is
 * fine.
 *
 * @param value The data to check.
 * @returns A short description such as `"undefined"` or `"a cycle"`, or `undefined`.
 * @internal
 */
export function jsonProblem(value: unknown): string | undefined {
  const stack: Frame[] = [{ value, exit: false }];
  const onPath = new Set<object>();
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    if (frame.exit) {
      if (typeof frame.value === "object" && frame.value !== null) onPath.delete(frame.value);
      continue;
    }
    const current = frame.value;
    if (current === null || typeof current === "string" || typeof current === "boolean") continue;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return `the number ${String(current)}`;
      continue;
    }
    if (current === undefined) return "undefined (use null)";
    if (typeof current !== "object") return `a ${typeof current} value`;
    if (onPath.has(current)) return "a cycle";
    if (!Array.isArray(current) && !isPlainObject(current)) return "a non-plain object";
    onPath.add(current);
    stack.push({ value: current, exit: true });
    const children: unknown[] = Array.isArray(current)
      ? Array.from({ length: current.length }, (_, index) => current[index])
      : Object.keys(current).map((key) => (current as Record<string, unknown>)[key]);
    for (const child of children) stack.push({ value: child, exit: false });
  }
  return undefined;
}
