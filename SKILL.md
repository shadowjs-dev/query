---
name: shadowjs-query
description: "Work with @shadow-js/query. Fetch, cache and update server data with queries, mutations and optimistic updates. Use when a project imports it, or when asked to add, configure or debug it."
---

# @shadow-js/query

Version 1.0.3. Fetch, cache and update server data with queries, mutations and optimistic updates.

## Where to read more

- @shadow-js/query: https://query.shadowjs.net
- Source and issues: https://github.com/shadowjs-dev/query
- The package README is the full reference for options and behavior; read it before changing a configuration.

## Install

```sh
npm install @shadow-js/query @shadow-js/core
```

## Peer dependencies

| Package | Range | Required |
| --- | --- | --- |
| `@shadow-js/core` | `^1.0.3` | yes |

## Import paths

Import only from these paths. Never from `dist` or `src`: files that are not listed here are private and change without notice.

- `@shadow-js/query`
- `@shadow-js/query/server`
- `@shadow-js/query/offline`
- `@shadow-js/query/queue`
- `@shadow-js/query/persist`
- `@shadow-js/query/scope`
- `@shadow-js/query/inspection`
- `@shadow-js/query/hydration`
- `@shadow-js/query/full`

## Quick start

```ts
import { createQueryClient } from "@shadow-js/query";

export const client = createQueryClient({
  defaultOptions: { queries: { staleTime: 30_000 } },
});
```

## Working rules

- Run `npm run check` before proposing a change; it lints, builds, type-checks and tests.
- Keep a public change documented: TSDoc on every exported symbol, and a CHANGELOG entry.
- To change this repository rather than use the package, read AGENTS.md: the layout, the commands, the rules and how a pull request is reviewed.
