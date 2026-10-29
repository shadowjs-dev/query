import {
  type Accessor,
  isServer,
  onCleanup,
  SuspenseContext,
  untrack,
  useContext,
  useMemo,
  useRenderEffect,
} from "@shadow-js/core";
import { createSignalNode, readSignal, type SignalNode, writeSignal } from "@shadow-js/core/extend";
import { hashKey, type QueryKey } from "../key";
import type { QueryKeyInput } from "../types";
import {
  type Core,
  type Outcome,
  type Policy,
  type QueryEntry,
  type QueryState,
  type Runner,
  timerDelay,
} from "./core";

/** @internal */
export interface ObserverArgs {
  readonly core: Core;
  readonly key: QueryKeyInput;
  readonly enabled: Accessor<boolean>;
  readonly policy: Policy;
  /** Builds what a fetch runs, for the entry the observer uses. */
  readonly runnerFor: (entry: QueryEntry, key: QueryKey) => Runner;
  readonly interval: Accessor<number | false> | undefined;
  readonly suspense: boolean;
  /** Runs once when a new entry is attached (seeds `initialData`). */
  readonly seed: ((entry: QueryEntry) => void) | undefined;
}

/** @internal */
export interface Observer {
  /** The entry the hook reads, tracked. */
  readonly snapshot: Accessor<QueryState | undefined>;
  /** Fetches the entry again, canceling a fetch in flight. */
  readonly refetch: () => Promise<Outcome<unknown>>;
  /** Holds the nearest Suspense boundary while the first load is pending (no-op outside one). */
  readonly holdIfPending: () => void;
  /** The entry, untracked. */
  readonly entry: () => QueryEntry | undefined;
}

const NOT_RUN: Outcome<unknown> = { ok: false, error: undefined, canceled: true };

/**
 * Connects a component to one cache entry. It attaches when the key is known, detaches when the key
 * changes or the owner is disposed, and keeps the enabled flag, the polling interval and the
 * Suspense hold in step with the component. Built only from public core primitives: a memo for the
 * key, render effects for the subscription, and a signal naming the current entry.
 *
 * On the server nothing subscribes or fetches: the entry is looked up and read, so a value seeded by
 * `hydrate` or `prefetch` is rendered.
 *
 * @internal
 */
export function createObserver(args: ObserverArgs): Observer {
  const { core } = args;
  const target = useMemo(
    () => {
      const raw = typeof args.key === "function" ? args.key() : args.key;
      if (raw === false || raw === null || raw === undefined) return undefined;
      return { hash: hashKey(raw), key: raw };
    },
    {
      equals: (a, b) => a === b || (a !== undefined && b !== undefined && a.hash === b.hash),
    },
  );
  const current: SignalNode<QueryEntry | undefined> = createSignalNode<QueryEntry | undefined>(
    undefined,
    false,
  );
  let observed:
    | { entry: QueryEntry; key: QueryKey; fetchable: boolean; runner: Runner }
    | undefined;

  const detach = (): void => {
    if (observed === undefined) return;
    const previous = observed;
    observed = undefined;
    core.detach(previous.entry, previous.fetchable);
  };

  const attach = (key: QueryKey, hash: string): void => {
    const entry = core.ensure(key, hash);
    if (args.seed !== undefined) args.seed(entry);
    const fetchable = untrack(args.enabled);
    const runner = args.runnerFor(entry, key);
    observed = { entry, key, fetchable, runner };
    core.attach(entry, { fetchable, runner, policy: args.policy });
    writeSignal(current, entry, { allowInMemo: true });
  };

  if (isServer) {
    // Render-only: the entry is looked up (it may hold seeded data) and nothing is fetched.
    const resolved = untrack(() => target());
    if (resolved !== undefined) {
      writeSignal(current, core.ensure(resolved.key, resolved.hash), { allowInMemo: true });
    }
  } else {
    useRenderEffect(target, (resolved) => {
      if (resolved === undefined) {
        writeSignal(current, undefined, { allowInMemo: true });
        return undefined;
      }
      attach(resolved.key, resolved.hash);
      return detach;
    });
    useRenderEffect(args.enabled, (on) => {
      const active = observed;
      if (active === undefined || active.fetchable === on) return;
      active.fetchable = on;
      if (on) core.enable(active.entry, active.runner);
      else core.disable(active.entry);
    });
    if (args.interval !== undefined) {
      const every = args.interval;
      useRenderEffect(
        () => (args.enabled() ? every() : false),
        (ms) => {
          // Infinity means "never"; a NaN or negative interval is none. A setInterval of 0 would poll in a hot loop.
          if (ms === false || !(ms > 0) || ms === Number.POSITIVE_INFINITY) return undefined;
          const timer = setInterval(() => {
            const active = observed;
            if (active !== undefined) void core.refetch(active.entry, false);
          }, timerDelay(ms));
          return () => clearInterval(timer);
        },
      );
    }
  }

  const snapshot: Accessor<QueryState | undefined> = useMemo(() => {
    const entry = readSignal(current);
    return entry === undefined ? undefined : core.read(entry);
  });

  // A pending first load holds the Suspense boundary the hook is read in, until it settles.
  const tracker = args.suspense && !isServer ? useContext(SuspenseContext) : null;
  let held = false;
  const release = (): void => {
    if (!held || tracker === null) return;
    held = false;
    tracker.decrement();
  };
  if (tracker !== null) {
    useRenderEffect(
      () => snapshot()?.status,
      (status) => {
        if (status !== "pending") release();
      },
    );
    onCleanup(release);
  }

  return {
    snapshot,
    refetch: () => {
      const entry = untrack(() => readSignal(current));
      return entry === undefined ? Promise.resolve(NOT_RUN) : core.refetch(entry, true);
    },
    holdIfPending: () => {
      if (tracker === null || held) return;
      if ((snapshot()?.status ?? "pending") !== "pending") return;
      held = true;
      tracker.increment();
    },
    entry: () => untrack(() => readSignal(current)),
  };
}

/** Reads a value that may be an accessor. @internal */
export function accessorOf<T>(value: T | Accessor<T>): Accessor<T> {
  return typeof value === "function" ? (value as Accessor<T>) : () => value;
}
