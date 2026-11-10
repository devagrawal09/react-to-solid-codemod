// Applies the value decisions to the source: wraps derived consts, turns their reads into calls,
// inlines single-use JSX, and puts a `// solid:` note above every value. Props, hooks and effects
// are left for the codemod and agent phases, so the output is a partial conversion by design.
import { parseExpression } from "@babel/parser";

const WRAPS = new Set(["memo", "accessor", "call-time", "jsx-fn", "inline", "getter-object"]);

function getterObject(text, render, offset) {
  let node;
  try {
    node = parseExpression(text, { plugins: ["typescript", "jsx"] });
  } catch {
    return null;
  }
  if (node.type !== "ObjectExpression") return null;
  const parts = [];
  for (const prop of node.properties) {
    if (prop.type !== "ObjectProperty" || prop.computed || prop.key.type !== "Identifier") return null;
    const read = render(offset + prop.value.start, offset + prop.value.end);
    parts.push(`get ${prop.key.name}() { return ${prop.shorthand ? read.replace(`${prop.key.name}: `, "") : read}; }`);
  }
  return `{ ${parts.join(", ")} }`;
}

export function rewrite(code, extracted) {
  const refEdits = [];
  const edits = [];
  let needsMemo = false;
  const safeFunctions = [];

  for (const fn of extracted.functions) {
    if (fn.compiler.status !== "compiled") continue;
    // Hook results keep their declaration; the hooks codemod converts built-in hooks and their reads,
    // so only reads of local hooks that hand back an accessor are rewritten here.
    const rewritable = fn.values.filter((v) => WRAPS.has(v.decision) && !v.hookCall);
    const hookReads = fn.values.filter((v) => v.hookCall && v.decision === "accessor" && !v.contract?.builtin);
    const blocked = rewritable.filter((v) => v.destructured || !(["const", "return"].includes(v.declarationKind) || v.tryAssigned));
    const flagged = fn.values.filter((v) => v.decision === "flag");
    if (flagged.length || blocked.length) continue;
    safeFunctions.push(fn);
    for (const v of [...rewritable, ...hookReads]) {
      if (v.decision === "inline" || v.decision === "getter-object") continue;
      for (const u of v.uses) {
        if (u.start == null) continue;
        // A direct hook argument gets the accessor itself, since converted hooks take accessors.
        const read = u.argOf && /^use/.test(u.argOf) ? v.name : `${v.name}()`;
        refEdits.push({ start: u.start, end: u.end, text: u.shorthand ? `${v.name}: ${read}` : read });
      }
    }
  }

  // Text of [start, end) with the read rewrites inside it applied.
  const render = (start, end) => {
    let out = "";
    let at = start;
    for (const e of refEdits.filter((e) => e.start >= start && e.end <= end).sort((a, b) => a.start - b.start)) {
      out += code.slice(at, e.start) + e.text;
      at = e.end;
    }
    return out + code.slice(at, end);
  };

  for (const fn of safeFunctions) {
    for (const v of fn.values) {
      if (!WRAPS.has(v.decision) || v.hookCall) continue;
      if (v.tryAssigned) {
        // `let x; try {...} catch {...}` becomes the body of the memo or accessor that returns x.
        const [ss, se] = v.range.statement;
        const lineStart = code.lastIndexOf("\n", ss - 1) + 1;
        const indent = code.slice(lineStart, ss).match(/^\s*/)[0];
        const body = `{\n${indent}  ${render(ss, se).replace(/\n/g, "\n  ")}\n${indent}  return ${v.name};\n${indent}}`;
        if (v.decision === "memo") needsMemo = true;
        edits.push({ start: ss, end: se, text: `const ${v.name} = ${v.decision === "memo" ? `createMemo(() => ${body})` : `() => ${body}`};` });
        continue;
      }
      const [is, ie] = v.range.init;
      const init = render(is, ie);
      if (v.decision === "memo") {
        needsMemo = true;
        edits.push({ start: is, end: ie, text: `createMemo(() => ${init.trimStart().startsWith("{") ? `(${init})` : init})` });
      } else if (v.decision === "inline" && v.singleDeclarator) {
        edits.push({ start: v.range.statement[0], end: v.range.statement[1], text: "" });
        const use = v.uses[0];
        edits.push({ start: use.start, end: use.end, text: `(${init})` });
      } else if (v.decision === "getter-object") {
        const getters = getterObject(code.slice(is, ie), render, is);
        if (getters) edits.push({ start: is, end: ie, text: getters });
      } else if (v.decision !== "inline") {
        edits.push({ start: is, end: ie, text: `() => (${init})` });
      }
    }
  }

  const all = [...edits, ...refEdits];
  const outer = all.filter((e) => !all.some((o) => o !== e && o.start <= e.start && o.end >= e.end && (o.end - o.start) > (e.end - e.start)));
  outer.sort((a, b) => b.start - a.start);

  const notes = [];
  for (const fn of extracted.functions) {
    const byStatement = new Map();
    for (const v of fn.values) {
      if (!v.range?.statement || (v.hookCall && v.decision === "hook")) continue;
      const key = v.range.statement[0];
      if (!byStatement.has(key)) byStatement.set(key, []);
      byStatement.get(key).push(`${v.name === "(return)" ? "return" : v.name}: ${v.decision} (${v.why})`);
    }
    for (const [start, lines] of byStatement) notes.push({ start, text: `// solid: ${lines.join("; ")}` });
  }

  let out = code;
  const inserts = [...outer.map((e) => ({ ...e, kind: "edit" })), ...notes.map((n) => ({ start: n.start, end: n.start, text: n.text, kind: "note" }))];
  inserts.sort((a, b) => b.start - a.start || (a.kind === "note" ? 1 : -1));
  for (const e of inserts) {
    if (e.kind === "note") {
      const lineStart = out.lastIndexOf("\n", e.start - 1) + 1;
      const indent = out.slice(lineStart, e.start).match(/^\s*/)[0];
      out = `${out.slice(0, lineStart)}${indent}${e.text}\n${out.slice(lineStart)}`;
    } else out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  if (needsMemo) out = `import { createMemo } from "solid-js";\n${out}`;
  return { code: out, rewrittenFunctions: safeFunctions.map((f) => f.name) };
}
