// Compiles every corpus file with Babel React Compiler (1.0.0 and the May 2026 experimental)
// and with oxc's Rust port, normalizes all outputs through oxc codegen, and writes per-file
// results to results.jsonl for compare.mjs.
import fs from "node:fs";
import { createRequire } from "node:module";
import { transformSync as oxcReact } from "oxc-transform-react";
import { transformSync as oxcStrip } from "oxc-transform";
import { all } from "./corpus.mjs";
const req = createRequire("/home/user/src/react-to-solid-codemod/package.json");
const babel = req("@babel/core");
const compilers = {
  "babel-1.0.0": req("babel-plugin-react-compiler"),
  "babel-exp-2026-05": createRequire("/home/user/src/harness/exp/package.json")("babel-plugin-react-compiler"),
};
const lang = (f) => (/\.tsx$/.test(f) ? "tsx" : /\.ts$/.test(f) ? "ts" : "jsx");
const normalize = (file, code) => {
  const r = oxcStrip(file, code, { typescript: {}, jsx: "preserve", lang: lang(file) });
  return r.errors.length ? null : r.code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\n\s*\n/g, "\n");
};
function runBabel(name, file, code) {
  const events = [];
  const t = performance.now();
  let out = null, err = null;
  try {
    out = babel.transformSync(code, {
      filename: file, babelrc: false, configFile: false, code: true, ast: false, compact: false, retainLines: false,
      parserOpts: { plugins: lang(file) === "ts" ? ["typescript"] : ["typescript", "jsx"] },
      plugins: [[compilers[name], { panicThreshold: "none", logger: { logEvent: (_f, e) => events.push(e) } }]],
    }).code;
  } catch (e) { err = String(e.message).split("\n")[0]; }
  const ms = performance.now() - t;
  return {
    ms, err, code: out && normalize(file, out),
    events: events.filter((e) => /Compile(Success|Error|Skip)|PipelineError/.test(e.kind)).map((e) => ({
      kind: e.kind, line: e.fnLoc?.start?.line ?? null, memoSlots: e.memoSlots,
      reason: e.kind === "CompileSkip" ? e.reason : (e.detail?.options?.reason ?? e.detail?.reason ?? e.data ?? null),
      category: e.detail?.options?.category ?? e.detail?.category ?? null,
      dline: e.detail?.options?.loc?.start?.line ?? e.detail?.loc?.start?.line ?? e.detail?.options?.details?.find?.((d) => d.loc)?.loc?.start?.line ?? null,
    })),
  };
}
function runOxc(file, code) {
  const t = performance.now();
  const r = oxcReact(file, code, { lang: lang(file), jsx: "preserve", typescript: {}, reactCompiler: { panicThreshold: "none", reportDiagnostics: true } });
  const ms = performance.now() - t;
  const lineOf = (pos) => code.slice(0, pos).split("\n").length;
  return {
    ms, err: r.fatal ? "fatal" : null,
    code: r.code ? r.code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\n\s*\n/g, "\n") : null,
    diags: r.errors.map((e) => ({ severity: e.severity, message: e.message.split("\n")[0], line: e.labels[0] ? lineOf(e.labels[0].start) : null })),
  };
}
const files = all();
const only = process.argv[2];
const outPath = process.argv[3] ?? "results.jsonl"; fs.writeFileSync(outPath, ""); const outFile = { write: (s) => fs.appendFileSync(outPath, s), end() {} };
let i = 0;
// warm up each compiler on the first spec so JIT and module init are not counted in per-file time
for (const f of files.slice(0, 3)) { runBabel("babel-1.0.0", f.file, f.code); runBabel("babel-exp-2026-05", f.file, f.code); runOxc(f.file, f.code); }
for (const f of files) {
  if (only && f.corpus !== only) continue;
  fs.writeFileSync("current.txt", f.corpus + " " + f.file);
  const rec = { corpus: f.corpus, file: f.file, bytes: f.code.length, lines: f.code.split("\n").length };
  for (const name of Object.keys(compilers)) rec[name] = runBabel(name, f.file, f.code);
  rec.oxc = runOxc(f.file, f.code);
  outFile.write(JSON.stringify(rec) + "\n");
  if (++i % 200 === 0) console.error(i);
}
outFile.end();
console.error("done", i);
