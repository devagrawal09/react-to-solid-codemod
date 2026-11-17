// Compares the react-to-solid extract with Babel's compiler (production path, pre-steps on)
// against the same extract fed by the native codemod:react-compiler facts.
// usage: node oxc-compare.mjs facts.jsonl > diffs.json
import fs from "node:fs";
import { extract } from "/home/user/src/react-to-solid-codemod/src/extract.mjs";

const facts = new Map();
for (const line of fs.readFileSync(process.argv[2], "utf8").split("\n")) if (line) { const f = JSON.parse(line); facts.set(f.file, f); }

const sig = (fn, id) => {
  const s = fn.scopes?.find((x) => x.id === id);
  // Compiler temporaries (t12, $40) are numbered differently by each build, so they compare as one name.
  const norm = (n) => n.replace(/^(t|\$)\d+/, "$1#").replace(/^@\d+/, "@#");
  return s ? `[${s.dependencies.map((d) => norm(d.name)).sort()}]->[${[...s.declares].map(norm).sort()}]` : String(id);
};
const view = (fn) => {
  const out = { status: fn.compiler.status, memoSlots: fn.compiler.memoSlots ?? null, values: {}, params: {} };
  for (const v of fn.values) if (v.compiler) out.values[`${v.name}@${v.loc}`] = {
    reactive: !!v.compiler.reactive, scope: v.compiler.scope == null ? null : sig(fn, v.compiler.scope),
    inputs: [...v.compiler.inputs].sort().join(","), readBy: (v.compiler.readByScopes ?? []).map((id) => sig(fn, id)).sort().join(" "),
  };
  for (const p of fn.params) out.params[`${p.name}@${p.loc}`] = !!p.reactive;
  return out;
};

const totals = { files: 0, functions: 0, statusSame: 0, bothCompiled: 0, memoSame: 0, functionsIdentical: 0, values: 0, fields: { reactive: 0, scope: 0, inputs: 0, readBy: 0 }, babelMs: 0, nativeUs: 0 };
const diffs = [];
for (const [file, f] of facts) {
  const code = fs.readFileSync(file, "utf8");
  const t0 = performance.now();
  const babel = extract(code, file);
  totals.babelMs += performance.now() - t0;
  totals.nativeUs += f.us;
  const native = extract(code, file, { analyze: () => f });
  totals.files++;
  const nByLoc = new Map(native.functions.map((x) => [x.loc ?? x.name + x.line, x]));
  babel.functions.forEach((bf, i) => {
    const nf = native.functions[i];
    totals.functions++;
    const b = view(bf), n = view(nf);
    const fnDiff = [];
    if (b.status !== n.status) { fnDiff.push({ status: [b.status, n.status], babelReason: bf.compiler.reason, nativeReason: nf.compiler.reason }); }
    else totals.statusSame++;
    if (b.status === "compiled" && n.status === "compiled") {
      totals.bothCompiled++;
      if (b.memoSlots === n.memoSlots) totals.memoSame++; else fnDiff.push({ memoSlots: [b.memoSlots, n.memoSlots] });
      for (const [k, bv] of Object.entries(b.values)) {
        const nv = n.values[k];
        totals.values++;
        for (const field of Object.keys(totals.fields)) {
          if (nv && bv[field] === nv[field]) totals.fields[field]++;
          else fnDiff.push({ value: k, field, babel: bv[field], native: nv?.[field] });
        }
      }
      for (const [k, bp] of Object.entries(b.params)) if (n.params[k] !== bp) fnDiff.push({ param: k, babel: bp, native: n.params[k] });
      if (!fnDiff.length) totals.functionsIdentical++;
    }
    if (fnDiff.length) diffs.push({ file, fn: bf.name, line: bf.line, diffs: fnDiff });
  });
}
console.error(JSON.stringify(totals, null, 1));
console.log(JSON.stringify(diffs, null, 1));
