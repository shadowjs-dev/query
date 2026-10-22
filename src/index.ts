/**
 * Server state for ShadowJS: a bounded keyed cache of server data and the hooks that read and write
 * it. Built only on the public API of `@shadow-js/core`; it imports no DOM-specific code, so it runs
 * on the server and in tests. The key format is the one every ShadowJS cache uses.
 *
 * @packageDocumentation
 * @since 1.0.0
 */

export { type ExponentialBackoffOptions, exponentialBackoff } from "./backoff";
export { createQueryClient } from "./client";
export { QueryClientContext, runWithQueryClient, useQueryClient } from "./context";
export { hashKey, type QueryKey } from "./key";
export type {
  DefaultOptions,
  DehydratedQuery,
  DehydratedState,
  DehydrateOptions,
  FetchStatus,
  MutationCacheOptions,
  MutationCacheView,
  MutationDefaults,
  MutationInfo,
  MutationOptions,
  MutationResult,
  MutationState,
  MutationStateOptions,
  MutationStatus,
  NetworkMode,
  PrefetchOptions,
  QueryCacheEvent,
  QueryCacheOptions,
  QueryCacheView,
  QueryClient,
  QueryClientOptions,
  QueryDefaults,
  QueryFeature,
  QueryFeatureName,
  QueryFilter,
  QueryFunction,
  QueryFunctionContext,
  QueryInfo,
  QueryKeyInput,
  QueryOptions,
  QueryResult,
  QueryStatus,
  RetryDelayOption,
  RetryOption,
} from "./types";
export {
  type InfiniteData,
  type InfiniteQueryFunctionContext,
  type InfiniteQueryOptions,
  type InfiniteQueryResult,
  useInfiniteQuery,
} from "./use-infinite-query";
export { useMutation, useMutationState } from "./use-mutation";
export { type QueryDefinition, type QueryResults, useQueries, useQuery } from "./use-query";
