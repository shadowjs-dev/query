import type { PersistStorage } from "../../src/persist";

/** A storage the test can inspect: a map of strings plus a log of the calls made. */
export interface MemoryStorage extends PersistStorage {
  /** The stored strings by key. */
  readonly data: Map<string, string>;
  /** Every call made, as `"set key"`, `"get key"` or `"remove key"`. */
  readonly calls: string[];
  /** Number of `setItem` calls. */
  sets(): number;
  /** Makes the next `setItem` calls throw `error`, `times` times (default 1). */
  failWrites(error: unknown, times?: number): void;
  /** Makes `getItem` throw (or reject, for the async storage) with `error`. */
  failReads(error: unknown): void;
}

/**
 * An in-memory storage. With `async: true` every method returns a promise that settles on a later turn,
 * as IndexedDB and React Native storage do; otherwise it answers at once, as `localStorage` does.
 */
export function memoryStorage(options: { readonly async?: boolean } = {}): MemoryStorage {
  const data = new Map<string, string>();
  const calls: string[] = [];
  let writeFailure: { readonly error: unknown; times: number } | undefined;
  let readFailure: { readonly error: unknown } | undefined;
  const later = <T>(action: () => T): T | Promise<T> =>
    options.async === true
      ? new Promise<T>((resolve, reject) => {
          setTimeout(() => {
            try {
              resolve(action());
            } catch (error) {
              reject(error);
            }
          }, 0);
        })
      : action();
  return {
    data,
    calls,
    sets: () => calls.filter((call) => call.startsWith("set ")).length,
    failWrites(error, times = 1) {
      writeFailure = { error, times };
    },
    failReads(error) {
      readFailure = { error };
    },
    getItem(key) {
      calls.push(`get ${key}`);
      return later(() => {
        if (readFailure !== undefined) throw readFailure.error;
        return data.get(key) ?? null;
      });
    },
    setItem(key, value) {
      calls.push(`set ${key}`);
      return later(() => {
        if (writeFailure !== undefined && writeFailure.times > 0) {
          writeFailure.times -= 1;
          throw writeFailure.error;
        }
        data.set(key, value);
      });
    },
    removeItem(key) {
      calls.push(`remove ${key}`);
      return later(() => {
        data.delete(key);
      });
    },
  };
}
