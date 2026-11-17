// Per-file stats from the spike outputs, and whether the WASM summaries match native's.
import { readFileSync } from "node:fs";
const read = (f) => new Map(readFileSync(f, "utf8").split("\n").map((l) => l.trim()).filter((l) => l.startsWith('{"mode"')).map((l) => JSON.parse(l)).map((o) => [o.file, o]));
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); return { total: s.reduce((a, b) => a + b, 0), median: s[s.length >> 1], max: s.at(-1) }; };
for (const t of ["todo", "t3"]) {
  const runs = Object.fromEntries(["native", "wasm", "babel"].map((m) => [m, read(`engine/${m}-${t}.out`)]));
  const same = (a, b) => [...runs[a]].filter(([f, o]) => JSON.stringify(o.functions) === JSON.stringify(runs[b].get(f)?.functions)).length;
  console.log(t, JSON.stringify({
    files: runs.native.size, wasmFiles: runs.wasm.size, babelFiles: runs.babel.size,
    wasmSameAsNative: same("wasm", "native"), wasmSameAsBabel: same("wasm", "babel"),
    extractMs: Object.fromEntries(Object.entries(runs).map(([m, r]) => [m, stats([...r.values()].map((o) => o.ms))])),
    analyzeMs: Object.fromEntries(["native", "wasm"].map((m) => [m, stats([...runs[m].values()].map((o) => o.analyzeMs))])),
    wasmMemMB: stats([...runs.wasm.values()].map((o) => o.memMB)),
  }));
}
