// The deterministic React -> Solid 2 pass. Each rule is conservative and reports what it could
// not do as a flag for the agent/human bucket instead of guessing.
// transform(src, { parse, Lang }) -> { code, applied, flags }. The ast-grep parser is passed in, so
// this runs under @ast-grep/napi in Node and under codemod/ast-grep in the workflow.
//
// R1-R10 are the original rules. R11-R34 come from hand fixes that repeated across three
// screen ports (t3code OpenTelemetry and Keybindings, codemod-app Repositories > Indexing).

const ATTRS = { className: "class", htmlFor: "for", tabIndex: "tabindex", readOnly: "readonly", autoFocus: "autofocus", autoComplete: "autocomplete", maxLength: "maxlength", minLength: "minlength", spellCheck: "spellcheck", colSpan: "colspan", rowSpan: "rowspan" };
// React's other camelCase HTML attributes, as @solidjs/web 2.0.3's JSX types spell them (lowercase,
// or HTML's own dashed name). Only on intrinsic elements: a component's props keep their names.
const DOM_ATTRS = {
  acceptCharset: "accept-charset",
  httpEquiv: "http-equiv",
  ...Object.fromEntries(["accessKey", "allowFullScreen", "allowTransparency", "autoCapitalize", "autoCorrect", "autoPlay", "charSet", "classID", "contentEditable", "contextMenu", "controlsList", "crossOrigin", "dateTime", "dirName", "disablePictureInPicture", "disableRemotePlayback", "encType", "enterKeyHint", "fetchPriority", "formAction", "formEncType", "formMethod", "formNoValidate", "formTarget", "frameBorder", "hrefLang", "imageSizes", "imageSrcSet", "inputMode", "itemID", "itemProp", "itemRef", "itemScope", "itemType", "keyParams", "keyType", "marginHeight", "marginWidth", "mediaGroup", "noModule", "noValidate", "playsInline", "popoverTarget", "popoverTargetAction", "referrerPolicy", "srcDoc", "srcLang", "srcSet", "useMap"].map((name) => [name, name.toLowerCase()])),
};
const FN_KINDS = new Set(["arrow_function", "function_expression", "function_declaration", "method_definition"]);
const SVG_ATTRS = ["strokeWidth", "strokeLinecap", "strokeLinejoin", "strokeDasharray", "strokeDashoffset", "strokeOpacity", "strokeMiterlimit", "fillOpacity", "fillRule", "clipRule", "clipPath", "stopColor", "stopOpacity", "textAnchor", "dominantBaseline", "markerStart", "markerMid", "markerEnd", "vectorEffect", "shapeRendering", "colorInterpolationFilters", "floodColor", "floodOpacity", "lightingColor", "pointerEvents", "fontFamily", "fontSize", "fontWeight"];
const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "file", "submit", "button", "reset", "image", "color", "hidden"]);
const REACT_EVENTS = { MouseEvent: "MouseEvent", KeyboardEvent: "KeyboardEvent", FocusEvent: "FocusEvent", PointerEvent: "PointerEvent", DragEvent: "DragEvent", TouchEvent: "TouchEvent", WheelEvent: "WheelEvent", ClipboardEvent: "ClipboardEvent", CompositionEvent: "CompositionEvent", AnimationEvent: "AnimationEvent", TransitionEvent: "TransitionEvent", UIEvent: "UIEvent", ChangeEvent: "Event", FormEvent: "Event", SyntheticEvent: "Event", InputEvent: "InputEvent" };
// React's unitless CSS properties: it adds px to any other number.
const UNITLESS = new Set(["animationIterationCount", "aspectRatio", "borderImageOutset", "borderImageSlice", "borderImageWidth", "boxFlex", "boxFlexGroup", "boxOrdinalGroup", "columnCount", "columns", "flex", "flexGrow", "flexPositive", "flexShrink", "flexNegative", "flexOrder", "gridArea", "gridRow", "gridRowEnd", "gridRowSpan", "gridRowStart", "gridColumn", "gridColumnEnd", "gridColumnSpan", "gridColumnStart", "fontWeight", "lineClamp", "lineHeight", "opacity", "order", "orphans", "scale", "tabSize", "widows", "zIndex", "zoom", "fillOpacity", "floodOpacity", "stopOpacity", "strokeDasharray", "strokeDashoffset", "strokeMiterlimit", "strokeOpacity", "strokeWidth"]);
// What to use for a React or react-dom API with no conversion here (R10 flags each one left).
const REACT_API = {
  useTransition: "Solid 2 has no transition to start: call the callback directly; async work in a createMemo or an action shows as pending through isPending(() => value) and <Loading>",
  startTransition: "call the callback directly: Solid 2 keeps showing the current UI under <Loading> while async work settles",
  useDeferredValue: "read the value directly; isPending(() => value) says when a newer one is on its way",
  useSyncExternalStore: "const [value, setValue] = createSignal(getSnapshot(), { ownedWrite: true }); onCleanup(subscribe(() => setValue(getSnapshot())))",
  useImperativeHandle: "call the ref prop with the API object: props.ref?.(api)",
  useActionState: "use action from solid-js, with a signal for its state",
  useOptimistic: "use createOptimistic from solid-js",
  useInsertionEffect: "use createRenderEffect",
  forwardRef: "a ref is a plain prop in Solid: take props.ref",
  Children: "use children(() => props.children) from solid-js, and its toArray()",
  cloneElement: "Solid's elements are DOM nodes, not descriptions: pass props or a render function instead",
  isValidElement: "Solid has no element objects: check for a DOM node or a function",
  createElement: "use JSX, or h from @solidjs/h",
  cache: "React's server-request cache: load the data in a server function in SolidStart or @solidjs/vite-plugin's start mode",
  hydrateRoot: "use hydrate(() => <App />, element) from @solidjs/web",
  renderToString: "use renderToString(() => <App />) from @solidjs/web",
  renderToStaticMarkup: "use renderToString(() => <App />) from @solidjs/web",
  createPortal: "use <Portal mount={container}> from @solidjs/web",
  preconnect: "add a <link rel=\"preconnect\"> with useHead from @solidjs/web",
  preload: "add a <link rel=\"preload\"> with useHead from @solidjs/web",
  prefetchDNS: "add a <link rel=\"dns-prefetch\"> with useHead from @solidjs/web",
};
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

// `ports`: the React libraries the project moves to their Solid 2 port, by name, each with its
// PORTS entry (src/manifests.mjs); R44 points their imports at the port. `next`: set when Next.js's
// App Router moves to Solid's file routes (R47-R54); see there. For the root layout, the result's
// `document` holds the stylesheets and head tags that move to src/App.tsx.
export function transform(input, { parse, Lang, ports = {}, next = null }) {
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
        // an insertion where an edit ends goes after it, not inside it
        while (it.end > it.start && j < list.length && list[j].start >= it.start && list[j].end <= it.end && list[j].start < it.end) nested.push(list[j++]);
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
  // Solid types the rules write, by module, for R10 to import (a bare `Component` has no `<` to find it by).
  const introduced = { "solid-js": new Set(), "@solidjs/web": new Set() };

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
    // member tags on the name (`<activeTeam.logo>`) -> the component made for each
    const tags = new Map();
    const real = new Set(readsOf(scope, name, { exclude: [declNode] }).map((id) => id.range().start.index));
    for (const id of scope.findAll({ rule: { any: [{ kind: "identifier", regex: `^${name}$` }, { kind: "shorthand_property_identifier", regex: `^${name}$` }] } })) {
      if (!real.has(id.range().start.index)) continue;
      const parent = id.parent();
      if (parent?.kind() === "jsx_opening_element" || parent?.kind() === "jsx_closing_element") continue;
      // A tag name can't hold a call (`<activeTeam().logo>` doesn't parse): as with a prop used as a
      // tag (R8), the tag becomes a component made with dynamic(), declared after the name is.
      let tag = id;
      while (tag.parent()?.kind() === "member_expression" && same(tag.parent().field("object"), tag)) tag = tag.parent();
      if (tag !== id && same(tag.parent()?.field("name"), tag) && !/^[\w$.]+$/.test(toRead)) {
        const local = tags.get(tag.text()) ?? freeName(tag.text().split(".").map(ucfirst).join(""), [...tags.values()]);
        if (/^import\b[^;]*\bdynamic\b[^;]*from\s*["'](?!@solidjs\/web["'])/m.test(src) || /\b(const|let|var|function|class)\s+dynamic\b/.test(src)) {
          if (!tags.has(tag.text())) flag("accessor in tag name", tag, `<${tag.text()}> reads the ${label} ${name}: write const ${local} = dynamic(() => ${toRead}${tag.text().slice(name.length)}) with dynamic from @solidjs/web (this file has a dynamic of its own)`);
          tags.set(tag.text(), local);
          continue;
        }
        if (!tags.has(tag.text())) {
          const statement = declNode?.kind() === "variable_declarator" ? declNode.parent() : declNode;
          const at = statement ?? bodyNode.child(0);
          const indent = " ".repeat(statement?.range().start.column ?? kids(bodyNode)[0]?.range().start.column ?? 2);
          edits.push({ start: at.range().end.index, end: at.range().end.index, text: `\n${indent}const ${local} = dynamic(() => ${toRead}${tag.text().slice(name.length)});` });
          note("member tag on an accessor -> dynamic()");
        }
        tags.set(tag.text(), local);
        edits.push(tag.replace(local));
        continue;
      }
      // shadowed by a nested function parameter?
      let shadowed = false;
      for (let a = id.parent(); a && a.range().start.index >= scope.range().start.index; a = a.parent()) {
        if (FN_KINDS.has(a.kind()) && !same(a, bodyNode?.parent())) {
          const params = a.field("parameters") ? kids(a.field("parameters")).map((p) => (p.field("pattern") ?? p).text()).join(" ") : a.field("parameter")?.text();
          if (params && new RegExp(`\\b${name}\\b`).test(params)) shadowed = true;
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
      // the binding of a catch or a for...of/in, not what the loop iterates
      if (pk === "catch_clause" || (pk === "for_in_statement" && same(parent.field("left"), id))) continue;
      let tag = parent;
      while (tag && (tag.kind() === "member_expression" || tag.kind() === "nested_identifier")) tag = tag.parent();
      if (tag !== parent && /^jsx_(opening|closing|self_closing)_element$/.test(tag?.kind() ?? "")) out.inTag = true;
      if (pk === "variable_declarator" && same(parent.field("name"), id)) continue;
      // a parameter's own name, not a default value that reads the name
      if ((pk === "required_parameter" || pk === "optional_parameter") && same(parent.field("pattern"), id)) continue;
      if (id.ancestors().some((a) => a.kind() === "type_query" || a.kind() === "type_annotation")) continue;
      if (skipCallee && pk === "call_expression" && same(parent.field("function"), id)) continue;
      if (skipHookArgs && pk === "arguments" && /^use[A-Z]/.test(parent.parent()?.field("function")?.text() ?? "")) continue;
      let shadowed = false;
      for (let a = parent; a && a.range().start.index > scope.range().start.index; a = a.parent()) {
        if (a.kind() === "catch_clause" && a.field("parameter")?.text() === name) shadowed = true;
        if (a.kind() === "for_in_statement" && new RegExp(`(^|[^.\\w])${name}\\b`).test(a.field("left")?.text() ?? "")) shadowed = true;
        if (a.kind() === "statement_block" && kids(a).some((st) => st.kind() === "lexical_declaration" && kids(st).some((d) => d.kind() === "variable_declarator" && new RegExp(`(^|[^.:\\w])${name}\\b`).test(d.field("name")?.text() ?? "")))) shadowed = true;
        if (FN_KINDS.has(a.kind())) {
          // the parameters' names, not their default values
          const params = a.field("parameters") ? kids(a.field("parameters")).map((p) => (p.field("pattern") ?? p).text()).join(" ") : a.field("parameter")?.text();
          if (params && new RegExp(`(^|[^.\\w])${name}\\b`).test(params)) shadowed = true;
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
    flag("accessor in tag name", node, `<${name}.…> would need const Tag = dynamic(() => ${name}().…), with dynamic from @solidjs/web; left as a plain value`);
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

  // R47-R54 Next.js, with nextRoutes on (`next` is set): what @solidjs/vite-plugin's start mode and
  // @solidjs/router's file routes have a counterpart for, before the React rules run. `next.kind` is
  // the App Router file this is (page, layout, document for the root layout, route, not-found) or
  // null for any other file; `next.pattern` is its route's path in the router's pattern language,
  // `next.key` the file it came from, and `next.wrap` the loading and error components a layout
  // wraps its children in, as import specifiers from where the layout now lives.
  const routerNames = new Set();
  const routerTypes = new Set();
  let document = null;
  if (next) {
    // R47 next/link's <Link> -> <a>: @solidjs/router intercepts plain anchors, and reads `replace`
    // and `noscroll` off them. An object href or Link's legacy props stay, flagged.
    const link = src.match(/^import\s+([\w$]+)\s+from\s+["']next\/link["'];?[ \t]*\n/m);
    if (link) {
      let left = 0;
      pass((root) =>
        root.findAll({ rule: { any: [{ kind: "jsx_opening_element" }, { kind: "jsx_self_closing_element" }], has: { field: "name", regex: `^${link[1]}$` } } }).flatMap((open) => {
          const attrs = open.children().filter((c) => c.kind() === "jsx_attribute");
          const blocker = attrs.find((a) => ["legacyBehavior", "passHref", "as", "locale", "shallow", "onNavigate"].includes(attrName(a)) || (attrName(a) === "href" && attrValue(a)?.kind() === "object"));
          if (blocker) {
            left++;
            flag("Next.js", open, `<${link[1]} ${attrName(blocker)}${attrName(blocker) === "href" ? "={{...}}" : ""}> has no <a> counterpart: build the URL as a string (or with the router's paths) and use <a href>`);
            return [];
          }
          const edits = [rep(open.field("name"), "a")];
          for (const a of attrs) {
            if (attrName(a) === "prefetch") edits.push(dropAttr(a));
            else if (attrName(a) === "scroll") edits.push(attrValue(a)?.text() === "false" ? rep(a, "noscroll") : dropAttr(a));
          }
          const close = open.kind() === "jsx_opening_element" ? open.parent()?.children().find((c) => c.kind() === "jsx_closing_element") : null;
          if (close) edits.push(rep(close, "</a>"));
          note("next/link <Link> -> <a>");
          return edits;
        }),
      );
      if (!left) src = src.replace(link[0], "");
    }

    // R48 next/image's <Image> -> <img>, lazy and async-decoded as Next.js renders it; `priority`
    // (and Next 16's `preload`) becomes fetchpriority="high". `quality` and `unoptimized` only meant
    // something to Next.js's image optimizer. `fill`, placeholders, loaders and spreads stay, flagged.
    const image = src.match(/^import\s+([\w$]+)\s+from\s+["']next\/image["'];?[ \t]*\n/m);
    if (image) {
      let left = 0;
      const kept = new Set(["src", "alt", "width", "height", "className", "style", "id", "title", "sizes", "srcSet", "loading", "decoding", "onLoad", "onError", "draggable", "crossOrigin", "referrerPolicy", "fetchPriority"]);
      pass((root) =>
        root.findAll({ rule: { any: [{ kind: "jsx_opening_element" }, { kind: "jsx_self_closing_element" }], has: { field: "name", regex: `^${image[1]}$` } } }).flatMap((open) => {
          const attrs = open.children().filter((c) => c.kind() === "jsx_attribute");
          const blocker = attrs.find((a) => !kept.has(attrName(a)) && !["priority", "preload", "quality", "unoptimized"].includes(attrName(a)));
          if (blocker || open.children().some((c) => c.kind() === "jsx_expression")) {
            left++;
            flag("Next.js", open, `<${image[1]}> with ${blocker ? attrName(blocker) : "a spread"}: write the <img> by hand (Next.js's image optimizer has no Solid counterpart)`);
            return [];
          }
          const eager = attrs.some((a) => ["priority", "preload"].includes(attrName(a)) && attrValue(a)?.text() !== "false");
          const dropped = attrs.filter((a) => ["priority", "preload", "quality", "unoptimized"].includes(attrName(a)));
          const has = (n) => attrs.some((a) => attrName(a) === n);
          const added = [eager ? 'fetchpriority="high"' : has("loading") ? "" : 'loading="lazy"', has("decoding") ? "" : 'decoding="async"'].filter(Boolean);
          // After the last attribute that stays (as part of its edit: a dropped one after it takes
          // the line break an insert there would sit on), on lines of their own when the tag has them.
          const last = attrs.filter((a) => !dropped.includes(a)).at(-1) ?? open.field("name");
          const sep = open.text().includes("\n") && last.kind() === "jsx_attribute" ? `\n${" ".repeat(last.range().start.column)}` : " ";
          const tail = added.length ? `${sep}${added.join(sep)}` : "";
          const edits = [rep(open.field("name"), `img${last.kind() === "jsx_attribute" ? "" : tail}`), ...dropped.map(dropAttr), ...(last.kind() === "jsx_attribute" && tail ? [rep(last, `${last.text()}${tail}`)] : [])];
          const close = open.kind() === "jsx_opening_element" ? open.parent()?.children().find((c) => c.kind() === "jsx_closing_element") : null;
          if (close) edits.push(rep(close, "</img>"));
          note("next/image <Image> -> <img>");
          return edits;
        }),
      );
      if (!left) src = src.replace(image[0], "");
    }

    // R49 next/dynamic's dynamic(() => import("./x")) -> lazy from solid-js, which suspends under
    // <Loading>. Options (ssr: false, a loading component) and a picked export stay, flagged.
    const loader = src.match(/^import\s+([\w$]+)\s+from\s+["']next\/dynamic["'];?[ \t]*\n/m);
    if (loader) {
      let left = 0;
      pass((root) =>
        root.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: `^${loader[1]}$` } } }).flatMap((call) => {
          const args = kids(call.field("arguments")).filter((a) => a.kind() !== "comment");
          const body = args[0]?.kind() === "arrow_function" ? unparen(args[0].field("body")) : null;
          if (args.length !== 1 || body?.kind() !== "call_expression" || body.field("function")?.text() !== "import") {
            left++;
            flag("Next.js", call, `${call.text().split("\n")[0]}: lazy(() => import("./x")) from solid-js loads a module's default export, under <Loading>; options such as ssr: false or loading have no counterpart`);
            return [];
          }
          note("next/dynamic -> lazy");
          return [rep(call.field("function"), "lazy")];
        }),
      );
      if (!left) src = src.replace(loader[0], "");
    }

    // R50 next/font loaders set a font's class names; there is no Solid counterpart, so each
    // declaration becomes the same shape with empty names (the code that reads them still type-checks
    // and renders) and is flagged with what to load instead.
    for (const m of [...src.matchAll(/^import\s+(?:([\w$]+)|\{([^}]*)\})\s+from\s+["'](next\/font\/(?:google|local))["'];?[ \t]*\n/gm)]) {
      const loaders = m[1] ? [m[1]] : m[2].split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean);
      let left = 0;
      pass((root) =>
        root.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: `^(${loaders.join("|")})$` } } }).flatMap((call) => {
          const decl = call.parent();
          if (decl?.kind() !== "variable_declarator" || decl.field("name")?.kind() !== "identifier" || !decl.parent()?.parent() || decl.parent().parent().kind() !== "program") {
            left++;
            flag("Next.js", call, `${call.field("function").text()}() from ${m[3]}: load the font with CSS (@font-face, or a @fontsource package) instead`);
            return [];
          }
          const variable = call.find({ rule: { kind: "pair", has: { field: "key", regex: "^variable$" } } })?.field("value")?.text();
          flag("Next.js", decl, `${decl.field("name").text()} was ${call.field("function").text()} from ${m[3]}, which has no Solid counterpart: it is now an object with empty class names, so the font isn't loaded. Load it with CSS (@font-face, or a @fontsource package)${variable ? ` and set the ${variable} custom property it defined` : ""}`);
          note("next/font loader -> empty class names");
          return [rep(call, `{ className: "", variable: "", style: {} }`)];
        }),
      );
      if (!left) src = src.replace(m[0], "");
    }

    // R51 Next.js's global route types: PageProps<"/items/[id]"> -> RouteProps<"/items/:id"> from
    // @solidjs/router, LayoutProps<...> -> ParentProps from solid-js.
    pass((root) =>
      root.findAll({ rule: { kind: "generic_type", has: { field: "name", regex: "^(PageProps|LayoutProps)$" } } }).flatMap((t) => {
        if (new RegExp(`\\b${t.field("name").text()}\\b`).test(src.match(/^import\b[^;]*;/gm)?.join("\n") ?? "")) return [];
        if (t.field("name").text() === "LayoutProps") {
          introduced["solid-js"].add("ParentProps");
          note("LayoutProps -> ParentProps");
          return [rep(t, "ParentProps")];
        }
        if (!next.pattern) return [];
        routerTypes.add("RouteProps");
        note("PageProps -> RouteProps");
        return [rep(t, `RouteProps<${JSON.stringify(next.pattern)}>`)];
      }),
    );

    // R52 an async page or layout of the simple shape (const declarations, which may await params,
    // searchParams and data, then a return of JSX) -> a sync component reading one async memo. The
    // declarations move into a query over a server function ("use server"), so they still run on the
    // server only, as in a Server Component: during SSR it's a direct call, and on a client
    // navigation a fetch. The memo's reads suspend under <Loading>. Anything else stays async and is
    // flagged as a server component below.
    if (next.kind === "page" || next.kind === "layout") {
      pass((root) => {
        const fn = componentFns(root, true).find((f) => f.kind() === "function_declaration" && (/^export\s+default\b/.test(f.parent()?.text() ?? "") || new RegExp(`^export\\s+default\\s+${f.field("name").text()}\\s*;?\\s*$`, "m").test(src)));
        if (!fn) return [];
        const allowed = next.kind === "layout" ? ["params", "children"] : ["params", "searchParams"];
        const params = kids(fn.field("parameters"));
        const pattern = params[0]?.field("pattern");
        if (params.length > 1 || (params.length && (pattern?.kind() !== "object_pattern" || !kids(pattern).every((p) => p.kind() === "shorthand_property_identifier_pattern" && allowed.includes(p.text()))))) return [];
        const statements = kids(fn.field("body")).filter((s) => s.kind() !== "comment");
        const ret = statements.pop();
        const view = ret?.kind() === "return_statement" ? unparen(arg(ret)) : null;
        if (!isJsx(view) || !statements.length || !statements.every((s) => s.kind() === "lexical_declaration" && /^const\b/.test(s.text()))) return [];
        const jsx = { any: [{ kind: "jsx_element" }, { kind: "jsx_self_closing_element" }] };
        const names = [];
        for (const d of statements.flatMap((s) => kids(s).filter((c) => c.kind() === "variable_declarator"))) {
          const name = d.field("name");
          const parts = name.kind() === "identifier" ? [name] : name.kind() === "array_pattern" ? kids(name) : name.kind() === "object_pattern" ? kids(name).map((p) => (p.kind() === "pair_pattern" ? p.field("value") : p)) : [null];
          if (!parts.every((p) => p && ["identifier", "shorthand_property_identifier_pattern"].includes(p.kind())) || d.find({ rule: jsx })) return [];
          names.push(...parts.map((p) => p.text()));
        }
        const declared = statements.map((s) => s.text()).join("\n");
        if (/\bchildren\b/.test(declared) || readsOf(view, "params").length || readsOf(view, "searchParams").length) return [];
        const shown = names.filter((n) => readsOf(view, n).length);
        if (!shown.length) return [];
        const name = fn.field("name").text();
        const load = freeName(`load${name}`);
        const data = freeName("data");
        const inputs = [/\bparams\b/.test(declared) && ["params", `RouteProps<${JSON.stringify(next.pattern)}>["params"]`, "{ ...props.params }"], /\bsearchParams\b/.test(declared) && ["searchParams", "SearchParams", "{ ...props.location.query }"]].filter(Boolean);
        const usesChildren = readsOf(view, "children").length > 0;
        routerNames.add("query");
        if (inputs.length || usesChildren) routerTypes.add("RouteProps");
        if (inputs.some(([n]) => n === "searchParams")) routerTypes.add("SearchParams");
        const body = src.slice(ix(statements[0].range().start.index), ix(statements.at(-1).range().end.index));
        const holder = fn.parent()?.kind() === "export_statement" ? fn.parent() : fn;
        const server = `const ${load} = query(async (${inputs.map(([n, t]) => `${n}: ${t}`).join(", ")}) => {\n  "use server";\n  ${body}\n  return { ${shown.join(", ")} };\n}, ${JSON.stringify(next.key)});\n\n`;
        const reads = [...shown.flatMap((n) => readsOf(view, n).map((id) => readAs(id, `${data}().${n}`))), ...readsOf(view, "children").map((id) => readAs(id, "props.children"))];
        const param = inputs.length || usesChildren ? `props: RouteProps<${JSON.stringify(next.pattern)}>` : "";
        const memo = `const ${data} = createMemo(() => ${load}(${inputs.map(([, , v]) => v).join(", ")}));`;
        note("async page -> query + async createMemo");
        return [
          { start: holder.range().start.index, end: holder.range().start.index, text: server },
          rep(fn.field("parameters"), `(${param})`),
          { start: fn.range().start.index, end: fn.field("name").range().start.index, text: "function " },
          { start: statements[0].range().start.index, end: statements.at(-1).range().end.index, text: memo },
          rep(view, textWith(view, reads)),
        ];
      });
    }

    // R53 a page's or layout's static metadata -> useHead from @solidjs/web, in its component. Only a
    // string title and description convert; the root layout's go to src/App.tsx, which is generated.
    const metadata = (root) => root.find({ rule: { kind: "export_statement", has: { kind: "lexical_declaration", has: { kind: "variable_declarator", has: { field: "name", regex: "^metadata$" } } } } });
    const tags = (decl) => {
      const object = unparen(decl.find({ rule: { kind: "variable_declarator" } })?.field("value"));
      const pairs = object?.kind() === "object" ? kids(object).filter((p) => p.kind() !== "comment") : [];
      const read = (key) => pairs.find((p) => p.kind() === "pair" && p.field("key")?.text() === key)?.field("value")?.find({ rule: { kind: "string_fragment" } })?.text();
      const ok = pairs.length && pairs.every((p) => p.kind() === "pair" && ["title", "description"].includes(p.field("key")?.text()) && p.field("value").kind() === "string");
      return ok ? [read("title") && { tag: "title", props: { children: read("title") } }, read("description") && { tag: "meta", props: { name: "description", content: read("description") } }].filter(Boolean) : null;
    };
    if (next.kind === "page" || next.kind === "layout") {
      pass((root) => {
        const decl = metadata(root);
        const fn = componentFns(root).find((f) => f.kind() === "function_declaration" && (/^export\s+default\b/.test(f.parent()?.text() ?? "") || new RegExp(`^export\\s+default\\s+${f.field("name").text()}\\s*;?\\s*$`, "m").test(src)));
        const head = decl && tags(decl);
        if (!decl) return [];
        if (!head || !fn) {
          flag("Next.js", decl, `metadata: ${fn ? "only a string title and description convert" : "the component is still async"}; set the page's head with useHead from @solidjs/web in its component`);
          return [];
        }
        note("metadata -> useHead");
        const open = fn.field("body").child(0);
        const list = head.map((t) => `{ tag: ${JSON.stringify(t.tag)}, props: { ${Object.entries(t.props).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")} } }`).join(", ");
        return [dropLine(decl, src), { start: open.range().end.index, end: open.range().end.index, text: `\n  useHead([${list}]);` }];
      });
    }
    pass((root) => {
      for (const fn of root.findAll({ rule: { kind: "function_declaration", has: { field: "name", regex: "^generateMetadata$" } } }))
        flag("Next.js", fn, "generateMetadata has no Solid counterpart: compute the head in the component and set it with useHead from @solidjs/web (with the page's data, under the same async memo)");
      return [];
    });

    // R54 the root layout -> the start-mode document (src/Document.tsx): it renders <html> around the
    // app, and needs <HydrationScript /> and the meta tags Next.js added by itself in its <head>. Its
    // stylesheet imports and metadata go to src/App.tsx (returned as `document`), because the
    // document is server-only: it isn't hydrated, and only the app's CSS is linked.
    if (next.kind === "document") {
      document = { css: [], head: [] };
      pass((root) => {
        const edits = [];
        const decl = metadata(root);
        if (decl) {
          const head = tags(decl);
          if (head) document.head = head;
          else flag("Next.js", decl, "the root layout's metadata: only a string title and description convert; set the rest with useHead from @solidjs/web in src/App.tsx");
          edits.push(dropLine(decl, src));
        }
        for (const imp of root.findAll({ rule: { kind: "import_statement", has: { field: "source", regex: "\\.(css|scss|sass|less)[\"']$" } } })) {
          if (imp.text().includes(" from ")) continue;
          document.css.push(imp.field("source").text().slice(1, -1));
          edits.push(dropLine(imp, src));
        }
        const html = root.find({ rule: { kind: "jsx_element", has: { kind: "jsx_opening_element", has: { field: "name", regex: "^html$" } } } });
        const body = html && kids(html).find((c) => c.kind() === "jsx_element" && c.child(0)?.field("name")?.text() === "body");
        if (!html || !body) {
          flag("Next.js", html, "the root layout doesn't render <html> with a <body>: src/Document.tsx must render the whole document, with <HydrationScript /> from @solidjs/web in its <head>");
          return edits;
        }
        const inside = kids(body).filter((c) => c.kind() !== "jsx_opening_element" && c.kind() !== "jsx_closing_element" && !(c.kind() === "jsx_text" && !c.text().trim()));
        if (inside.length !== 1 || !/^\{\s*(props\.)?children\s*\}$/.test(inside[0].text()))
          flag("Next.js", body, "the root layout renders more than {children} in <body>: src/Document.tsx is server-only (it isn't hydrated), so move providers and interactive parts around the routes into src/App.tsx's <Router> root");
        const head = kids(html).find((c) => c.kind() === "jsx_element" && c.child(0)?.field("name")?.text() === "head");
        const indent = " ".repeat(body.range().start.column);
        const has = (re) => head && re.test(head.text());
        const added = [has(/<meta\s+charSet|<meta\s+charset/i) ? "" : '<meta charset="utf-8" />', has(/name="viewport"/) ? "" : '<meta name="viewport" content="width=device-width, initial-scale=1" />', "<HydrationScript />"].filter(Boolean);
        if (head) {
          const close = kids(head).find((c) => c.kind() === "jsx_closing_element");
          edits.push({ start: close.range().start.index, end: close.range().start.index, text: `  ${added.join(`\n${indent}  `)}\n${indent}` });
        } else edits.push({ start: body.range().start.index, end: body.range().start.index, text: `<head>\n${indent}  ${added.join(`\n${indent}  `)}\n${indent}</head>\n${indent}` });
        note("root layout -> Document");
        return edits;
      });
    }

    // A layout whose segment has a loading.tsx or error.tsx wraps its children in <Errored> and
    // <Loading>, where Next.js put its error boundary and Suspense.
    if (next.kind === "layout" && next.wrap) {
      pass((root) => {
        const fn = componentFns(root).find((f) => f.kind() === "function_declaration" && (/^export\s+default\b/.test(f.parent()?.text() ?? "") || new RegExp(`^export\\s+default\\s+${f.field("name").text()}\\s*;?\\s*$`, "m").test(src)));
        const slots = fn ? fn.findAll({ rule: { kind: "jsx_expression", regex: "^\\{\\s*(props\\.)?children\\s*\\}$" } }) : [];
        if (slots.length !== 1) {
          flag("Next.js", fn, `this segment's ${[next.wrap.loading && "loading.tsx", next.wrap.error && "error.tsx"].filter(Boolean).join(" and ")} wrapped its pages: put {children} in <Errored fallback={(err, reset) => ...}> and <Loading fallback={...}> by hand`);
          return [];
        }
        const loading = next.wrap.loading ? `<Loading fallback={<SegmentLoading />}>${slots[0].text()}</Loading>` : slots[0].text();
        const wrapped = next.wrap.error ? `<Errored fallback={(err, reset) => { const error = err(); return <SegmentError error={error instanceof Error ? error : new Error(String(error))} reset={reset} />; }}>${loading}</Errored>` : loading;
        const imports = [next.wrap.loading && `import SegmentLoading from ${JSON.stringify(next.wrap.loading)};\n`, next.wrap.error && `import SegmentError from ${JSON.stringify(next.wrap.error)};\n`].filter(Boolean).join("");
        const last = root.findAll({ rule: { kind: "import_statement" } }).at(-1);
        note("loading.tsx/error.tsx -> <Loading>/<Errored>");
        return [rep(slots[0], wrapped), { start: last ? last.range().end.index : 0, end: last ? last.range().end.index : 0, text: last ? `\n${imports.trimEnd()}` : imports }];
      });
    }

    // The root not-found.tsx is the catch-all route ([...404].tsx): it answers 404 during SSR.
    if (next.kind === "not-found") {
      pass((root) => {
        const last = root.findAll({ rule: { kind: "import_statement" } }).at(-1);
        const at = last ? last.range().end.index : 0;
        note("not-found -> [...404] route");
        return [{ start: at, end: at, text: `${last ? "\n\n" : ""}export const route = { preload: () => httpStatus(404) };${last ? "" : "\n\n"}` }];
      });
    }

    // A route handler (route.ts) -> an API route of filesystem-routing, which calls each method
    // export with an event: the Next.js handler is kept under another name and called with the
    // request, and with the params when it takes them (Next.js passes them as a promise).
    if (next.kind === "route") {
      pass((root) => {
        const edits = [];
        for (const fn of root.findAll({ rule: { kind: "function_declaration", has: { field: "name", regex: "^(GET|HEAD|POST|PUT|DELETE|PATCH|OPTIONS)$" }, inside: { kind: "export_statement" } } })) {
          const method = fn.field("name").text();
          const exp = fn.parent();
          const arity = kids(fn.field("parameters")).length;
          // A lowercase name: it isn't a component.
          const call = `next${method}(${arity === 0 ? "" : arity === 1 ? "event.request" : "event.request, { params: Promise.resolve(event.params ?? {}) }"})`;
          if (arity > 1) flag("Next.js", fn, `${method} takes the route's params: they come from event.params, typed Record<string, string> (Next.js typed them from the folder names)`);
          edits.push({ start: exp.range().start.index, end: fn.field("name").range().end.index, text: `${fn.text().startsWith("async") ? "async " : ""}function next${method}` });
          // `event` even when unused: R31 moves a zero-parameter arrow's type to its return.
          edits.push({ start: exp.range().end.index, end: exp.range().end.index, text: `\n\nexport const ${method}: APIHandler = (event) => ${call};` });
          note("route handler -> API route");
        }
        if (edits.length) edits.push({ start: 0, end: 0, text: `import type { APIHandler } from "filesystem-routing/api";\n` });
        for (const res of root.findAll({ rule: { kind: "member_expression", regex: "^NextResponse\\.json$" } })) edits.push(rep(res, "Response.json"));
        return edits;
      });
      if (!/\bNextResponse\b/.test(src.replace(/^import\b[^;]*;/gm, ""))) src = src.replace(/^import\s+\{\s*NextResponse\s*\}\s+from\s+["']next\/server["'];?[ \t]*\n/m, "");
    }
    // Next.js's Metadata type goes with the metadata export it typed (R53, R54).
    if (!/\bMetadata\b/.test(src.replace(/^import\b[^;]*;/gm, ""))) src = src.replace(/^import\s+type\s+\{\s*Metadata\s*\}\s+from\s+["']next["'];?[ \t]*\n/m, "");
  }

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
      if (DOM_ATTRS[n] && intrinsic) { note(`${n} -> ${DOM_ATTRS[n]}`); return [nameNode.replace(DOM_ATTRS[n])]; }
      // React-only hints with no Solid counterpart.
      if (intrinsic && /^suppress(Hydration|ContentEditable)Warning$/.test(n ?? "")) { note(`drop ${n}`); return [dropAttr(attr)]; }
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
  // The call around fn is cut away rather than fn's text copied, so a useCallback inside a memo'd
  // component still converts.
  pass((root) =>
    root.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: "^(React\\.)?(useCallback|memo|useEffectEvent)$" } } }).flatMap((call) => {
      const [fn] = kids(call.field("arguments"));
      if (!fn) return [];
      note(call.field("function").text().replace("React.", ""));
      return [{ start: call.range().start.index, end: fn.range().start.index, text: "" }, { start: fn.range().end.index, end: call.range().end.index, text: "" }];
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
  const fromReact = new Set([...input.matchAll(/^import\s+(?:type\s+)?(?:(\w+|\*\s+as\s+\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*["']react["']/gm)].flatMap((m) => [
    ...(m[1] ? [m[1].split(/\s+/).pop()] : []),
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
    // Solid has both under the same name.
    ...(fromReact.has("React") ? root.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: "^React\\.(createContext|useContext)$" } } }) : []).map((call) => {
      note("React.createContext/useContext -> Solid's");
      return call.field("function").replace(call.field("function").text().slice("React.".length));
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
      if (statements.at(-1)?.kind() !== "return_statement" || statements.length !== (destructure ? 2 : 1)) return [];
      const thisReads = body.findAll({ rule: { kind: "this" } });
      // With both, defaultProps become the destructured names' defaults, which R8 turns into merge;
      // a default not destructured isn't read. Not when a name has a default of its own, a rest
      // would miss a default, or the return reads this.props too.
      let pattern = destructure?.field("name").text();
      if (destructure && defaults) {
        const values = new Map(kids(defaults.field("value")).map((p) => [p.kind() === "pair" ? p.field("key").text().replace(/^(["'])(.*)\1$/, "$2") : null, p.field("value")]));
        const elements = kids(destructure.field("name"));
        const key = (e) => (e.kind() === "pair_pattern" ? e.field("key").text().replace(/^(["'])(.*)\1$/, "$2") : e.text());
        if (values.has(null) || thisReads.length > 1 || elements.some((e) => e.kind() === "object_assignment_pattern" || (e.kind() === "pair_pattern" && e.field("value")?.kind() !== "identifier"))) return [];
        if (elements.some((e) => e.kind() === "rest_pattern") && [...values.keys()].some((k) => !elements.some((e) => key(e) === k))) return [];
        pattern = textWith(destructure.field("name"), elements.filter((e) => e.kind() !== "rest_pattern" && values.has(key(e))).map((e) => ({ start: e.range().end.index, end: e.range().end.index, text: ` = ${values.get(key(e)).text()}` })));
      }
      const fnKinds = ["function_expression", "function_declaration", "generator_function", "generator_function_declaration", "method_definition", "class_body"];
      if (!thisReads.every((t) => t.parent()?.kind() === "member_expression" && t.parent().field("property")?.text() === "props" && !t.ancestors().some((a) => inside(a, body) && fnKinds.includes(a.kind())))) return [];
      // this.props becomes `props` (or `merged`), so the body can't have a name of its own like it.
      const holder = defaults ? freeName("merged") : "props";
      if (/(^|[^.\w$])props\b/.test(body.text())) return [];
      const typeArg = kids(heritage.find({ rule: { kind: "type_arguments" } }))[0]?.text();
      const param = `${pattern ?? "props"}${typeArg ? `: ${typeArg}` : ""}`;
      const edits = [...thisReads.map((t) => rep(t.parent(), holder)), ...(destructure ? [dropLine(first, src)] : [])];
      // The body moves out of the class: one level of indentation less.
      const column = (cls.parent()?.kind() === "export_statement" ? cls.parent() : cls).range().start.column;
      const shift = render.range().start.column - column;
      let text = textWith(body, edits).replace(new RegExp(`\n {${shift}}`, "g"), "\n");
      if (defaults && !destructure) {
        const indent = " ".repeat(column + 2);
        const rest = text.slice(1);
        // A one-line render body gets a line per statement.
        // Each literal keeps its literal type; `as const` on the object would make [] readonly never[].
        const object = defaults.field("value");
        const literals = kids(object).map((p) => p.kind() === "pair" && p.field("value")).filter((v) => v && (["string", "number", "true", "false"].includes(v.kind()) || (v.kind() === "unary_expression" && v.field("argument")?.kind() === "number")));
        text = `{\n${indent}const ${holder} = merge(${textWith(object, literals.map((v) => ({ start: v.range().end.index, end: v.range().end.index, text: " as const" })))}, props);${rest.startsWith("\n") ? rest : `\n${indent}${rest.trimStart().replace(/\s*\}$/, `\n${" ".repeat(column)}}`)}`}`;
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
          edits.push(...rewriteReads(body, statement, state.text(), `${state.text()}()`, body, "state"));
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
  // A useMemo that isn't assigned (a hook's `return useMemo(...)`) has no reads to rewrite.
  pass((root) =>
    root.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: "^(React\\.)?useMemo$" } } }).flatMap((call) => {
      const [fn] = kids(call.field("arguments"));
      if (!fn || !FN_KINDS.has(fn.kind())) return [];
      note("useMemo -> createMemo");
      return [rep(call.field("function"), "createMemo"), { start: fn.range().end.index, end: call.range().end.index - 1, text: "" }];
    }),
  );

  // R27 useRef used only as `x.current` and `ref={x}` -> a plain `let` and a ref callback. A ref
  // passed on as a value (to a hook, or returned) or written while the component renders becomes
  // a plain `{ current }` object: the body runs once, so that is what useRef was. A render-time
  // write is flagged: it now happens once.
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
      const refAttrs = [];
      let renderWrite = null;
      let object = false;
      for (const id of readsOf(body, name.text(), { exclude: [decl] })) {
        const p = id.parent();
        if (p.kind() === "member_expression" && p.field("property")?.text() === "current") {
          // a write during render (not inside a function or JSX) is render state, not a ref
          if (p.parent()?.kind() === "assignment_expression" && !p.ancestors().some((a) => inside(a, body) && !same(a, body) && (FN_KINDS.has(a.kind()) || a.kind() === "jsx_expression"))) renderWrite ??= p;
          edits.push(rep(p, name.text()));
        } else if (p.kind() === "jsx_expression" && p.parent()?.kind() === "jsx_attribute" && attrName(p.parent()) === "ref") {
          refAttrs.push(p);
        } else object = true; // passed on as a value
      }
      const initText = init?.text();
      const type = typeArg ? (initText === "null" ? `${typeArg} | null` : initText ? typeArg : `${typeArg} | undefined`) : null;
      if (object || renderWrite) {
        if (renderWrite) flag("ref", renderWrite, `${name.text()}.current is written while the component renders, and a Solid component renders once: it keeps the first value. Read what it copies (an accessor or props) where ${name.text()}.current is read`);
        note("useRef -> { current }");
        return [rep(statement, `const ${name.text()}${type ? `: { current: ${type} }` : ""} = { current: ${initText ?? "undefined"} };`), ...refAttrs.map((p) => rep(p, `{(element) => (${name.text()}.current = element)}`))];
      }
      note("useRef -> let");
      return [rep(statement, `let ${name.text()}${type ? `: ${type}` : ""}${initText ? ` = ${initText}` : ""};`), ...edits, ...refAttrs.map((p) => rep(p, `{(element) => (${name.text()} = element)}`))];
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
      // defaults: [prop, default value, the pattern's own name node]
      const names = [], defaults = [];
      let rest = null;
      let complex = false;
      for (const p of kids(pat)) {
        if (p.kind() === "shorthand_property_identifier_pattern") names.push([p.text(), p.text()]);
        else if (p.kind() === "object_assignment_pattern") { const k = p.field("left").text(); names.push([k, k]); defaults.push([k, p.field("right"), p.field("left")]); }
        else if (p.kind() === "pair_pattern" && p.field("value")?.kind() === "identifier") { names.push([p.field("value").text(), p.field("key").text()]); note("renamed prop"); }
        else if (p.kind() === "pair_pattern" && p.field("value")?.kind() === "assignment_pattern" && p.field("value").field("left")?.kind() === "identifier") {
          const k = p.field("key").text();
          names.push([p.field("value").field("left").text(), k]);
          defaults.push([k, p.field("value").field("right"), p.field("value").field("left")]);
          note("renamed prop");
        }
        else if (p.kind() === "rest_pattern" && /^\.\.\.\s*[\w$]+$/.test(p.text())) rest = p.text().replace(/^\.\.\./, "").trim();
        else { flag("complex props pattern", p, p.text()); complex = true; }
      }
      if (complex) continue;
      const key = (n) => (n === "className" ? "class" : n);
      // merge() unions a default's type with the prop's, so an empty [] or {} default would make the
      // merged prop never[] | T[]: it's applied where the prop is read instead. A literal keeps its
      // literal type (`as const`). A default that reads a prop before it (destructuring defaults
      // can) becomes a getter over props.
      const empty = new Map(defaults.filter(([, v]) => /^(\[\s*\]|\{\s*\})$/.test(v.text())).map(([k, v]) => [k, v.text()]));
      // A default can only read the props before it, so they're settled in order: a read of one with
      // a default of its own takes that default, its reads rewritten too.
      const defaultOf = new Map();
      const entries = [];
      for (const [k, v, own] of defaults) {
        const reads = names.filter(([local]) => local !== own.text()).flatMap(([local, from]) => readsOf(v.parent(), local, { exclude: [own] }).map((id) => readAs(id, defaultOf.has(from) ? `(props.${key(from)} ?? ${defaultOf.get(from)})` : `props.${key(from)}`)));
        const text = textWith(v, reads);
        defaultOf.set(k, ["identifier", "number", "string", "template_string", "true", "false", "null", "array", "object", "member_expression", "call_expression", "parenthesized_expression"].includes(v.kind()) ? text : `(${text})`);
        if (empty.has(k)) continue;
        const literal = ["string", "number", "true", "false"].includes(v.kind()) || (v.kind() === "unary_expression" && v.field("argument")?.kind() === "number");
        entries.push(reads.length ? `get ${key(k)}() { return ${text}; }` : `${key(k)}: ${text}${literal ? " as const" : ""}`);
      }
      const propsVar = entries.length ? "merged" : "props";
      const restVar = rest === "props" ? "others" : rest;
      const read = Object.fromEntries(names.map(([, k]) => [k, empty.has(k) ? `(${propsVar}.${key(k)} ?? ${empty.get(k)})` : `${propsVar}.${key(k)}`]));
      const pre = [];
      if (entries.length) pre.push(`const merged = merge({ ${entries.join(", ")} }, props);`);
      if (rest) pre.push(`const ${restVar} = omit(${propsVar}, ${names.map(([, k]) => JSON.stringify(key(k))).join(", ")});`);
      // A prop used as a JSX tag (`{ icon: Icon }` and `<Icon />`) becomes a component with dynamic(),
      // which follows the prop when it changes; the tag keeps its name.
      for (const [local, k] of names) {
        if (!/^[A-Z]/.test(local) || !body.find({ rule: { any: [{ kind: "jsx_opening_element" }, { kind: "jsx_self_closing_element" }], has: { field: "name", regex: `^${local}$` } } })) continue;
        if (/^import\b[^;]*\bdynamic\b[^;]*from\s*["'](?!@solidjs\/web["'])/m.test(src) || /\b(const|let|var|function|class)\s+dynamic\b/.test(src)) {
          flag("prop as tag", fn, `<${local}> renders the ${k} prop: write const ${local} = dynamic(() => ${read[k]}) with dynamic from @solidjs/web (this file has a dynamic of its own)`);
          continue;
        }
        pre.push(`const ${local} = dynamic(() => ${read[k]});`);
        note("prop as tag -> dynamic()");
      }
      edits.push(first.replace(`props${typeAnn}`));
      if (pre.length) edits.push(body.child(0).replace(`{\n  ${pre.join("\n  ")}`));
      for (const [local, k] of names) edits.push(...rewriteReads(body, null, local, read[k], body, "prop"));
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
  // The same for a field of it (`{x().icon ? <I name={x().icon} /> : null}`: the field's reads become
  // the callback's), and a ternary's other branch becomes the fallback. Show's callback gets an
  // accessor of the non-null value.
  pass((root) =>
    root.findAll({ rule: { kind: "jsx_expression", inside: { kind: "jsx_element" } } }).flatMap((ex) => {
      if (ex.parent()?.kind() !== "jsx_element") return [];
      const e = kids(ex)[0];
      if (!e) return [];
      let cond, jsx, fallback = null;
      if (e.kind() === "binary_expression" && e.field("operator")?.text() === "&&") { cond = unparen(e.field("left")); jsx = unparen(e.field("right")); }
      else if (e.kind() === "ternary_expression") { cond = unparen(e.field("condition")); jsx = unparen(e.field("consequence")); fallback = isNullish(e.field("alternative")) ? null : e.field("alternative"); }
      else return [];
      if (!isJsx(jsx)) return [];
      const when = cond.text();
      let param, hits = [];
      if (/^[A-Za-z_$][\w$]*\(\)$/.test(when)) {
        // the callback's parameter takes the accessor's name, so its reads inside stay as they are
        param = when.slice(0, -2);
        const calls = jsx.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: `^${param.replace(/\$/g, "\\$")}$` } } }).filter((c) => !kids(c.field("arguments")).length);
        if (!calls.some((c) => c.parent()?.kind() === "member_expression")) return [];
      } else if (/^[A-Za-z_$][\w$]*\(\)(\.[A-Za-z_$][\w$]*)+$/.test(when)) {
        hits = jsx.findAll({ rule: { kind: "member_expression" } }).filter((m) => m.text() === when && !(["call_expression", "assignment_expression"].includes(m.parent()?.kind()) && same(m.parent().field(m.parent().kind() === "call_expression" ? "function" : "left"), m)));
        if (!hits.length || hits.some((h) => /^jsx_(opening|closing|self_closing)_element$/.test(h.parent()?.kind() ?? ""))) return [];
        const base = when.split(".").pop();
        param = jsx.findAll({ rule: { kind: "identifier", regex: `^${base}$` } }).some((x) => !hits.some((h) => inside(x, h))) ? `${base}Value` : base;
      } else return [];
      note("guarded accessor -> <Show> callback");
      return [
        { start: ex.range().start.index, end: jsx.range().start.index, text: `<Show when={${when}}${fallback ? ` fallback=${asProp(fallback)}` : ""}>{(${param}) => ` },
        ...hits.map((h) => rep(h, `${param}()`)),
        { start: jsx.range().end.index, end: ex.range().end.index, text: "}</Show>" },
      ];
    }),
  );

  // R31 the compiler pass keeps a value's type on a const it turned into an accessor or memo;
  // the type belongs on what the function returns.
  pass((root) =>
    root.findAll({ rule: { kind: "variable_declarator", has: { field: "type", kind: "type_annotation" } } }).flatMap((d) => {
      const ann = d.field("type");
      const type = kids(ann)[0];
      const v = d.field("value");
      // A component's type (const App: React.FC = () => ...) is the function's, not its return's.
      if (!type || !v || /^(Accessor|Memo)\b|=>/.test(type.text()) || /^(React\.)?(FC|VFC|FunctionComponent|VoidFunctionComponent|ComponentType|Component|VoidComponent|ParentComponent)\b/.test(type.text())) return [];
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

  // R31 also: a hook annotated with the type of the value it returned now returns an accessor (a
  // createMemo, a return the compiler pass made a memo or an accessor, or its own memo or signal),
  // so the annotation becomes Accessor<T>.
  pass((root) =>
    root.findAll({ rule: { any: [{ kind: "function_declaration" }, { kind: "function_expression" }, { kind: "arrow_function" }], has: { field: "return_type", kind: "type_annotation" } } }).flatMap((fn) => {
      const type = kids(fn.field("return_type"))[0];
      const body = fn.field("body");
      if (!/^use[A-Z]/.test(fn.field("name")?.text() ?? fn.parent()?.field("name")?.text() ?? "") || !type || /^(Accessor|Memo)\b|=>/.test(type.text()) || body?.kind() !== "statement_block") return [];
      const returns = body.findAll({ rule: { kind: "return_statement" } }).filter((r) => same(r.ancestors().find((a) => FN_KINDS.has(a.kind())), fn));
      const accessors = new Set(body.findAll({ rule: { kind: "variable_declarator", has: { field: "value", kind: "call_expression", has: { field: "function", regex: "^(createMemo|createSignal)$" } } } }).map((d) => (d.field("name")?.kind() === "array_pattern" ? kids(d.field("name"))[0] : d.field("name"))?.text()));
      if (!returns.length || !returns.every((r) => {
        const v = unparen(arg(r));
        return !!v && ((v.kind() === "call_expression" && v.field("function")?.text() === "createMemo") || (v.kind() === "identifier" && accessors.has(v.text())) || (r.prev()?.kind() === "comment" && /^\/\/ solid: return: (memo|accessor) /.test(r.prev().text())));
      })) return [];
      note("hook return type -> Accessor<T>");
      introduced["solid-js"].add("Accessor");
      return [rep(type, `Accessor<${type.text()}>`)];
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
  const isReactType = (name) => name.startsWith("React.") || fromReact.has(name);
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
      // Only the name is replaced, so edits inside the type arguments still apply.
      if (/^(ComponentType|FC|FunctionComponent)$/.test(bare) && isReactType(name)) { note("ComponentType -> Component"); introduced["solid-js"].add("Component"); return [(t.kind() === "generic_type" ? t.field("name") : t).replace("Component")]; }
      if (/^(VFC|VoidFunctionComponent)$/.test(bare) && isReactType(name)) { note("VFC -> VoidComponent"); introduced["solid-js"].add("VoidComponent"); return [(t.kind() === "generic_type" ? t.field("name") : t).replace("VoidComponent")]; }
      if (bare === "PropsWithChildren" && isReactType(name)) { note("PropsWithChildren -> ParentProps"); introduced["solid-js"].add("ParentProps"); return [(t.kind() === "generic_type" ? t.field("name") : t).replace("ParentProps")]; }
      // React's ElementType is a tag name or a component; so is @solidjs/web's ValidComponent.
      if (bare === "ElementType" && !args.length && isReactType(name)) { note("ElementType -> ValidComponent"); introduced["@solidjs/web"].add("ValidComponent"); return [t.replace("ValidComponent")]; }
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

  // R46 tests: @testing-library/react's API -> @solidjs/testing-library's (R44 moves the import),
  // when the project moves to the port. Solid 2 applies writes on flush(), and RTL ran act()
  // around render, fireEvent and act's own callback: act(fn) becomes fn's body and flush(), and
  // each fireEvent statement gets a flush() after it. render takes a function; a rerender with new
  // literal props becomes a signal per prop that changes; renderHook takes its props as an array
  // and hands back the hook's value itself, with cleanup for unmount.
  const testing = ports["@testing-library/react"] ? Object.fromEntries([...src.matchAll(/^import\s+\{([^}]*)\}\s*from\s*["']@testing-library\/react["']/gm)]
    .flatMap((m) => m[1].split(",").map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)).filter(([name]) => name).map(([name, local]) => [name, local ?? name]))) : {};
  const RERENDER = "@solidjs/testing-library's render has no rerender: a component runs once and reads its props where they're used. Put each prop that changes in a signal, render(() => <X a={a()} />), then call setA(...) and flush() where rerender was";
  // React 19 exports act from react too; R10 drops that import.
  const acts = [testing.act, fromReact.has("act") ? "act" : null].filter(Boolean);
  if (acts.length) {
    pass((root) =>
      root.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: `^(${acts.join("|")})$` } } }).flatMap((call) => {
        const awaited = call.parent()?.kind() === "await_expression";
        const statement = awaited ? call.parent().parent() : call.parent();
        const [cb, ...more] = kids(call.field("arguments")).filter((a) => a.kind() !== "comment");
        const body = cb?.field("body");
        const returns = body?.kind() === "statement_block" && body.findAll({ rule: { kind: "return_statement" } }).some((r) => same(r.ancestors().find((a) => FN_KINDS.has(a.kind())), cb));
        if (statement?.kind() !== "expression_statement" || !["arrow_function", "function_expression"].includes(cb?.kind()) || more.length || returns || (/^async\b/.test(cb.text()) && !awaited)) {
          flag("act", call, "@solidjs/testing-library has no act: Solid 2 applies writes on flush() (from solid-js). Run the callback's body, then call flush(), or await a findBy query");
          return [];
        }
        const indent = " ".repeat(statement.range().start.column);
        let inner;
        if (body.kind() !== "statement_block") inner = `${awaited ? "await " : ""}${unparen(body).text()};`;
        // A declaration in the callback keeps its block, so its name stays scoped.
        else if (kids(body).some((s) => /^(lexical_declaration|variable_declaration|function_declaration|class_declaration)$/.test(s.kind()))) inner = body.text();
        else {
          // One level of indentation less.
          const shift = Math.max(0, (kids(body)[0]?.range().start.column ?? 0) - statement.range().start.column);
          inner = body.text().slice(1, -1).trim().split("\n").map((line) => line.replace(new RegExp(`^ {0,${shift}}`), "")).join("\n");
        }
        note("act(fn) -> body + flush()");
        return [rep(statement, inner ? `${inner}\n${indent}flush();` : "flush();")];
      }),
    );
    if (testing.act && !new RegExp(`\\b${testing.act}\\b`).test(src.replace(/^import\b[^;]*?\bfrom\s*["'][^"'\n]*["'];?[ \t]*$/gm, ""))) {
      src = src.replace(/^import\s+\{([^}]*)\}\s*(from\s*["']@testing-library\/react["'];?)[ \t]*\n/m, (m, list, from) => {
        const rest = list.split(",").map((s) => s.trim()).filter((s) => s && s.split(/\s+as\s+/).pop() !== testing.act);
        return rest.length ? `import { ${rest.join(", ")} } ${from}\n` : "";
      });
    }
  }
  if (testing.fireEvent) {
    pass((root) =>
      root.findAll({ rule: { kind: "expression_statement", has: { kind: "call_expression", has: { field: "function", regex: `^${testing.fireEvent}(\\.\\w+)?$` } } } }).flatMap((statement) => {
        if (/^flush\(\)/.test(statement.next()?.text() ?? "")) return [];
        note("fireEvent -> fireEvent + flush()");
        const end = statement.range().end.index;
        return [{ start: end, end, text: `\n${" ".repeat(statement.range().start.column)}flush();` }];
      }),
    );
  }
  if (testing.render) {
    // const { rerender } = render(<X a={1} />); rerender(<X a={2} />) -> a signal per prop that
    // changes, set before a flush() where rerender was. Only literal values: a function would be
    // read as an updater. Any other shape is flagged by the next pass.
    pass((root) => {
      const edits = [];
      for (const call of root.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: `^${testing.render}$` } } })) {
        const decl = call.parent();
        const pattern = decl?.kind() === "variable_declarator" ? decl.field("name") : null;
        const prop = pattern?.kind() === "object_pattern" ? kids(pattern).find((p) => (p.kind() === "pair_pattern" ? p.field("key") : p).text() === "rerender") : null;
        const statement = decl?.parent();
        const scope = statement?.parent();
        if (!prop || !scope || kids(statement).length !== 1) continue;
        const rerenders = readsOf(scope, prop.kind() === "pair_pattern" ? prop.field("value").text() : "rerender", { exclude: [pattern] }).map((id) => id.parent());
        if (!rerenders.length || !rerenders.every((c) => c?.kind() === "call_expression" && c.parent()?.kind() === "expression_statement")) continue;
        const elements = [call, ...rerenders].map((c) => unparen(kids(c.field("arguments"))[0]));
        const opens = elements.map((el) => (el?.kind() === "jsx_element" ? el.child(0) : el));
        const bodies = elements.map((el) => (el?.kind() === "jsx_element" ? el.children().slice(1, -1).map((c) => c.text()).join("") : ""));
        if (!opens.every((o) => ["jsx_opening_element", "jsx_self_closing_element"].includes(o?.kind()) && o.field("name").text() === opens[0].field("name").text()) || bodies.some((b) => b !== bodies[0])) continue;
        if (opens.some((o) => kids(o).some((a) => a.kind() === "jsx_expression" || (a.kind() === "jsx_attribute" && !/^[A-Za-z_$][\w$]*$/.test(attrName(a)))))) continue;
        // Each element's props: the value's text, and whether it's a literal.
        const values = opens.map((o) => new Map(kids(o).filter((a) => a.kind() === "jsx_attribute").map((a) => {
          const v = attrValue(a);
          return [attrName(a), { text: v ? v.text() : "true", literal: !v || ["string", "template_string", "number", "true", "false", "null", "undefined"].includes(v.kind()) || (v.kind() === "unary_expression" && v.field("argument")?.kind() === "number") }];
        })));
        const missing = { text: "undefined", literal: true };
        const changing = [...new Set(values.flatMap((m) => [...m.keys()]))].filter((n) => values.some((m) => (m.get(n) ?? missing).text !== (values[0].get(n) ?? missing).text));
        if (!changing.length || !changing.every((n) => values.every((m) => (m.get(n) ?? missing).literal))) continue;
        const tag = opens[0].field("name").text();
        const indent = " ".repeat(statement.range().start.column);
        // Named after the prop, apart from the file's own names (a prop name in JSX isn't one).
        const taken = new Set(root.findAll({ rule: { any: [{ kind: "identifier" }, { kind: "shorthand_property_identifier" }, { kind: "shorthand_property_identifier_pattern" }] } }).map((id) => id.text()));
        const signals = new Map(changing.map((n) => {
          let name = n;
          for (let i = 2; taken.has(name) || taken.has(`set${ucfirst(name)}`); i++) name = `${n}${i}`;
          taken.add(name).add(`set${ucfirst(name)}`);
          return [n, [name, `set${ucfirst(name)}`]];
        }));
        const declarations = changing.map((n) => `const [${signals.get(n).join(", ")}] = createSignal<ComponentProps<${/^[a-z]/.test(tag) ? JSON.stringify(tag) : `typeof ${tag}`}>[${JSON.stringify(n)}]>(${(values[0].get(n) ?? missing).text});\n${indent}`).join("");
        for (const n of changing) {
          const attr = kids(opens[0]).find((a) => a.kind() === "jsx_attribute" && attrName(a) === n);
          const end = opens[0].field("name").range().end.index;
          edits.push(attr ? rep(attr, `${n}={${signals.get(n)[0]}()}`) : { start: end, end, text: ` ${n}={${signals.get(n)[0]}()}` });
        }
        const others = kids(pattern).filter((p) => !same(p, prop));
        if (others.length) edits.push({ start: statement.range().start.index, end: statement.range().start.index, text: declarations }, rep(pattern, `{ ${others.map((p) => p.text()).join(", ")} }`));
        else edits.push({ start: statement.range().start.index, end: call.range().start.index, text: declarations });
        rerenders.forEach((c, i) => {
          const sets = changing.filter((n) => (values[i + 1].get(n) ?? missing).text !== (values[i].get(n) ?? missing).text).map((n) => `${signals.get(n)[1]}(${(values[i + 1].get(n) ?? missing).text});`);
          edits.push(rep(c.parent(), [...sets, "flush();"].join(`\n${" ".repeat(c.parent().range().start.column)}`)));
        });
        note("rerender -> signal props + flush()");
      }
      return edits;
    });
    // render(<X />) -> render(() => <X />). Options only React reads are flagged, and so is what
    // the result has no counterpart for.
    pass((root) =>
      root.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: `^${testing.render}$` } } }).flatMap((call) => {
        const [ui, options] = kids(call.field("arguments")).filter((a) => a.kind() !== "comment");
        const reactOnly = options?.kind() === "object" ? kids(options).map((p) => (p.kind() === "pair" ? p.field("key") : p).text()).filter((k) => /^(legacyRoot|onCaughtError|onRecoverableError|onUncaughtError|reactStrictMode|formState)$/.test(k)) : [];
        if (reactOnly.length) flag("render", call, `${reactOnly.join(", ")}: React-only render options with no counterpart in @solidjs/testing-library; remove them (an error boundary in the test is <Errored>)`);
        const decl = call.parent()?.kind() === "variable_declarator" ? call.parent() : null;
        const name = decl?.field("name");
        const used = name?.kind() === "object_pattern" ? kids(name).map((p) => (p.kind() === "pair_pattern" ? p.field("key") : p).text())
          : name?.kind() === "identifier" && decl.parent()?.parent() ? readsOf(decl.parent().parent(), name.text()).map((id) => (id.parent()?.kind() === "member_expression" ? id.parent().field("property")?.text() : null)) : [];
        if (used.includes("rerender")) flag("rerender", call, RERENDER);
        if (used.includes("asFragment")) flag("render", call, "asFragment() returns the container's innerHTML, a string, not a DocumentFragment: update the snapshots it's compared with");
        if (!ui || FN_KINDS.has(ui.kind())) return [];
        if (ui.kind() === "identifier") flag("render", call, `${ui.text()} is an element made before render() runs, outside its root: pass a function that makes it, render(() => <X />), and have callers pass one too`);
        note("render(ui) -> render(() => ui)");
        return [rep(ui, `() => ${ui.text()}`)];
      }),
    );
  }
  // renderHook(fn, { initialProps: p }) -> renderHook(fn, { initialProps: [p] }) (the hook's
  // arguments); result.current -> result, unmount -> cleanup.
  if (testing.renderHook) {
    pass((root) =>
      root.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: `^${testing.renderHook}$` } } }).flatMap((call) => {
        const edits = [];
        const [, options] = kids(call.field("arguments")).filter((a) => a.kind() !== "comment");
        if (options && options.kind() !== "object") flag("renderHook", call, `Solid's renderHook takes initialProps as an array of the hook's arguments: check what ${options.text()} passes`);
        for (const p of options?.kind() === "object" ? kids(options) : []) {
          if (p.kind() === "shorthand_property_identifier" && p.text() === "initialProps") edits.push(rep(p, "initialProps: [initialProps]"));
          else if (p.kind() === "pair" && p.field("key")?.text() === "initialProps" && p.field("value")?.kind() !== "array") edits.push(rep(p.field("value"), `[${p.field("value").text()}]`));
        }
        const decl = call.parent()?.kind() === "variable_declarator" ? call.parent() : null;
        const name = decl?.field("name");
        const scope = decl?.parent()?.parent();
        // `result.current` reads, and the result's other members: destructured, or read off the result.
        let current = [];
        const members = [];
        if (name?.kind() === "object_pattern" && scope) {
          for (const p of kids(name)) {
            const key = (p.kind() === "pair_pattern" ? p.field("key") : p).text();
            if (key === "result") current = readsOf(scope, p.kind() === "pair_pattern" ? p.field("value").text() : key, { exclude: [name] }).map((id) => id.parent()).filter((m) => m?.kind() === "member_expression" && m.field("property")?.text() === "current");
            else members.push([key, p]);
          }
        } else if (name?.kind() === "identifier" && scope) {
          for (const m of readsOf(scope, name.text()).map((id) => id.parent()).filter((m) => m?.kind() === "member_expression")) {
            if (m.field("property")?.text() === "result" && m.parent()?.kind() === "member_expression" && m.parent().field("property")?.text() === "current") current.push(m.parent());
            else members.push([m.field("property")?.text(), m]);
          }
        }
        // Solid's renderHook returns the value the hook returned, so `result` is it. Read whole (not
        // a field), it depends on whether the hook now returns an accessor.
        for (const m of current) {
          edits.push(rep(m, m.field("object").text()));
          if (!(m.parent()?.kind() === "member_expression" && same(m.parent().field("object"), m))) flag("renderHook", m, `${m.text()} was the hook's value; it's ${m.field("object").text()} now. If the hook now returns an accessor, call it: ${m.field("object").text()}()`);
        }
        for (const [key, node] of members) {
          if (key === "unmount") edits.push(node.kind() === "shorthand_property_identifier_pattern" ? rep(node, "cleanup: unmount") : rep(node.kind() === "pair_pattern" ? node.field("key") : node.field("property"), "cleanup"));
          if (key === "rerender") flag("rerender", node, "Solid's renderHook has no rerender: the hook runs once. Pass it signals (initialProps: [a]) and set them, then flush()");
        }
        note("renderHook -> Solid's renderHook");
        return edits;
      }),
    );
  }

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
    // React's own hooks left over are flagged once, as React APIs (R10). A hook under test in
    // renderHook is read through its result (R46). R53's useHead is @solidjs/web's.
    if (!/^use(Context|State|Memo|Callback|Effect|LayoutEffect|Ref)$/.test(c.field("function").text()) && !fromReact.has(c.field("function").text()) && !c.ancestors().some((a) => a.kind() === "call_expression" && a.field("function")?.text() === testing.renderHook) && !(next && c.field("function").text() === "useHead")) flag("custom hook call", c, `${c.field("function").text()}() returns values in React; decide value vs accessor`);

  // R44 a library whose Solid 2 port exports its names (`lacks` lists the ones it doesn't) is
  // imported from the port, so the code matches the package.json the run writes (or, for a catalog
  // range, the swap the run asks for). An import of a name the port lacks is flagged with what to
  // use; a subpath of the library has no port to point at.
  pass((root) =>
    root.findAll({ rule: { any: [{ kind: "import_statement" }, { kind: "export_statement" }], has: { field: "source", kind: "string" } } }).flatMap((imp) => {
      const source = imp.field("source");
      const from = source.text().slice(1, -1);
      const port = ports[from];
      if (!port?.lacks) {
        const library = Object.keys(ports).find((name) => ports[name].lacks && from.startsWith(`${name}/`));
        if (library) flag("ported library", imp, `${from} is a subpath of ${library}, whose imports now come from ${ports[library].to}: find its counterpart there`);
        return [];
      }
      for (const spec of imp.findAll({ rule: { any: [{ kind: "import_specifier" }, { kind: "export_specifier" }] } })) {
        const name = spec.field("name")?.text();
        if (Object.hasOwn(port.lacks, name)) flag("ported library", spec, `${name} from ${port.to}: ${port.lacks[name]}`);
      }
      note(`${from} -> ${port.to}`);
      return [rep(source, `${source.text()[0]}${port.to}${source.text()[0]}`)];
    }),
  );

  // R45 react-dom's createPortal(children, container) -> <Portal mount={container}>, from @solidjs/web.
  const portalImport = /^import\s*\{\s*createPortal\s*\}\s*from\s*["']react-dom["'];?[ \t]*\n/m;
  if (portalImport.test(src)) {
    const portals = pass((root) =>
      root.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: "^createPortal$" } } }).flatMap((call) => {
        const [children, container, ...more] = kids(call.field("arguments")).filter((a) => a.kind() !== "comment");
        if (!children || !container || more.length) return [];
        note("createPortal -> <Portal>");
        const element = `<Portal mount={${container.text()}}>${asChild(children)}</Portal>`;
        // Inside JSX, `{createPortal(...)}` becomes the element itself.
        return [call.parent()?.kind() === "jsx_expression" ? rep(call.parent(), element) : rep(call, element)];
      }),
    );
    if (portals && !/\bcreatePortal\b/.test(src.replace(portalImport, ""))) src = src.replace(portalImport, "");
  }

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
  // Names the file already imports from Solid (it was converted before, or written for Solid): a
  // second import of one would be a duplicate identifier.
  const have = new Set([...src.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'](?:solid-js|@solidjs\/web)["']/gm)].flatMap((m) => m[1].split(",").map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()).filter(Boolean)));
  const solidNames = [
    // `lazy` by its call: loading="lazy" (R48's <img>) isn't a use.
    ...["createSignal", "createMemo", "createContext", "useContext", "createEffect", "onSettled", "merge", "omit", "For", "createUniqueId", "lazy"].filter((n) => used(new RegExp(n === "lazy" ? "\\blazy\\(" : `\\b${n}\\b`))).filter((n) => !have.has(n)).filter(free((n) => new RegExp(`\\b${n}\\b`))),
    ...["Show", "Switch", "Match", "Loading", ...(next ? ["Errored"] : [])].filter((n) => used(new RegExp(`<${n}\\b`))).filter((n) => !have.has(n)).filter(free((n) => new RegExp(`<${n}\\b`))),
    ...["untrack", "flush"].filter((n) => used(new RegExp(`\\b${n}\\(`))).filter((n) => !have.has(n)).filter(free((n) => new RegExp(`\\b${n}\\(`))),
  ];
  const webNames = [...(renders ? ["render"] : []), ...["Portal", ...(next ? ["HydrationScript"] : [])].filter((n) => used(new RegExp(`<${n}\\b`))), ...["dynamic", ...(next ? ["useHead", "httpStatus"] : [])].filter((n) => used(new RegExp(`\\b${n}\\(`)))].filter((n) => !have.has(n)).filter(free((n) => new RegExp(/^[A-Z]/.test(n) ? `<${n}\\b` : `\\b${n}\\(`)));
  const webTypes = [...new Set([...["JSX", "ComponentProps"].filter((n) => used(new RegExp(`\\b${n}\\b`))), ...introduced["@solidjs/web"]])].filter((n) => !have.has(n)).filter(free((n) => new RegExp(`\\b${n}\\b`)));
  // `extends Component<P, S>` is React's class (R39), not Solid's Component type, and so is React.Component.
  const solidTypes = [...new Set([...["Component", "Setter"].filter((n) => new RegExp(`(^|[^.\\w$])${n}<`).test(code.replace(/\bextends\s+Component</g, ""))), ...introduced["solid-js"]])].filter((n) => !have.has(n)).filter(free((n) => new RegExp(`\\b${n}\\b`)));
  let removedReact = false;
  src = src.replace(/^import\s+(type\s+)?(\*\s+as\s+React|React(,\s*\{[^}]*\})?|\{[^}]*\})\s+from\s+["']react["'];?[ \t]*\n/gm, () => { removedReact = true; return ""; });
  src = src.replace(/^import\s+\{\s*flushSync\s*\}\s+from\s+["']react-dom["'];?[ \t]*\n/gm, "");
  // New names join the file's own import from that module when it has one.
  const lines = [];
  // R52 and R51's names from @solidjs/router, when the code still uses them.
  const fromRouter = (names) => [...names].filter((n) => used(new RegExp(`\\b${n}\\b`)) && !new RegExp(`\\b${n}\\b`).test(elsewhere));
  for (const [module, type, names] of [["solid-js", false, solidNames], ["solid-js", true, solidTypes], ["@solidjs/web", false, webNames], ["@solidjs/web", true, webTypes], ["@solidjs/router", false, fromRouter(routerNames)], ["@solidjs/router", true, fromRouter(routerTypes)]]) {
    if (!names.length) continue;
    const existing = new RegExp(`^import\\s+${type ? "type\\s+" : ""}\\{([^}]*)\\}\\s*from\\s*["']${module.replace("/", "\\/")}["']`, "m");
    if (existing.test(src)) src = src.replace(existing, (m, list) => m.replace(`{${list}}`, () => `{ ${[...list.split(",").map((s) => s.trim()).filter(Boolean), ...names].join(", ")} }`));
    else lines.push(`import ${type ? "type " : ""}{ ${names.join(", ")} } from "${module}";`);
  }
  // A class R39 left still extends React's Component or PureComponent, so that import stays (React's
  // Component as ReactComponent when the file now uses Solid's Component type).
  const bases = [...new Set([...code.matchAll(/\bextends\s+((?:React\.)?(?:Pure)?Component)\b/g)].map((m) => m[1]))].filter((b) => b.startsWith("React.") || fromReact.has(b));
  if (removedReact && bases.length) {
    const clash = solidTypes.includes("Component") || have.has("Component");
    const named = bases.filter((b) => !b.startsWith("React.")).map((b) => (b === "Component" && clash ? "Component as ReactComponent" : b));
    if (clash) src = src.replace(/\bextends\s+Component\b/g, "extends ReactComponent");
    if (bases.some((b) => b.startsWith("React."))) lines.push(`import * as React from "react";`);
    if (named.length) lines.push(`import { ${named.join(", ")} } from "react";`);
  }
  if (lines.length) src = src.replace(/^(["']use client["'];\n\n?)?/, (m) => `${m}${lines.join("\n")}\n`);
  // The Next.js imports removed above can leave the file starting with a blank line.
  if (next) src = src.replace(/^\n+/, "");
  if (removedReact) note("react imports -> solid-js");
  src = src.replace(/^["']use client["'];\n\n?/m, () => { note("drop 'use client'"); return ""; });
  // The React Compiler's own directives mean nothing to Solid.
  src = src.replace(/^[ \t]*["']use (no )?memo["'];?[ \t]*\n/gm, () => { note("drop React Compiler directive"); return ""; });
  // Anything else the file imported from react, or still imports from react-dom, has no conversion
  // here: each name is flagged where it's first used, with what to use when there's something.
  const leftover = []; // [name, detail]
  if (removedReact) {
    const body = src.replace(/^import\b[^;]*?\bfrom\s*["'][^"'\n]*["'];?[ \t]*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    const imported = (src.match(/^import\b[^;]*?\bfrom\s*["'][^"'\n]*["'];?[ \t]*$/gm) ?? []).join("\n");
    for (const name of fromReact) {
      if (name === "React") continue;
      // Without the import, an event type React and the DOM share a name with is the DOM's: right.
      if (REACT_EVENTS[name] === name) continue;
      // `JSX.CSSProperties` isn't a use of React's CSSProperties.
      if (new RegExp(`(^|[^.\\w$])${name}\\b`).test(body) && !new RegExp(`\\b${name}\\b`).test(imported)) leftover.push([name, `${name} was imported from react and has no conversion here; its import was removed${REACT_API[name] ? `. ${REACT_API[name]}` : ""}`]);
    }
  }
  for (const m of src.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'](react-dom(?:\/\w+)?)["']/gm)) {
    for (const name of m[1].split(",").map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]).filter(Boolean)) {
      leftover.push([name, `${name} from ${m[2]}: @solidjs/web replaces react-dom${REACT_API[name] ? `. ${REACT_API[name]}` : ", and has no counterpart"}`]);
    }
  }
  // Each at the first line that uses it.
  const sourceLines = src.split("\n");
  for (const [name, detail] of leftover) flags.push({ kind: "React API", line: sourceLines.findIndex((l) => !/^\s*(import\b|\/\/)/.test(l) && new RegExp(`(^|[^.\\w$])${name}\\b`).test(l)) + 1, detail });
  if (/\bReact\.\w+/.test(src)) flag("React namespace", null, [...new Set(src.match(/\bReact\.\w+/g))].join(", "));

  return { code: src, applied, flags, ...(document ? { document } : {}) };
}

