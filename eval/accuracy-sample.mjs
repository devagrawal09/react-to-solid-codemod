// node eval/accuracy-sample.mjs <t3code checkout> <scan out dir> <packets dir> [count] [--seed N] [--exclude key.json]
// Picks components for a blind review: reviewers classify every value themselves, without our
// decisions, and eval/accuracy-score.mjs compares. Deterministic (seeded) and stratified so that
// a third of the picks hold at least one value the tool calls static.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const [root, scanDir, packetsDir, countArg] = args.filter((a, i) => !a.startsWith("--") && !["--seed", "--exclude"].includes(args[i - 1]));
const excluded = new Set(opt("--exclude") ? JSON.parse(fs.readFileSync(opt("--exclude"), "utf8")).map((k) => k.file) : []);
const count = Number(countArg ?? 25);
const lines = fs.readFileSync(path.join(scanDir, "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const REVIEWED = new Set(["memo", "accessor", "static", "function", "inline", "jsx-fn", "call-time", "getter-object", "getter-read"]);

const candidates = [];
for (const f of lines) {
  for (const fn of f.functions) {
    if (fn.kind !== "component" || fn.status !== "compiled" || excluded.has(f.file)) continue;
    const values = fn.values.filter((v) => v.name !== "(return)" && REVIEWED.has(v.decision));
    if (values.length < 3 || values.length > 25) continue;
    if (/\/(ui|components\/ui)\//.test(f.file) && values.length < 5) continue;
    candidates.push({ file: f.file, fn, values, hasStatic: values.some((v) => v.decision === "static") });
  }
}
let seed = Number(opt("--seed") ?? 20261109);
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const shuffle = (a) => a.map((x) => [rand(), x]).sort((p, q) => p[0] - q[0]).map(([, x]) => x);
const withStatic = shuffle(candidates.filter((c) => c.hasStatic));
const others = shuffle(candidates.filter((c) => !c.hasStatic));
const picked = [];
const files = new Set();
for (const c of [...withStatic.slice(0, Math.ceil(count / 3) * 3), ...others]) {
  if (picked.length >= count) break;
  if (files.has(c.file)) continue;
  if (c.hasStatic && picked.filter((p) => p.hasStatic).length >= Math.ceil(count / 3)) continue;
  files.add(c.file);
  picked.push(c);
}

fs.mkdirSync(packetsDir, { recursive: true });
const key = [];
picked.forEach((c, i) => {
  const src = fs.readFileSync(path.join(root, c.file), "utf8");
  const id = String(i + 1).padStart(2, "0");
  fs.writeFileSync(path.join(packetsDir, `${id}.md`), [
    `# ${id}: ${c.fn.name} in ${c.file} (line ${c.fn.line})`,
    "",
    "Classify each value below. The full file follows.",
    "",
    ...c.values.map((v) => `- ${v.name} (line ${v.line})`),
    "",
    "```tsx",
    src,
    "```",
    "",
  ].join("\n"));
  key.push({ id, file: c.file, component: c.fn.name, values: c.values.map(({ name, line, decision, why }) => ({ name, line, decision, why })) });
});
fs.writeFileSync(path.join(packetsDir, "key.json"), JSON.stringify(key, null, 2));
console.log(`${picked.length} components, ${key.reduce((n, k) => n + k.values.length, 0)} values, ${picked.filter((p) => p.hasStatic).length} with a static value`);
