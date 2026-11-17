// Runs oxc (and Babel 1.0.0 for context) on React's own compiler fixtures and compares each
// memoized function with the TS-main output recorded in the fixture's .expect.md.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { transformSync as oxcReact } from "oxc-transform-react";
import { transformSync as oxcStrip } from "oxc-transform";
import { parseSync } from "oxc-parser";
const req = createRequire("/home/user/src/react-to-solid-codemod/package.json");
const babel = req("@babel/core");
const DIR = "/home/user/src/react/compiler/packages/babel-plugin-react-compiler/src/__tests__/fixtures/compiler";
const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else if (/\.(js|jsx|ts|tsx)$/.test(e.name) && !/\.expect\./.test(e.name)) out.push(p); } return out; };
const lang = (f) => (/\.tsx$/.test(f) ? "tsx" : /\.ts$/.test(f) ? "ts" : "jsx");
const ALLOWED = /^@(compilationMode|panicThreshold)\b/;
const strip = (f, code) => { const r = oxcStrip(f.replace(/\.(js|ts)$/, ".tsx"), code, { typescript: {}, jsx: "preserve", lang: "tsx" }); return r.errors.length ? null : r.code; };
function fns(code) {
  const out = new Map(); if (!code) return out;
  let ast; try { ast = parseSync("x.tsx", code).program; } catch { return out; }
  for (const st of ast.body) {
    const text = code.slice(st.start, st.end).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\n\s*\n/g, "\n");
    if (!/\b_c\(\d+\)/.test(text)) continue;
    const d = st.declaration ?? st;
    out.set(d.id?.name ?? d.declarations?.[0]?.id?.name ?? `@${st.start}`, text);
  }
  return out;
}
const stats = { fixtures: 0, skippedPragma: 0, skippedError: 0, compared: 0 };
const res = { oxc: { fnsExpected: 0, missing: 0, extra: 0, same: 0, slotsSame: 0 }, "babel-1.0.0": { fnsExpected: 0, missing: 0, extra: 0, same: 0, slotsSame: 0 } };
const diffs = [];
for (const f of walk(DIR)) {
  stats.fixtures++;
  const rel = path.relative(DIR, f);
  if (/(^|\/)error\./.test(path.basename(f)) || /todo/.test(path.basename(f))) { stats.skippedError++; continue; }
  const exp = f.replace(/\.(js|jsx|ts|tsx)$/, ".expect.md");
  if (!fs.existsSync(exp)) continue;
  const src = fs.readFileSync(f, "utf8");
  const first = src.split("\n")[0];
  const pragmas = first.startsWith("//") ? [...first.matchAll(/@[\w:"]+/g)].map((m) => m[0]) : [];
  if (pragmas.some((p) => !ALLOWED.test(p))) { stats.skippedPragma++; continue; }
  const md = fs.readFileSync(exp, "utf8");
  const m = md.match(/## Code\n\n```javascript\n([\s\S]*?)\n```/);
  if (!m) continue;
  const mode = (first.match(/@compilationMode:"?(\w+)"?/) ?? [])[1] ?? "all";
  stats.compared++;
  const expected = fns(strip(f, m[1]));
  let oxcOut = null, babelOut = null;
  try { oxcOut = oxcReact(f, src, { lang: lang(f), jsx: "preserve", typescript: {}, reactCompiler: { compilationMode: mode, panicThreshold: "none" } }).code; } catch {}
  try { babelOut = babel.transformSync(src, { filename: f, babelrc: false, configFile: false, parserOpts: { plugins: ["typescript", "jsx"] }, plugins: [[req("babel-plugin-react-compiler"), { compilationMode: mode, panicThreshold: "none" }]] }).code; } catch {}
  for (const [impl, out] of [["oxc", oxcOut && strip(f, oxcOut)], ["babel-1.0.0", babelOut && strip(f, babelOut)]]) {
    const got = fns(out);
    const r = res[impl];
    for (const [name, text] of expected) {
      r.fnsExpected++;
      const g = got.get(name);
      if (!g) { r.missing++; if (impl === "oxc") diffs.push({ rel, name, kind: "not memoized" }); continue; }
      const sig = (t) => [...[...t.matchAll(/if \(((?:\$\[\d+\] !== [^|)]+?(?: \|\| )?)+)\)/g)].map((m) => [...m[1].matchAll(/\$\[\d+\] !== ([^|)]+?)(?= \|\||$)/g)].map((x) => x[1].trim().replace(/\["(\w+)"\]/g, ".$1")).join(",")), (t.match(/memo_cache_sentinel/g) ?? []).length, [...t.matchAll(/\b_c\((\d+)\)/g)].map((x) => x[1])].join("|");
      if (sig(g) === sig(text)) r.sameScopes = (r.sameScopes ?? 0) + 1; else if (impl === "oxc") diffs.push({ rel, name, kind: "scopes differ", exp: sig(text), got: sig(g) });
      const ws = (t) => t.replace(/\s+/g, " ").replace(/> </g, "><").replace(/> \{/g, ">{").replace(/\} </g, "}<").replace(/\["(\w+)"\]/g, ".$1");
      if (ws(g) === ws(text)) r.same++;
      else if (impl === "oxc") diffs.push({ rel, name, kind: "differs" });
      const slots = (t) => [...t.matchAll(/\b_c\((\d+)\)/g)].map((x) => x[1]).join();
      if (slots(g) === slots(text)) r.slotsSame++;
    }
    for (const name of got.keys()) if (!expected.has(name)) { r.extra++; if (impl === "oxc") diffs.push({ rel, name, kind: "memoized only by oxc" }); }
  }
}
console.log(JSON.stringify({ stats, res }, null, 1));
fs.writeFileSync("fixture-diffs.json", JSON.stringify(diffs, null, 1));
