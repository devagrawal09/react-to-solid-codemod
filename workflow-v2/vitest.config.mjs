import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // The Solid behavior specs run solid-js's browser build, in development mode, under jsdom.
  resolve: { conditions: ["browser", "development"] },
  test: {
    // The corpus is a node:test release check (pnpm test:corpus), not a vitest spec.
    exclude: [...configDefaults.exclude, "tests/corpus.test.mjs"],
    server: { deps: { inline: ["solid-js", "@solidjs/web", "@solidjs/signals"] } },
    tags: [{ name: "slow", description: "Runs the codemod CLI on a fixture app.", timeout: 120_000 }],
  },
});
