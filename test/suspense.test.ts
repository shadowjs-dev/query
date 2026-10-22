import { SuspenseContext, type SuspenseTracker } from "@shadow-js/core";
import { runWithContext } from "@shadow-js/core/extend";
import { flush, renderHook } from "@shadow-js/testing";
import { describe, expect, it } from "vitest";
import { createQueryClient, useQuery } from "../src/index";
import { probe } from "./support/probe";

function tracker(): SuspenseTracker & { readonly held: () => number } {
  let held = 0;
  return {
    increment: () => {
      held += 1;
    },
    decrement: () => {
      held -= 1;
    },
    held: () => held,
  };
}

describe("Suspense integration", () => {
  it("[QRY-SU1] a pending first load inside a boundary holds it until the data arrives", async () => {
    const qc = createQueryClient({ defaultOptions: { queries: { retry: false } } });
    const fn = probe<string>();
    const boundary = tracker();
    const hook = renderHook(() =>
      runWithContext(SuspenseContext, boundary, () =>
        useQuery(["hold"], fn.fetch, { client: qc, suspense: true }),
      ),
    );
    expect(hook.result.current.data()).toBeUndefined();
    expect(boundary.held()).toBe(1);
    expect(hook.result.current.data()).toBeUndefined();
    expect(boundary.held()).toBe(1);
    fn.resolve(0, "ready");
    await flush();
    expect(boundary.held()).toBe(0);
    expect(hook.result.current.data()).toBe("ready");
    hook.dispose();
    expect(boundary.held()).toBe(0);
  });

  it("[QRY-SU2] without the suspense option, a read never holds the boundary", () => {
    const qc = createQueryClient({ defaultOptions: { queries: { retry: false } } });
    const fn = probe<string>();
    const boundary = tracker();
    const hook = renderHook(() =>
      runWithContext(SuspenseContext, boundary, () =>
        useQuery(["plain"], fn.fetch, { client: qc }),
      ),
    );
    expect(hook.result.current.data()).toBeUndefined();
    expect(boundary.held()).toBe(0);
    hook.dispose();
  });

  it("[QRY-SU3] unmounting while the boundary is held releases it exactly once", () => {
    const qc = createQueryClient({ defaultOptions: { queries: { retry: false } } });
    const fn = probe<string>();
    const boundary = tracker();
    const hook = renderHook(() =>
      runWithContext(SuspenseContext, boundary, () =>
        useQuery(["gone"], fn.fetch, { client: qc, suspense: true }),
      ),
    );
    hook.result.current.data();
    expect(boundary.held()).toBe(1);
    hook.dispose();
    expect(boundary.held()).toBe(0);
    hook.dispose();
    expect(boundary.held()).toBe(0);
  });
});
