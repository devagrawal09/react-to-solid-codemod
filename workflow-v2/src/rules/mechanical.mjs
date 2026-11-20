// The deterministic React -> Solid 2 pass. Each rule is conservative and reports what it could
// not do as a flag for the agent/human bucket instead of guessing.
// transform(src, { parse, Lang }) -> { code, applied, flags }. The ast-grep parser is passed in, so
// this runs under @ast-grep/napi in Node and under codemod/ast-grep in the workflow.
//
// R1-R10 are the original rules. R11-R34 come from hand fixes that repeated across three
// screen ports (t3code OpenTelemetry and Keybindings, codemod-app Repositories > Indexing).

const ATTRS = { className: "class", htmlFor: "for", tabIndex: "tabindex", readOnly: "readonly", autoFocus: "autofocus", autoComplete: "autocomplete", maxLength: "maxlength", minLength: "minlength", spellCheck: "spellcheck", colSpan: "colspan", rowSpan: "rowspan" };
const FN_KINDS = new Set(["arrow_function", "function_expression", "function_declaration", "method_definition"]);
const SVG_ATTRS = ["strokeWidth", "strokeLinecap", "strokeLinejoin", "strokeDasharray", "strokeDashoffset", "strokeOpacity", "strokeMiterlimit", "fillOpacity", "fillRule", "clipRule", "clipPath", "stopColor", "stopOpacity", "textAnchor", "dominantBaseline", "markerStart", "markerMid", "markerEnd", "vectorEffect", "shapeRendering", "colorInterpolationFilters", "floodColor", "floodOpacity", "lightingColor", "pointerEvents", "fontFamily", "fontSize", "fontWeight"];
const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "file", "submit", "button", "reset", "image", "color", "hidden"]);
const REACT_EVENTS = { MouseEvent: "MouseEvent", KeyboardEvent: "KeyboardEvent", FocusEvent: "FocusEvent", PointerEvent: "PointerEvent", DragEvent: "DragEvent", TouchEvent: "TouchEvent", WheelEvent: "WheelEvent", ClipboardEvent: "ClipboardEvent", CompositionEvent: "CompositionEvent", AnimationEvent: "AnimationEvent", TransitionEvent: "TransitionEvent", UIEvent: "UIEvent", ChangeEvent: "Event", FormEvent: "Event", SyntheticEvent: "Event", InputEvent: "InputEvent" };
// React's unitless CSS properties: it adds px to any other number.
const UNITLESS = new Set(["animationIterationCount", "aspectRatio", "borderImageOutset", "borderImageSlice", "borderImageWidth", "boxFlex", "boxFlexGroup", "boxOrdinalGroup", "columnCount", "columns", "flex", "flexGrow", "flexPositive", "flexShrink", "flexNegative", "flexOrder", "gridArea", "gridRow", "gridRowEnd", "gridRowSpan", "gridRowStart", "gridColumn", "gridColumnEnd", "gridColumnSpan", "gridColumnStart", "fontWeight", "lineClamp", "lineHeight", "opacity", "order", "orphans", "scale", "tabSize", "widows", "zIndex", "zoom", "fillOpacity", "floodOpacity", "stopOpacity", "strokeDasharray", "strokeDashoffset", "strokeMiterlimit", "strokeOpacity", "strokeWidth"]);
const QUERY_HOOKS = /^(useQuery|useSuspenseQuery|useInfiniteQuery|useQueries|useMutation)$/;
const EFFECT_HOOKS = /^(React\.)?(useEffect|useLayoutEffect)$/;

const same = (a, b) => !!a && !!b && a.range().start.index === b.range().start.index && a.range().end.index === b.range().end.index && a.kind() === b.kind();
const kids = (n) => (n ? n.children().filter((c) => c.isNamed()) : []);
const tagName = (attr) => {
  const open = attr.parent();
  return open?.field("name")?.text() ?? "";
};
const span = (n) => [n.range().start.index, n.range().end.index];
const inside = (n, outer) => n.range().start.index >= outer.range().start.index && n.range().end.index <= outer.range().end.index;
// first named child that isn't a comment: a return's value, a paren's inner expression
const arg = (n) => kids(n).find((c) => c.kind() !== "comment");
const unparen = (n) => {
  while (n && n.kind() === "parenthesized_expression") n = arg(n);
  return n;
};
const isJsx = (n) => !!n && ["jsx_element", "jsx_self_closing_element", "jsx_fragment"].includes(n.kind());
const attrName = (attr) => attr.child(0)?.text();
const attrValue = (attr) => {
  const v = attr.children().find((c, i) => i > 0 && c.kind() !== "=");
  if (!v) return null;
  if (v.kind() === "jsx_expression") return kids(v)[0] ?? null;
  return v;
};
const lcfirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const ucfirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function transform(input, { parse, Lang }) {
  // Offsets are per file, so the helpers that read them live in here: a module-level binding
  // that changes can't be copied into a workflow callback once the package is bundled.
  // Edits are { start, end, text } or { start, end, wrap(innerText) }. Nested edits are applied
  // inside the edit that contains them, so a rule can wrap a node and rewrite reads inside it.
  // Node offsets are UTF-16 indexes under @ast-grep/napi but UTF-8 byte offsets in the codemod
  // sandbox. Edits keep the parser's offsets; `ix` turns one into a string index for the source
  // being edited, so files with non-ASCII text splice correctly under both.
  let ix = (i) => i;
  function useOffsetsOf(parse, Lang, text) {
    ix = (i) => i;
    if (/^[\x00-\x7f]*$/.test(text) || parse(Lang.Tsx, '"\u00e9"').root().range().end.index === 3) return;
    const map = [];
    for (let i = 0; i < text.length; i++) {
      const c = text.codePointAt(i);
      const bytes = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
      for (let b = 0; b < bytes; b++) map.push(i);
      if (c >= 0x10000) i++;
    }
    map.push(text.length);
    ix = (i) => map[i];
  }
  const charAt = (text, i) => text[ix(i)];

  function spliceAll(text, base, edits) {
    const items = edits.filter(Boolean).map((e) => ("insertedText" in e ? { start: e.startPos, end: e.endPos, text: e.insertedText } : e));
    items.sort((a, b) => a.start - b.start || (b.end > b.start) - (a.end > a.start) || b.end - a.end);
    const go = (s, e, list) => {
      let out = "";
      let at = s;
      let i = 0;
      while (i < list.length) {
        const it = list[i];
        let j = i + 1;
        const nested = [];
        while (it.end > it.start && j < list.length && list[j].start >= it.start && list[j].end <= it.end) nested.push(list[j++]);
        if (it.start < at) { i = j; continue; }
        out += text.slice(ix(at) - ix(base), ix(it.start) - ix(base));
        out += it.text != null ? it.text : it.wrap(go(it.start, it.end, nested));
        at = it.end;
        i = j;
      }
      return out + (e == null ? text.slice(ix(at) - ix(base)) : text.slice(ix(at) - ix(base), ix(e) - ix(base)));
    };
    return go(base, null, items);
  }
  // remove a statement together with its indentation and line break
  const dropLine = (node, text) => {
    let a = node.range().start.index, b = node.range().end.index;
    // only steps over ASCII whitespace, which is one byte and one index
    const c = (i) => charAt(text, i);
    while (a > 0 && (c(a - 1) === " " || c(a - 1) === "\t")) a--;
    while (c(b) === " " || c(b) === "\t") b++;
    if (c(b) === "\n") b++;
    if (c(b) === "\n" && c(a - 1) === "\n" && c(a - 2) === "\n") b++;
    return { start: a, end: b, text: "" };
  };
  const rep = (node, text) => ({ start: node.range().start.index, end: node.range().end.index, text });
  const wrapRep = (node, wrap) => ({ start: node.range().start.index, end: node.range().end.index, wrap });
  const textWith = (node, edits) => spliceAll(node.text(), node.range().start.index, edits.filter((e) => e && (e.startPos ?? e.start) >= node.range().start.index && (e.endPos ?? e.end) <= node.range().end.index));

  let src = input;
  const flags = [];
  const applied = {};
  const note = (rule, n = 1) => (applied[rule] = (applied[rule] || 0) + n);
  const flag = (kind, node, detail) => flags.push({ kind, line: node ? node.range().start.line + 1 : 0, detail });

  function pass(fn) {
    useOffsetsOf(parse, Lang, src);
    const root = parse(Lang.Tsx, src).root();
    const edits = (fn(root) || []).filter(Boolean);
    if (edits.length) src = spliceAll(src, 0, edits);
    return edits.length;
  }

  // Rewrite reads of `name` inside `scope` to `replacement(text)`; report body-level reads.
  function rewriteReads(scope, declNode, name, toRead, bodyNode, label) {
    const edits = [];
    const real = new Set(readsOf(scope, name, { exclude: [declNode] }).map((id) => id.range().start.index));
    for (const id of scope.findAll({ rule: { any: [{ kind: "identifier", regex: `^${name}$` }, { kind: "shorthand_property_identifier", regex: `^${name}$` }] } })) {
      if (!real.has(id.range().start.index)) continue;
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
      // A hook that returns its signal or memo hands back the accessor, which is what the compiler
      // pass tells its callers (`x()`).
      const owner = bodyNode?.parent();
      if (parent?.kind() === "return_statement" && same(parent.parent(), bodyNode) && /^use[A-Z]/.test(owner?.field("name")?.text() ?? owner?.parent()?.field("name")?.text() ?? "")) continue;
      // deferred if any ancestor below the component body is a function or JSX expression/attribute
      // An effect's deps array becomes its compute function (R41).
      let deferred = false;
      for (let a = id.parent(); a && !same(a, bodyNode); a = a.parent()) {
        if (FN_KINDS.has(a.kind()) || a.kind() === "jsx_expression") { deferred = true; break; }
        if (a.kind() === "array" && a.parent()?.kind() === "arguments" && EFFECT_HOOKS.test(a.parent().parent()?.field("function")?.text() ?? "")) { deferred = true; break; }
      }
      if (!deferred && bodyNode) flag("render-dependent read", id, `${label} '${name}' is read in the component body; it runs once in Solid (needs createMemo/<Show>)`);
      edits.push(id.kind() === "shorthand_property_identifier" ? id.replace(`${name}: ${toRead}`) : id.replace(toRead));
    }
    return edits;
  }

  // Reads of a local name inside `scope` (not its declaration, not shadowed, not type positions).
  function readsOf(scope, name, { exclude = [], skipCallee = false, skipHookArgs = false } = {}) {
    const out = [];
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return out;
    for (const id of scope.findAll({ rule: { any: [{ kind: "identifier", regex: `^${name.replace(/\$/g, "\\$")}$` }, { kind: "shorthand_property_identifier", regex: `^${name.replace(/\$/g, "\\$")}$` }] } })) {
      if (exclude.some((x) => x && inside(id, x))) continue;
      const parent = id.parent();
      const pk = parent?.kind();
      if (pk === "jsx_opening_element" || pk === "jsx_closing_element" || pk === "jsx_self_closing_element") continue;
      if (pk === "catch_clause" || pk === "for_in_statement") continue;
      let tag = parent;
      while (tag && (tag.kind() === "member_expression" || tag.kind() === "nested_identifier")) tag = tag.parent();
      if (tag !== parent && /^jsx_(opening|closing|self_closing)_element$/.test(tag?.kind() ?? "")) out.inTag = true;
      if (pk === "variable_declarator" && same(parent.field("name"), id)) continue;
      if (pk === "required_parameter" || pk === "optional_parameter") continue;
      if (id.ancestors().some((a) => a.kind() === "type_query" || a.kind() === "type_annotation")) continue;
      if (skipCallee && pk === "call_expression" && same(parent.field("function"), id)) continue;
      if (skipHookArgs && pk === "arguments" && /^use[A-Z]/.test(parent.parent()?.field("function")?.text() ?? "")) continue;
      let shadowed = false;
      for (let a = parent; a && a.range().start.index > scope.range().start.index; a = a.parent()) {
        if (a.kind() === "catch_clause" && a.field("parameter")?.text() === name) shadowed = true;
        if (a.kind() === "for_in_statement" && new RegExp(`(^|[^.\\w])${name}\\b`).test(a.field("left")?.text() ?? "")) shadowed = true;
        if (a.kind() === "statement_block" && kids(a).some((st) => st.kind() === "lexical_declaration" && kids(st).some((d) => d.kind() === "variable_declarator" && new RegExp(`(^|[^.:\\w])${name}\\b`).test(d.field("name")?.text() ?? "")))) shadowed = true;
        if (FN_KINDS.has(a.kind())) {
          const params = a.field("parameters") ?? a.field("parameter");
          if (params && new RegExp(`(^|[^.\\w])${name}\\b`).test(params.text())) shadowed = true;
        }
      }
      if (!shadowed) out.push(id);
    }
    return out;
  }
  // reads that will become `name()`; null when one is a JSX tag name, where a call can't go
  const callReads = (scope, name, opts, node) => {
    const reads = readsOf(scope, name, opts);
    if (!reads.inTag) return reads;
    flag("accessor in tag name", node, `<${name}.…> would need <Dynamic component={${name}().…}>; left as a plain value`);
    return null;
  };
  const readAs = (id, text) => rep(id, id.kind() === "shorthand_property_identifier" ? `${id.text()}: ${text}` : text);

  // drop an attribute and the space before it, or its whole line when it has one to itself
  const dropAttr = (a) => {
    const at = a.range().start.index;
    let start = at;
    while (charAt(src, start - 1) === " " || charAt(src, start - 1) === "\t") start--;
    if (charAt(src, start - 1) === "\n") return { start: start - 1, end: a.range().end.index, text: "" };
    return { start: charAt(src, at - 1) === " " ? at - 1 : at, end: a.range().end.index, text: "" };
  };
  // Async components are React Server Components: no component rule touches them (flagged below).
  const componentFns = (root, async = false) =>
    root.findAll({
      rule: {
        ...(async ? { regex: "^async\\b" } : { not: { regex: "^async\\b" } }),
        any: [
          { kind: "function_declaration", has: { field: "name", regex: "^[A-Z]" } },
          { kind: "function_expression", has: { field: "name", regex: "^[A-Z]" } },
          { kind: "arrow_function", inside: { kind: "variable_declarator", has: { field: "name", regex: "^[A-Z]" } } },
          { kind: "function_expression", inside: { kind: "variable_declarator", has: { field: "name", regex: "^[A-Z]" } } },
          { kind: "arrow_function", inside: { kind: "arguments", inside: { kind: "call_expression", has: { field: "function", regex: "^(React\\.)?(memo|forwardRef)$" } } } },
        ],
      },
    });
  // `taken`: names a pass has already chosen, which aren't in src until the pass ends
  const freeName = (base, taken = []) => {
    let n = base;
    for (let i = 2; new RegExp(`\\b${n}\\b`).test(src) || taken.includes(n); i++) n = `${base}${i}`;
    return n;
  };

  // R7 {arr.map((x) => <JSX/>)} -> <For>, keyed the way React keyed it (R22), index reads as accessor
  // calls. Derived values in the callback become accessors in a late pass (R23).
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
      const params = cb.field("parameter") ? [cb.field("parameter")] : kids(cb.field("parameters"));
      const pat = (p) => p?.field?.("pattern") ?? p;
      const itemPat = pat(params[0]);
      const indexPat = pat(params[1]);
      const body = cb.field("body");
      const edits = [];

      // root JSX element of the callback and its key
      let rootEl = unparen(body);
      if (body.kind() === "statement_block") {
        const ret = kids(body).filter((s) => s.kind() === "return_statement").pop();
        rootEl = unparen(arg(ret));
      }
      const opening = rootEl?.kind() === "jsx_element" ? rootEl.child(0) : rootEl?.kind() === "jsx_self_closing_element" ? rootEl : null;
      const keyAttr = opening?.children().find((c) => c.kind() === "jsx_attribute" && attrName(c) === "key");
      const keyExpr = keyAttr ? attrValue(keyAttr) : null;
      const itemNames = !itemPat ? [] : itemPat.kind() === "identifier" ? [itemPat.text()] : itemPat.findAll({ rule: { any: [{ kind: "shorthand_property_identifier_pattern" }, { kind: "identifier" }] } }).map((n) => n.text());
      const indexName = indexPat?.kind() === "identifier" ? indexPat.text() : null;
      const uses = (names) => keyExpr && names.some((n) => keyExpr.find({ rule: { kind: "identifier", regex: `^${n}$` } }) || keyExpr.text() === n);
      let mode = "default";
      if (keyExpr && !(itemPat?.kind() === "identifier" && keyExpr.text() === itemPat.text())) {
        if (indexName && uses([indexName]) && !uses(itemNames)) mode = "index";
        else if (uses(itemNames) && !(indexName && uses([indexName]))) mode = "fn";
        else flag("list key", keyAttr, `key={${keyExpr.text()}} is not the item or the index; <For> keys by reference here`);
      }
      if (keyAttr) edits.push(dropAttr(keyAttr));

      const exclude = [itemPat, indexPat].filter(Boolean);
      // item becomes an accessor when keyed by a function or by index
      let paramText = itemPat?.text();
      if ((mode === "fn" || mode === "index") && itemPat) {
        const tagSafe = itemPat.kind() !== "object_pattern" || kids(itemPat).every((p) => callReads(body, p.text(), { exclude }, keyAttr));
        if (itemPat.kind() === "identifier" && callReads(body, itemPat.text(), { exclude }, keyAttr)) {
          for (const id of readsOf(body, itemPat.text(), { exclude })) edits.push(readAs(id, `${itemPat.text()}()`));
        } else if (tagSafe && itemPat.kind() === "object_pattern" && kids(itemPat).every((p) => p.kind() === "shorthand_property_identifier_pattern")) {
          const item = freeName("item");
          paramText = item;
          edits.push(rep(params[0], item));
          for (const p of kids(itemPat)) for (const id of readsOf(body, p.text(), { exclude })) edits.push(readAs(id, `${item}().${p.text()}`));
        } else {
          if (itemPat.kind() !== "identifier" && tagSafe) flag("list key", keyAttr, "keyed list with a complex item pattern: read the item through its accessor");
          mode = "default";
          edits.length = 0;
          if (keyAttr) edits.push(dropAttr(keyAttr));
        }
      }
      if (indexName && mode !== "index") {
        for (const id of readsOf(body, indexName, { exclude })) edits.push(readAs(id, `${indexName}()`));
        note("list index -> accessor");
      }

      const keyed = mode === "fn" ? ` keyed={(${paramText === itemPat?.text() ? itemPat.text() : itemPat.text()}) => ${keyExpr.text()}}` : mode === "index" ? " keyed={false}" : "";
      note(".map -> <For>");
      if (keyAttr) note(mode === "fn" ? "key -> <For keyed>" : mode === "index" ? "index key -> keyed={false}" : "remove key");
      return [{ start: expr.range().start.index, end: expr.range().end.index, text: `<For each={${arr}}${keyed}>{${textWith(cb, edits)}}</For>` }];
    }),
  );

  // R22 key on an element outside a list remounts it in React; Solid needs a keyed <Show>.
  pass((root) =>
    root.findAll({ rule: { kind: "jsx_attribute", has: { kind: "property_identifier", regex: "^key$" } } }).flatMap((attr) => {
      if (attrName(attr) !== "key") return [];
      const value = attrValue(attr);
      if (!value || value.kind() === "string") return [];
      const open = attr.parent();
      const el = open.kind() === "jsx_opening_element" ? open.parent() : open;
      const inList = el.ancestors().some((a) => (a.kind() === "call_expression" && /\.(map|flatMap)$/.test(a.field("function")?.text() ?? "")) || (a.kind() === "jsx_element" && a.child(0)?.field("name")?.text() === "For"));
      if (inList) return [];
      note("key -> <Show keyed>");
      return [{ start: el.range().start.index, end: el.range().end.index, text: `<Show when={[${value.text()}]} keyed>{(_key) => ${textWith(el, [dropAttr(attr)])}}</Show>` }];
    }),
  );

  // R1 attribute renames (R12: on owned components too), R2 key removal, R13 onChange -> onInput,
  // R14 render={<El/>} -> render function, R16 boolean aria-* -> strings, R17 SVG attribute names
  const hasCn = /\bcn\b/.test(src.split("\n").filter((l) => /^import|function cn|const cn/.test(l)).join("\n"));
  pass((root) =>
    root.findAll({ rule: { kind: "jsx_attribute" } }).flatMap((attr) => {
      const nameNode = attr.child(0);
      const n = nameNode?.text();
      const tag = tagName(attr);
      const intrinsic = /^[a-z]/.test(tag);
      if (n === "key") { note("remove key"); return [dropAttr(attr)]; }
      if (n === "className" && !intrinsic) { note("className -> class (owned component prop)"); return [nameNode.replace("class")]; }
      if (ATTRS[n] && intrinsic) { note(`${n} -> ${ATTRS[n]}`); return [nameNode.replace(ATTRS[n])]; }
      if (ATTRS[n] && !intrinsic) { note(`${n} -> ${ATTRS[n]} (component prop)`); return [nameNode.replace(ATTRS[n])]; }
      if (n === "dangerouslySetInnerHTML") {
        const m = attr.text().match(/^dangerouslySetInnerHTML=\{\{\s*__html:\s*([\s\S]*?)\s*,?\s*\}\}$/);
        if (m) { note("dangerouslySetInnerHTML -> innerHTML"); return [attr.replace(`innerHTML={${m[1]}}`)]; }
      }
      if (intrinsic && SVG_ATTRS.includes(n)) { note("SVG attribute -> kebab-case"); return [nameNode.replace(n.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`))]; }
      if (/^aria-/.test(n ?? "")) {
        const v = attrValue(attr);
        const vText = v?.text();
        if (!v) { note("boolean aria -> string"); return [attr.replace(`${n}="true"`)]; }
        if (vText === "true" || vText === "false") { note("boolean aria -> string"); return [attr.replace(`${n}="${vText}"`)]; }
        const orUndef = v.kind() === "binary_expression" && v.field("operator")?.text() === "||" && v.field("right")?.text() === "undefined" ? v.field("left").text() : null;
        if (orUndef) { note("boolean aria -> string"); return [attr.replace(`${n}={${orUndef} ? "true" : undefined}`)]; }
        const asBool = v.kind() === "call_expression" && v.field("function")?.text() === "Boolean" ? kids(v.field("arguments"))[0]?.text() : v.kind() === "unary_expression" && /^!!/.test(vText) ? vText.slice(2) : null;
        if (asBool) { note("boolean aria -> string"); return [attr.replace(`${n}={${asBool} ? "true" : "false"}`)]; }
        return [];
      }
      if (n === "render") {
        const value = attrValue(attr);
        const el = unparen(value);
        if (!isJsx(el) || el.kind() === "jsx_fragment") return [];
        const elOpen = el.kind() === "jsx_element" ? el.child(0) : el;
        const owner = tag.replace(/^.*\./, "");
        const p = `${lcfirst(owner === "Trigger" || /Trigger$/.test(owner) ? "trigger" : owner)}Props`;
        const elName = elOpen.field("name");
        const at = (i, text) => ({ start: i, end: i, text });
        // point inserts, so renames inside the element (made by this same pass) still apply
        const edits = [at(el.range().start.index, `(${p}) => `), at(elName.range().end.index, ` {...${p}}`)];
        if (value.kind() !== "jsx_expression" && value.parent()?.kind() !== "jsx_expression") {
          edits[0] = at(el.range().start.index, `{(${p}) => `);
          edits.push(at(el.range().end.index, "}"));
        }
        const cls = elOpen.children().find((c) => c.kind() === "jsx_attribute" && ["class", "className"].includes(attrName(c)));
        if (cls && hasCn) {
          const cv = attrValue(cls);
          const str = cv?.kind() === "string";
          if (cv) edits.push(at(cv.range().start.index, `${str ? "{" : ""}cn(${p}.class, `), at(cv.range().end.index, str ? ")}" : ")"));
        }
        if (elOpen.children().some((c) => c.kind() === "jsx_attribute" && /^on[A-Z]/.test(attrName(c) ?? ""))) flag("render handler", el, "an event handler on the render element replaces the part's own handler; chain it");
        note("render={<El/>} -> render function");
        return edits;
      }
      if (n === "onChange") {
        const typeAttr = attr.parent().children().find((c) => c.kind() === "jsx_attribute" && attrName(c) === "type");
        const type = typeAttr ? attrValue(typeAttr)?.text().replace(/^["']|["']$/g, "") : null;
        const handler = unparen(attrValue(attr));
        const evParam = handler && FN_KINDS.has(handler.kind()) ? (handler.field("parameter") ?? kids(handler.field("parameters"))[0]?.field("pattern"))?.text() : null;
        const readsValue = evParam && new RegExp(`\\b${evParam}\\.(current)?[tT]arget\\.(value|checked)`).test(handler.text());
        const textField = (tag === "input" && !NON_TEXT_INPUTS.has(type ?? "")) || tag === "textarea" || (!intrinsic && /(Input|Textarea|TextArea)$/.test(tag) && readsValue && !NON_TEXT_INPUTS.has(type ?? ""));
        if (textField) {
          note("onChange -> onInput (text field)");
          const inner = [];
          if (evParam) for (const m of handler.findAll({ rule: { kind: "member_expression", regex: `^${evParam}\\.target$` } })) inner.push(rep(m, `${evParam}.currentTarget`));
          return [nameNode.replace("onInput"), ...inner.map((e) => e)];
        }
        if (intrinsic && /^(input|textarea)$/.test(tag)) flag("controlled input", attr, "React onChange fires per keystroke; Solid onChange fires on commit. Use onInput (check type=checkbox/radio)");
      }
      return [];
    }),
  );

  // R3 <Ctx.Provider> -> <Ctx>. R36 needs to know which tags were providers.
  const contexts = new Set([
    ...[...src.matchAll(/<([A-Z][\w.]*)\.Provider\b/g)].map((m) => m[1]),
    ...[...src.matchAll(/\b(?:const|let|var)\s+([A-Z]\w*)\s*=\s*(?:React\.)?createContext\b/g)].map((m) => m[1]),
  ]);
  pass((root) =>
    root.findAll({ rule: { any: [{ kind: "jsx_opening_element" }, { kind: "jsx_closing_element" }], has: { field: "name", regex: "\\.Provider$" } } }).map((el) => {
      note("Ctx.Provider -> Ctx");
      const nameNode = el.field("name");
      return nameNode.replace(nameNode.text().replace(/\.Provider$/, ""));
    }),
  );

  // R4 useCallback(fn, deps) -> fn ; React.memo(C)/memo(C) -> C ; R20 useEffectEvent(fn) -> fn
  pass((root) =>
    root.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: "^(React\\.)?(useCallback|memo|useEffectEvent)$" } } }).flatMap((call) => {
      const [fn] = kids(call.field("arguments"));
      if (!fn) return [];
      note(call.field("function").text().replace("React.", ""));
      return [call.replace(fn.text())];
    }),
  );

  // R35 createRoot(el).render(<App />) from react-dom/client -> render(() => <App />, el) from
  // @solidjs/web. A <StrictMode> wrapper is dropped: Solid has no counterpart.
  const createRootImport = /^import\s+\{\s*createRoot\s*\}\s+from\s+["']react-dom\/client["'];?[ \t]*\n/m;
  let renders = 0;
  if (createRootImport.test(src)) {
    renders = pass((root) =>
      root.findAll({ rule: { kind: "call_expression", has: { field: "function", kind: "member_expression", has: { field: "object", kind: "call_expression", has: { field: "function", regex: "^createRoot$" } } } } }).flatMap((call) => {
        const member = call.field("function");
        if (member.field("property")?.text() !== "render") return [];
        const [el] = kids(member.field("object").field("arguments"));
        const [app] = kids(call.field("arguments"));
        if (!el || !app) return [];
        const strict = app.text().match(/^<(?:React\.)?StrictMode>\s*([\s\S]*?)\s*<\/(?:React\.)?StrictMode>$/);
        note("createRoot().render -> render");
        return [call.replace(`render(() => ${strict ? strict[1] : app.text()}, ${el.text()})`)];
      }),
    );
    if (renders && !/\bcreateRoot\b/.test(src.replace(createRootImport, ""))) src = src.replace(createRootImport, "");
  }

  // R37 React APIs with a Solid 2 counterpart, when imported from react: <Suspense> -> <Loading>,
  // lazy -> Solid's lazy, useId() -> createUniqueId(), and a <Fragment> without props -> <>.
  const fromReact = new Set([...input.matchAll(/^import\s+(?:type\s+)?(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*["']react["']/gm)].flatMap((m) => [
    ...(m[1] ? [m[1]] : []),
    ...(m[2] ?? "").split(",").map((part) => part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()).filter(Boolean),
  ]));
  const reactName = (name) => (name.startsWith("React.") ? fromReact.has("React") : fromReact.has(name));
  pass((root) => [
    ...root.findAll({ rule: { any: [{ kind: "jsx_opening_element" }, { kind: "jsx_closing_element" }, { kind: "jsx_self_closing_element" }], has: { field: "name", regex: "^(React\\.)?(Suspense|Fragment)$" } } }).flatMap((el) => {
      const name = el.field("name");
      if (!reactName(name.text())) return [];
      if (/Suspense$/.test(name.text())) {
        if (el.kind() !== "jsx_closing_element") note("Suspense -> Loading");
        return [name.replace("Loading")];
      }
      if (el.kind() === "jsx_self_closing_element") return [];
      const open = el.kind() === "jsx_opening_element" ? el : el.parent()?.children().find((c) => c.kind() === "jsx_opening_element");
      if (open && kids(open).some((c) => c.kind() === "jsx_attribute" || c.kind() === "jsx_expression")) {
        if (el.kind() === "jsx_opening_element") flag("Fragment with props", el, "Solid has no Fragment component; keep the children and move the props (key) elsewhere");
        return [];
      }
      if (el.kind() === "jsx_opening_element") note("Fragment -> <>");
      return [rep(el, el.kind() === "jsx_opening_element" ? "<>" : "</>")];
    }),
    ...root.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: "^(React\\.)?(lazy|useId)$" } } }).flatMap((call) => {
      const fn = call.field("function");
      if (!reactName(fn.text())) return [];
      const lazy = /lazy$/.test(fn.text());
      note(lazy ? "lazy -> lazy" : "useId -> createUniqueId");
      return [fn.replace(lazy ? "lazy" : "createUniqueId")];
    }),
  ]);

  // R42 a class component that is only render() (and optionally static defaultProps) and reads
  // nothing of `this` but this.props -> a function component, this.props -> props, defaultProps ->
  // merge. Its render can only return, after an optional `const { ... } = this.props` (which R8
  // then converts like any destructured props): a value computed above the return would be read
  // once in Solid. Anything else (state, lifecycle or error-boundary methods, instance fields,
  // other uses of `this`) stays a class, flagged by R39.
  pass((root) =>
    root.findAll({ rule: { kind: "class_declaration", has: { kind: "class_heritage" } } }).flatMap((cls) => {
      const heritage = cls.children().find((c) => c.kind() === "class_heritage");
      const base = heritage.text().match(/^extends\s+((?:React\.)?(?:Pure)?Component)\b/)?.[1];
      if (!base || !(base.startsWith("React.") || fromReact.has(base))) return [];
      const name = cls.field("name").text();
      const members = kids(cls.field("body")).filter((m) => m.kind() !== "comment");
      const render = members.find((m) => m.kind() === "method_definition" && m.field("name")?.text() === "render");
      const defaults = members.find((m) => m.kind() === "public_field_definition" && m.field("name")?.text() === "defaultProps" && m.children().some((c) => c.kind() === "static"));
      if (!render || /^(async|get|\*)\b/.test(render.text()) || kids(render.field("parameters")).length) return [];
      if (members.some((m) => !same(m, render) && !same(m, defaults)) || (defaults && defaults.field("value")?.kind() !== "object")) return [];
      // `X.defaultProps = ...` after the class would land on the function and do nothing.
      if (new RegExp(`\\b${name}\\.(defaultProps|contextType)\\b`).test(src)) return [];
      const body = render.field("body");
      const statements = kids(body).filter((s) => s.kind() !== "comment");
      const first = statements[0];
      const destructure = statements.length === 2 && first.kind() === "lexical_declaration" && /^const\b/.test(first.text()) && kids(first).length === 1
        && kids(first)[0].field("name")?.kind() === "object_pattern" && kids(first)[0].field("value")?.text() === "this.props" ? kids(first)[0] : null;
      if (statements.at(-1)?.kind() !== "return_statement" || statements.length !== (destructure ? 2 : 1) || (destructure && defaults)) return [];
      const thisReads = body.findAll({ rule: { kind: "this" } });
      const fnKinds = ["function_expression", "function_declaration", "generator_function", "generator_function_declaration", "method_definition", "class_body"];
      if (!thisReads.every((t) => t.parent()?.kind() === "member_expression" && t.parent().field("property")?.text() === "props" && !t.ancestors().some((a) => inside(a, body) && fnKinds.includes(a.kind())))) return [];
      // this.props becomes `props` (or `merged`), so the body can't have a name of its own like it.
      const holder = defaults ? freeName("merged") : "props";
      if (/(^|[^.\w$])props\b/.test(body.text())) return [];
      const typeArg = kids(heritage.find({ rule: { kind: "type_arguments" } }))[0]?.text();
      const param = `${destructure ? destructure.field("name").text() : "props"}${typeArg ? `: ${typeArg}` : ""}`;
      const edits = [...thisReads.map((t) => rep(t.parent(), holder)), ...(destructure ? [dropLine(first, src)] : [])];
      // The body moves out of the class: one level of indentation less.
      const column = (cls.parent()?.kind() === "export_statement" ? cls.parent() : cls).range().start.column;
      const shift = render.range().start.column - column;
      let text = textWith(body, edits).replace(new RegExp(`\n {${shift}}`, "g"), "\n");
      if (defaults) {
        const indent = " ".repeat(column + 2);
        const rest = text.slice(1);
        // A one-line render body gets a line per statement.
        text = `{\n${indent}const ${holder} = merge(${defaults.field("value").text()} as const, props);${rest.startsWith("\n") ? rest : `\n${indent}${rest.trimStart().replace(/\s*\}$/, `\n${" ".repeat(column)}}`)}`}`;
      }
      note("class component -> function component");
      return [rep(cls, `function ${name}(${param})${render.field("return_type")?.text() ?? ""} ${text}`)];
    }),
  );

  // R38 inline style objects on intrinsic elements: Solid sets each key with style.setProperty, so
  // camelCase keys become CSS names, and a number gets the px React added on its own. A value that
  // may be a number at runtime is flagged.
  pass((root) =>
    root.findAll({ rule: { kind: "jsx_attribute", inside: { any: [{ kind: "jsx_opening_element" }, { kind: "jsx_self_closing_element" }] } } }).flatMap((attr) => {
      if (attrName(attr) !== "style" || !/^[a-z]/.test(tagName(attr))) return [];
      const object = attrValue(attr);
      if (object?.kind() !== "object") return [];
      return kids(object).flatMap((prop) => {
        const shorthand = prop.kind() === "shorthand_property_identifier";
        if (!shorthand && prop.kind() !== "pair") return [];
        const key = shorthand ? prop : prop.field("key");
        const value = shorthand ? prop : prop.field("value");
        if (!key || !value || !["property_identifier", "shorthand_property_identifier", "string"].includes(key.kind())) return [];
        const name = key.kind() === "string" ? key.text().slice(1, -1) : key.text();
        if (name.startsWith("--")) return [];
        const css = name.replace(/^(Webkit|Moz|O|ms)(?=[A-Z])/, (prefix) => `-${prefix.toLowerCase()}`).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
        let text = value.text();
        const unitless = UNITLESS.has(name.replace(/^(Webkit|Moz|O|ms)([A-Z])/, (_, _prefix, c) => c.toLowerCase()));
        if (value.kind() === "number" && !unitless && Number(value.text()) !== 0) text = JSON.stringify(`${value.text()}px`);
        else if (!unitless && !["string", "template_string", "number"].includes(value.kind())) flag("style number", prop, `style "${css}" gets a number as-is in Solid (React added px); make it a string with its unit`);
        if (css === name && text === value.text() && !shorthand) return [];
        note("style keys -> CSS names");
        return [rep(prop, `${JSON.stringify(css)}: ${text}`)];
      });
    }),
  );

  // R20 use(Context) -> useContext(Context); flushSync(() => x) -> x; flush()
  pass((root) => [
    ...root.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: "^(React\\.)?use$" } } }).flatMap((call) => {
      const [arg] = kids(call.field("arguments"));
      if (!arg || !/Context$/.test(arg.text())) return [];
      note("use(Context) -> useContext");
      return [call.field("function").replace("useContext")];
    }),
    ...root.findAll({ rule: { kind: "expression_statement", has: { kind: "call_expression", has: { field: "function", regex: "^(ReactDOM\\.)?flushSync$" } } } }).flatMap((st) => {
      const call = kids(st)[0];
      const [fn] = kids(call?.field("arguments"));
      if (!fn || !["arrow_function", "function_expression"].includes(fn.kind())) return [];
      const body = fn.field("body");
      const inner = body.kind() === "statement_block" ? body.text().slice(1, -1).trim() : `${unparen(body).text()};`;
      note("flushSync -> flush()");
      return [rep(st, `${inner}\n${" ".repeat(st.range().start.column)}flush();`)];
    }),
  ]);

  // R5/R6 useState -> createSignal, useMemo(fn, deps) -> createMemo(fn), plus read rewrites.
  // R19 a function initializer runs once (untrack), and state without a setter is a plain const.
  // R21 useReducer -> createSignal + dispatch.
  const isFunctionBound = (root, name) =>
    !!root.find({ rule: { any: [{ kind: "function_declaration", has: { field: "name", regex: `^${name}$` } }, { kind: "variable_declarator", all: [{ has: { field: "name", regex: `^${name}$` } }, { has: { field: "value", any: [{ kind: "arrow_function" }, { kind: "function_expression" }, { kind: "call_expression", has: { field: "function", regex: "^createMemo$" } }] } }] }] } });
  for (const hook of ["useState", "useMemo", "useReducer"]) {
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
        const args = kids(call.field("arguments"));
        const typeArgs = call.field("type_arguments")?.text() ?? "";
        const edits = [];
        if (hook === "useState") {
          const pattern = decl.field("name");
          const [getter, setter] = kids(pattern);
          if (pattern.kind() !== "array_pattern" || !getter) { flag("useState shape", decl, "non-tuple useState"); return [decl.replace(decl.text().replace(/useState/, "createSignal"))]; }
          const init = args[0];
          const isFn = init && (["arrow_function", "function_expression"].includes(init.kind()) || (init.kind() === "identifier" && isFunctionBound(root, init.text())));
          const initText = init ? (isFn ? `untrack(${init.text()})` : init.text()) : "";
          if (isFn) note("useState(fn) -> untrack(fn)");
          if (!setter) {
            note("useState without setter -> const");
            return [decl.replace(`${getter.text()} = ${initText || "undefined"}`)];
          }
          note("useState -> createSignal");
          edits.push(call.replace(`createSignal${typeArgs}(${[initText, ...args.slice(1).map((a) => a.text())].filter(Boolean).join(", ")})`));
          edits.push(...rewriteReads(body, decl, getter.text(), `${getter.text()}()`, body, "state"));
        } else if (hook === "useReducer") {
          const pattern = decl.field("name");
          const [state, dispatch] = kids(pattern);
          if (pattern.kind() !== "array_pattern" || !state || state.kind() !== "identifier" || args.length < 2) { flag("useReducer shape", decl, "rewrite by hand"); return [call.field("function").replace("useReducer_TODO")]; }
          const [reducer, initArg, init] = args;
          const setter = freeName(dispatch?.text() === `set${ucfirst(state.text())}` ? `set${ucfirst(state.text())}State` : `set${ucfirst(state.text())}`);
          const plain = !init && !/[\w)\]]\(|\bprops\.|\bmerged\./.test(initArg.text());
          const initFn = init && !/^(identifier|member_expression)$/.test(init.kind()) ? `(${init.text()})` : init?.text();
          const start = init ? `untrack(() => ${initFn}(${initArg.text()}))` : plain ? initArg.text() : `untrack(() => (${initArg.text()}))`;
          const statement = decl.parent();
          const indent = " ".repeat(statement.range().start.column);
          const lines = [`const [${state.text()}, ${setter}] = createSignal<Parameters<typeof ${reducer.text()}>[0]>(${start});`];
          if (dispatch) lines.push(`const ${dispatch.text()} = (action: Parameters<typeof ${reducer.text()}>[1]) => ${setter}((previous) => ${reducer.text()}(previous, action));`);
          note("useReducer -> createSignal + dispatch");
          edits.push(rep(statement, lines.join(`\n${indent}`)));
          edits.push(...rewriteReads(body, statement, state.text(), `${state.text()}()`, body, "state").map((e) => ({ start: e.startPos, end: e.endPos, text: e.insertedText })));
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
        return edits;
      });
    }
  }

  // R27 useRef used only as `x.current` and `ref={x}` -> a plain `let` and a ref callback.
  pass((root) =>
    root.findAll({ rule: { kind: "variable_declarator", has: { field: "value", kind: "call_expression", has: { field: "function", regex: "^(React\\.)?useRef$" } } } }).flatMap((decl) => {
      const name = decl.field("name");
      const statement = decl.parent();
      const body = statement?.parent();
      if (name?.kind() !== "identifier" || statement?.kind() !== "lexical_declaration" || kids(statement).length !== 1 || body?.kind() !== "statement_block") return [];
      const call = decl.field("value");
      const typeArg = kids(call.field("type_arguments"))[0]?.text();
      const [init] = kids(call.field("arguments"));
      const edits = [];
      for (const id of readsOf(body, name.text(), { exclude: [decl] })) {
        const p = id.parent();
        if (p.kind() === "member_expression" && p.field("property")?.text() === "current") {
          // a write during render (not inside a function or JSX) is render state, not a ref
          if (p.parent()?.kind() === "assignment_expression" && !p.ancestors().some((a) => inside(a, body) && !same(a, body) && (FN_KINDS.has(a.kind()) || a.kind() === "jsx_expression"))) return [];
          edits.push(rep(p, name.text()));
        } else if (p.kind() === "jsx_expression" && p.parent()?.kind() === "jsx_attribute" && attrName(p.parent()) === "ref") {
          edits.push(rep(p, `{(element) => (${name.text()} = element)}`));
        } else return []; // passed on as a value: keep the ref object
      }
      const initText = init?.text();
      const type = typeArg ? (initText === "null" ? `${typeArg} | null` : initText ? typeArg : `${typeArg} | undefined`) : null;
      note("useRef -> let");
      return [rep(statement, `let ${name.text()}${type ? `: ${type}` : ""}${initText ? ` = ${initText}` : ""};`), ...edits];
    }),
  );

  // R8 props destructuring -> props / merge / omit (R26: function expressions and renamed props;
  // R15: literal defaults keep their literal types)
  pass((root) => {
    const edits = [];
    for (const fn of componentFns(root)) {
      const params = fn.field("parameters");
      const first = kids(params)[0];
      const pat = first?.field?.("pattern") ?? first;
      if (!pat || pat.kind() !== "object_pattern") continue;
      const typeAnn = first.field("type")?.text() ?? "";
      const body = fn.field("body");
      if (!body || body.kind() !== "statement_block") { flag("expression-bodied component", fn, "add a block body first"); continue; }
      const names = [], defaults = [];
      let rest = null;
      let complex = false;
      for (const p of kids(pat)) {
        if (p.kind() === "shorthand_property_identifier_pattern") names.push([p.text(), p.text()]);
        else if (p.kind() === "object_assignment_pattern") { const k = p.field("left").text(); names.push([k, k]); defaults.push(`${k === "className" ? "class" : k}: ${p.field("right").text()}`); }
        else if (p.kind() === "pair_pattern" && p.field("value")?.kind() === "identifier") { names.push([p.field("value").text(), p.field("key").text()]); note("renamed prop"); }
        else if (p.kind() === "pair_pattern" && p.field("value")?.kind() === "assignment_pattern" && p.field("value").field("left")?.kind() === "identifier") {
          const k = p.field("key").text();
          names.push([p.field("value").field("left").text(), k]);
          defaults.push(`${k === "className" ? "class" : k}: ${p.field("value").field("right").text()}`);
          note("renamed prop");
        }
        else if (p.kind() === "rest_pattern" && /^\.\.\.\s*[\w$]+$/.test(p.text())) rest = p.text().replace(/^\.\.\./, "").trim();
        else { flag("complex props pattern", p, p.text()); complex = true; }
      }
      if (complex) continue;
      const propsVar = defaults.length ? "merged" : "props";
      const restVar = rest === "props" ? "others" : rest;
      const pre = [];
      if (defaults.length) pre.push(`const merged = merge({ ${defaults.join(", ")} } as const, props);`);
      const key = (n) => (n === "className" ? "class" : n);
      if (rest) pre.push(`const ${restVar} = omit(${propsVar}, ${names.map(([, k]) => JSON.stringify(key(k))).join(", ")});`);
      edits.push(first.replace(`props${typeAnn}`));
      if (pre.length) edits.push(body.child(0).replace(`{\n  ${pre.join("\n  ")}`));
      for (const [local, k] of names) edits.push(...rewriteReads(body, null, local, `${propsVar}.${key(k)}`, body, "prop"));
      if (rest && rest !== restVar) edits.push(...rewriteReads(body, null, rest, restVar, null, "rest"));
      note("destructured props -> props/merge/omit");
    }
    return edits;
  });

  // R12 DOM prop names on the props side: prop types, props reads and omit/merge keys follow the
  // attribute renames above, so a component and its callers agree.
  pass((root) => {
    const edits = [];
    const propsTypes = root.findAll({ rule: { any: [{ kind: "interface_declaration", has: { field: "name", regex: "Props$" } }, { kind: "type_alias_declaration", has: { field: "name", regex: "Props$" } }] } });
    for (const fn of componentFns(root)) {
      const first = kids(fn.field("parameters"))[0];
      if (first?.field?.("type")) propsTypes.push(first.field("type"));
    }
    const seen = new Set();
    for (const t of propsTypes) {
      for (const ps of t.findAll({ rule: { kind: "property_signature" } })) {
        const nm = ps.field("name");
        if (!nm || !ATTRS[nm.text()] || seen.has(nm.range().start.index)) continue;
        seen.add(nm.range().start.index);
        note("prop type name -> Solid name");
        edits.push(nm.replace(ATTRS[nm.text()]));
      }
    }
    for (const fn of componentFns(root)) {
      const body = fn.field("body");
      if (!body) continue;
      const holders = new Set(["props"]);
      for (const d of body.findAll({ rule: { kind: "variable_declarator", has: { field: "value", kind: "call_expression", has: { field: "function", regex: "^(merge|omit|splitProps|mergeProps)$" } } } })) if (d.field("name")?.kind() === "identifier") holders.add(d.field("name").text());
      for (const m of body.findAll({ rule: { kind: "member_expression" } })) {
        const obj = m.field("object");
        const prop = m.field("property");
        if (obj?.kind() === "identifier" && holders.has(obj.text()) && prop && ATTRS[prop.text()] && !seen.has(prop.range().start.index)) {
          seen.add(prop.range().start.index);
          note("props read -> Solid name");
          edits.push(prop.replace(ATTRS[prop.text()]));
        }
      }
      for (const c of body.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: "^(omit|splitProps)$" } } })) {
        for (const s of c.field("arguments").findAll({ rule: { kind: "string" } })) {
          const v = s.text().slice(1, -1);
          if (ATTRS[v] && !seen.has(s.range().start.index)) { seen.add(s.range().start.index); edits.push(s.replace(JSON.stringify(ATTRS[v]))); note("omit key -> Solid name"); }
        }
      }
    }
    return edits;
  });

  // R24 a destructured hook result reads every field once; keep the object and read fields lazily.
  pass((root) => {
    const edits = [];
    const named = [];
    for (const decl of root.findAll({ rule: { kind: "variable_declarator", all: [{ has: { field: "name", kind: "object_pattern" } }, { has: { field: "value", kind: "call_expression", has: { field: "function", regex: "^use[A-Z]\\w*$" } } }] } })) {
      const call = decl.field("value");
      const callee = call.field("function").text();
      if (/^use(State|Reducer|Ref|Memo|Callback|Id|Transition|DeferredValue|Effect|LayoutEffect)$/.test(callee)) continue;
      const statement = decl.parent();
      const scope = statement?.parent();
      if (statement?.kind() !== "lexical_declaration" || kids(statement).length !== 1 || !scope || scope.kind() !== "statement_block") continue;
      const fields = [];
      let ok = true;
      for (const p of kids(decl.field("name"))) {
        if (p.kind() === "shorthand_property_identifier_pattern") fields.push([p.text(), p.text()]);
        else if (p.kind() === "pair_pattern" && p.field("value")?.kind() === "identifier") fields.push([p.field("value").text(), p.field("key").text()]);
        else ok = false;
      }
      if (!ok) { flag("destructured hook result", decl, `${callee}() result has defaults or rest; keep the object and read fields lazily`); continue; }
      const ctxArg = callee === "useContext" ? kids(call.field("arguments"))[0]?.text() : null;
      const obj = freeName(lcfirst(ctxArg ? ctxArg.replace(/Context$/, "") : callee.replace(/^use/, "")) || "value", named);
      named.push(obj);
      edits.push(rep(decl.field("name"), obj));
      for (const [local, k] of fields) for (const id of readsOf(scope, local, { exclude: [statement] })) edits.push(readAs(id, `${obj}.${k}`));
      note("destructured hook result -> object reads");
    }
    return edits;
  });

  // R25 the compiler pass says a library hook hands back an accessor ("read it as `x()`"): do that.
  pass((root) => {
    const edits = [];
    for (const c of root.findAll({ rule: { kind: "comment", regex: "^// solid:" } })) {
      const stmt = c.next();
      if (!stmt || stmt.kind() !== "lexical_declaration") continue;
      const scope = stmt.parent();
      // A function the compiler bailed on was decided from the AST, which the note says after the read.
      for (const m of c.text().matchAll(/(\w+): accessor \((\w+) hands back an accessor: read it as `\1\(\)`(?: \(AST fallback: no compiler output\))?\)/g)) {
        if (/^use(State|Reducer|Memo)$/.test(m[2])) continue;
        const reads = callReads(scope, m[1], { exclude: [stmt], skipCallee: true, skipHookArgs: true }, stmt);
        if (!reads) continue;
        for (const id of reads) edits.push(readAs(id, `${m[1]}()`));
        if (reads.length) note("hook accessor reads -> calls", reads.length);
      }
    }
    return edits;
  });

  // R28 TanStack Query for Solid takes its options as a function, so they stay reactive.
  if (/from ["']@tanstack\/(react|solid)-query["']/.test(src)) {
    pass((root) =>
      root.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: QUERY_HOOKS.source } } }).flatMap((call) => {
        const [arg] = kids(call.field("arguments"));
        if (!arg || ["arrow_function", "function_expression"].includes(arg.kind())) return [];
        note("query options -> accessor");
        return [rep(arg, arg.kind() === "object" ? `() => (${arg.text()})` : `() => ${arg.text()}`)];
      }),
    );
  }

  // R11 early returns in a component -> <Show> (one) or <Switch>/<Match> (several). The body runs
  // once in Solid, so a guard that returns early would never re-check its condition.
  const negate = (node) => {
    const n = unparen(node);
    const k = n.kind();
    if (k === "unary_expression" && n.field("operator")?.text() === "!") return unparen(n.field("argument")).text();
    if (k === "binary_expression") {
      const op = n.field("operator")?.text();
      const flip = { "===": "!==", "!==": "===", "==": "!=", "!=": "==" }[op];
      if (flip) return `${n.field("left").text()} ${flip} ${n.field("right").text()}`;
      if (op === "||") {
        const atomic = (x) => { const u = unparen(x); return (u.kind() === "unary_expression" && u.field("operator")?.text() === "!") || (u.kind() === "binary_expression" && /^[!=]==?$/.test(u.field("operator")?.text())) || ["identifier", "member_expression", "call_expression"].includes(u.kind()); };
        if (atomic(n.field("left")) && atomic(n.field("right"))) return `${negate(n.field("left"))} && ${negate(n.field("right"))}`;
      }
    }
    return ["identifier", "member_expression", "call_expression", "subscript_expression"].includes(k) ? `!${n.text()}` : `!(${n.text()})`;
  };
  const asChild = (n) => (n == null ? null : isJsx(unparen(n)) ? unparen(n).text() : `{${unparen(n).text()}}`);
  const asProp = (n) => `{${unparen(n).text()}}`;
  const isNullish = (n) => !n || ["null", "undefined"].includes(unparen(n).text());
  const lazySafe = (s) => {
    if (["comment", "function_declaration", "empty_statement"].includes(s.kind())) return true;
    if (s.kind() !== "lexical_declaration") return false;
    return kids(s).filter((d) => d.kind() === "variable_declarator").every((d) => {
      const v = d.field("value");
      if (!v || d.field("name")?.kind() !== "identifier") return !v;
      return ["arrow_function", "function_expression", "string", "number", "true", "false", "null", "undefined", "template_string"].includes(v.kind()) || (v.kind() === "call_expression" && /^(createMemo|merge|omit)$/.test(v.field("function")?.text()));
    });
  };
  pass((root) => {
    const edits = [];
    for (const fn of componentFns(root)) {
      const body = fn.field("body");
      if (body?.kind() !== "statement_block") continue;
      const stmts = kids(body).filter((s) => s.kind() !== "comment");
      let last = stmts[stmts.length - 1];
      if (!last) continue;
      const guards = [];
      const guardOf = (s) => {
        if (s.kind() !== "if_statement") return null;
        const ret = (n) => {
          if (!n) return null;
          if (n.kind() === "return_statement") return n;
          if (n.kind() === "statement_block") { const k = kids(n).filter((x) => x.kind() !== "comment"); return k.length === 1 && k[0].kind() === "return_statement" ? k[0] : null; }
          if (n.kind() === "else_clause") return ret(kids(n)[0]);
          return null;
        };
        const cons = ret(s.field("consequence"));
        if (!cons) return null;
        const alt = s.field("alternative");
        if (alt && !ret(alt)) return null;
        return { node: s, cond: unparen(s.field("condition")), value: arg(cons) ?? null, alt: alt ? arg(ret(alt)) ?? null : undefined };
      };
      let final;
      if (last.kind() === "return_statement") final = arg(last) ?? null;
      else {
        const g = guardOf(last);
        if (!g || g.alt === undefined) continue;
        final = g.alt;
      }
      let unsafe = null;
      for (const s of stmts) {
        if (s === last) break;
        const g = guardOf(s);
        if (g && g.alt === undefined) { guards.push(g); continue; }
        if (!guards.length) {
          if (s.findAll({ rule: { kind: "return_statement" } }).some((r) => !r.ancestors().some((a) => FN_KINDS.has(a.kind()) && inside(a, body) && !same(a, fn)))) { unsafe = s; break; }
          continue;
        }
        if (!lazySafe(s)) { unsafe = s; break; }
      }
      if (last.kind() === "if_statement") guards.push(guardOf(last));
      if (!guards.length) continue;
      if (unsafe) { flag("early return", guards[0]?.node ?? unsafe, "statements between an early return and the final return run eagerly in Solid; convert to <Show> by hand"); continue; }
      const indent = " ".repeat(last.range().start.column);
      let jsx;
      if (guards.length === 1) {
        const g = guards[0];
        if (isNullish(final)) {
          jsx = `<Show when={${g.cond.text()}}>${asChild(g.value) ?? ""}</Show>`;
        } else {
          const when = negate(g.cond);
          const whenNode = (() => { try { return parse(Lang.Tsx, `(${when})`).root().find({ rule: { kind: "parenthesized_expression" } }); } catch { return null; } })();
          const w = unparen(whenNode);
          let child = asChild(final);
          // narrow a single nullable value through Show's callback, as TypeScript did after the guard
          const simple = w && (["identifier", "member_expression"].includes(w.kind()) || (w.kind() === "call_expression" && kids(w.field("arguments")).length === 0)) && !/[?(]\./.test(w.text().replace(/\(\)$/, ""));
          if (simple) {
            const finalNode = unparen(final);
            const hits = finalNode.findAll({ rule: { kind: w.kind() } }).filter((x) => x.text() === w.text() && !(x.parent()?.kind() === "call_expression" && same(x.parent().field("function"), x)));
            const inTag = hits.some((h) => {
              let t = h.parent();
              while (t && (t.kind() === "member_expression" || t.kind() === "nested_identifier")) t = t.parent();
              return t !== h.parent() && /^jsx_(opening|closing|self_closing)_element$/.test(t?.kind() ?? "");
            });
            if (hits.length && !inTag) {
              const base = w.text().replace(/\(\)$/, "").split(".").pop();
              const clash = finalNode.findAll({ rule: { kind: "identifier", regex: `^${base}$` } }).some((x) => !hits.some((h) => inside(x, h)));
              const param = clash ? `${base}Value` : base;
              const inner = textWith(finalNode, hits.map((h) => rep(h, `${param}()`)));
              child = `{(${param}) => ${isJsx(finalNode) ? inner : `(${inner})`}}`;
            }
          }
          jsx = `<Show when={${when}}${isNullish(g.value) ? "" : ` fallback=${asProp(g.value)}`}>${child}</Show>`;
        }
        note("early return -> <Show>");
      } else {
        const matches = guards.map((g) => `<Match when={${g.cond.text()}}>${asChild(g.value) ?? "{null}"}</Match>`);
        jsx = `<Switch${isNullish(final) ? "" : ` fallback=${asProp(final)}`}>\n${indent}    ${matches.join(`\n${indent}    `)}\n${indent}  </Switch>`;
        note("early returns -> <Switch>/<Match>");
      }
      for (const g of guards) if (g.node !== last) edits.push(dropLine(g.node, src));
      edits.push(rep(last, `return (\n${indent}  ${jsx}\n${indent});`));
    }
    return edits;
  });

  // R29 `let x; if (c) { x = A } else { x = B }` in a component -> const x = <Show> (branch
  // consts become accessors so they only run when their branch shows).
  pass((root) => {
    const edits = [];
    for (const fn of componentFns(root)) {
      const body = fn.field("body");
      if (body?.kind() !== "statement_block") continue;
      const stmts = kids(body).filter((s) => s.kind() !== "comment");
      for (let i = 0; i < stmts.length - 1; i++) {
        const decl = stmts[i];
        const ifs = stmts[i + 1];
        if (decl.kind() !== "lexical_declaration" || !/^let\b/.test(decl.text()) || ifs.kind() !== "if_statement") continue;
        const ds = kids(decl).filter((d) => d.kind() === "variable_declarator");
        if (ds.length !== 1 || ds[0].field("value") || ds[0].field("name")?.kind() !== "identifier") continue;
        const x = ds[0].field("name").text();
        const branch = (n) => {
          const block = n?.kind() === "else_clause" ? kids(n)[0] : n;
          if (block?.kind() !== "statement_block") return null;
          const k = kids(block).filter((s) => s.kind() !== "comment");
          const assign = k.pop();
          const a = assign?.kind() === "expression_statement" ? kids(assign)[0] : null;
          if (a?.kind() !== "assignment_expression" || a.field("left")?.text() !== x) return null;
          if (!k.every((s) => s.kind() === "lexical_declaration" && kids(s).every((d) => d.kind() !== "variable_declarator" || d.field("name")?.kind() === "identifier"))) return "destructure";
          return { block, consts: k, value: a.field("right") };
        };
        const a = branch(ifs.field("consequence"));
        const b = branch(ifs.field("alternative"));
        if (!a || !b) continue;
        if (a === "destructure" || b === "destructure") { flag("reassigned let", decl, `${x} is chosen by if/else with destructuring in a branch; convert to <Show> by hand`); continue; }
        const hoisted = [];
        const inner = { a: [], b: [] };
        for (const [side, br] of [["a", a], ["b", b]]) {
          for (const s of br.consts) for (const d of kids(s).filter((v) => v.kind() === "variable_declarator")) {
            const nm = d.field("name").text();
            const reads = readsOf(br.block, nm, { exclude: [d.field("name")] });
            hoisted.push(`const ${nm} = () => (${textWith(d.field("value"), inner[side])});`);
            for (const r of reads) inner[side].push(readAs(r, `${nm}()`));
          }
        }
        const indent = " ".repeat(decl.range().start.column);
        const av = textWith(unparen(a.value), inner.a);
        const bv = textWith(unparen(b.value), inner.b);
        const child = isJsx(unparen(a.value)) ? av : `{${av}}`;
        edits.push(rep(decl, [...hoisted, `const ${x} = (\n${indent}  <Show when={${unparen(ifs.field("condition")).text()}} fallback={${bv}}>\n${indent}    ${child}\n${indent}  </Show>\n${indent});`].join(`\n${indent}`)));
        edits.push(dropLine(ifs, src));
        note("reassigned let -> <Show>");
      }
    }
    return edits;
  });

  // R32 Base UI's useRender reads its params once in Solid: pass props/render as getters and
  // return the element accessor. The default props object takes Solid's `class`.
  pass((root) => {
    const edits = [];
    for (const ret of root.findAll({ rule: { kind: "return_statement", has: { kind: "call_expression", has: { field: "function", regex: "^useRender$" } } } })) {
      const call = arg(ret);
      if (call?.kind() !== "call_expression") continue;
      const obj = kids(call.field("arguments"))[0];
      if (obj?.kind() !== "object") continue;
      const fn = ret.ancestors().find((a) => FN_KINDS.has(a.kind()));
      const fnBody = fn?.field("body");
      if (!fnBody) continue;
      const ind = " ".repeat(ret.range().start.column);
      const pairEdits = [];
      for (const pair of kids(obj).filter((p) => p.kind() === "pair")) {
        const k = pair.field("key")?.text();
        const v = pair.field("value");
        if (!["props", "render"].includes(k) || !v || FN_KINDS.has(v.kind())) continue;
        pairEdits.push(wrapRep(pair, () => `get ${k}() {\n${ind}    return ${textWith(v, renames(v))};\n${ind}  }`));
      }
      // className -> class on the default props handed to mergeProps
      function renames(scope) {
        const out = [];
        for (const mp of scope.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: "^mergeProps$" } } })) {
          const first = kids(mp.field("arguments"))[0];
          let target = first?.kind() === "object" ? first : null;
          if (first?.kind() === "call_expression" && !kids(first.field("arguments")).length) {
            const d = fnBody.find({ rule: { kind: "variable_declarator", has: { field: "name", regex: `^${first.field("function").text()}$` } } });
            const memo = d?.field("value");
            if (memo?.kind() === "call_expression" && memo.field("function")?.text() === "createMemo") {
              const body = kids(memo.field("arguments"))[0]?.field("body");
              const o = unparen(body);
              if (o?.kind() === "object") for (const p of kids(o)) if (p.kind() === "pair" && p.field("key")?.text() === "className") edits.push(rep(p.field("key"), "class"));
            }
          }
          if (target) for (const p of kids(target)) if (p.kind() === "pair" && p.field("key")?.text() === "className") out.push(rep(p.field("key"), "class"));
        }
        return out;
      }
      edits.push(rep(ret, `const element = ${textWith(call, pairEdits)};\n${ind}return element();`));
      note("useRender -> getters + element()");
    }
    return edits;
  });

  // R33 the compiler pass marked a component value as memo/accessor but left it as a value:
  // apply the decision.
  pass((root) => {
    const edits = [];
    for (const fn of componentFns(root)) {
      const body = fn.field("body");
      if (body?.kind() !== "statement_block") continue;
      for (const c of kids(body).filter((x) => x.kind() === "comment" && /^\/\/ solid:/.test(x.text()))) {
        const st = c.next();
        if (st?.kind() !== "lexical_declaration" || !/^const\b/.test(st.text())) continue;
        const ds = kids(st).filter((d) => d.kind() === "variable_declarator");
        if (ds.length !== 1 || ds[0].field("name")?.kind() !== "identifier") continue;
        const name = ds[0].field("name").text();
        const m = c.text().match(new RegExp(`\\b${name}: (memo|accessor) \\(`));
        const v = ds[0].field("value");
        if (!m || !v || FN_KINDS.has(v.kind()) || /^(createMemo|createSignal|use[A-Z])/.test(v.text())) continue;
        if (!callReads(body, name, { exclude: [ds[0].field("name")] }, st)) continue;
        edits.push(wrapRep(v, (t) => (m[1] === "memo" ? `createMemo(() => ${v.kind() === "object" ? `(${t})` : t})` : `() => (${t})`)));
        for (const id of readsOf(body, name, { exclude: [ds[0].field("name")] })) edits.push(readAs(id, `${name}()`));
        note("compiler decision applied");
      }
    }
    return edits;
  });

  // R34 a DOM event has no nativeEvent: the event is the native event.
  pass((root) =>
    root.findAll({ rule: { kind: "member_expression", has: { field: "property", regex: "^nativeEvent$" } } }).flatMap((m) => {
      const obj = m.field("object");
      if (obj?.kind() !== "identifier") return [];
      const fn = m.ancestors().find((a) => FN_KINDS.has(a.kind()));
      const params = fn && (fn.field("parameters") ?? fn.field("parameter"));
      if (!params || !new RegExp(`\\b${obj.text()}\\b`).test(params.text())) return [];
      note("event.nativeEvent -> event");
      return [rep(m, obj.text())];
    }),
  );

  // R23 values derived in a <For> callback re-run per render in React; the callback runs once per
  // row here, so anything that reads reactive state becomes an accessor. A value read twice in
  // another one is read once into a local, so TypeScript can still narrow it.
  // Runs late: tree-sitter misreads some accessor calls (`override()`), so later passes would stumble.
  pass((root) => {
    const edits = [];
    for (const forEl of root.findAll({ rule: { kind: "jsx_element", has: { field: "open_tag", has: { field: "name", regex: "^For$" } } } })) {
      const cbExpr = forEl.children().find((c) => c.kind() === "jsx_expression");
      const cb = kids(cbExpr)[0];
      if (!cb || !FN_KINDS.has(cb.kind())) continue;
      const body = cb.field("body");
      if (body?.kind() !== "statement_block") continue;
      const derived = new Map(); // name -> declarator
      for (const st of kids(body)) {
        if (st.kind() !== "lexical_declaration" || !/^const\b/.test(st.text())) continue;
        for (const d of kids(st).filter((c) => c.kind() === "variable_declarator")) {
          const name = d.field("name");
          const init = d.field("value");
          if (!name || !init || name.kind() !== "identifier" || d.field("type")) continue;
          if (FN_KINDS.has(init.kind()) || isJsx(unparen(init))) continue;
          const reactive = /[\w)\]]\(|\bprops\.|\bmerged\./.test(init.text()) || [...derived.keys()].some((n) => new RegExp(`\\b${n}\\b`).test(init.text()));
          if (reactive) derived.set(name.text(), d);
        }
      }
      if (!derived.size) continue;
      if ([...derived].some(([n, d]) => !callReads(body, n, { exclude: [d.field("name")] }, d))) continue;
      const aliases = new Map(); // declarator start -> names read twice or more inside it
      for (const [, d] of derived) {
        const init = d.field("value");
        const twice = [...derived.keys()].filter((n) => readsOf(init, n).length > 1);
        aliases.set(d.range().start.index, twice);
      }
      const ownerOf = (id) => [...derived.values()].find((d) => inside(id, d.field("value")));
      for (const [n, d] of derived) {
        for (const id of readsOf(body, n, { exclude: [d.field("name")] })) {
          const owner = ownerOf(id);
          edits.push(readAs(id, owner && aliases.get(owner.range().start.index).includes(n) ? `${n}Value` : `${n}()`));
        }
        const twice = aliases.get(d.range().start.index);
        const ind = " ".repeat(d.parent().range().start.column);
        edits.push(wrapRep(d.field("value"), (t) => (twice.length ? `() => {\n${twice.map((a) => `${ind}  const ${a}Value = ${a}();\n`).join("")}${ind}  return ${t};\n${ind}}` : `() => (${t})`)));
      }
      note("list callback values -> accessors", derived.size);
    }
    return edits;
  });

  // R30 `{x() && <El a={x().b} />}` can't narrow x() in TypeScript; <Show> hands the narrowed value in.
  pass((root) =>
    root.findAll({ rule: { kind: "jsx_expression", inside: { kind: "jsx_element" } } }).flatMap((ex) => {
      if (ex.parent()?.kind() !== "jsx_element") return [];
      const e = kids(ex)[0];
      if (!e) return [];
      let cond, jsx;
      if (e.kind() === "binary_expression" && e.field("operator")?.text() === "&&") { cond = e.field("left"); jsx = unparen(e.field("right")); }
      else if (e.kind() === "ternary_expression" && isNullish(e.field("alternative"))) { cond = e.field("condition"); jsx = unparen(e.field("consequence")); }
      else return [];
      if (!isJsx(jsx) || cond.kind() !== "call_expression" || cond.field("function")?.kind() !== "identifier" || kids(cond.field("arguments")).length) return [];
      const n = cond.field("function").text();
      const calls = jsx.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: `^${n}$` } } }).filter((c) => !kids(c.field("arguments")).length);
      if (!calls.some((c) => c.parent()?.kind() === "member_expression")) return [];
      note("guarded accessor -> <Show> callback");
      return [rep(ex, `<Show when={${n}()}>{(${n}) => ${jsx.text()}}</Show>`)];
    }),
  );

  // R31 the compiler pass keeps a value's type on a const it turned into an accessor or memo;
  // the type belongs on what the function returns.
  pass((root) =>
    root.findAll({ rule: { kind: "variable_declarator", has: { field: "type", kind: "type_annotation" } } }).flatMap((d) => {
      const ann = d.field("type");
      const type = kids(ann)[0];
      const v = d.field("value");
      if (!type || !v || /^(Accessor|Memo)\b|=>/.test(type.text())) return [];
      if (v.kind() === "arrow_function" && !v.field("return_type") && v.field("parameters") && !kids(v.field("parameters")).length) {
        note("typed accessor -> return type");
        return [rep(ann, ""), { start: v.field("parameters").range().end.index, end: v.field("parameters").range().end.index, text: `: ${type.text()}` }];
      }
      if (v.kind() === "call_expression" && v.field("function")?.text() === "createMemo" && !v.field("type_arguments")) {
        note("typed memo -> createMemo<T>");
        return [rep(ann, ""), { start: v.field("function").range().end.index, end: v.field("function").range().end.index, text: `<${type.text()}>` }];
      }
      return [];
    }),
  );

  // R36 a context provider's inline value object is read once in Solid: a property that reads
  // reactive values (a call, or props) becomes a getter, so consumers see it change.
  if (contexts.size) {
    pass((root) =>
      root.findAll({ rule: { kind: "jsx_attribute", inside: { any: [{ kind: "jsx_opening_element" }, { kind: "jsx_self_closing_element" }] } } }).flatMap((attr) => {
        if (attrName(attr) !== "value" || !contexts.has(tagName(attr))) return [];
        const object = attrValue(attr);
        if (object?.kind() !== "object") return [];
        return kids(object).flatMap((pair) => {
          if (pair.kind() !== "pair") return [];
          const key = pair.field("key");
          const value = pair.field("value");
          if (!key || !value || key.kind() === "computed_property_name" || ["arrow_function", "function_expression", "function"].includes(value.kind())) return [];
          if (!/[\w)\]]\(|\bprops\./.test(value.text())) return [];
          note("provider value -> getters");
          return [rep(pair, `get ${key.text()}() { return ${value.text()}; }`)];
        });
      }),
    );
  }

  // R9 types and React namespace members; R18 the rest of React's type vocabulary
  const reactImports = new Set([...src.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']react["']/gm)].flatMap((m) => m[1].split(",").map((s) => s.replace(/^\s*type\s+/, "").trim().split(/\s+as\s+/).pop())));
  const isReactType = (name) => name.startsWith("React.") || reactImports.has(name);
  pass((root) =>
    root.findAll({ rule: { any: [{ kind: "nested_type_identifier" }, { kind: "generic_type" }, { kind: "type_identifier" }] } }).flatMap((t) => {
      const s = t.text();
      if (t.kind() !== "generic_type" && t.parent()?.kind() === "generic_type" && same(t.parent().field("name"), t)) return [];
      if (/^(React\.)?(ReactNode|ReactElement|JSX\.Element)$/.test(s)) { note("ReactNode -> JSX.Element"); return [t.replace("JSX.Element")]; }
      if (t.kind() === "generic_type" && /^React\.ComponentProps</.test(s)) { note("React.ComponentProps -> ComponentProps"); return [t.replace(s.replace(/^React\./, ""))]; }
      const name = t.kind() === "generic_type" ? t.field("name").text() : s;
      const args = t.kind() === "generic_type" ? kids(t.field("type_arguments")).map((a) => a.text()) : [];
      const bare = name.replace(/^React\./, "");
      if (/^(ComponentPropsWithoutRef|ComponentPropsWithRef)$/.test(bare) && args.length) { note("ComponentPropsWithoutRef -> ComponentProps"); return [t.replace(`ComponentProps<${args.join(", ")}>`)]; }
      if (bare === "RefAttributes" && isReactType(name)) {
        const p = t.parent();
        if (p?.kind() === "intersection_type") { note("drop RefAttributes"); const other = kids(p).find((c) => !same(c, t) && c.kind() !== "&"); if (!other) return [];
          // delete just `& RefAttributes<…>` so edits inside the other side still apply
          const [a, b] = t.range().start.index > other.range().start.index ? [other.range().end.index, t.range().end.index] : [t.range().start.index, other.range().start.index];
          return [{ start: a, end: b, text: "" }]; }
        return [];
      }
      if (bare === "CSSProperties" && (isReactType(name) || name === "CSSProperties")) { note("CSSProperties -> JSX.CSSProperties"); return [t.replace("JSX.CSSProperties")]; }
      if (/^(ComponentType|FC|FunctionComponent)$/.test(bare) && isReactType(name)) { note("ComponentType -> Component"); return [t.replace(`Component${args.length ? `<${args.join(", ")}>` : ""}`)]; }
      if (/^(RefObject|MutableRefObject)$/.test(bare) && args.length) { note("RefObject -> { current }"); return [t.replace(`{ current: ${args[0]} }`)]; }
      if (bare === "Dispatch" && isReactType(name) && /^(React\.)?SetStateAction<([\s\S]*)>$/.test(args[0] ?? "")) { note("Dispatch<SetStateAction> -> Setter"); return [t.replace(`Setter<${args[0].replace(/^(React\.)?SetStateAction</, "").slice(0, -1)}>`)]; }
      if (REACT_EVENTS[bare] && (args.length || name.startsWith("React."))) {
        note("React event type -> DOM event");
        return [t.replace(args.length ? `${REACT_EVENTS[bare]} & { currentTarget: ${args[0]} }` : REACT_EVENTS[bare])];
      }
      if (/^[A-Za-z]*HTMLAttributes$/.test(bare) && name.startsWith("React.")) { note("React.*HTMLAttributes -> JSX.*HTMLAttributes"); return [t.replace(`JSX.${bare}${args.length ? `<${args.join(", ")}>` : ""}`)]; }
      return [];
    }),
  );

  // R39 Solid has no class components: note each React class component above it, with what its
  // lifecycle methods become. An error boundary becomes <Errored>. Flagged below.
  pass((root) =>
    root.findAll({ rule: { any: [{ kind: "class_declaration" }, { kind: "abstract_class_declaration" }, { kind: "class" }], has: { kind: "class_heritage" } } }).flatMap((cls) => {
      const base = cls.children().find((c) => c.kind() === "class_heritage")?.text().match(/^extends\s+((?:React\.)?(?:Pure)?Component)\b/)?.[1];
      if (!base || !(base.startsWith("React.") || fromReact.has(base))) return [];
      const methods = new Set(cls.field("body")?.children().filter((m) => m.kind() === "method_definition").map((m) => m.field("name")?.text()));
      const name = cls.field("name")?.text() ?? "class";
      let detail;
      if (methods.has("getDerivedStateFromError") || methods.has("componentDidCatch")) {
        detail = `${name} is an error boundary and Solid has no class components: use Solid 2's <Errored fallback={(err, reset) => ...}> around the children it guards`;
      } else {
        const lifecycle = { componentDidMount: "onSettled", componentDidUpdate: "createEffect(compute, apply), split by what it compares", componentWillUnmount: "onCleanup", getDerivedStateFromProps: "createMemo", shouldComponentUpdate: "nothing (Solid updates only what changed)" };
        const maps = Object.entries(lifecycle).filter(([m]) => methods.has(m)).map(([m, to]) => `${m} -> ${to}`);
        if (/\bthis\.(state|setState)\b/.test(cls.text())) maps.unshift("this.state/setState -> createSignal");
        detail = `${name} is a class component and Solid has none: rewrite it as a function component${maps.length ? ` (${maps.join("; ")})` : ""}`;
      }
      const statement = [cls, ...cls.ancestors()].find((a) => ["program", "statement_block"].includes(a.parent()?.kind() ?? ""));
      if (!statement) return [];
      const at = statement.range().start.index;
      note("class component -> note");
      return [{ start: at, end: at, text: `// solid: class component: ${detail}\n${" ".repeat(statement.range().start.column)}` }];
    }),
  );

  // R41 useEffect/useLayoutEffect(fn, [deps]) -> createEffect(compute, apply); (fn, []) -> onSettled(fn).
  // The deps (their reads already rewritten) become compute, and apply takes the ones its body
  // reads as parameters: Solid warns about a signal read directly in apply, and a cleanup that
  // reads the parameter sees its own run's value, as in React. Solid's effect runs after the DOM
  // is updated and before paint, so useLayoutEffect converts the same way. Anything else is
  // flagged. tests/solid-effects.test.mjs pins down the solid-js behavior this relies on.
  pass((root) => {
    const edits = [];
    for (const call of root.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: EFFECT_HOOKS.source } } })) {
      const [cb, deps] = kids(call.field("arguments")).filter((a) => a.kind() !== "comment");
      const statement = call.parent();
      const fn = statement?.parent()?.parent();
      const at = deps ? `${deps.text()}: ` : "";
      if (statement?.kind() !== "expression_statement" || statement.parent().kind() !== "statement_block" || !FN_KINDS.has(fn?.kind() ?? "") || /^async\b/.test(fn.text())) {
        flag("effect", call, `${at}not at the top of a component or hook body; convert to createEffect(compute, apply) or onSettled by hand`);
        continue;
      }
      if (!cb || !["arrow_function", "function_expression"].includes(cb.kind())) { flag("effect", call, `${at}the callback isn't an inline function; call it from createEffect(compute, apply) or onSettled`); continue; }
      if (/^async\b/.test(cb.text())) { flag("effect", call, `${at}an async callback returns a promise, which Solid rejects as a cleanup (React warns and ignores it): run the async work inside a sync apply`); continue; }
      if (!deps) { flag("effect", call, `${at}no deps array: it ran after every render, and a Solid component doesn't re-render. Track what it reads in compute: createEffect(() => [...], (values) => ...)`); continue; }
      if (deps.kind() !== "array" || kids(deps).some((d) => d.kind() === "spread_element")) { flag("effect", call, `${at}the deps aren't an array literal; list what it tracks in createEffect's compute`); continue; }
      const fnBody = fn.field("body");
      const lets = new Set(fnBody.findAll({ rule: { kind: "variable_declarator", inside: { kind: "lexical_declaration", regex: "^let\\b" } } }).map((d) => d.field("name")?.text()));
      const items = kids(deps).filter((d) => d.kind() !== "comment");
      const ref = items.find((d) => /\.current\b/.test(d.text()) || [d, ...d.findAll({ rule: { kind: "identifier" } })].some((id) => id.kind() === "identifier" && lets.has(id.text())));
      if (ref) { flag("effect", call, `${at}${ref.text()} is a ref or a let, which isn't reactive: track the signal that changes it, or set it up in the ref callback`); continue; }
      const body = cb.field("body");
      // A setter returns the value it set, and Solid rejects anything but a function as a cleanup.
      const writes = body.kind() !== "statement_block" && (["assignment_expression", "augmented_assignment_expression", "update_expression"].includes(unparen(body).kind()) || (unparen(body).kind() === "call_expression" && /^set[A-Z]/.test(unparen(body).field("function")?.text() ?? "")));
      const hook = call.field("function").text().replace("React.", "");
      if (!items.length) {
        edits.push(rep(call, `onSettled(${textWith(cb, writes ? [rep(body, `{ ${unparen(body).text()}; }`)] : [])})`));
        note(`${hook}(fn, []) -> onSettled`);
        continue;
      }
      // Each dep read as `x()` or `a.b` in the body becomes a parameter named after it.
      const taken = new Set(body.findAll({ rule: { any: [{ kind: "identifier" }, { kind: "shorthand_property_identifier" }] } }).map((id) => id.text()));
      const names = [];
      const reads = [];
      for (const dep of items) {
        const d = unparen(dep);
        const accessor = d.kind() === "call_expression" && d.field("function")?.kind() === "identifier" && !kids(d.field("arguments")).length;
        const base = accessor ? d.field("function").text() : d.kind() === "member_expression" ? d.field("property")?.text() : d.kind() === "identifier" ? d.text() : null;
        // a plain identifier (a function, a constant) isn't reactive: it's tracked as is
        const hits = !base || d.kind() === "identifier" ? [] : accessor
          ? readsOf(body, base).map((id) => id.parent()).filter((p) => p?.kind() === "call_expression" && !kids(p.field("arguments")).length)
          : body.findAll({ rule: { kind: "member_expression" } }).filter((m) => m.text() === d.text() && !(m.parent()?.kind() === "assignment_expression" && same(m.parent().field("left"), m)));
        // A parameter can't shadow a name the body uses for something else (the accessor it replaces
        // is fine); a key only has to be unique.
        const ownReads = accessor && readsOf(body, base).every((id) => hits.some((h) => inside(id, h)));
        let name = base ?? `dep${names.length + 1}`;
        for (let i = 2; names.includes(name) || (hits.length && taken.has(name) && !(ownReads && name === base)); i++) name = `${base ?? "dep"}Value${i > 2 ? i - 1 : ""}`;
        names.push(name);
        reads.push(hits);
      }
      const used = reads.map((hits) => hits.length > 0);
      const replace = reads.flatMap((hits, i) => hits.map((h) => rep(h, names[i])));
      let applyBody = textWith(body, replace);
      if (writes) applyBody = `{ ${textWith(unparen(body), replace)}; }`;
      let compute, params;
      if (items.length === 1) {
        compute = `() => ${items[0].kind() === "object" ? `(${items[0].text()})` : items[0].text()}`;
        params = used[0] ? `(${names[0]})` : "()";
      } else if (used.some(Boolean)) {
        compute = `() => ({ ${items.map((d, i) => (d.text() === names[i] ? names[i] : `${names[i]}: ${d.text()}`)).join(", ")} })`;
        params = `({ ${names.filter((_, i) => used[i]).join(", ")} })`;
      } else {
        compute = `() => ${deps.text()}`;
        params = "()";
      }
      // Reads of this component's signals and memos left in apply warn in dev: they aren't deps.
      const accessors = new Set(fnBody.findAll({ rule: { kind: "variable_declarator", has: { field: "value", kind: "call_expression", has: { field: "function", regex: "^(createSignal|createMemo)$" } } } }).map((d) => (d.field("name")?.kind() === "array_pattern" ? kids(d.field("name"))[0] : d.field("name"))?.text()));
      const untracked = [...new Set(body.findAll({ rule: { any: [{ kind: "call_expression", has: { field: "function", kind: "identifier" } }, { kind: "member_expression", has: { field: "object", regex: "^(props|merged)$" } }] } })
        // a read in a nested function runs later, outside apply, and doesn't warn
        .filter((n) => !n.ancestors().some((a) => inside(a, body) && !same(a, body) && FN_KINDS.has(a.kind())) && !replace.some((r) => r.start <= n.range().start.index && n.range().end.index <= r.end))
        .filter((n) => (n.kind() === "call_expression" ? accessors.has(n.field("function").text()) && !kids(n.field("arguments")).length : !(n.parent()?.kind() === "call_expression" && same(n.parent().field("function"), n))))
        .map((n) => n.text()))];
      // A dep the body declared as a plain value (or got from a hook) was read once: React re-ran
      // the effect when it changed between renders, and nothing changes it here. Setters, and
      // values the compiler pass found stable (a `static` note), don't change in React either.
      const plain = items.filter((d) => d.kind() === "identifier" && !/^set[A-Z]/.test(d.text())).map((d) => d.text()).filter((n) => {
        const binds = { any: [{ kind: "identifier" }, { kind: "shorthand_property_identifier_pattern" }], regex: `^${n.replace(/\$/g, "\\$")}$` };
        const decl = fnBody.find({ rule: { kind: "variable_declarator", has: { field: "name", any: [binds, { has: { ...binds, stopBy: "end" } }] } } });
        const v = decl?.field("value");
        const noted = decl?.parent()?.prev();
        if (noted?.kind() === "comment" && new RegExp(`^// solid:.*\\b${n.replace(/\$/g, "\\$")}: static\\b`).test(noted.text())) return false;
        return !!v && !FN_KINDS.has(v.kind()) && !/^(createSignal|createMemo|useContext)\b/.test(v.text());
      });
      if (plain.length) flag("effect dep", call, `${plain.join(", ")} ${plain.length > 1 ? "are plain values" : "is a plain value"} here (the component body runs once), so tracking ${plain.length > 1 ? "them" : "it"} never re-runs the effect; React re-ran it when ${plain.length > 1 ? "they" : "it"} changed. Make ${plain.length > 1 ? "each" : "it"} an accessor (a signal, a memo, or a hook that returns one) and track it as ${plain[0]}()`);
      if (untracked.length) flag("effect read", call, `${untracked.join(", ")} ${untracked.length > 1 ? "are" : "is"} read in the effect but not in its deps: Solid warns (STRICT_READ_UNTRACKED) in dev. Add ${untracked.length > 1 ? "them" : "it"} to compute if the effect should re-run on ${untracked.length > 1 ? "them" : "it"}, or read ${untracked.length > 1 ? "them" : "it"} with untrack() for a deliberate snapshot`);
      edits.push(rep(cb, compute), rep(deps, `${params} => ${applyBody}`), rep(call.field("function"), "createEffect"));
      note(`${hook}(fn, deps) -> createEffect(compute, apply)`);
    }
    return edits;
  });

  // Flags for the judgment bucket
  const root = parse(Lang.Tsx, src).root();
  for (const c of root.findAll({ rule: { kind: "comment", regex: "^// solid: class component: " } }))
    flag("class component", c.next(), c.text().replace("// solid: class component: ", ""));
  for (const fn of componentFns(root, true)) {
    const name = fn.field("name")?.text() ?? fn.parent()?.field("name")?.text() ?? "this component";
    flag("server component", fn, `${name} is async, a React Server Component, and a Solid component can't be async; its body was left as is. In SolidStart or @solidjs/vite-plugin's start mode, load the data in the route with an async createMemo (Solid 2 memos can be async; reads suspend under <Loading>) or a server function, and render synchronously`);
  }
  // R40 Next.js imports: no Solid 2 equivalent is installed for them, so each import is flagged
  // with what to use instead. @solidjs/router 2 has no link component and no notFound.
  for (const imp of root.findAll({ rule: { kind: "import_statement", has: { field: "source", regex: "^[\"']next([/\"'])" } } })) {
    const source = imp.field("source").text().slice(1, -1);
    const names = (imp.text().match(/^import\s+(?:type\s+)?([\s\S]*?)\s+from\s/)?.[1] ?? "").replace(/^type\s+|[{}]|\btype\s+/g, "").split(",").map((n) => n.trim()).filter(Boolean);
    const navigation = { useRouter: "useNavigate() (router.push(p) -> navigate(p))", usePathname: "useLocation().pathname", useSearchParams: "useSearchParams()", useParams: "useParams()", redirect: "redirect from @solidjs/web", permanentRedirect: "redirect from @solidjs/web", notFound: "a catch-all *404 route, with httpStatus(404) from @solidjs/web" };
    const guidance = {
      "next/link": "@solidjs/router has no link component: use <a href>, which the router intercepts",
      "next/navigation": names.map((n) => `${n} -> ${navigation[n.split(/\s+as\s+/)[0]] ?? "no direct equivalent; see @solidjs/router"}`).join("; ") + " (from @solidjs/router unless noted)",
      "next/image": "use <img> with width, height and loading=\"lazy\"",
      "next/dynamic": "use lazy from solid-js, rendered under <Loading>",
      "next/headers": "server-only: read it in a server function (\"use server\") in start mode",
      "next/server": "server-only: move it to a server function or a server route in start mode",
      "next/script": "use a <script> tag, or useHead from @solidjs/web",
      next: "Metadata and generateMetadata -> useHead from @solidjs/web",
    }[source] ?? "Next.js has no Solid 2 equivalent";
    flag("Next.js", imp, `${names.join(", ") || "import"} from ${source}: ${guidance}`);
  }
  // R43 zustand's React hook has no Solid 2 binding. Each store is flagged once, where it's created,
  // with the bridge the converted callers were written for: selected state is an accessor (`x()`),
  // a selected action is called directly (the compiler pass reads both off the store).
  const zustandCreate = src.match(/^import\s*\{([^}]*)\}\s*from\s*["']zustand["']/m)?.[1].split(",").map((s) => s.trim().split(/\s+as\s+/)).find(([imported]) => imported === "create")?.pop();
  if (zustandCreate) {
    for (const decl of root.findAll({ rule: { kind: "variable_declarator", inside: { kind: "lexical_declaration", inside: { any: [{ kind: "program" }, { kind: "export_statement" }] } }, has: { field: "value", kind: "call_expression", regex: `^${zustandCreate}\\b` } } })) {
      const name = decl.field("name").text();
      flag("zustand store", decl, `${name} is a zustand React hook, and zustand has no Solid 2 binding (solid-zustand is Solid 1 only). Its callers were converted to read selected state as an accessor, x(), and to call a selected action directly. A bridge makes that true: create the store with createStore from zustand/vanilla, then export const ${name} = Object.assign((selector) => { const initial = selector(store.getState()); if (typeof initial === "function") return initial; const [value, setValue] = createSignal(initial, { ownedWrite: true }); onCleanup(store.subscribe((state) => setValue(() => selector(state)))); return value; }, store). Actions come back as they are (zustand makes them once), and ownedWrite lets a store write made while a component or a computation runs update the signal (Solid throws otherwise)`);
    }
  }
  for (const c of root.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: "^(React\\.)?useRef$" } } }))
    flag("ref", c, "useRef -> DOM ref callback or plain let");
  for (const c of root.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: "^(React\\.)?(createContext)$" } } }))
    if (/\(\s*(undefined)?\s*\)$/.test(c.text())) flag("context default", c, "Solid 2: undefined default means 'no provider' and throws; use null for optional");
  for (const c of root.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: "^use[A-Z]\\w*$" } } }))
    if (!/^use(Context|State|Memo|Callback|Effect|LayoutEffect|Ref)$/.test(c.field("function").text())) flag("custom hook call", c, `${c.field("function").text()}() returns values in React; decide value vs accessor`);

  // R10 imports
  // A `// solid:` note names Solid APIs (R39's onSettled) without using them.
  const code = src.replace(/^import\b[^;]*?\bfrom\s*["'][^"'\n]*["'];?[ \t]*$|^import\s*["'][^"'\n]*["'];?[ \t]*$/gm, "").replace(/\/\/ solid:.*$/gm, "");
  const used = (re) => re.test(code);
  // A name the file declares or imports from another module stays that binding: importing Solid's
  // too would clash. When the conversion added that use, which one it means needs a person.
  const elsewhere = [...src.matchAll(/^import\s+(?:type\s+)?([\s\S]*?)\s+from\s*["']([^"']+)["']/gm)]
    .filter((m) => !/^(react|react-dom|solid-js|@solidjs\/web)$/.test(m[2])).map((m) => m[1]).join(" ");
  const free = (pattern) => (n) => {
    if (!new RegExp(`\\b(const|let|var|function|class|type|interface|enum)\\s+${n}\\b`).test(code) && !new RegExp(`\\b${n}\\b`).test(elsewhere)) return true;
    if (!pattern(n).test(input)) flag("name clash", null, `${n} is declared in this file, and the conversion uses Solid's ${n}; check which one each use means`);
    return false;
  };
  const solidNames = [
    ...["createSignal", "createMemo", "createContext", "useContext", "createEffect", "onSettled", "merge", "omit", "For", "createUniqueId", "lazy"].filter((n) => used(new RegExp(`\\b${n}\\b`))).filter(free((n) => new RegExp(`\\b${n}\\b`))),
    ...["Show", "Switch", "Match", "Loading"].filter((n) => used(new RegExp(`<${n}\\b`))).filter(free((n) => new RegExp(`<${n}\\b`))),
    ...["untrack", "flush"].filter((n) => used(new RegExp(`\\b${n}\\(`))).filter(free((n) => new RegExp(`\\b${n}\\(`))),
  ];
  const typeNames = ["JSX", "ComponentProps"].filter((n) => used(new RegExp(`\\b${n}\\b`))).filter(free((n) => new RegExp(`\\b${n}\\b`)));
  // `extends Component<P, S>` is React's class (R39), not Solid's Component type.
  const solidTypes = ["Component", "Setter"].filter((n) => new RegExp(`\\b${n}<`).test(code.replace(/\bextends\s+Component</g, ""))).filter(free((n) => new RegExp(`\\b${n}<`)));
  let removedReact = false;
  src = src.replace(/^import\s+(type\s+)?(\*\s+as\s+React|React(,\s*\{[^}]*\})?|\{[^}]*\})\s+from\s+["']react["'];?[ \t]*\n/gm, () => { removedReact = true; return ""; });
  src = src.replace(/^import\s+\{\s*flushSync\s*\}\s+from\s+["']react-dom["'];?[ \t]*\n/gm, "");
  const header = [solidNames.length ? `import { ${solidNames.join(", ")} } from "solid-js";` : "", solidTypes.length ? `import type { ${solidTypes.join(", ")} } from "solid-js";` : "", renders ? `import { render } from "@solidjs/web";` : "", typeNames.length ? `import type { ${typeNames.join(", ")} } from "@solidjs/web";` : ""].filter(Boolean).join("\n");
  if (header) src = src.replace(/^(["']use client["'];\n\n?)?/, (m) => `${m}${header}\n`);
  if (removedReact) note("react imports -> solid-js");
  // Anything else the file imported from react and still uses has no conversion here. Hooks are
  // flagged where they're called; `use` is only converted for a context.
  if (removedReact) {
    const body = src.replace(/^import\b[^;]*?\bfrom\s*["'][^"'\n]*["'];?[ \t]*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    const imported = (src.match(/^import\b[^;]*?\bfrom\s*["'][^"'\n]*["'];?[ \t]*$/gm) ?? []).join("\n");
    for (const name of fromReact) {
      if (name === "React" || /^use[A-Z]/.test(name)) continue;
      // Without the import, an event type React and the DOM share a name with is the DOM's: right.
      if (REACT_EVENTS[name] === name) continue;
      if (new RegExp(`\\b${name}\\b`).test(body) && !new RegExp(`\\b${name}\\b`).test(imported)) flag("React API", null, `${name} was imported from react and has no conversion here; its import was removed`);
    }
  }
  src = src.replace(/^["']use client["'];\n\n?/m, () => { note("drop 'use client'"); return ""; });
  if (/\bReact\.\w+/.test(src)) flag("React namespace", null, [...new Set(src.match(/\bReact\.\w+/g))].join(", "));

  return { code: src, applied, flags };
}

