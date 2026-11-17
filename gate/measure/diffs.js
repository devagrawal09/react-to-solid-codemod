// diffs.js <screen> : per tool file, lines differing from the hand-fixed version (old vs new),
// and lines the old output already had right that the new output lost (regression candidates).
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const prettier = require("/home/user/rules/measure/node_modules/prettier");
const S = process.argv[2];
const D = "experiments/solid2-one-screen";
const files = execFileSync("find", [".", "-name", "*.tsx"], { cwd: `/home/user/rw/${S}/decided`, encoding: "utf8" }).trim().split("\n").map((f) => f.replace(/^\.\//, ""));
const only = (f) => (S === "big" && f.endsWith("settingsLayout.tsx") ? ["SettingsRow", "SettingsPageContainer"] : null);
async function norm(file, names) {
  let t = fs.readFileSync(file, "utf8");
  try { t = await prettier.format(t, { parser: "typescript", printWidth: 100 }); } catch {}
  if (names) {
    // keep only the named top-level functions
    const out = [];
    for (const n of names) { const m = t.match(new RegExp(`^export function ${n}\\b[\\s\\S]*?^}\\n`, "m")); if (m) out.push(m[0]); }
    t = out.join("\n");
  }
  return t.replace(/\} as const,/g, "},").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("// solid:") && !/^import\b/.test(l));
}
function lcsDiff(a, b) {
  const n = a.length, m = b.length, dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  return n + m - 2 * dp[0][0];
}
(async () => {
  let to = 0, tn = 0;
  const rows = [];
  for (const f of files) {
    const names = only(f);
    const [O, N, F] = await Promise.all(["old", "new", "fin"].map((v) => norm(`/home/user/m/${S}-${v}/${D}/${f}`, names)));
    const o = lcsDiff(O, F), n = lcsDiff(N, F);
    to += o; tn += n;
    const count = (arr) => arr.reduce((m, l) => m.set(l, (m.get(l) || 0) + 1), new Map());
    const cO = count(O), cF = count(F), cN = count(N);
    const lost = [...cO.keys()].filter((l) => cF.has(l) && (cN.get(l) || 0) < Math.min(cO.get(l), cF.get(l)));
    rows.push({ f, o, n, lost });
  }
  for (const r of rows) console.log(`${r.f.padEnd(55)} old ${String(r.o).padStart(4)}  new ${String(r.n).padStart(4)}`);
  console.log(`${"TOTAL".padEnd(55)} old ${String(to).padStart(4)}  new ${String(tn).padStart(4)}`);
  if (process.argv[3] === "-v") for (const r of rows) if (r.lost.length) console.log(`\n## lost in ${r.f}\n` + r.lost.join("\n"));
})();
