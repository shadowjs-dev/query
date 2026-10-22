import { flush, renderHook } from "@shadow-js/testing";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient, useMutation, useMutationState, useQuery } from "../src/index";
import { scope } from "../src/scope";
import { probe } from "./support/probe";

interface Todo {
  readonly id: number;
  readonly title: string;
}

describe("mutations", () => {
  it("[QRY-M1] callbacks run in order and the state goes pending, then success", async () => {
    const qc = createQueryClient({ features: [scope] });
    const order: string[] = [];
    const work = probe<string>();
    const hook = renderHook(() =>
      useMutation(
        (value: string) =>
          work.fetch({ signal: new AbortController().signal }).then((v) => `${v}${value}`),
        {
          client: qc,
          onMutate: (value) => {
            order.push(`mutate:${value}`);
            return { value };
          },
          onSuccess: (data, _variables, context) => order.push(`success:${data}:${context?.value}`),
          onSettled: (data, error) => order.push(`settled:${data}:${String(error)}`),
        },
      ),
    );
    const mutation = hook.result.current;
    const pending = mutation.mutateAsync("x");
    await flush();
    expect(mutation.isPending()).toBe(true);
    expect(mutation.status()).toBe("pending");
    expect(mutation.variables()).toBe("x");
    work.resolve(0, "ok-");
    await expect(pending).resolves.toBe("ok-x");
    expect(mutation.status()).toBe("success");
    expect(mutation.data()).toBe("ok-x");
    expect(order).toEqual(["mutate:x", "success:ok-x:x", "settled:ok-x:undefined"]);
    hook.dispose();
  });

  it("[QRY-M2] an optimistic update is shown while in flight and rolled back when the mutation fails", async () => {
    const qc = createQueryClient({
      features: [scope],
      defaultOptions: { queries: { retry: false } },
    });
    const list = probe<Todo[]>();
    const write = probe<Todo>();
    const view = renderHook(() => useQuery(["todos"], list.fetch, { client: qc }));
    list.resolve(0, [{ id: 1, title: "a" }]);
    await flush();
    const add = renderHook(() =>
      useMutation(
        (title: string) =>
          write.fetch({ signal: new AbortController().signal }).then(() => ({ id: 2, title })),
        {
          client: qc,
          retry: false,
          onMutate: (title) => {
            const previous = qc.getCache<Todo[]>(["todos"]) ?? [];
            qc.setCache<Todo[]>(["todos"], [...previous, { id: -1, title }]);
            return { previous };
          },
          onError: (_error, _title, context) => {
            qc.setCache<Todo[]>(["todos"], context?.previous ?? []);
          },
        },
      ),
    );
    const promise = add.result.current.mutateAsync("b");
    expect(view.result.current.data()?.map((todo) => todo.title)).toEqual(["a", "b"]);
    const failure = new Error("server said no");
    // The mutation function runs after onMutate's result is awaited: one turn later.
    await flush();
    write.reject(0, failure);
    await expect(promise).rejects.toBe(failure);
    await flush();
    expect(view.result.current.data()?.map((todo) => todo.title)).toEqual(["a"]);
    expect(add.result.current.error()).toBe(failure);
    expect(add.result.current.status()).toBe("error");
    view.dispose();
    add.dispose();
  });

  it("[QRY-M3] mutations do not retry by default; retry: n retries after backoff", async () => {
    vi.useFakeTimers();
    try {
      const qc = createQueryClient({ features: [scope] });
      const fn = probe<number>();
      const once = renderHook(() =>
        useMutation(() => fn.fetch({ signal: new AbortController().signal }), { client: qc }),
      );
      const failing = once.result.current.mutateAsync();
      fn.reject(0, new Error("first"));
      await expect(failing).rejects.toThrow("first");
      await vi.advanceTimersByTimeAsync(5000);
      expect(fn.calls()).toBe(1);
      once.dispose();

      const again = probe<number>();
      const retried = renderHook(() =>
        useMutation(() => again.fetch({ signal: new AbortController().signal }), {
          client: qc,
          retry: 1,
          retryDelay: 50,
        }),
      );
      const second = retried.result.current.mutateAsync();
      again.reject(0, new Error("a"));
      await vi.advanceTimersByTimeAsync(50);
      again.resolve(1, 4);
      await expect(second).resolves.toBe(4);
      retried.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("[QRY-M4] mutate never rejects: a failure is in error() and in onError", async () => {
    const qc = createQueryClient({ features: [scope] });
    const onError = vi.fn();
    const hook = renderHook(() =>
      useMutation(() => Promise.reject(new Error("bad")), { client: qc, retry: false, onError }),
    );
    hook.result.current.mutate(undefined);
    await flush();
    expect(hook.result.current.status()).toBe("error");
    expect(onError).toHaveBeenCalledTimes(1);
    hook.result.current.reset();
    expect(hook.result.current.status()).toBe("idle");
    expect(hook.result.current.error()).toBeUndefined();
    hook.dispose();
  });

  it("[QRY-M5] the state shows the latest call even when an earlier call settles later", async () => {
    const qc = createQueryClient({ features: [scope] });
    const fn = probe<string>();
    const hook = renderHook(() =>
      useMutation(
        (name: string) =>
          fn.fetch({ signal: new AbortController().signal }).then((v) => `${v}:${name}`),
        {
          client: qc,
        },
      ),
    );
    const first = hook.result.current.mutateAsync("first");
    const second = hook.result.current.mutateAsync("second");
    fn.resolve(1, "B");
    await expect(second).resolves.toBe("B:second");
    fn.resolve(0, "A");
    await expect(first).resolves.toBe("A:first");
    expect(hook.result.current.data()).toBe("B:second");
    expect(hook.result.current.variables()).toBe("second");
    hook.dispose();
  });

  it("[QRY-M6] a throwing onMutate is a failed mutation and the mutation function does not run", async () => {
    const qc = createQueryClient({ features: [scope] });
    const body = vi.fn(() => 1);
    const hook = renderHook(() =>
      useMutation(body, {
        client: qc,
        onMutate: () => {
          throw new Error("guard");
        },
      }),
    );
    await expect(hook.result.current.mutateAsync(undefined)).rejects.toThrow("guard");
    expect(body).not.toHaveBeenCalled();
    hook.dispose();
  });

  it("[QRY-M7] useMutationState lists mutations by key and status, and the mutation cache is bounded", async () => {
    const qc = createQueryClient({ features: [scope], mutationCache: { maxMutations: 3 } });
    const fn = probe<number>();
    const pendingOnly = renderHook(() =>
      useMutationState({ mutationKey: ["todos"], status: "pending", client: qc }),
    );
    const hook = renderHook(() =>
      useMutation(() => fn.fetch({ signal: new AbortController().signal }), {
        client: qc,
        mutationKey: ["todos", "add"],
      }),
    );
    const call = hook.result.current.mutateAsync();
    expect(pendingOnly.result.current().map((item) => item.status)).toEqual(["pending"]);
    fn.resolve(0, 1);
    await call;
    expect(pendingOnly.result.current()).toEqual([]);
    for (let index = 0; index < 5; index += 1) void hook.result.current.mutateAsync();
    for (let index = 0; index < 5; index += 1) fn.resolve(index + 1, index);
    await flush();
    expect(qc.mutationCache.size).toBeLessThanOrEqual(3);
    hook.dispose();
    pendingOnly.dispose();
  });

  it("[QRY-M8] the cache callbacks see every settled mutation", async () => {
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const qc = createQueryClient({ features: [scope], mutationCache: { onSuccess, onError } });
    const ok = renderHook(() => useMutation(() => 1, { client: qc }));
    await ok.result.current.mutateAsync();
    const bad = renderHook(() => useMutation(() => Promise.reject(new Error("x")), { client: qc }));
    await expect(bad.result.current.mutateAsync()).rejects.toThrow("x");
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    ok.dispose();
    bad.dispose();
  });

  it("[QRY-M9] mutations in one scope run one at a time, in call order, even when a later call would settle first", async () => {
    const qc = createQueryClient({ features: [scope] });
    const fn = probe<string>();
    const hook = renderHook(() =>
      useMutation(
        (name: string) =>
          fn.fetch({ signal: new AbortController().signal }).then((v) => `${v}:${name}`),
        { client: qc, scope: { id: "ledger" } },
      ),
    );
    const first = hook.result.current.mutateAsync("first");
    const second = hook.result.current.mutateAsync("second");
    await flush();
    expect(fn.calls()).toBe(1);
    fn.resolve(0, "A");
    await expect(first).resolves.toBe("A:first");
    await flush();
    expect(fn.calls()).toBe(2);
    fn.resolve(1, "B");
    await expect(second).resolves.toBe("B:second");
    expect(hook.result.current.data()).toBe("B:second");
    hook.dispose();
  });

  it("[QRY-M10] a failed mutation in a scope does not block the calls queued behind it", async () => {
    const qc = createQueryClient({ features: [scope] });
    const fn = probe<string>();
    const hook = renderHook(() =>
      useMutation(
        (name: string) =>
          fn.fetch({ signal: new AbortController().signal }).then((v) => `${v}:${name}`),
        { client: qc, scope: { id: "ledger" } },
      ),
    );
    const failure = new Error("rejected");
    const first = hook.result.current.mutateAsync("first");
    const second = hook.result.current.mutateAsync("second");
    await flush();
    fn.reject(0, failure);
    await expect(first).rejects.toBe(failure);
    await flush();
    expect(fn.calls()).toBe(2);
    fn.resolve(1, "B");
    await expect(second).resolves.toBe("B:second");
    hook.dispose();
  });

  it("[QRY-M11] calls in different scopes, and calls without a scope, do not wait for each other", async () => {
    const qc = createQueryClient({ features: [scope] });
    const fn = probe<string>();
    const run = (name: string) =>
      fn.fetch({ signal: new AbortController().signal }).then((v) => `${v}:${name}`);
    const scoped = renderHook(() => useMutation(run, { client: qc, scope: { id: "a" } }));
    const other = renderHook(() => useMutation(run, { client: qc, scope: { id: "b" } }));
    const unscoped = renderHook(() => useMutation(run, { client: qc }));
    void scoped.result.current.mutateAsync("1");
    void other.result.current.mutateAsync("2");
    void unscoped.result.current.mutateAsync("3");
    await flush();
    expect(fn.calls()).toBe(3);
    fn.resolve(0, "x");
    fn.resolve(1, "y");
    fn.resolve(2, "z");
    await flush();
    scoped.dispose();
    other.dispose();
    unscoped.dispose();
  });

  it("[QRY-M12] with a scope, an optimistic update that failed is rolled back before the next one applies, so neither clobbers the other", async () => {
    const qc = createQueryClient({
      features: [scope],
      defaultOptions: { queries: { retry: false } },
    });
    const list = probe<string[]>();
    const write = probe<string>();
    const view = renderHook(() => useQuery(["names"], list.fetch, { client: qc }));
    list.resolve(0, ["a"]);
    await flush();
    const add = () =>
      useMutation(() => write.fetch({ signal: new AbortController().signal }), {
        client: qc,
        scope: { id: "names" },
        onMutate: (variable: string) => {
          const previous = qc.getCache<string[]>(["names"]) ?? [];
          qc.setCache<string[]>(["names"], [...previous, variable]);
          return { previous };
        },
        onError: (_error, _variable, context) => {
          qc.setCache<string[]>(["names"], context?.previous ?? []);
        },
      });
    const first = renderHook(() => add());
    const second = renderHook(() => add());
    const failedFirst = first.result.current.mutateAsync("x").catch(() => undefined);
    void second.result.current.mutateAsync("y");
    await flush();
    expect(view.result.current.data()).toEqual(["a", "x"]);
    write.reject(0, new Error("no"));
    await failedFirst;
    await flush();
    // The rollback of "x" ran first, then the queued call applied "y" on top of it. Unscoped, the
    // rollback would have written back ["a"] and erased "y".
    expect(view.result.current.data()).toEqual(["a", "y"]);
    expect(write.calls()).toBe(2);
    write.resolve(1, "ok");
    await flush();
    expect(view.result.current.data()).toEqual(["a", "y"]);
    view.dispose();
    first.dispose();
    second.dispose();
  });
});
