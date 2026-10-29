import { renderHook } from "@shadow-js/testing";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient, useMutation } from "../src/index";

describe("onSettled of a mutation", () => {
  it("[QUERY-R7-1] a throw in onSettled after a success is reported; the call still succeeds, onError does not run, onSettled runs once", async () => {
    const qc = createQueryClient();
    const queued: (() => void)[] = [];
    const spy = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
      queued.push(callback as () => void);
    });
    const onError = vi.fn();
    const onSettled = vi.fn(() => {
      throw new Error("settled failed");
    });
    const hook = renderHook(() =>
      useMutation((value: number) => Promise.resolve(value * 2), {
        client: qc,
        onError,
        onSettled,
      }),
    );
    const mutation = hook.result.current;
    let result: number;
    try {
      result = await mutation.mutateAsync(4);
    } finally {
      spy.mockRestore();
    }
    expect(result).toBe(8);
    expect(mutation.status()).toBe("success");
    expect(onError).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(() => {
      for (const callback of queued) callback();
    }).toThrow("settled failed");
  });

  it("[QUERY-R7-2] a failed mutation runs onError and onSettled once each, and a throwing onSettled changes nothing", async () => {
    const qc = createQueryClient();
    const queued: (() => void)[] = [];
    const spy = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
      queued.push(callback as () => void);
    });
    const onError = vi.fn();
    const onSettled = vi.fn(() => {
      throw new Error("settled failed");
    });
    const hook = renderHook(() =>
      useMutation((_value: string) => Promise.reject(new Error("bad")), {
        client: qc,
        retry: false,
        onError,
        onSettled,
      }),
    );
    const mutation = hook.result.current;
    try {
      await expect(mutation.mutateAsync("x")).rejects.toThrow("bad");
    } finally {
      spy.mockRestore();
    }
    expect(mutation.status()).toBe("error");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(queued.length).toBe(1);
  });
});

describe("the gc timer of an unobserved entry", () => {
  it("[QUERY-R7-3] does not keep the event loop alive", async () => {
    const handles: Array<{ delay: number; handle: ReturnType<typeof setTimeout> }> = [];
    const real = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
      delay?: number,
    ) => {
      const handle = real(callback, delay);
      handles.push({ delay: delay ?? 0, handle });
      return handle;
    }) as typeof setTimeout);
    const qc = createQueryClient();
    try {
      await qc.prefetch(["a"], () => Promise.resolve(1));
    } finally {
      spy.mockRestore();
    }
    const gc = handles.filter((item) => item.delay === 300_000);
    expect(gc.length).toBeGreaterThan(0);
    for (const { handle } of gc) {
      expect(typeof handle === "object" && "hasRef" in handle ? handle.hasRef() : false).toBe(
        false,
      );
    }
  });
});
