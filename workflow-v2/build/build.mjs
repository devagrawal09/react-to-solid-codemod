// Bundles the reactivity pass (Babel + babel-plugin-react-compiler) into lib/reactivity.mjs, one
// ESM file that jssg loads under QuickJS. Node built-ins are stubbed: the pass never reads config
// files, spawns, or logs, and jssg has no `require` for the compiler's optional lookups.
import { builtinModules, createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const stub = (file) => new URL(`./stubs/${file}`, import.meta.url).pathname;
const named = { fs: "fs.cjs", module: "module.cjs", url: "url.cjs", assert: "assert.cjs", debug: "debug.cjs" };
const alias = { path: require.resolve("path-browserify"), "node:path": require.resolve("path-browserify") };
for (const name of builtinModules.filter((m) => !m.startsWith("_") && !m.includes("/") && m !== "path")) alias[name] = stub(named[name] ?? "misc.cjs");
alias.debug = stub(named.debug);

await build({
  entryPoints: [new URL("./entry.mjs", import.meta.url).pathname],
  outfile: new URL("../lib/reactivity.mjs", import.meta.url).pathname,
  bundle: true,
  format: "esm",
  platform: "neutral",
  mainFields: ["browser", "module", "main"],
  alias,
  logLevel: "error",
});
