// Runs lib/compiler-facts.wasm under Node over a file list and compares each result with the
// native facts JSONL written earlier (same order). Prints counts and timings.
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { loadAnalyze } from "/home/user/src/react-to-solid-codemod/src/compiler-facts-node.mjs";

const [list, nativeFile] = process.argv.slice(2);
const files = readFileSync(list, "utf8").trim().split("\n");
const native = readFileSync(nativeFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
let t = performance.now();
const analyze = loadAnalyze();
const load = performance.now() - t;
let same = 0, differ = [], times = [], nativeUs = [];
files.forEach((file, i) => {
  const src = readFileSync(file, "utf8");
  t = performance.now();
  const got = analyze(src, file);
  times.push(performance.now() - t);
  const { file: _f, us, ...want } = native[i];
  nativeUs.push(us / 1000);
  if (JSON.stringify(got) === JSON.stringify(want)) same++; else differ.push(file);
});
const stats = (a) => { const s = [...a].sort((x, y) => x - y); const sum = s.reduce((x, y) => x + y, 0);
  return { total: +sum.toFixed(0), avg: +(sum / s.length).toFixed(2), median: +s[s.length >> 1].toFixed(2), max: +s.at(-1).toFixed(1) }; };
console.log(JSON.stringify({ files: files.length, identical: same, differ: differ.slice(0, 5), loadMs: +load.toFixed(1),
  wasmNodeMs: stats(times), nativeMs: stats(nativeUs) }));
