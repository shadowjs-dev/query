/**
 * The `queue` feature: while the browser reports no connection, a retry waits for it and a mutation made
 * offline waits in a queue that replays, one call at a time and in call order, when the connection returns.
 * Subpath `@shadow-js/query/queue`. It works with the `offline` feature (which holds the start of a query)
 * or without it. Without this feature a retry runs at once, a mutation runs and fails like `fetch` when
 * offline, `resumePausedMutations()` throws a `TypeError` that names the feature, and so does the
 * `networkMode` option of `useMutation`.
 * @packageDocumentation
 */
import { addMutationWatcher, type QueryFeatureHost } from "./internal/features";
import type { QueryFeature } from "./types";

/** One mutation that waits for its turn: `order` sorts the queue, `start` lets it run. */
interface Waiting {
  readonly id: number;
  readonly order: number;
  readonly start: () => void;
}

/** A restored mutation (see `adopt`) runs before every mutation made in this session. */
const RESTORED_FIRST = -Infinity;

function abortError(): Error {
  const error = new Error("The query was canceled.");
  error.name = "AbortError";
  return error;
}

/**
 * The `queue` feature: install it in `createQueryClient({ features: [queue] })`.
 *
 * With it, a retry waits while the browser is offline (`fetchStatus` is `"paused"`), and a mutation made
 * offline waits in a queue (`isPaused` in the mutation cache). The queue replays one call at a time, in
 * call order, on the `online` event or when `client.resumePausedMutations()` is called. A failed call
 * does not stop the ones behind it. Mutations made while the browser is online are not queued, except
 * while a replay is running, when they wait behind it so the order holds.
 *
 * @example
 * ```ts
 * import { createQueryClient } from "@shadow-js/query";
 * import { offline } from "@shadow-js/query/offline";
 * import { queue } from "@shadow-js/query/queue";
 *
 * const client = createQueryClient({ features: [offline, queue] });
 * // A "retry now" button: replays the queue without waiting for the browser's event.
 * const retryNow = (): Promise<void> => client.resumePausedMutations();
 * ```
 * @see {@link QueryFeature}
 * @since 1.0.0
 */
export const queue: QueryFeature<"queue"> = {
  name: "queue",
  plug(host: QueryFeatureHost): void {
    /** Retries that wait for the connection, with what to do when it returns. */
    const waiting = new Set<() => void>();
    /** The mutations that wait for their turn, sorted by `order` and then by id. */
    const line: Waiting[] = [];
    /** Mutations that were let through and have not settled; their retries wait only for the connection. */
    const admitted = new Set<number>();
    /** Called when a mutation that was let through settles. */
    const settled = new Map<number, () => void>();
    let draining: Promise<void> | undefined;
    let forced = false;
    let watching = false;
    const isOffline = (): boolean => typeof navigator !== "undefined" && navigator.onLine === false;

    /** Lets the retries go, and replays the queue. */
    const resume = (): void => {
      const retries = [...waiting];
      waiting.clear();
      for (const go of retries) go();
      void drain();
      unwatch();
    };
    const watch = (): void => {
      if (watching || typeof window === "undefined") return;
      watching = true;
      window.addEventListener("online", resume);
    };
    function unwatch(): void {
      if (!watching || waiting.size > 0 || line.length > 0 || draining !== undefined) return;
      watching = false;
      if (typeof window !== "undefined") window.removeEventListener("online", resume);
    }

    /** Runs the queued mutations one at a time while the connection is up (or the caller forced it). */
    function drain(): Promise<void> {
      if (draining !== undefined) return draining;
      if (line.length === 0) return Promise.resolve();
      const run = (async (): Promise<void> => {
        while (line.length > 0 && (forced || !isOffline())) {
          const next = line.shift();
          if (next === undefined) break;
          const done = new Promise<void>((resolve) => settled.set(next.id, resolve));
          admitted.add(next.id);
          host.mutations.update(next.id, { isPaused: false });
          next.start();
          await done;
        }
      })();
      draining = run;
      void run.then(() => {
        draining = undefined;
        forced = false;
        unwatch();
      });
      return run;
    }

    // A mutation that reached a final state lets the replay go on.
    addMutationWatcher(host.ext, (record) => {
      if (record.status === "pending") return;
      admitted.delete(record.id);
      const done = settled.get(record.id);
      if (done === undefined) return;
      settled.delete(record.id);
      done();
    });

    const enqueue = (item: Waiting): void => {
      let index = line.length;
      while (index > 0) {
        const before = line[index - 1];
        if (
          before === undefined ||
          before.order < item.order ||
          (before.order === item.order && before.id < item.id)
        ) {
          break;
        }
        index -= 1;
      }
      line.splice(index, 0, item);
      watch();
    };

    /** A promise that settles when the connection returns, or rejects when `signal` aborts first. */
    const untilOnline = (go: () => void, signal?: AbortSignal): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          waiting.delete(release);
          unwatch();
          reject(abortError());
        };
        const release = (): void => {
          signal?.removeEventListener("abort", onAbort);
          go();
          resolve();
        };
        waiting.add(release);
        signal?.addEventListener("abort", onAbort, { once: true });
        watch();
      });

    host.ext.queue = {
      pause(entry, signal, networkMode): Promise<void> | undefined {
        if (networkMode !== "online" || !isOffline()) return undefined;
        host.setState(entry, { fetchStatus: "paused" });
        return untilOnline(() => host.setState(entry, { fetchStatus: "fetching" }), signal);
      },
      gate(id, networkMode): Promise<void> | undefined {
        if (networkMode !== "online") return undefined;
        if (admitted.has(id)) {
          // A retry: it already runs, so it waits only for the connection, not for its turn.
          return isOffline() ? untilOnline(() => undefined) : undefined;
        }
        if (!isOffline() && line.length === 0 && draining === undefined) {
          admitted.add(id);
          return undefined;
        }
        host.mutations.update(id, { isPaused: true });
        return new Promise<void>((resolve) => enqueue({ id, order: id, start: resolve }));
      },
      adopt(id, start): void {
        enqueue({ id, order: RESTORED_FIRST, start });
        if (!isOffline()) void drain();
      },
      resume(): Promise<void> {
        if (line.length === 0 && draining === undefined) return Promise.resolve();
        forced = true;
        return drain();
      },
    };
  },
};
