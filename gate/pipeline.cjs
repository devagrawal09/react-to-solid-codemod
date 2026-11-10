// node gate/pipeline.cjs <t3code checkout> <decided dir> [out dir] [--lint-only]
// Runs the rule pass (mechanical.js: props, hooks, JSX attributes) twice over apps/web: on the
// original files ("codemod") and on the files our decisions rewrote ("decisions"), then lints both
// with eslint-plugin-solid's v2 config and reports the difference.
// <decided dir> comes from `node src/scan.mjs <checkout> <out> --write <decided dir>`.
const fs = require("node:fs");
const path = require("node:path");

const [root, decidedDir, outArg] = process.argv.slice(2);
const out = path.resolve(outArg ?? path.join(__dirname, "out"));
const mechanical = path.join(__dirname, "mechanical.js");

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) files.push(path.relative(decidedDir, p));
  }
})(decidedDir);

// mechanical.js is a script that reads process.argv; run it in-process once per file.
function codemod(inFile, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const argv = process.argv;
  const log = console.log;
  process.argv = [argv[0], mechanical, inFile, outFile];
  console.log = () => {};
  try {
    delete require.cache[require.resolve(mechanical)];
    require(mechanical);
    return null;
  } catch (e) {
    return String(e.message).split("\n")[0];
  } finally {
    process.argv = argv;
    console.log = log;
  }
}

const started = Date.now();
const failures = { codemod: [], decisions: [] };
const tmp = path.join(out, ".in");
const lintOnly = process.argv.includes("--lint-only");
for (const rel of lintOnly ? [] : files) {
  const original = path.join(root, rel);
  const e1 = codemod(original, path.join(out, "codemod", rel));
  if (e1) failures.codemod.push(`${rel}: ${e1}`);
  // The codemod writes its own solid-js import, so drop the one the rewrite added.
  const decided = fs.readFileSync(path.join(decidedDir, rel), "utf8").replace(/^import \{ createMemo \} from "solid-js";\n/, "");
  const staged = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.writeFileSync(staged, decided);
  const e2 = codemod(staged, path.join(out, "decisions", rel));
  if (e2) failures.decisions.push(`${rel}: ${e2}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
const codemodMs = Date.now() - started;

(async () => {
  const { ESLint } = require("eslint");
  const eslint = new ESLint({ cwd: out, overrideConfigFile: path.join(__dirname, "eslint.config.mjs"), errorOnUnmatchedPattern: false });
  const lint = async (set) => {
    const results = await eslint.lintFiles([`${set}/**/*.{ts,tsx}`]);
    const byRule = {};
    const perFile = new Map();
    let parseErrors = 0;
    for (const r of results) {
      for (const m of r.messages) {
        if (!m.ruleId) { parseErrors++; continue; }
        byRule[m.ruleId] = (byRule[m.ruleId] ?? 0) + 1;
      }
      perFile.set(path.relative(path.join(out, set), r.filePath), r.messages.filter((m) => m.ruleId === "solid/reactivity").length);
    }
    return { files: results.length, byRule, parseErrors, perFile };
  };
  const a = await lint("codemod");
  const b = await lint("decisions");
  let better = 0, worse = 0, same = 0;
  const worst = [];
  for (const [rel, n] of a.perFile) {
    const m = b.perFile.get(rel) ?? 0;
    if (m < n) better++; else if (m > n) { worse++; worst.push(`${rel}: ${n} → ${m}`); } else same++;
  }
  const summary = {
    files: files.length, codemodMs, lintMs: Date.now() - started - codemodMs,
    codemodFailures: { codemod: failures.codemod.length, decisions: failures.decisions.length, samples: failures.decisions.slice(0, 5) },
    lint: {
      codemod: { byRule: a.byRule, parseErrors: a.parseErrors },
      decisions: { byRule: b.byRule, parseErrors: b.parseErrors },
      reactivityPerFile: { fewer: better, more: worse, same, more_samples: worst.slice(0, 15) },
    },
  };
  fs.writeFileSync(path.join(out, "gate-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
})();
