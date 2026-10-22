/**
 * The full preset of `@shadow-js/query`: every export of the root entry and the three optional
 * features in one import. Subpath `@shadow-js/query/full`. A client that needs only some of the
 * features lists those (`features: [offline]`), so it carries no code for the others.
 * @packageDocumentation
 */
import { hydration } from "./hydration";
import { inspection } from "./inspection";
import { offline } from "./offline";
import { scope } from "./scope";
import type { QueryFeature } from "./types";

export * from "./index";

/**
 * Every optional feature in one frozen list: `offline`, `scope`, `inspection` and `hydration`. Pass it as
 * `createQueryClient({ features: full })`.
 *
 * @example
 * ```ts
 * import { createQueryClient, full } from "@shadow-js/query/full";
 *
 * const client = createQueryClient({ features: full });
 * ```
 * @since 1.0.0
 */
export const full: readonly [
  QueryFeature<"offline">,
  QueryFeature<"scope">,
  QueryFeature<"inspection">,
  QueryFeature<"hydration">,
] = Object.freeze([offline, scope, inspection, hydration]);
