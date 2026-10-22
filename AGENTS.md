# AGENTS.md: working on query

This file is for anyone who changes this repository, people and coding agents alike. It says how the repository is laid out, how to implement
and test a change, and how a pull request is reviewed. To **use** the released package, read [README.md](README.md) and [SKILL.md](SKILL.md)
instead; to take part in the project, read [CONTRIBUTING.md](CONTRIBUTING.md).

Server state: typed keys, caching, mutations, infinite queries and offline support.

## What is in this repository

| Package | Folder | What it is | Documentation |
| --- | --- | --- | --- |
| `@shadow-js/query` | `.` | Fetch, cache and update server data with queries, mutations and optimistic updates | https://query.shadowjs.net |

The repository is the package: `@shadow-js/query`. Source and issues:
https://github.com/shadowjs-dev/query. Every package of the project has the same version number.

## Set up

You need Node.js 22.12 or newer and npm (pnpm and Yarn are not used).

```sh
npm install
npm run check   # lint, build, type check and every test
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run lint` | Biome: lint and format check (`npx biome check --write <path>` fixes what it can) |
| `npm run build` | builds the package with tsdown |
| `npm run typecheck` | TypeScript 7 in strict mode, tests included |
| `npm test` | unit, DOM and server tests (Vitest) |
| `npx vitest run <path>` | one test file |
| `npm run test:gc` | memory and leak tests |
| `npm run test:perf` | wall-clock budgets; run alone, never in parallel with other work |
| `npm run check` | all of the above; a change is ready when it passes |

## Layout

- `.github/`: workflows, issue and pull request templates, code owners.
- `build/`: the shared tsdown preset every package build uses.
- `scripts/`: build and release scripts; `release.mjs` is run by the workflows.
- `src/`: the source of the package; one folder per concern, `index.ts` re-exports the public API. Folders: `internal/`.
- `test/`: the tests; one file per behavior, each test named by an invariant id such as `[ROUTER-12]`.
- `test-types/`: type-level tests: what the package promises to the compiler of its users.
- `types/`: ambient declarations shared with the build.
- `CHANGELOG.md`: what each release changed.
- `biome.json`: lint and format rules.
- `package.json`: the manifest; `version` is changed only by a release.
- `tsconfig.json`: type check of the source.
- `tsconfig.test-types.json`: type check of `test-types/`.
- `tsdown.config.mjs`: the build.
- `vitest.config.ts`: the test projects (unit, DOM, server, gc, perf).
- `vitest.setup.ts`: test setup: an unasserted `console.warn` or `console.error` fails a test.

## How to implement a change

1. **Find where the behavior lives.** Search `test/` and `src/` for the name of the behavior or its invariant id, then read the source the tests exercise. The invariants below say what must stay true.
2. **Write the failing test first.** A bug fix reproduces the bug; a feature states the behavior it promises. Name the test with an invariant id in square brackets, the way the neighboring tests do, then the behavior in words. The test asserts what the code does and is never skipped, marked as todo or marked as an expected failure.
3. **Make it pass with the smallest change** that keeps the invariants. Match the code around it.
4. **Keep the surface honest.** A public symbol has TSDoc (summary, parameters, return value, an example and `@since`). An error says what happened and how to fix it. User-visible behavior gets a documentation update and a line under `## Unreleased` in CHANGELOG.md.
5. **Run `npm run check`** and read its output; do not report a change as done without it passing.

### Rules every change keeps

- No `any`, `@ts-ignore` or non-null assertion. Use `unknown` and narrow.
- Compare indices, lengths and counts explicitly (`=== undefined`, `=== -1`, `> 0`), never by truthiness.
- No empty `catch`: every catch rethrows, passes the error to the owner's handler, or reports it. Every "set the current X" register is restored in `finally`.
- User callbacks run untracked unless the API says otherwise. No stack parsing, no `fn.name` sniffing, no flags stamped on user functions.
- Traversals whose depth the user controls are iterative. Caches, queues and recursion are bounded, and a test hits the bound.
- Code meant for development only sits behind `__DEV__`. No import-time side effects and no module-level mutable state beyond the registers the core owns (bounded caches and `WeakMap`s excepted).
- No sleeps in tests (flush the scheduler); a `console.warn` or `console.error` that a test does not assert fails the test. Property tests use `fast-check` with a fixed seed.
- Files are kebab-case, tests are `*.test.ts`, internals live in `src/internal/`. American English in code, comments and documentation. Comments explain why, not what.
- The reactive core and the DOM renderer have no runtime dependencies.

## Pull requests

1. **Open an issue first** for anything that adds or changes public API, behavior, supported platforms or dependencies. A small fix needs no issue.
2. **Fork, then branch from `main`** (`fix/<topic>`, `feat/<topic>`, `docs/<topic>`). One concern per pull request.
3. **Commit in small steps** with a message that says what changed and why: a short type prefix (`fix:`, `feat:`, `docs:`, `test:`, `chore:`), then the subject. Commit under your own identity; do not add trailers or notes about tools.
4. **Open the pull request against `main`** and fill in the template: what changes, why, and the checks you ran. The CI workflow (`.github/workflows/ci.yml`) runs lint, build, type check and all tests; it must be green.
5. **Review.** A maintainer (see `.github/CODEOWNERS`) reviews every pull request. Expect questions about the test, the public surface and the error messages. Push fixes to the same branch; the pull request is squash-merged.
6. **Releases are not part of a pull request.** Do not change `version`, `.github/workflows/release.yml` or `scripts/release.mjs`, and do not create tags or publish. A maintainer releases by renaming `## Unreleased` in the changelog to the version and pushing a version that is not yet on npm to `main`; the workflow publishes it with provenance.

Security problems never go in a public issue or pull request: follow [SECURITY.md](SECURITY.md).

## Architecture and invariants

What each package keeps true. A change that breaks one of these is a bug in the change.

Package-specific rules:

### Layout
```
src/index.ts          public barrel (framework-agnostic; imports only @shadow-js/core and /extend)
src/server.ts         @shadow-js/query/server: SSR script helpers (dehydrateScript, hydrateFromDocument, createDehydrationStream, hydrateFromStream); no renderer import
src/client.ts         createQueryClient
src/context.ts        QueryClientContext, useQueryClient, runWithQueryClient
src/key.ts            hashKey: canonical text of a key (the one key format)
src/share.ts          structuralShare: iterative structural sharing
src/serial.ts         jsonProblem: what does not survive JSON (dehydrate, key warnings)
src/offline.ts        feature offline (@shadow-js/query/offline): pause and resume while offline
src/queue.ts          feature queue (@shadow-js/query/queue): retries wait for the connection; mutations made offline replay in order
src/persist.ts        feature persist (@shadow-js/query/persist): the cache (and queued mutations) kept in a storage
src/scope.ts          feature scope (@shadow-js/query/scope): mutation scopes, one at a time
src/inspection.ts     feature inspection (@shadow-js/query/inspection): queryCache.subscribe
src/hydration.ts      feature hydration (@shadow-js/query/hydration): dehydrate and hydrate
src/full.ts           @shadow-js/query/full: every export and every feature
src/internal/features.ts  the feature slots (Extensions), featureMissing, checkNetworkMode, collectFeatures
src/backoff.ts        exponentialBackoff: a retryDelay function (kept out of the core so the minimal bundle stays small)
src/types.ts          every public type
src/internal/core.ts  the engine: entries, flights, retries, GC, focus/reconnect, the client API, mutations
src/internal/observer.ts  the hook-side observer (attach/detach, enabled, polling, Suspense hold)
src/internal/registry.ts  client -> engine (WeakMap); the public client stays narrow
src/use-query.ts use-infinite-query.ts use-mutation.ts   the hooks
test/                 *.test.ts (node), *.dom.test.ts (happy-dom), *.server.test.ts, *.gc.test.ts
test/support/probe.ts a fetch the test settles by hand, in any order
test-types/           type tests (tsc -p tsconfig.test-types.json), never executed
```

### Rules
- Imports: `@shadow-js/core` and `@shadow-js/core/extend` only. No web, router, dusk or DOM-specific
  import in the entry. `test/conformance.test.ts` (`QRY-X1`, `QRY-X2`) enforces it.
- State: each entry holds one immutable state object in one signal cell (`createSignalNode`). Writes go through
  `setState`/`finishFlight`, which create a new object. Reads from hooks are tracked (`core.read`); reads inside
  the engine are untracked (`core.state`).
- Flights: one per entry. A result applies only if its flight is still `entry.flight` (generation check).
  Aborting settles the flight's outcome at once, so a fetch that never settles cannot hang a caller
  (`QRY-R6`). Every outcome object is a value: `execute` and `startFetch` never reject.
- Features (`src/internal/features.ts`): each optional capability is a feature (`offline`, `scope`, `inspection`,
  `hydration`) that fills one slot of `Extensions` when the client is created. The engine checks the slot; a member
  that needs a missing slot throws `featureMissing`. `full` lists all four. A feature may not change the default
  client: without it a query runs as the core does.
- Offline (feature `offline`): a flight started with `networkMode` online while `navigator.onLine` is false is `paused`, is not counted in
  `isFetching()`, and starts on the `online` event (one `online` listener, present only while a flight is paused).
- Queue (feature `queue`): `withRetries` stays free of it; each attempt of a query (`execute`) and of a mutation
  (`useMutation`) asks `ext.queue` first and gets a promise while the connection is down. A mutation made offline, or while a
  replay runs, joins a line sorted by call id (restored calls first) and gets `isPaused: true`; `drain` lets one call go,
  waits until its record leaves `pending` (the mutation watcher), then the next. One `online` listener, present only
  while something waits. A wait on a query rejects when its signal aborts.
- Cache watchers: `ext.watch` (query entries) and `ext.watchMutation` (mutation records) are single functions that a
  feature composes with `addWatcher` / `addMutationWatcher`; the engine calls them with `?.` after every change.
- Persist (feature `persist`): one blob per cache under `key` (the entries as JSON text, reused while an entry's data and
  time are unchanged) and one list of paused calls under `key:mutations`, merged on write so other tabs' calls survive. A
  synchronous storage is read and written inside the call (restore at install, write on `pagehide`); an asynchronous
  one is awaited. Restored values pass the checks `hydrate` makes (recomputed hash, JSON data) plus `maxAge`, `buster`
  and a clamp of future times. Writes are throttled, serialized (one in flight) and never throw; errors go to `onError`.
  Everything it creates (timer, listeners, channel, locks) is removed by `dispose()`.
- Features are installed last, once the caches exist (`createCore` passes itself as the host), so a feature may read and
  write the caches while it installs; list a feature after the ones it needs (`queue` before `persist({ mutations })`).
- Cache subscribers (`queryCache.subscribe`, feature `inspection`) are called only when there is one; a listener runs untracked and a throw is
  reported like a callback error.
- Mutations with a `scope` run through the queue of feature `scope`, held per client; a drained queue leaves no entry.
- Caches are bounded and tested: unobserved entries (`maxQueries`, `QRY-C10`), mutation records
  (`maxMutations`, `QRY-M7`), pages (`maxPages`, `QRY-I3`), dev warnings (`MAX_WARNINGS`).
- Module state: none. Per-client state lives in the `createCore` closure; the only module-level map is the
  client-to-engine WeakMap in `registry.ts`.
- Dev-only code sits behind `__DEV__` (devtools reports, key warnings). Warnings use the `[shadow-query]`
  prefix and are deduplicated per client.
- User callbacks run untracked (`untrack`). A throw in a callback that runs after state was stored is rethrown
  on a microtask (`reportCallbackError`), so it reaches the global handler and never changes query state.
- Server: `isServer` skips every effect. `useQuery` reads the entry; nothing fetches or subscribes.
- Traversals whose depth the user controls are iterative: `structuralShare`, `jsonProblem`, `canonicalText`.
- Optional public properties are `readonly x?: T | undefined` (the repo uses `exactOptionalPropertyTypes`).
- Public symbols have TSDoc with `@since 1.0.0`; functions carry `@example`.

### Tests
- Invariant ids `[QRY-nn]`, unique across the suite (`QRY-K`: keys, `QRY-S`: sharing, `QRY-C`: client API,
  `QRY-Q`: useQuery, `QRY-R`: races, `QRY-M`: mutations, `QRY-I`: infinite, `QRY-D`: dehydrate, `QRY-SU`:
  Suspense, `QRY-F`/`QRY-W`: browser and SSR helpers, `QRY-G`: GC properties, `QRY-L`: leaks, `QRY-SV`: server,
  `QRY-X`: conformance, `QRY-T`: types, `QRY-DT`: devtools, `QRY-IN`: cache inspection, `QRY-O`: offline pause,
  `QRY-B`: retry backoff, `QRY-P`: persist; `QRY-O10`..: the offline queue; `QRY-R12`/`R13`: request dedupe; `QRY-W5`..:
  the streamed state; `QRY-SV5`: the real renderer).
- Test first; no `.skip`, `.only` or `.todo`; no sleeps (`flush()` or fake timers).
- Un-asserted `console.warn`/`console.error` fails a test (`vitest.setup.ts`). A test that expects a warning reads
  `vi.mocked(console.warn).mock.calls` and calls `mockClear()`; it must not `mockRestore()` the setup spy.
- Property tests use `fast-check` with `seed: 42`.
- A test that waits on a probe must settle it in the order the engine requests: a sequential refetch of
  infinite pages starts page two only when page one has answered.

## Where to look next

- [README.md](README.md): what the package does and every option.
- [SKILL.md](SKILL.md): how to use the released package (install, import paths, a quick start).
- [CONTRIBUTING.md](CONTRIBUTING.md): the short guide to taking part.
- [CHANGELOG.md](CHANGELOG.md): what each release changed.
- [ShadowJS hub](https://github.com/shadowjs-dev/shadow): every repository of the project.
