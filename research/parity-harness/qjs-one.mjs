// Times the sibling's extract() bundle (Babel + React Compiler 1.0.0) in Node and in QuickJS (wasm, release build)
import { readFileSync } from "node:fs";
import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";
import { specs, dir } from "./corpus.mjs";

const BUNDLE = "/mnt/project-files/v2-react-to-solid/workflow/lib/reactivity.mjs";
const src = readFileSync(BUNDLE, "utf8");
const exportAt = src.lastIndexOf("export {");
const script = src.slice(0, exportAt) + "\nglobalThis.__extract = extract;\n" + src.slice(src.indexOf("};", exportAt) + 2);

const only = Number(process.argv[2]);
const files = [...specs(), ...dir("t3code-web", "/home/user/src/t3code/apps/web/src").filter((_, i) => i % 35 === 0), ...dir("codemod-app-nextjs", "/home/user/codemod-app/apps/nextjs/src").filter((_, i) => i % 20 === 0)].slice(only, only + 1);

const node = await import(BUNDLE);
const QuickJS = await getQuickJS();
const rt = QuickJS.newRuntime();
rt.setMemoryLimit(2 ** 31 - 1);
rt.setMaxStackSize(0);
const vm = rt.newContext();
const con = vm.newObject(); const noop = vm.newFunction("log", () => {});
for (const k of ["log", "warn", "error", "debug"]) vm.setProp(con, k, noop);
vm.setProp(vm.global, "console", con);
vm.unwrapResult(vm.evalCode(`globalThis.performance = { now: () => Date.now() }; globalThis.process = { versions: { node: "22.0.0" }, env: {}, platform: "linux", argv: [], cwd: () => "/", nextTick: (f, ...a) => Promise.resolve().then(() => f(...a)), emitWarning() {}, features: {} };`)).dispose();
let t = performance.now();
vm.unwrapResult(vm.evalCode(script, "reactivity.js")).dispose();
console.log("qjs bundle load ms", Math.round(performance.now() - t));

const rows = [];
for (const f of files) {
  let a = performance.now(), nOk = true;
  try { nOk = JSON.stringify(node.extract(f.code, f.file)).length; } catch { nOk = false; }
  const nodeMs = performance.now() - a;
  vm.setProp(vm.global, "__code", vm.newString(f.code));
  vm.setProp(vm.global, "__name", vm.newString(f.file));
  a = performance.now();
  rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 60000));
  const r = vm.evalCode("var __ok = true; try { var __r = __extract(__code, __name); __ok = JSON.stringify(__r).length } catch (e) { __ok = String(e).slice(0,120) } __ok");
  const qjsMs = performance.now() - a;
  let ok = true;
  if (r.error) { ok = vm.dump(r.error); r.error.dispose(); } else { ok = vm.dump(r.value); r.value.dispose(); }
  const row = ({ name: f.corpus + ":" + f.file, lines: f.code.split("\n").length, nodeMs: +nodeMs.toFixed(1), qjsMs: +qjsMs.toFixed(1), ok, nOk }); rows.push(row); console.log(JSON.stringify(row));
}

const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
const med = (k) => { const v = rows.map((r) => r[k]).sort((x, y) => x - y); return v[v.length >> 1]; };
console.log({ files: rows.length, nodeAvg: +(sum("nodeMs") / rows.length).toFixed(1), qjsAvg: +(sum("qjsMs") / rows.length).toFixed(1), nodeMedian: med("nodeMs"), qjsMedian: med("qjsMs") });
