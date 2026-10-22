/**
 * The `scope` feature: the `scope` option of `useMutation` runs the calls of one scope one at a time,
 * in call order. Subpath `@shadow-js/query/scope`. Without it a `scope` option throws a `TypeError`
 * that names this feature; calls without a scope are unaffected.
 * @packageDocumentation
 */
import type { QueryFeatureHost } from "./internal/features";
import type { QueryFeature } from "./types";

/**
 * The `scope` feature: install it in `createQueryClient({ features: [scope] })`.
 *
 * @example
 * ```ts
 * import { createQueryClient } from "@shadow-js/query";
 * import { scope } from "@shadow-js/query/scope";
 *
 * const client = createQueryClient({ features: [scope] });
 * ```
 * @see {@link QueryFeature}
 * @since 1.0.0
 */
export const scope: QueryFeature<"scope"> = {
  name: "scope",
  plug(host: QueryFeatureHost): void {
    /** The tail of each scope's queue: the promise the next call of the scope waits for. An entry is removed when its queue drains. */
    const tails = new Map<string, Promise<void>>();
    host.ext.scope = {
      run<T>(id: string, task: () => Promise<T>): Promise<T> {
        const previous = tails.get(id) ?? Promise.resolve();
        const run = previous.then(task);
        const tail = run.then(
          () => undefined,
          () => undefined,
        );
        tails.set(id, tail);
        void tail.then(() => {
          if (tails.get(id) === tail) tails.delete(id);
        });
        return run;
      },
    };
  },
};
