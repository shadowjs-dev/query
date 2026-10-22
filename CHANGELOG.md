# Changelog

## 1.0.0

### Added

- Reactive queries, infinite queries and mutations with keyed caching and invalidation.
- Optional offline, scope, inspection and hydration features with a full preset.
- `persist` (`@shadow-js/query/persist`): keeps the cache in a storage (`localStorage`, IndexedDB, React Native) with
  `maxAge`, `buster`, `shouldPersist`, throttled writes (flushed on `pagehide`), size caps, quota and error handling that
  never throws into app code, a restore that shows data with no loading state, and `BroadcastChannel` sync between tabs.
- `queue` (`@shadow-js/query/queue`): retries wait while the browser is offline; mutations made offline wait in a queue
  (`isPaused`), replay one at a time in call order on reconnect, and `client.resumePausedMutations()` replays on demand.
  `useMutation` takes `networkMode`.
- `persist({ mutations })` stores queued mutations and replays them after a reload (at least once, one tab per call
  through Web Locks where available).
- `createDehydrationStream` and `hydrateFromStream` (`@shadow-js/query/server`): queries that finish after the shell are
  appended to a streamed response and read as the browser parses them.
- Hydrated and restored fetch times ahead of the local clock are clamped to now.
