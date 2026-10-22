/**
 * A fetch the test controls: every call records its signal and stays pending until the test settles
 * it, in any order. The engine's concurrency rules are tested through it.
 */
export interface Probe<T> {
  /** The query function to pass to a hook or a client method. */
  readonly fetch: (context: { readonly signal: AbortSignal }) => Promise<T>;
  /** Number of calls made. */
  readonly calls: () => number;
  /** The signal of call `index` (0 is the first call). */
  readonly signalOf: (index: number) => AbortSignal;
  /** Resolves call `index` with `value`. */
  resolve(index: number, value: T): void;
  /** Rejects call `index` with `error`. */
  reject(index: number, error: unknown): void;
  /** Calls that have not settled yet. */
  readonly open: () => number;
}

interface Call<T> {
  readonly signal: AbortSignal;
  readonly settle: (action: () => void) => void;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

export function probe<T>(): Probe<T> {
  const calls: Call<T>[] = [];
  const at = (index: number): Call<T> => {
    const call = calls[index];
    if (call === undefined) throw new Error(`probe: no call ${index}`);
    return call;
  };
  return {
    fetch: ({ signal }) => {
      let resolve: (value: T) => void = () => undefined;
      let reject: (error: unknown) => void = () => undefined;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      calls.push({ signal, settle: (action) => action(), resolve, reject });
      return promise;
    },
    calls: () => calls.length,
    signalOf: (index) => at(index).signal,
    resolve: (index, value) => at(index).resolve(value),
    reject: (index, error) => at(index).reject(error),
    open: () => calls.filter((call) => !call.signal.aborted).length,
  };
}
