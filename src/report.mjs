// Per-file annotation report in Markdown.
export function report(extracted, rewritten) {
  const lines = [`# ${extracted.file}`, ""];
  if (extracted.parseError) lines.push(`Parse error: ${extracted.parseError}`, "");
  for (const fn of extracted.functions) {
    const c = fn.compiler;
    lines.push(`## ${fn.name} (${fn.kind}, line ${fn.line}): ${c.status}${c.reason ? `, ${c.reason}` : ""}${c.line ? ` at line ${c.line}` : ""}`, "");
    const tries = (fn.tryPrestep ?? []).filter((t) => t.rewritten).map((t) => t.line);
    if (tries.length) lines.push(`Try pre-step: the compiler analyzed the try/catch at line ${tries.join(", ")} as an if/else (analysis only; the source keeps its try).`, "");
    for (const t of (fn.tryPrestep ?? []).filter((t) => !t.rewritten)) lines.push(`Try pre-step skipped line ${t.line}: ${t.why} (AST fallback).`, "");
    if (fn.params.length) lines.push(`Params: ${fn.params.map((p) => `${p.name} → ${p.decision}`).join(", ")}`, "");
    const rows = fn.values.filter((v) => v.decision !== "hook");
    if (rows.length) {
      lines.push("| line | value | decision | why | reactive inputs | read in |", "|---:|---|---|---|---|---|");
      for (const v of rows) {
        const uses = [...new Set(v.uses.map((u) => (u.via ? `${u.kind}:${u.via}` : u.kind)))].join(", ");
        lines.push(`| ${v.line} | \`${v.name}\` | **${v.decision}** | ${v.why} | ${(v.compiler?.inputs ?? []).join(", ")} | ${uses} |`);
      }
      lines.push("");
    }
    const groups = new Map();
    for (const v of fn.values) if (v.decision === "memo") groups.set(v.compiler.scope, [...(groups.get(v.compiler.scope) ?? []), v.name]);
    const shared = [...groups].filter(([, names]) => names.length > 1);
    if (shared.length) lines.push(`Shared React scopes (one memo could return them together): ${shared.map(([id, n]) => `@${id}: ${n.join(", ")}`).join("; ")}`, "");
    for (const e of fn.effects) lines.push(`- ${e.hook} (line ${e.line}): compute half \`${e.compute.join(", ") || "(none)"}\`${e.note ? `. ${e.note}` : ""}`);
    if (fn.effects.length) lines.push("");
    if (fn.earlyReturns) lines.push(`- ${fn.earlyReturns} early return(s): becomes <Show>/<Switch> (agent)`, "");
  }
  lines.push(rewritten.rewrittenFunctions.length ? `Rewritten: ${rewritten.rewrittenFunctions.join(", ")}` : "Rewritten: none (flagged values present)");
  return lines.join("\n");
}
