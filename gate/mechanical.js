// Prototype of the deterministic React -> Solid 2 pass. Each rule is conservative and
// reports what it could not do as a flag for the agent/human bucket instead of guessing.
// Usage: node mechanical.js <in.tsx> <out.tsx>   (prints flags as JSON to stdout)
const { parse, Lang } = require("@ast-grep/napi");
const fs = require("fs");

const [, , inFile, outFile] = process.argv;
let src = fs.readFileSync(inFile, "utf8");
const flags = [];
const applied = {};
const note = (rule, n = 1) => (applied[rule] = (applied[rule] || 0) + n);
const flag = (kind, node, detail) =>
  flags.push({ kind, line: node ? node.range().start.line + 1 : 0, detail });

const ATTRS = { className: "class", htmlFor: "for", tabIndex: "tabindex", readOnly: "readonly", autoFocus: "autofocus", autoComplete: "autocomplete", maxLength: "maxlength", minLength: "minlength", spellCheck: "spellcheck", colSpan: "colspan", rowSpan: "rowspan" };
const FN_KINDS = new Set(["arrow_function", "function_expression", "function_declaration", "method_definition"]);

function pass(fn) {
  const root = parse(Lang.Tsx, src).root();
  const edits = fn(root) || [];
  if (edits.length) src = root.commitEdits(edits);
  return edits.length;
}
const same = (a, b) => !!a && !!b && a.range().start.index === b.range().start.index && a.range().end.index === b.range().end.index && a.kind() === b.kind();
const kids = (n) => (n ? n.children().filter((c) => !["(", ")", ",", "[", "]", "{", "}"].includes(c.kind())) : []);
const tagName = (attr) => {
  const open = attr.parent();
  return open?.field("name")?.text() ?? "";
};

// Rewrite reads of `name` inside `scope` to `replacement(text)`; report body-level reads.
function rewriteReads(scope, declNode, name, toRead, bodyNode, label) {
  const edits = [];
  for (const id of scope.findAll({ rule: { any: [{ kind: "identifier", regex: `^${name}$` }, { kind: "shorthand_property_identifier", regex: `^${name}$` }] } })) {
    if (declNode && id.range().start.index >= declNode.range().start.index && id.range().end.index <= declNode.range().end.index) continue;
    const parent = id.parent();
    if (parent?.kind() === "jsx_opening_element" || parent?.kind() === "jsx_closing_element") continue;
    // shadowed by a nested function parameter?
    let shadowed = false;
    for (let a = id.parent(); a && a.range().start.index >= scope.range().start.index; a = a.parent()) {
      if (FN_KINDS.has(a.kind()) && !same(a, bodyNode?.parent())) {
        const params = a.field("parameters") ?? a.field("parameter");
        if (params && new RegExp(`\\b${name}\\b`).test(params.text())) shadowed = true;
      }
    }
    if (shadowed) continue;
    // deferred if any ancestor below the component body is a function or JSX expression/attribute
    let deferred = false;
    for (let a = id.parent(); a && !same(a, bodyNode); a = a.parent()) {
      if (FN_KINDS.has(a.kind()) || a.kind() === "jsx_expression") { deferred = true; break; }
    }
    if (!deferred && bodyNode) flag("render-dependent read", id, `${label} '${name}' is read in the component body; it runs once in Solid (needs createMemo/<Show>)`);
    edits.push(id.kind() === "shorthand_property_identifier" ? id.replace(`${name}: ${toRead}`) : id.replace(toRead));
  }
  return edits;
}

// R1 intrinsic attribute renames, R2 key removal
pass((root) =>
  root.findAll({ rule: { kind: "jsx_attribute" } }).flatMap((attr) => {
    const nameNode = attr.child(0);
    const n = nameNode?.text();
    const tag = tagName(attr);
    if (n === "key") { note("remove key"); return [attr.replace("")]; }
    if (n === "className" && !/^[a-z]/.test(tag)) { note("className -> class (owned component prop)"); return [nameNode.replace("class")]; }
    if (ATTRS[n] && /^[a-z]/.test(tag)) { note(`${n} -> ${ATTRS[n]}`); return [nameNode.replace(ATTRS[n])]; }
    if (n === "dangerouslySetInnerHTML") {
      const m = attr.text().match(/^dangerouslySetInnerHTML=\{\{\s*__html:\s*([\s\S]*?)\s*,?\s*\}\}$/);
      if (m) { note("dangerouslySetInnerHTML -> innerHTML"); return [attr.replace(`innerHTML={${m[1]}}`)]; }
    }
    if (n === "onChange" && /^(input|textarea)$/.test(tag)) flag("controlled input", attr, "React onChange fires per keystroke; Solid onChange fires on commit. Use onInput (check type=checkbox/radio)");
    return [];
  }),
);

// R3 <Ctx.Provider> -> <Ctx>
pass((root) =>
  root.findAll({ rule: { any: [{ kind: "jsx_opening_element" }, { kind: "jsx_closing_element" }], has: { field: "name", regex: "\\.Provider$" } } }).map((el) => {
    note("Ctx.Provider -> Ctx");
    const nameNode = el.field("name");
    return nameNode.replace(nameNode.text().replace(/\.Provider$/, ""));
  }),
);

// R4 useCallback(fn, deps) -> fn ; React.memo(C)/memo(C) -> C
pass((root) =>
  root.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: "^(React\\.)?(useCallback|memo)$" } } }).flatMap((call) => {
    const [fn] = kids(call.field("arguments"));
    if (!fn) return [];
    note(call.field("function").text().replace("React.", ""));
    return [call.replace(fn.text())];
  }),
);

// R5/R6 useState -> createSignal, useMemo(fn, deps) -> createMemo(fn), plus read rewrites
for (const hook of ["useState", "useMemo"]) {
  let changed = true;
  while (changed) {
    changed = pass((root) => {
      const decl = root.find({
        rule: {
          kind: "variable_declarator",
          has: { field: "value", kind: "call_expression", has: { field: "function", regex: `^(React\\.)?${hook}(<.*>)?$` } },
        },
      });
      if (!decl) return [];
      const call = decl.field("value");
      const body = decl.parent()?.parent(); // statement_block of the component/hook
      const fnNode = body?.parent();
      const args = kids(call.field("arguments"));
      const typeArgs = call.field("type_arguments")?.text() ?? "";
      const edits = [];
      if (hook === "useState") {
        const pattern = decl.field("name");
        const [getter, setter] = kids(pattern);
        if (pattern.kind() !== "array_pattern" || !getter) { flag("useState shape", decl, "non-tuple useState"); return [decl.replace(decl.text().replace(/useState/, "createSignal"))]; }
        note("useState -> createSignal");
        edits.push(call.replace(`createSignal${typeArgs}(${args.map((a) => a.text()).join(", ")})`));
        edits.push(...rewriteReads(body, decl, getter.text(), `${getter.text()}()`, body, "state"));
        void setter;
      } else {
        const nameNode = decl.field("name");
        if (nameNode.kind() !== "identifier") {
          flag("destructured memo", decl, "useMemo result is destructured; destructuring a memo reads it once");
          return [call.replace(`createMemo${typeArgs}(${args[0].text()})`)];
        }
        const name = nameNode.text();
        note("useMemo -> createMemo");
        edits.push(call.replace(`createMemo${typeArgs}(${args[0].text()})`));
        edits.push(...rewriteReads(body, decl, name, `${name}()`, body, "memo"));
      }
      void fnNode;
      return edits;
    });
  }
}

// R7 {arr.map((x) => <JSX/>)} -> <For each={arr}>{(x) => <JSX/>}</For>
pass((root) =>
  root.findAll({
    rule: {
      kind: "jsx_expression",
      has: {
        kind: "call_expression",
        has: { field: "function", kind: "member_expression", has: { field: "property", regex: "^map$" } },
      },
    },
  }).flatMap((expr) => {
    const call = kids(expr)[0];
    if (!call || call.kind() !== "call_expression") return [];
    const member = call.field("function");
    const arr = member.field("object").text();
    const [cb] = kids(call.field("arguments"));
    if (!cb || cb.kind() !== "arrow_function" || !/<[A-Za-z>]/.test(cb.text())) return [];
    const params = kids(cb.field("parameters"));
    if (params.length > 1) {
      flag("list index", expr, `.map() uses an index param '${params[1].text()}'; in <For> it becomes an accessor`);
    }
    note(".map -> <For>");
    return [expr.replace(`<For each={${arr}}>{${cb.text()}}</For>`)];
  }),
);

// R8 props destructuring -> props / merge / omit
pass((root) => {
  const edits = [];
  const comps = root.findAll({
    rule: {
      any: [{ kind: "function_declaration", has: { field: "name", regex: "^[A-Z]" } }, { kind: "arrow_function", inside: { kind: "variable_declarator", has: { field: "name", regex: "^[A-Z]" } } }, { kind: "arrow_function", inside: { kind: "arguments", inside: { kind: "call_expression", has: { field: "function", regex: "^(React\\.)?(memo|forwardRef)$" } } } }],
    },
  });
  for (const fn of comps) {
    const params = fn.field("parameters");
    const first = kids(params)[0];
    const pat = first?.field?.("pattern") ?? first;
    if (!pat || pat.kind() !== "object_pattern") continue;
    const typeAnn = first.field("type")?.text() ?? "";
    const body = fn.field("body");
    if (!body || body.kind() !== "statement_block") { flag("expression-bodied component", fn, "add a block body first"); continue; }
    const names = [], defaults = [];
    let rest = null;
    for (const p of kids(pat)) {
      if (p.kind() === "shorthand_property_identifier_pattern") names.push(p.text());
      else if (p.kind() === "object_assignment_pattern") { const k = p.field("left").text(); names.push(k); defaults.push(`${k === "className" ? "class" : k}: ${p.field("right").text()}`); }
      else if (p.kind() === "rest_pattern") rest = p.text().replace(/^\.\.\./, "").trim();
      else { flag("complex props pattern", p, p.text()); }
    }
    const propsVar = defaults.length ? "merged" : "props";
    const restVar = rest === "props" ? "others" : rest;
    const pre = [];
    if (defaults.length) pre.push(`const merged = merge({ ${defaults.join(", ")} }, props);`);
    const key = (n) => (n === "className" ? "class" : n);
    if (rest) pre.push(`const ${restVar} = omit(${propsVar}, ${names.map((n) => JSON.stringify(key(n))).join(", ")});`);
    edits.push(first.replace(`props${typeAnn}`));
    if (pre.length) edits.push(body.child(0).replace(`{\n  ${pre.join("\n  ")}`));
    for (const n of names) edits.push(...rewriteReads(body, null, n, `${propsVar}.${key(n)}`, body, "prop"));
    if (rest && rest !== restVar) edits.push(...rewriteReads(body, null, rest, restVar, null, "rest"));
    note("destructured props -> props/merge/omit");
  }
  return edits;
});

// R9 types and React namespace members
pass((root) =>
  root.findAll({ rule: { any: [{ kind: "nested_type_identifier" }, { kind: "generic_type" }, { kind: "type_identifier" }] } }).flatMap((t) => {
    const s = t.text();
    if (/^(React\.)?(ReactNode|ReactElement|JSX\.Element)$/.test(s)) { note("ReactNode -> JSX.Element"); return [t.replace("JSX.Element")]; }
    if (t.kind() === "generic_type" && /^React\.ComponentProps</.test(s)) { note("React.ComponentProps -> ComponentProps"); return [t.replace(s.replace(/^React\./, ""))]; }
    return [];
  }),
);

// Flags for the judgment bucket
const root = parse(Lang.Tsx, src).root();
for (const c of root.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: "^(React\\.)?(useEffect|useLayoutEffect)$" } } }))
  flag("effect", c, `${kids(c.field("arguments"))[1]?.text() ?? "no deps"} -> createEffect(compute, apply) or onSettled`);
for (const c of root.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: "^(React\\.)?useRef$" } } }))
  flag("ref", c, "useRef -> DOM ref callback or plain let");
for (const c of root.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: "^(React\\.)?(createContext)$" } } }))
  if (/\(\s*(undefined)?\s*\)$/.test(c.text())) flag("context default", c, "Solid 2: undefined default means 'no provider' and throws; use null for optional");
for (const c of root.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: "^use[A-Z]\\w*$" } } }))
  if (!/^use(Context|State|Memo|Callback|Effect|LayoutEffect|Ref)$/.test(c.field("function").text())) flag("custom hook call", c, `${c.field("function").text()}() returns values in React; decide value vs accessor`);

// R10 imports
const used = (re) => re.test(src.replace(/^import[^;]+;$/gm, ""));
const solidNames = ["createSignal", "createMemo", "createContext", "useContext", "createEffect", "onSettled", "merge", "omit", "For", "Show", "createUniqueId"].filter((n) => used(new RegExp(`\\b${n}\\b`)));
const typeNames = ["JSX", "ComponentProps"].filter((n) => used(new RegExp(`\\b${n}\\b`)));
let removedReact = false;
src = src.replace(/^import\s+(type\s+)?(\*\s+as\s+React|React(,\s*\{[^}]*\})?|\{[^}]*\})\s+from\s+["']react["'];\n/gm, () => { removedReact = true; return ""; });
const header = [solidNames.length ? `import { ${solidNames.join(", ")} } from "solid-js";` : "", typeNames.length ? `import type { ${typeNames.join(", ")} } from "@solidjs/web";` : ""].filter(Boolean).join("\n");
if (header) src = src.replace(/^(["']use client["'];\n\n?)?/, (m) => `${m}${header}\n`);
if (removedReact) note("react imports -> solid-js");
src = src.replace(/^["']use client["'];\n\n?/m, () => { note("drop 'use client'"); return ""; });
if (/\bReact\.\w+/.test(src)) flag("React namespace", null, [...new Set(src.match(/\bReact\.\w+/g))].join(", "));

fs.writeFileSync(outFile, src);
console.log(JSON.stringify({ file: inFile, applied, flags }, null, 2));
