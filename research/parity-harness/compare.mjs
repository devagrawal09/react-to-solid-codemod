// Reads results.jsonl and reports compile-decision and output parity between implementations.
import fs from "node:fs";
import { parseSync } from "oxc-parser";
const recs = fs.readFileSync(process.argv[2] ?? "results.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const IMPLS = ["babel-1.0.0", "babel-exp-2026-05", "oxc"];
const clean = (code) => code
  .replace(/const \{ c: _c \} = require\("react\/compiler-runtime"\);/, 'import { c as _c } from "react/compiler-runtime";')
  .replace(/^"use strict";\n/, "");
// top-level statement name -> its text, for every statement that memoizes (calls _c)
function memoized(code) {
  const out = new Map();
  if (!code) return out;
  let ast;
  try { ast = parseSync("x.tsx", code).program; } catch { return out; }
  for (const st of ast.body) {
    const text = code.slice(st.start, st.end);
    if (!/\b_c\(\d+\)/.test(text)) continue;
    const d = st.declaration ?? st;
    const name = d.id?.name ?? d.declarations?.[0]?.id?.name ?? (st.type === "ExportDefaultDeclaration" ? "default" : `@${st.start}`);
    out.set(name, { text, slots: [...text.matchAll(/\b_c\((\d+)\)/g)].map((m) => +m[1]) });
  }
  return out;
}
// dependency lists of each memo block: `if ($[0] !== a || $[1] !== b.c)` -> "a,b.c"
const scopes = (text) => [...text.matchAll(/if \(((?:\$\[\d+\] !== [^|)]+?(?: \|\| )?)+)\)/g)].map((m) => [...m[1].matchAll(/\$\[\d+\] !== ([^|)]+?)(?= \|\||$)/g)].map((x) => x[1].trim()).join(","));
const sentinelScopes = (text) => (text.match(/=== Symbol\.for\("react\.memo_cache_sentinel"\)/g) ?? []).length;

const summary = {};
const diffs = [];
for (const r of recs) {
  const s = (summary[r.corpus] ??= { files: 0, errored: {}, ms: {}, memoFns: {}, pairs: {} });
  s.files++;
  const m = {};
  for (const impl of IMPLS) {
    const x = r[impl];
    if (x.err || !x.code) s.errored[impl] = (s.errored[impl] ?? 0) + 1;
    s.ms[impl] = (s.ms[impl] ?? 0) + x.ms;
    m[impl] = memoized(x.code && clean(x.code));
    s.memoFns[impl] = (s.memoFns[impl] ?? 0) + m[impl].size;
  }
  for (const [a, b] of [["babel-1.0.0", "oxc"], ["babel-exp-2026-05", "oxc"], ["babel-1.0.0", "babel-exp-2026-05"]]) {
    const p = (s.pairs[`${a} vs ${b}`] ??= { filesIdentical: 0, fnsBoth: 0, fnsOnlyA: 0, fnsOnlyB: 0, sameSlots: 0, sameText: 0, sameScopeDeps: 0 });
    if (r[a].code && r[b].code && clean(r[a].code) === clean(r[b].code)) p.filesIdentical++;
    for (const [name, fa] of m[a]) {
      const fb = m[b].get(name);
      if (!fb) { p.fnsOnlyA++; diffs.push({ pair: `${a} vs ${b}`, corpus: r.corpus, file: r.file, fn: name, kind: `memoized only by ${a}` }); continue; }
      p.fnsBoth++;
      if (fa.slots.join() === fb.slots.join()) p.sameSlots++;
      if (fa.text === fb.text) p.sameText++;
      const sa = [...scopes(fa.text), `sentinel:${sentinelScopes(fa.text)}`].join("|"), sb = [...scopes(fb.text), `sentinel:${sentinelScopes(fb.text)}`].join("|");
      if (sa === sb) p.sameScopeDeps++;
      else diffs.push({ pair: `${a} vs ${b}`, corpus: r.corpus, file: r.file, fn: name, kind: "scope deps differ", a: sa, b: sb, slots: [fa.slots, fb.slots] });
    }
    for (const name of m[b].keys()) if (!m[a].has(name)) { p.fnsOnlyB++; diffs.push({ pair: `${a} vs ${b}`, corpus: r.corpus, file: r.file, fn: name, kind: `memoized only by ${b}` }); }
  }
}
for (const s of Object.values(summary)) for (const k of Object.keys(s.ms)) s.ms[k] = +(s.ms[k] / s.files).toFixed(2);
console.log(JSON.stringify(summary, null, 1));
fs.writeFileSync(process.argv[3] ?? "diffs.json", JSON.stringify(diffs, null, 1));
