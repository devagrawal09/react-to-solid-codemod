// jssg codemod: react-to-solid extract with the native React Compiler facts; one JSON line per file
// with extract time, analyze time. Changes nothing.
import { analyze as analyzeRaw } from "codemod:react-compiler";
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
  console.log(JSON.stringify({ mode: "native", file: file.split("/").slice(-2).join("/"), ms: Date.now() - started, analyzeMs, functions }));
  return null;
}
