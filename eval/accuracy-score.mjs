// node eval/accuracy-score.mjs <packets dir> <reviews file> [decisions.jsonl]
// With decisions.jsonl (from a later scan), the tool's current decisions replace the ones in key.json,
// so a fix can be rescored against the same blind reviews.
// Compares blind reviews (eval/accuracy-rubric.md lines) with the tool's decisions in key.json.
// "Safe" groups decisions by what a wrong pick costs: static/function (no wrapper) vs a reactive
// wrapper or getter. A tool "static" where the reviewer says reactive is a stale-UI risk.
import fs from "node:fs";
import path from "node:path";

const [packetsDir, reviewsFile, decisionsFile] = process.argv.slice(2);
const key = JSON.parse(fs.readFileSync(path.join(packetsDir, "key.json"), "utf8"));
if (decisionsFile) {
  const current = new Map();
  for (const line of fs.readFileSync(decisionsFile, "utf8").trim().split("\n")) {
    const f = JSON.parse(line);
    for (const fn of f.functions) for (const v of fn.values) current.set(`${f.file}|${fn.name}|${v.name}|${v.line}`, v);
  }
  for (const k of key) for (const v of k.values) Object.assign(v, current.get(`${k.file}|${k.component}|${v.name}|${v.line}`) ?? {});
}
const reviews = new Map();
for (const line of fs.readFileSync(reviewsFile, "utf8").split("\n")) {
  const parts = line.split("|").map((s) => s.trim());
  if (parts.length < 5 || !/^\d\d$/.test(parts[0])) continue;
  reviews.set(`${parts[0]}|${parts[1]}|${parts[2]}`, { answer: parts[3].toLowerCase(), reason: parts.slice(4).join("|") });
}
const group = (d) => (["static", "function"].includes(d) ? "plain" : d === "flag" ? "flag" : "reactive");
const rows = [];
for (const k of key) for (const v of k.values) {
  const r = reviews.get(`${k.id}|${v.name}|${v.line}`);
  rows.push({ id: k.id, component: k.component, file: k.file, name: v.name, line: v.line, tool: v.decision, toolWhy: v.why, review: r?.answer ?? "missing", reason: r?.reason ?? "" });
}
const reviewed = rows.filter((r) => !["missing", "unsure"].includes(r.review) && r.tool !== "flag");
const exact = reviewed.filter((r) => r.tool === r.review);
const safe = reviewed.filter((r) => group(r.tool) === group(r.review));
const stale = reviewed.filter((r) => group(r.tool) === "plain" && group(r.review) === "reactive" && r.tool !== "function");
const over = reviewed.filter((r) => group(r.tool) === "reactive" && group(r.review) === "plain" && r.review !== "function");
const confusion = {};
for (const r of reviewed.filter((r) => r.tool !== r.review)) confusion[`${r.tool} → ${r.review}`] = (confusion[`${r.tool} → ${r.review}`] ?? 0) + 1;
const staticRows = reviewed.filter((r) => r.tool === "static");
const summary = {
  components: key.length, values: rows.length, reviewed: reviewed.length, nowFlagged: rows.filter((r) => r.tool === "flag").length,
  unsure: rows.filter((r) => r.review === "unsure").length, missing: rows.filter((r) => r.review === "missing").length,
  exact: exact.length, sameGroup: safe.length,
  toolStatic: { total: staticRows.length, reviewerAgrees: staticRows.filter((r) => group(r.review) === "plain").length },
  staleRisk: stale.map((r) => `${r.file}:${r.line} ${r.component}.${r.name}: tool ${r.tool}, review ${r.review} (${r.reason})`),
  overReactive: over.map((r) => `${r.file}:${r.line} ${r.component}.${r.name}: tool ${r.tool}, review ${r.review} (${r.reason})`),
  disagreements: confusion,
};
fs.writeFileSync(path.join(packetsDir, "score.json"), JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify(summary, null, 2));
