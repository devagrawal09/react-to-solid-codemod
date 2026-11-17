// gate.js : run old and new codemod over every decided apps/web file; report crashes and files
// whose output has more parse errors under the new codemod than under the old one.
const fs = require("fs");
const path = require("path");
const { parse, Lang } = require("@ast-grep/napi");
const { transform } = require("../mechanical.js");
const root = "/home/user/cp/out/decided-now/apps/web";
const files = require("child_process").execFileSync("find", [root, "-name", "*.tsx"], { encoding: "utf8" }).trim().split("\n");
// old codemod is a CLI; load it with a fake argv per file
const oldSrc = fs.readFileSync("/home/user/rules/codemod/mechanical.base.js", "utf8");
const runOld = (input) => {
  const tmpIn = "/tmp/claude-0/gate-in.tsx", tmpOut = "/tmp/claude-0/gate-out.tsx";
  fs.writeFileSync(tmpIn, input);
  require("child_process").execFileSync("node", ["/home/user/rules/codemod/mechanical.base.js", tmpIn, tmpOut], { stdio: "ignore" });
  return fs.readFileSync(tmpOut, "utf8");
};
const errs = (code) => parse(Lang.Tsx, code).root().findAll({ rule: { kind: "ERROR" } }).length;
let crashes = 0, worse = 0, applied = {}, n = 0;
const strip = (t) => t.replace(/^import \{ createMemo \} from "solid-js";\n/, "");
for (const f of files) {
  const input = strip(fs.readFileSync(f, "utf8"));
  let out;
  try { out = transform(input); } catch (e) { crashes++; console.log("CRASH", path.relative(root, f), e.message.split("\n")[0]); continue; }
  n++;
  for (const [k, v] of Object.entries(out.applied)) applied[k] = (applied[k] || 0) + v;
  let old; try { old = runOld(input); } catch { old = null; }
  const en = errs(out.code), eo = old == null ? 0 : errs(old);
  if (en > eo) { worse++; console.log("MORE PARSE ERRORS", path.relative(root, f), eo, "->", en); }
}
console.log(JSON.stringify({ files: files.length, ran: n, crashes, worse }));
fs.writeFileSync("/home/user/rules/measure/out/gate-applied.json", JSON.stringify(applied, null, 1));
