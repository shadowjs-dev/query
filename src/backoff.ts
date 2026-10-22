/**
 * Retry delays for `retryDelay`: exponential backoff with a cap and optional full jitter. Kept in its
 * own module so a client that never asks for it does not pay for it in its bundle.
 *
 * @packageDocumentation
 * @since 1.0.0
 */

/**
 * Options of {@link exponentialBackoff}.
 * @since 1.0.0
 */
export interface ExponentialBackoffOptions {
  /**
   * The delay after the first failure, in milliseconds; it doubles with each further failure.
   * Must be finite and positive, and not above `max`.
   * @default 1000, or `max` when that is smaller
   */
  readonly base?: number | undefined;
  /**
   * The longest delay, in milliseconds. Must be finite, positive, and at most 2^31 - 1 (the longest
   * delay a timer can wait; a longer one would fire at once).
   * @default 30000
   */
  readonly max?: number | undefined;
  /**
   * Full jitter: each delay is a random share of the capped delay, so many clients that failed
   * together do not all retry at the same instant.
   * @default false
   */
  readonly jitter?: boolean | undefined;
  /**
   * The random source of jitter. It returns a number in `[0, 1)`; tests pass a fixed one.
   * @default Math.random
   */
  readonly random?: (() => number) | undefined;
}

/** The longest delay a timer can wait, in milliseconds. @internal */
const MAX_TIMER_DELAY = 2 ** 31 - 1;

/**
 * Returns a `retryDelay` function: the delay before retry number `failureCount` (1 after the first
 * failure) is `base` doubled for each failure after the first, capped at `max`. With `jitter`, the
 * delay is a random share of that capped value (full jitter).
 *
 * @param options See {@link ExponentialBackoffOptions}.
 * @returns A function of the failure count and the error, returning the delay in milliseconds.
 * @throws RangeError when `base` or `max` is not a finite positive number, when `base` is above
 * `max`, or when `max` is above 2^31 - 1.
 * @example
 * import { createQueryClient, exponentialBackoff } from "@shadow-js/query";
 *
 * export const client = createQueryClient({
 *   defaultOptions: {
 *     queries: { retryDelay: exponentialBackoff({ base: 500, max: 10_000, jitter: true }) },
 *   },
 * });
 * @since 1.0.0
 */
export function exponentialBackoff(
  options: ExponentialBackoffOptions = {},
): (failureCount: number, error: unknown) => number {
  const max = options.max ?? 30_000;
  const base = options.base ?? Math.min(1000, max);
  if (!Number.isFinite(max) || max <= 0 || max > MAX_TIMER_DELAY) {
    throw new RangeError(
      `exponentialBackoff: max must be a finite positive number up to ${MAX_TIMER_DELAY}, got ${max}`,
    );
  }
  if (!Number.isFinite(base) || base <= 0 || base > max) {
    throw new RangeError(
      `exponentialBackoff: base must be a finite positive number not above max (${max}), got ${base}`,
    );
  }
  const jitter = options.jitter === true;
  const random = options.random ?? Math.random;
  return (failureCount: number): number => {
    const capped = Math.min(base * 2 ** (failureCount - 1), max);
    return jitter ? random() * capped : capped;
  };
}
