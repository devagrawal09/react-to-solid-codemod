import { configDefaults, defineConfig } from "vitest/config";

// compiler-facts/.oxc is the oxc checkout build.sh makes; its own tests aren't ours.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "compiler-facts/**"] },
});
