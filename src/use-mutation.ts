import { type Accessor, untrack, useSignal } from "@shadow-js/core";
import { useQueryClient } from "./context";
import { withRetries } from "./internal/core";
import { coreOf } from "./internal/registry";
import { matchesKeyPrefix } from "./key";
import type {
  MutationOptions,
  MutationResult,
  MutationState,
  MutationStateOptions,
  MutationStatus,
} from "./types";

type Settled<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: unknown };

interface LocalState<TData, TVariables> {
  readonly status: MutationStatus;
  readonly data: TData | undefined;
  readonly error: unknown;
  readonly variables: TVariables | undefined;
}

function idle<TData, TVariables>(): LocalState<TData, TVariables> {
  return { status: "idle", data: undefined, error: undefined, variables: undefined };
}

/**
 * Creates a mutation: a write (`mutationFn`) with reactive state. Each call starts at once, and
 * calls are not queued or canceled; the state shows the latest call, even when an earlier one
 * settles later. The mutation cache keeps every call for {@link useMutationState}. Nothing runs
 * until `mutate` or `mutateAsync` is called.
 *
 * Optimistic updates: in `onMutate`, write the change with `client.setCache` and return the previous
 * data; in `onError`, write that previous data back (rollback); in `onSettled`, invalidate the query
 * so the server value replaces the guess.
 *
 * @param mutationFn The write. It receives the variables and runs untracked; a rejection (or a
 * throw) is a failed call, retried only as `retry` says.
 * @param options Callbacks, retries, a `mutationKey` and the client (see {@link MutationOptions}).
 * Undefined uses the provided client and its mutation defaults.
 * @returns A {@link MutationResult}.
 * @throws Error ("no QueryClient") when `options.client` is undefined and no client is provided by
 * `QueryClientContext`.
 * @throws TypeError when the client was not made by {@link createQueryClient}.
 * @example
 * import { useMutation, useQueryClient } from "@shadow-js/query";
 *
 * interface Todo { id: number; title: string }
 * const saveTodo = (title: string): Promise<Todo> =>
 *   fetch("/api/todos", { method: "POST", body: title }).then((r) => r.json() as Promise<Todo>);
 *
 * function AddTodo() {
 *   const client = useQueryClient();
 *   const add = useMutation(saveTodo, {
 *     onMutate: (title) => {
 *       const previous = client.getCache<Todo[]>(["todos"]) ?? [];
 *       client.setCache<Todo[]>(["todos"], [...previous, { id: -1, title }]);
 *       return { previous };
 *     },
 *     onError: (_error, _title, context) => client.setCache(["todos"], context?.previous),
 *     onSettled: () => void client.invalidate({ key: ["todos"] }),
 *   });
 *   return <button onClick={() => add.mutate("Write docs")}>Add</button>;
 * }
 * @see useMutationState
 * @see useQuery
 * @since 1.0.0
 */
export function useMutation<TData, TVariables = void, TContext = unknown>(
  mutationFn: (variables: TVariables) => TData | PromiseLike<TData>,
  options: MutationOptions<TData, TVariables, TContext> = {},
): MutationResult<TData, TVariables> {
  const core = coreOf(options.client ?? useQueryClient());
  const [local, setLocal] = useSignal<LocalState<TData, TVariables>>(idle<TData, TVariables>(), {
    equals: false,
  });
  const retry = options.retry ?? core.defaultMutation.retry;
  const retryDelay = options.retryDelay ?? core.defaultMutation.retryDelay;
  const networkMode = options.networkMode ?? "online";
  if (options.networkMode !== undefined) core.need("queue", "the networkMode option");
  // A mutation is not canceled by the engine; withRetries needs a signal that never aborts.
  const neverAborted = new AbortController().signal;
  let latest = 0;

  const put = (next: LocalState<TData, TVariables>): void => {
    setLocal(() => next);
  };
  const notifyCache = (record: { readonly id: number }, outcome: Settled<TData>): void => {
    const info = core.mutations.list().find((item) => item.id === record.id);
    if (info === undefined) return;
    const hook = core.mutationCache;
    core.guard(() =>
      outcome.ok ? hook.onSuccess?.(outcome.data, info) : hook.onError?.(outcome.error, info),
    );
  };

  const execute = async (variables: TVariables): Promise<Settled<TData>> => {
    latest += 1;
    const call = latest;
    const id = core.mutations.add({
      mutationKey: options.mutationKey,
      status: "pending",
      variables,
      data: undefined,
      error: undefined,
      submittedAt: Date.now(),
      isPaused: false,
    });
    put({ status: "pending", data: undefined, error: undefined, variables });
    let context: TContext | undefined;
    try {
      context =
        options.onMutate === undefined
          ? undefined
          : await untrack(() => options.onMutate?.(variables));
      const data = await withRetries(
        () => {
          // The `queue` feature holds an attempt: a call made offline waits for its turn, a retry for the connection.
          const held = core.ext.queue?.gate(id, networkMode);
          const run = (): TData | PromiseLike<TData> => untrack(() => mutationFn(variables));
          return held === undefined ? run() : held.then(run);
        },
        { retry, retryDelay },
        neverAborted,
      );
      const outcome: Settled<TData> = { ok: true, data };
      untrack(() => options.onSuccess?.(data, variables, context));
      untrack(() => options.onSettled?.(data, undefined, variables, context));
      core.mutations.update(id, { status: "success", data });
      if (call === latest) put({ status: "success", data, error: undefined, variables });
      notifyCache({ id }, outcome);
      return outcome;
    } catch (error) {
      core.mutations.update(id, { status: "error", error });
      core.guard(() => options.onError?.(error, variables, context));
      core.guard(() => options.onSettled?.(undefined, error, variables, context));
      if (call === latest) put({ status: "error", data: undefined, error, variables });
      notifyCache({ id }, { ok: false, error });
      return { ok: false, error };
    }
  };

  // A scoped mutation needs the `scope` feature; the check is made once, when the hook is created.
  let run: (variables: TVariables) => Promise<Settled<TData>> = execute;
  if (options.scope !== undefined) {
    const queue = core.need("scope", "the scope option");
    const id = options.scope.id;
    run = (variables) => queue.run(id, () => execute(variables));
  }

  return {
    mutate: (variables) => {
      // run() never rejects: a failure is in `error()` and in the callbacks.
      void run(variables);
    },
    mutateAsync: async (variables) => {
      const outcome = await run(variables);
      if (outcome.ok) return outcome.data;
      throw outcome.error;
    },
    data: () => local().data,
    error: () => local().error,
    status: () => local().status,
    isPending: () => local().status === "pending",
    variables: () => local().variables,
    reset: () => {
      // A call still running no longer owns the state: its result must not undo the reset.
      latest += 1;
      put(idle<TData, TVariables>());
    },
  };
}

/**
 * Lists the mutation calls of a client, reactively: the pending ones and the recent settled ones
 * (as many as `maxMutations` keeps), optionally filtered by `mutationKey` (prefix match) and
 * `status`. Use it to show a pending state anywhere in the app, away from the component that
 * mutates.
 *
 * @param options Filters and the client (see {@link MutationStateOptions}). Undefined lists every
 * mutation of the provided client.
 * @returns A tracked accessor of the matching mutation records, oldest first.
 * @throws Error ("no QueryClient") when `options.client` is undefined and no client is provided by
 * `QueryClientContext`.
 * @throws TypeError when the client was not made by {@link createQueryClient}.
 * @example
 * import { useMutationState } from "@shadow-js/query";
 *
 * function SavingBadge() {
 *   const pending = useMutationState({ mutationKey: ["todos"], status: "pending" });
 *   return <p>{pending().length} saving</p>;
 * }
 * @see useMutation
 * @since 1.0.0
 */
export function useMutationState(
  options: MutationStateOptions = {},
): Accessor<readonly MutationState[]> {
  const core = coreOf(options.client ?? useQueryClient());
  return () =>
    core.mutations.list().filter((record) => {
      if (options.status !== undefined && record.status !== options.status) return false;
      if (options.mutationKey !== undefined) {
        if (record.mutationKey === undefined) return false;
        if (!matchesKeyPrefix(options.mutationKey, record.mutationKey)) return false;
      }
      return true;
    });
}
