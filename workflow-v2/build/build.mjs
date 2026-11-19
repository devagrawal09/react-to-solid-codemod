// Bundles the reactivity pass (Babel + babel-plugin-react-compiler) into lib/reactivity.mjs, one
// ESM file that jssg loads under QuickJS. Node built-ins are stubbed: the pass never reads config
// files, spawns, or logs, and jssg has no `require` for the compiler's optional lookups.
import { builtinModules, createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const stub = (file) => new URL(`./stubs/${file}`, import.meta.url).pathname;
const named = { fs: "fs.cjs", module: "module.cjs", url: "url.cjs", assert: "assert.cjs", debug: "debug.cjs" };
const alias = { path: require.resolve("path-browserify"), "node:path": require.resolve("path-browserify") };
for (const name of builtinModules.filter((m) => !m.startsWith("_") && !m.includes("/") && m !== "path")) alias[name] = stub(named[name] ?? "misc.cjs");
alias.debug = stub(named.debug);

// One IIFE assigned to one const, then its exports. `codemod publish` bundles the workflow, and a
// workflow callback gets only the bindings it uses: setup code at the top of a module would be
// left out, and a module-level binding that is reassigned can't be copied. Inside the IIFE, the
// prelude and every module's setup run as part of that one const's initializer.
const NAMES = ["extract", "decide", "applyContracts", "rewrite", "report"];
const { outputFiles } = await build({
  entryPoints: [new URL("./entry.mjs", import.meta.url).pathname],
  write: false,
  bundle: true,
  format: "iife",
  globalName: "reactivity",
  platform: "neutral",
  mainFields: ["browser", "module", "main"],
  alias,
  // `codemod publish` bundles with Rolldown, which replaces process.env.NODE_ENV with
  // "development"; the React Compiler then emits dev-only cache checks that need node:crypto.
  // Settle it here, as the value jssg has: none.
  define: { "process.env.NODE_ENV": "undefined" },
  logLevel: "error",
});
const exports = NAMES.map((name) => `export const ${name} = reactivity.${name};`).join("\n");
writeFileSync(new URL("../src/lib/reactivity.mjs", import.meta.url), `${outputFiles[0].text.replace(/^var reactivity = /m, "const reactivity = ")}${exports}\n`);
