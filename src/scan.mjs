// node src/scan.mjs <t3code checkout> <out-dir> [--workers N] [--compare]
// Runs extractor + mapper over apps/web production files in parallel workers, then the cross-file
// hook-contract pass, and writes summary.json, samples.json and decisions.jsonl.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { applyContracts } from "./contracts.mjs";
import { rewrite } from "./rewrite.mjs";
import { parse } from "@babel/parser";

const args = process.argv.slice(2);
const [root, outDir] = args.filter((a, i) => !a.startsWith("--") && !["--workers", "--write"].includes(args[i - 1]));
const workers = Number(args[args.indexOf("--workers") + 1]) || (args.includes("--workers") ? 1 : Math.max(1, os.availableParallelism() - 1));
const compare = args.includes("--compare");
// --write <dir>: also write each file's rewritten code there, at its path under the checkout.
const writeDir = args.includes("--write") ? args[args.indexOf("--write") + 1] : null;
const webSrc = path.join(root, "apps/web/src");
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!["test", "__tests__", "node_modules"].includes(e.name)) walk(p); continue; }
    if (!/\.(ts|tsx)$/.test(e.name) || /\.(test|spec)\.|\.d\.ts$|routeTree\.gen/.test(e.name)) continue;
    if (!/use[A-Z]|<[A-Za-z>]/.test(fs.readFileSync(p, "utf8"))) continue;
    files.push(p);
  }
})(webSrc);

const started = performance.now();
// Biggest files first so one slow file doesn't finish last on its own.
const queue = [...files].sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
const results = [];
await Promise.all(Array.from({ length: workers }, () => new Promise((resolve, reject) => {
  const w = new Worker(new URL("./scan-worker.mjs", import.meta.url), { workerData: { compare } });
  const next = () => (queue.length ? w.postMessage(queue.shift()) : (w.terminate(), resolve()));
  w.on("message", (r) => { results.push(r); next(); });
  w.on("error", reject);
  next();
})));
const extractMs = Math.round(performance.now() - started);
results.sort((a, b) => a.file.localeCompare(b.file));
const contractStarted = performance.now();
const beforeContracts = new Map();
for (const r of results) for (const fn of r.functions) for (const v of fn.values) beforeContracts.set(v, v.decision);
applyContracts(results);
const contractMs = Math.round(performance.now() - contractStarted);

const perFile = [];
const decisionLines = [];
const count = (map, key, n = 1) => map.set(key, (map.get(key) ?? 0) + n);
const status = new Map(), decisions = new Map(), inventoryDecisions = new Map(), bailReasons = new Map(), paramDecisions = new Map(), flagReasons = new Map();
let unscopedStatic = 0, inventoryDeclarators = 0, effects = 0, effectsWithNotes = 0;
const samples = new Map();
const bailed = [];
let rewrittenFiles = 0, rewrittenFunctions = 0;
const rewriteParseErrors = [];
const contractChanges = new Map(), hookValues = new Map(), opaqueHooks = new Map();
let demoted = 0;
const demotedSamples = [];
const prestepFunctions = new Map(), unblockedDecisions = new Map(), tryAssigned = new Map();
const unblocked = [], regressions = [];
for (const r of results) {
  const file = r.file;
  const code = fs.readFileSync(file, "utf8");
  const rel = path.relative(root, file);
  perFile.push({ file: rel, ms: r.ms, parseError: r.parseError });
  // Every decision, one line per file, for reviews like eval/accuracy.
  decisionLines.push(JSON.stringify({ file: rel, functions: r.functions.map((fn) => ({ name: fn.name, kind: fn.kind, line: fn.line, status: fn.compiler?.status, values: fn.values.map((v) => ({ name: v.name, line: v.line, decision: v.decision, why: v.why })) })) }));
  const out = rewrite(code, r);
  if (writeDir) {
    fs.mkdirSync(path.dirname(path.join(writeDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(writeDir, rel), out.code);
  }
  rewrittenFunctions += out.rewrittenFunctions.length;
  if (out.code !== code) {
    rewrittenFiles++;
    try {
      parse(out.code, { sourceType: "module", plugins: ["typescript", "jsx"] });
    } catch (e) {
      rewriteParseErrors.push(`${rel}: ${String(e.message).split("\n")[0]}`);
    }
  }
  if (r.before) {
    const before = new Map(r.before.map((f) => [f.loc, f]));
    for (const fn of r.functions) {
      const was = before.get(fn.loc);
      if (!was) continue;
      if (was.status === "bailout") {
        count(prestepFunctions, `${was.reason} → ${fn.compiler.status === "bailout" ? fn.compiler.reason : fn.compiler.status}`);
        unblocked.push({ fn: `${rel}:${fn.line} ${fn.name}`, values: fn.values.length, stillFlagged: fn.values.filter((v) => v.decision === "flag").length, now: fn.compiler.status === "bailout" ? fn.compiler.reason : fn.compiler.status });
        for (const v of fn.values) count(unblockedDecisions, v.decision === "flag" ? `flag: ${v.why.replace(/ \(.*|: .*/, "")}` : v.decision);
      } else if (was.status === "compiled" && fn.compiler.status !== "compiled") {
        regressions.push({ fn: `${rel}:${fn.line} ${fn.name}`, now: fn.compiler.reason ?? fn.compiler.status });
      }
    }
  }
  for (const fn of r.functions) {
    for (const v of fn.values) {
      if (v.tryAssigned) count(tryAssigned, v.decision);
      if (v.compiler?.demoted && demoted++ % 8 === 0) demotedSamples.push(`${path.relative(root, file)}:${v.line} ${fn.name}.${v.name}: ${v.why} | ${v.text.slice(0, 70)}`);
      const was = beforeContracts.get(v);
      if (was !== v.decision) count(contractChanges, `${was} → ${v.decision}`);
      if (v.hookCall) {
        count(hookValues, `${v.decision}${v.contract ? ` (${v.contract.kind})` : ""}`);
        if (v.contract?.kind === "opaque") count(opaqueHooks, v.contract.why);
      }
    }
    const relevant = fn.compiler.status !== "not-compiled" || (fn.kind === "component" && fn.hasJsx);
    if (!relevant) continue;
    count(status, `${fn.kind}:${fn.compiler.status}`);
    if (fn.compiler.status === "bailout") { count(bailReasons, fn.compiler.reason); bailed.push({ fn: `${rel}:${fn.line} ${fn.name}`, values: fn.values.filter((v) => v.decision === "flag").length, reason: fn.compiler.reason }); }
    for (const p of fn.params) count(paramDecisions, p.decision);
    for (const e of fn.effects) { effects++; if (e.note) effectsWithNotes++; }
    const seenDecl = new Set();
    for (const v of fn.values) {
      count(decisions, v.decision);
      // Recomputed on every React render today but frozen once in Solid: the residual staleness risk.
      if (v.decision === "static" && v.compiler?.scope == null && !["function", "literal"].includes(v.initKind)) unscopedStatic++;
      if (v.decision === "flag") count(flagReasons, v.why.replace(/ \(.*|: .*/, ""));
      if (!samples.has(v.decision)) samples.set(v.decision, []);
      samples.get(v.decision).push(`${rel}:${v.line} ${fn.name}.${v.name}`);
      // Same definition as inventory.cjs's 4,378: top-level declarators in components (capitalized,
      // containing JSX) whose init is not a function, hook call or literal.
      if (fn.kind === "component" && fn.hasJsx && v.range?.declarator && !["function", "hook", "literal", "none"].includes(v.initKind)) {
        const key = v.range.declarator.join(":");
        if (seenDecl.has(key)) continue;
        seenDecl.add(key);
        inventoryDeclarators++;
        count(inventoryDecisions, v.decision);
      }
    }
  }
}
const totalMs = Math.round(performance.now() - started);
const top = (m, n) => Object.fromEntries([...m].sort((a, b) => b[1] - a[1]).slice(0, n));
const ms = perFile.map((f) => f.ms).sort((a, b) => a - b);
const obj = (m) => Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));
const summary = {
  root, files: perFile.length, parseErrors: perFile.filter((f) => f.parseError),
  runtime: { totalMs, workers, extractMs, contractMs, compare, medianFileMs: ms[Math.floor(ms.length / 2)], p95FileMs: ms[Math.floor(ms.length * 0.95)], maxFile: perFile.reduce((a, b) => (a.ms > b.ms ? a : b)) },
  functions: obj(status), bailReasons: obj(bailReasons),
  inventoryComparable: { declarators: inventoryDeclarators, byDecision: obj(inventoryDecisions) },
  rewrite: { files: rewrittenFiles, functions: rewrittenFunctions, parseErrors: rewriteParseErrors },
  contracts: { hookValues: obj(hookValues), changedDecisions: obj(contractChanges), demotedToStatic: demoted, demotedSamples, topOpaque: top(opaqueHooks, 15) },
  prestep: { functionsBefore: obj(prestepFunctions), valuesInThoseFunctions: obj(unblockedDecisions), functions: unblocked.sort((a, b) => b.values - a.values), regressions, letAssignedByTry: obj(tryAssigned) },
  allValues: obj(decisions), unscopedStatic, largestBailouts: bailed.sort((a, b) => b.values - a.values).slice(0, 8), flagReasons: obj(flagReasons), params: obj(paramDecisions), effects: { total: effects, withNotes: effectsWithNotes },
};
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(outDir, "decisions.jsonl"), decisionLines.join("\n") + "\n");
const shuffled = Object.fromEntries([...samples].map(([k, list]) => [k, list.filter((_, i) => i % Math.max(1, Math.floor(list.length / 8)) === 0).slice(0, 8)]));
fs.writeFileSync(path.join(outDir, "samples.json"), JSON.stringify(shuffled, null, 2));
console.log(JSON.stringify(summary, null, 2));
