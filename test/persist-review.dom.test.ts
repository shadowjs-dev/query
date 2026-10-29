/**
 * Review round: the two places of `persist` that dropped an error without a word now report it
 * (rule R-CODE-3).
 */
import { flush, renderHook } from "@shadow-js/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createQueryClient, useMutation } from "../src/index";
import { type PersistError, persist } from "../src/persist";
import { queue } from "../src/queue";
import { memoryStorage } from "./support/storage";

const KEY = "shadow-query";

function setOnline(online: boolean): void {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
  window.dispatchEvent(new Event(online ? "online" : "offline"));
}

afterEach(() => {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
});

describe("persist reports what it drops", () => {
  it("[QRY-REV-4] a stored mutation list that turned corrupt while the page ran is replaced with a restore error", async () => {
    setOnline(false);
    const storage = memoryStorage();
    const errors: PersistError[] = [];
    const cache = persist({
      storage,
      onError: (error) => errors.push(error),
      mutations: [{ mutationKey: ["save"], mutationFn: () => undefined }],
    });
    const client = createQueryClient({ features: [queue, cache] });
    storage.data.set(`${KEY}:mutations`, "{not json");
    const hook = renderHook(() =>
      useMutation((name: string) => Promise.resolve(name), { client, mutationKey: ["save"] }),
    );
    hook.result.current.mutate("a");
    await flush();
    await cache.flush();
    expect(errors.map((error) => error.kind)).toEqual(["restore"]);
    expect(JSON.parse(storage.data.get(`${KEY}:mutations`) ?? "null").mutations).toHaveLength(1);
    hook.dispose();
    cache.dispose();
  });

  it("[QRY-REV-5] a paused mutation whose key is not plain data is reported as a serialize error", async () => {
    setOnline(false);
    const storage = memoryStorage();
    const errors: PersistError[] = [];
    const cache = persist({
      storage,
      onError: (error) => errors.push(error),
      mutations: [{ mutationKey: ["save"], mutationFn: () => undefined }],
    });
    const client = createQueryClient({ features: [queue, cache] });
    const hook = renderHook(() =>
      useMutation((name: string) => Promise.resolve(name), {
        client,
        mutationKey: [new Date(0)],
      }),
    );
    hook.result.current.mutate("a");
    await flush();
    expect(errors.map((error) => error.kind)).toEqual(["serialize"]);
    expect(storage.data.has(`${KEY}:mutations`)).toBe(false);
    hook.dispose();
    cache.dispose();
  });

  it("[QRY-REV-6] when the storage refuses to delete an unusable cache, the refusal is reported after the restore error", () => {
    const storage = memoryStorage();
    storage.data.set(KEY, "{not json");
    const refusal = new Error("read only");
    storage.removeItem = () => {
      throw refusal;
    };
    const errors: PersistError[] = [];
    const cache = persist({ storage, onError: (error) => errors.push(error) });
    createQueryClient({ features: [cache] });
    expect(errors.map((error) => error.kind)).toEqual(["restore", "write"]);
    expect(errors[1]?.cause).toBe(refusal);
    cache.dispose();
  });
});
