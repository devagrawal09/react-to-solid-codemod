// merge.js ours base theirs [onlyNames,comma] > out
// Carries the post-tool, non-hand edits (trims, import swaps, stubs) from the old tool output onto
// the new one, one top-level declaration at a time. Conflicts keep ours and are reported on stderr.
const { parse, Lang } = require("/home/user/rules/node_modules/@ast-grep/napi");
const fs = require("fs");
const { execFileSync } = require("child_process");
const [, , oursF, baseF, theirsF, only] = process.argv;
const onlyNames = only ? new Set(only.split(",")) : null;
const read = (f) => fs.readFileSync(f, "utf8");
const SOLID = /from ["'](solid-js|@solidjs\/web)["']/;
function split(text) {
  const root = parse(Lang.Tsx, text).root();
  const out = [];
  let prevEnd = 0;
  for (const st of root.children()) {
    const lead = text.slice(prevEnd, st.range().start.index);
    prevEnd = st.range().end.index;
    let key = null;
    const decl = st.kind() === "export_statement" ? st.field("declaration") ?? st : st;
    const name = decl.field?.("name");
    if (name) key = `${decl.kind()}:${name.text()}`;
    else if (decl.kind() === "lexical_declaration") key = "var:" + decl.children().filter((c) => c.kind() === "variable_declarator").map((d) => d.field("name").text()).join(",");
    else if (st.kind() === "import_statement") key = "import:" + st.field("source").text();
    out.push({ key, text: st.text(), lead, kind: st.kind(), name: name?.text() });
  }
  return { items: out, tail: text.slice(prevEnd) };
}
const ok = (t) => !parse(Lang.Tsx, t).root().children().some((c) => !/(statement|declaration|comment)$/.test(c.kind()));
if (![oursF, baseF, theirsF].every((f) => ok(read(f)))) {
  // tree-sitter misreads some valid TS (a call named `override()`); fall back to a whole-file merge
  process.stderr.write("whole-file merge\n");
  try { process.stdout.write(execFileSync("git", ["merge-file", "-p", oursF, baseF, theirsF], { encoding: "utf8" })); }
  catch (e) {
    // a conflict made only of import lines: theirs' solid imports, ours' library imports
    let left = 0;
    const out = e.stdout.replace(/^<<<<<<< .*\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> .*\n/gm, (m, o, t) => {
      const lines = (x) => x.split("\n").filter(Boolean);
      if (![...lines(o), ...lines(t)].every((l) => /^import\b/.test(l))) { left++; return m; }
      return [...lines(t).filter((l) => SOLID.test(l)), ...lines(o).filter((l) => !SOLID.test(l) && !/from ["']react["']/.test(l))].join("\n") + "\n";
    });
    process.stdout.write(out);
    process.exitCode = left ? 1 : 0;
  }
  return;
}
const ours = split(read(oursF)), base = split(read(baseF)), theirs = split(read(theirsF));
const by = (s) => new Map(s.items.filter((i) => i.key).map((i) => [i.key, i]));
const B = by(base), T = by(theirs);
const tmp = "/tmp/claude-0/merge-" + process.pid;
let conflicts = 0;
const pieces = [];
// imports: drop solid lines, keep the rest of ours, put theirs' solid lines first
const theirsSolid = theirs.items.filter((i) => i.kind === "import_statement" && SOLID.test(i.text)).map((i) => i.text);
let head = "";
const done = new Set();
const ikey = (t) => (/^import\s+type\b/.test(t) ? "type " : "") + t.match(/from ["']([^"']+)["']/)[1];
const namesIn = (side, k) => side.items.filter((i) => i.kind === "import_statement" && SOLID.test(i.text) && ikey(i.text) === k).flatMap((i) => (i.text.match(/\{([^}]*)\}/)?.[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean));
const mergedNames = (k) => {
  const o = namesIn(ours, k), b = namesIn(base, k), t = namesIn(theirs, k);
  if (onlyNames) return [...new Set([...o, ...t.filter((n) => !b.includes(n))])];
  return [...new Set([...o.filter((n) => !(b.includes(n) && !t.includes(n))), ...t.filter((n) => !b.includes(n))])];
};
const line = (k, names) => `import ${k.startsWith("type ") ? "type " : ""}{ ${names.join(", ")} } from "${k.replace(/^type /, "")}";`;
for (const it of ours.items) {
  if (it.kind === "import_statement" && SOLID.test(it.text)) {
    const k = ikey(it.text);
    const all = mergedNames(k);
    const own = (it.text.match(/\{([^}]*)\}/)?.[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const o = namesIn(ours, k);
    const names = [...own.filter((n) => all.includes(n)), ...(done.has(k) ? [] : all.filter((n) => !o.includes(n)))];
    done.add(k);
    pieces.push(names.length ? it.lead + line(k, names) : "");
    if (!head) head = "x";
    continue;
  }
  if (it.kind === "import_statement" && !onlyNames) {
    const b = B.get(it.key), t = T.get(it.key);
    pieces.push(it.lead + (b && t && b.text === it.text ? t.text : it.text));
    continue;
  }
  const b = it.key && B.get(it.key), t = it.key && T.get(it.key);
  if (onlyNames && !onlyNames.has(it.name)) { pieces.push(it.lead + it.text); continue; }
  if (!b || !t) { pieces.push(it.lead + it.text); continue; }
  if (b.text === it.text) { pieces.push(it.lead + t.text); continue; }
  fs.writeFileSync(tmp + ".o", it.text); fs.writeFileSync(tmp + ".b", b.text); fs.writeFileSync(tmp + ".t", t.text);
  try { pieces.push(it.lead + execFileSync("git", ["merge-file", "-p", tmp + ".o", tmp + ".b", tmp + ".t"], { encoding: "utf8" })); }
  catch (e) { conflicts++; process.stderr.write(`conflict in ${it.key}\n`); pieces.push(it.lead + it.text); }
}
const extra = [...new Set(theirs.items.filter((i) => i.kind === "import_statement" && SOLID.test(i.text)).map((i) => ikey(i.text)))].filter((k) => !done.has(k)).map((k) => [k, mergedNames(k)]).filter(([, n]) => n.length).map(([k, n]) => line(k, n));
if (extra.length) pieces.unshift(extra.join("\n") + (pieces.length && !pieces[0].startsWith("\n") ? "\n" : ""));
for (const x of [".o", ".b", ".t"]) try { fs.unlinkSync(tmp + x); } catch {}
process.stdout.write(pieces.join("") + ours.tail);
process.exitCode = conflicts ? 1 : 0;
