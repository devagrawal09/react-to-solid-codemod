// jssg codemod: react-to-solid extract with the wasm React Compiler facts; one JSON line per file
// with extract time, analyze time and the instance's linear memory. Changes nothing.
import compilerFacts from "./lib/compiler-facts.wasm";
import { bindAnalyze } from "./src/compiler-facts.mjs";

// The jssg entry is bindAnalyze(compilerFacts); this wraps it to see the live instance's memory.
let live = null;
const analyzeRaw = bindAnalyze({ instantiate: () => (live = compilerFacts.instantiate()) });
import { extract } from "./extract.bundle.mjs";

let analyzeMs = 0;
const analyze = (code, file) => { const t = Date.now(); try { return analyzeRaw(code, file); } finally { analyzeMs += Date.now() - t; } };

export default function transform(root) {
  const file = root.filename();
  if (!/\.(tsx|jsx)$/.test(file) && !/\/use[A-Z]/.test(file)) return null;
  analyzeMs = 0;
  const started = Date.now();
  const result = extract(root.root().text(), file, { analyze });
  const functions = result.functions.map((f) => ({
    name: f.name, status: f.compiler.status, scopes: f.scopes?.length ?? 0,
    reactive: f.values.filter((v) => v.compiler?.reactive).map((v) => v.name),
  }));
  console.log(JSON.stringify({ mode: "wasm", file: file.split("/").slice(-2).join("/"), ms: Date.now() - started, analyzeMs, memMB: +(live.memory.size() / 1048576).toFixed(1), functions }));
  return null;
}
