import { createConfig } from "./build/tsdown-preset.mjs";

// `index` is the framework-agnostic entry (no server import). `server` holds the SSR script helpers only.
// Each optional feature is its own entry, so a client that lists only some of them bundles only those.
export default createConfig({
  entries: {
    index: "src/index.ts",
    server: "src/server.ts",
    offline: "src/offline.ts",
    queue: "src/queue.ts",
    persist: "src/persist.ts",
    scope: "src/scope.ts",
    inspection: "src/inspection.ts",
    hydration: "src/hydration.ts",
    full: "src/full.ts",
  },
  packageDir: import.meta.dirname,
});
