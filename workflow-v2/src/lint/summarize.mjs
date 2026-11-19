// Reads ESLint's JSON report on stdin and prints a one-line JSON summary as the last line
// of stdout, which the workflow parses. The human summary goes to stderr.
import fs from "node:fs";

const results = JSON.parse(fs.readFileSync(0, "utf8"));
const byRule = {};
const byFile = {};
let parseErrors = 0;
for (const r of results) {
  const file = r.filePath.replace(`${process.cwd()}/`, "");
  for (const m of r.messages) {
    if (m.fatal) parseErrors++;
    const rule = m.ruleId ?? (m.fatal ? "parse-error" : "eslint");
    byRule[rule] = (byRule[rule] ?? 0) + 1;
    (byFile[file] ??= []).push(`${m.line}: ${rule}: ${m.message.split("\n")[0]}`);
  }
}
const summary = { files: results.length, problems: Object.values(byRule).reduce((a, b) => a + b, 0), parseErrors, byRule, byFile };
console.error(`${summary.problems} problems in ${summary.files} files`, JSON.stringify(byRule));
console.log(JSON.stringify(summary));
