import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    tags: [{ name: "slow", description: "Runs the codemod CLI on a fixture app.", timeout: 120_000 }],
  },
});
