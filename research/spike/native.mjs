// jssg codemod: runs the react-to-solid extract with the engine's native React Compiler and
// prints one JSON line per file. Changes nothing.
import { analyze } from "codemod:react-compiler";
import { extract } from "./extract.bundle.mjs";

export default function transform(root) {
  const file = root.filename();
  if (!/\.(tsx|jsx)$/.test(file) && !/\/use[A-Z]/.test(file)) return null;
  const started = Date.now();
  const result = extract(root.root().text(), file, { analyze });
  const functions = result.functions.map((f) => ({
    name: f.name, status: f.compiler.status, scopes: f.scopes?.length ?? 0,
    reactive: f.values.filter((v) => v.compiler?.reactive).map((v) => v.name),
  }));
  console.log(JSON.stringify({ mode: "native", file: file.split("/").slice(-2).join("/"), ms: Date.now() - started, functions }));
  return null;
}
