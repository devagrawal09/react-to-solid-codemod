// Moves a React app's package.json, tsconfig and Vite config to Solid 2. Each function takes a
// file's text and returns { text, changes, flags }: what it changed, and what it left for a person
// ({ kind, detail }). Edits keep the file's own formatting: comments, indentation, quotes and key
// order. Like the rule pass, nothing here touches Node, so it runs in the workflow's sandbox.

// Checked on npm against solid-js 2.0.3, Nov 19. A dependency step will replace these tables.
export const SOLID = "2.0.3";
// @solidjs/vite-plugin 3 needs Vite 8 or 9.
const VITE = "8.3.8";

// React libraries and their Solid 2 ports. With a version, apply mode installs the port in the
// React package's place (a prerelease exactly, a release with ^); without one, it's only reported.
export const PORTS = {
  react: { to: "solid-js", version: SOLID },
  "react-dom": { to: "@solidjs/web", version: SOLID },
  "@tanstack/react-query": { to: "@tanstack/solid-query", version: "6.0.0-rc.6", note: "the first version for Solid 2, on the rc tag" },
  "@tanstack/react-router": { to: "@tanstack/solid-router", version: "2.0.0-rc.11", note: "on the rc tag; it still depends on some Solid 1 helper packages, so expect peer warnings" },
  "react-router": { to: "@solidjs/router", version: "2.0.0", note: "a different API: routes, loaders and hooks need rewriting" },
  "react-router-dom": { to: "@solidjs/router", version: "2.0.0", note: "a different API: routes, loaders and hooks need rewriting" },
  // lucide-solid is the Solid 1 package.
  "lucide-react": { to: "@lucide/solid", version: "1.76.0" },
  "@base-ui/react": { to: "@solidports/base-ui", note: "installs and works on Solid 2.0.x, with type errors on stable (HTMLAttributes gained a data-* index signature in @solidjs/web rc.16) and dev warnings in a few form components until a fix release; render takes a tag or a function, render={(p) => <a {...p} />}, not an element" },
  "@base-ui-components/react": { to: "@solidports/base-ui", note: "Base UI's old name. The port installs and works on Solid 2.0.x, with type errors on stable (HTMLAttributes gained a data-* index signature in @solidjs/web rc.16) and dev warnings in a few form components until a fix release; render takes a tag or a function, render={(p) => <a {...p} />}, not an element" },
  "@vitejs/plugin-react": { to: "@solidjs/vite-plugin", version: "3.0.1", note: "needs Vite 8 or 9 and Node 22.12 or newer" },
  "@vitejs/plugin-react-swc": { to: "@solidjs/vite-plugin", version: "3.0.1", note: "needs Vite 8 or 9 and Node 22.12 or newer" },
  "@testing-library/react": { to: "@solidjs/testing-library", version: "1.0.0-rc.2", note: "tests aren't converted: render takes a function, render(() => <App />), and there is no rerender with new props" },
  // Not a port: the same package, given Solid's JSX runtime instead of React's.
  "hast-util-to-jsx-runtime": { to: "hast-util-to-jsx-runtime", note: "pass jsx, jsxs and Fragment from @solidjs/h/jsx-runtime, with elementAttributeNameCase: \"html\" and stylePropertyNameCase: \"css\"" },
};
// Libraries with no Solid 2 port yet, and what to do instead. Names without "react" in them only
// show up in the plan when they're listed here.
export const NO_PORT = {
  "@effect/atom-react": "@effect/atom-solid peers solid-js <2; Solid 2 support is in Effect-TS/effect#10764, not released yet",
  zustand: "the React hook (create) has no Solid 2 port: solid-zustand is Solid 1 only. Subscribe to the vanilla store into a signal created with ownedWrite: true (about 40 lines)",
  "@tanstack/react-pacer": "@tanstack/solid-pacer 0.24 doesn't run on Solid 2 (TanStack/pacer#307 ports it); the Debouncer and Throttler classes from @tanstack/pacer work as they are",
  "@clerk/react": "clerk-solidjs doesn't run on Solid 2 and is Clerk Core 2; @resonant-projects/clerk-solidjs covers Core 3 but peers solid-js 1",
  "@clerk/electron": "no Solid version",
  "react-markdown": "solid-markdown is Solid 1 only and has no urlTransform: render with unified and hast-util-to-jsx-runtime, given jsx, jsxs and Fragment from @solidjs/h/jsx-runtime (elementAttributeNameCase: \"html\", stylePropertyNameCase: \"css\")",
  "@legendapp/list": "no Solid version",
  "gt-react": "no Solid version",
  "react-day-picker": "no Solid version",
  "@daypicker/react": "no Solid version",
  "@pierre/diffs": "its React entry (@pierre/diffs/react) has no Solid version",
  "@pierre/trees": "its React entry (@pierre/trees/react) has no Solid version",
  "@dnd-kit/core": "no verified Solid 2 port",
  "@dnd-kit/sortable": "no verified Solid 2 port",
  "@dnd-kit/utilities": "no verified Solid 2 port",
  "@dnd-kit/modifiers": "no verified Solid 2 port",
  "@dnd-kit/react": "no verified Solid 2 port",
};
// React-only packages the converted app no longer needs.
const REMOVED = new Set(["@types/react", "@types/react-dom", "babel-plugin-react-compiler"]);
// Left in place: removing them breaks the lint config that loads them.
const LINT_PLUGINS = new Set(["eslint-plugin-react", "eslint-plugin-react-hooks", "eslint-plugin-react-refresh"]);

// A JSONC value with string indexes: { start, end }, plus `entries` for an object or array. An
// entry has its own start and end, the object key if any, its value, and the index of the comma
// after it.
function parseJsonc(text) {
  let i = 0;
  const skip = () => {
    for (;;) {
      if (/\s/.test(text[i] ?? "")) i++;
      else if (text.startsWith("//", i)) i = text.includes("\n", i) ? text.indexOf("\n", i) : text.length;
      else if (text.startsWith("/*", i) && text.includes("*/", i + 2)) i = text.indexOf("*/", i + 2) + 2;
      else return;
    }
  };
  const value = () => {
    skip();
    const start = i;
    if (text[i] === "{" || text[i] === "[") {
      const object = text[i] === "{";
      const entries = [];
      i++;
      skip();
      while (text[i] !== (object ? "}" : "]")) {
        if (i >= text.length) throw new Error("unterminated object or array");
        const entry = { start: i };
        if (object) {
          if (text[i] !== '"') throw new Error(`expected a key at ${i}`);
          const key = value();
          entry.key = JSON.parse(text.slice(key.start, key.end));
          skip();
          if (text[i++] !== ":") throw new Error(`expected ':' at ${i - 1}`);
        }
        entry.value = value();
        entry.end = entry.value.end;
        skip();
        if (text[i] === ",") {
          entry.comma = i++;
          skip();
        }
        entries.push(entry);
      }
      i++;
      return { start, end: i, entries };
    }
    if (text[i] === '"') {
      for (i++; text[i] !== '"'; i++) {
        if (i >= text.length) throw new Error("unterminated string");
        if (text[i] === "\\") i++;
      }
      i++;
      return { start, end: i };
    }
    while (i < text.length && !/[\s,\]}/]/.test(text[i])) i++;
    if (i === start) throw new Error(`unexpected ${JSON.stringify(text[i] ?? "end of file")} at ${i}`);
    return { start, end: i };
  };
  const root = value();
  skip();
  if (i < text.length) throw new Error(`unexpected text at ${i}`);
  return root;
}

// package.json: React packages out, their Solid 2 ports in, each dependency list rewritten in its
// own order with new names inserted alphabetically. A `catalog:` or `workspace:` range is defined
// elsewhere, so it's reported instead.
export function migratePackageJson(text) {
  const changes = [];
  const flags = [];
  const root = parseJsonc(text);
  const sections = ["dependencies", "devDependencies"].map((key) => root.entries?.find((e) => e.key === key)).filter((pair) => pair?.value.entries);
  const present = new Set(sections.flatMap((pair) => pair.value.entries.map((e) => e.key)));
  const edits = [];
  for (const pair of sections) {
    const kept = [];
    const added = [];
    let changed = false;
    for (const e of pair.value.entries) {
      const range = JSON.parse(text.slice(e.value.start, e.value.end));
      const port = PORTS[e.key];
      const elsewhere = /^(catalog|workspace):/.test(range);
      if (REMOVED.has(e.key) && !elsewhere) {
        changes.push(`removed ${e.key}`);
        changed = true;
        continue;
      }
      if (port?.version && !elsewhere) {
        const spec = port.version.includes("-") ? port.version : `^${port.version}`;
        if (!present.has(port.to)) added.push([port.to, JSON.stringify(spec)]);
        present.add(port.to);
        changes.push(`${e.key} -> ${port.to}@${spec}${port.note ? ` (${port.note})` : ""}`);
        changed = true;
        continue;
      }
      if (port?.version || REMOVED.has(e.key)) flags.push({ kind: "dependency", detail: `${e.key} is "${range}": ${port ? `replace it with ${port.to}@${port.version}` : "remove it"} where that range is defined` });
      else if (port) flags.push({ kind: "dependency", detail: `${e.key} -> ${port.to}: ${port.note}` });
      else if (NO_PORT[e.key]) flags.push({ kind: "dependency", detail: `${e.key} has no Solid 2 port: ${NO_PORT[e.key]}` });
      else if (LINT_PLUGINS.has(e.key)) flags.push({ kind: "dependency", detail: `${e.key} lints React code: remove it and its lint config, or switch to eslint-plugin-solid` });
      else if (/react/i.test(e.key)) flags.push({ kind: "dependency", detail: `${e.key} has no known Solid 2 port` });
      kept.push([e.key, text.slice(e.value.start, e.value.end)]);
    }
    if (pair.key === "dependencies") {
      for (const name of ["solid-js", "@solidjs/web"]) {
        if (present.has(name)) continue;
        present.add(name);
        added.push([name, JSON.stringify(`^${SOLID}`)]);
        changes.push(`added ${name}@^${SOLID}`);
        changed = true;
      }
    }
    // @solidjs/vite-plugin needs Vite 8 or 9.
    const vite = kept.find(([name]) => name === "vite");
    if (vite && added.some(([name]) => name === "@solidjs/vite-plugin")) {
      const major = Number(JSON.parse(vite[1]).match(/^[\^~>=v\s]*(\d+)\./)?.[1]);
      if (!major) flags.push({ kind: "dependency", detail: `vite is ${vite[1]}: @solidjs/vite-plugin needs Vite 8 or 9` });
      else if (major < 8) {
        changes.push(`vite ${JSON.parse(vite[1])} -> ^${VITE}: @solidjs/vite-plugin needs Vite 8 or 9; check your other Vite plugins and Vitest against Vite 8`);
        vite[1] = JSON.stringify(`^${VITE}`);
        changed = true;
      }
    }
    if (!changed) continue;
    for (const entry of added) {
      const at = kept.findIndex(([name]) => name > entry[0]);
      kept.splice(at < 0 ? kept.length : at, 0, entry);
    }
    // Rewrite the list with the indentation it had.
    const object = pair.value;
    const outer = text.slice(text.lastIndexOf("\n", pair.start - 1) + 1, pair.start);
    const first = object.entries[0];
    const inner = first ? text.slice(text.lastIndexOf("\n", first.start - 1) + 1, first.start) : `${outer}  `;
    const pairs = kept.map(([name, value]) => `${JSON.stringify(name)}: ${value}`);
    const body = !pairs.length ? "{}" : /^\s*$/.test(inner) && /^\s*$/.test(outer) ? `{\n${pairs.map((p) => inner + p).join(",\n")}\n${outer}}` : `{ ${pairs.join(", ")} }`;
    edits.push({ start: object.start, end: object.end, text: body });
  }
  const out = edits.sort((a, b) => b.start - a.start).reduce((t, e) => t.slice(0, e.start) + e.text + t.slice(e.end), text);
  return { text: out, changes, flags };
}

// tsconfig: Solid's JSX. Only a file that sets `jsx` gets `jsxImportSource` (`jsx` says whether
// it's on); `types` loses React's.
export function migrateTsconfig(text) {
  const changes = [];
  const flags = [];
  const root = parseJsonc(text);
  const options = root.entries?.find((e) => e.key === "compilerOptions")?.value;
  if (!options?.entries) return { text, changes, flags, jsx: false };
  const edits = [];
  const jsx = options.entries.find((e) => e.key === "jsx");
  if (jsx && text.slice(jsx.value.start, jsx.value.end) !== '"preserve"') {
    edits.push({ start: jsx.value.start, end: jsx.value.end, text: '"preserve"' });
    changes.push(`jsx ${text.slice(jsx.value.start, jsx.value.end)} -> "preserve"`);
  }
  const source = options.entries.find((e) => e.key === "jsxImportSource");
  if (jsx && source && text.slice(source.value.start, source.value.end) !== '"@solidjs/web"') {
    edits.push({ start: source.value.start, end: source.value.end, text: '"@solidjs/web"' });
    changes.push(`jsxImportSource ${text.slice(source.value.start, source.value.end)} -> "@solidjs/web"`);
  } else if (jsx && !source) {
    // On the line after jsx, or right after it when the next option shares its line.
    const indent = text.slice(text.lastIndexOf("\n", jsx.start - 1) + 1, jsx.start);
    const next = options.entries[options.entries.indexOf(jsx) + 1];
    const lineEnd = text.includes("\n", jsx.end) ? text.indexOf("\n", jsx.end) : text.length;
    const pair = '"jsxImportSource": "@solidjs/web"';
    if (jsx.comma == null) edits.push({ start: jsx.end, end: jsx.end, text: /^\s*$/.test(indent) ? `,\n${indent}${pair}` : `, ${pair}` });
    else if (/^\s*$/.test(indent) && !(next && next.start < lineEnd)) edits.push({ start: lineEnd, end: lineEnd, text: `\n${indent}${pair},` });
    else edits.push({ start: jsx.comma + 1, end: jsx.comma + 1, text: ` ${pair},` });
    changes.push('added jsxImportSource "@solidjs/web"');
  }
  const types = options.entries.find((e) => e.key === "types")?.value;
  const react = (types?.entries ?? []).filter((e) => /^"(react|react-dom|@types\/react|@types\/react-dom)"$/.test(text.slice(e.start, e.end)));
  if (react.length) {
    const names = react.map((e) => text.slice(e.start, e.end)).join(", ");
    if (text.slice(types.start, types.end).includes("\n")) flags.push({ kind: "build config", detail: `remove ${names} from compilerOptions.types` });
    else {
      edits.push({ start: types.start, end: types.end, text: `[${types.entries.filter((e) => !react.includes(e)).map((e) => text.slice(e.start, e.end)).join(", ")}]` });
      changes.push(`removed ${names} from types`);
    }
  }
  const out = edits.sort((a, b) => b.start - a.start).reduce((t, e) => t.slice(0, e.start) + e.text + t.slice(e.end), text);
  return { text: out, changes, flags, jsx: !!jsx };
}

// vite.config: `import react from "@vitejs/plugin-react"` and `plugins: [react()]` become Solid's
// plugin. Options that only mean something to React (the React Compiler's babel setup, the JSX
// runtime, Fast Refresh) are dropped; any other shape is flagged.
export function migrateViteConfig(text, { parse, Lang }) {
  const root = parse(Lang.Tsx, text).root();
  const imports = root.findAll({ rule: { kind: "import_statement", has: { field: "source", regex: "^['\"]@vitejs/plugin-react(-swc)?['\"]$" } } });
  if (!imports.length) return { text, changes: [], flags: [] };
  const name = imports.length === 1 ? imports[0].text().match(/^import\s+([\w$]+)\s+from\s/)?.[1] : null;
  const calls = name ? root.findAll({ rule: { kind: "call_expression", has: { field: "function", regex: `^${name.replace(/\$/g, "\\$")}$` } } }) : [];
  const call = calls.length === 1 ? calls[0] : null;
  const plugins = call?.parent()?.parent();
  const args = call ? call.field("arguments").children().filter((c) => c.isNamed() && c.kind() !== "comment") : [];
  const options = args[0]?.kind() === "object" ? args[0].children().filter((c) => c.isNamed() && c.kind() !== "comment") : [];
  const keys = options.map((o) => (o.kind() === "pair" ? o.field("key")?.text().replace(/["']/g, "") : o.text()));
  // React-only options: the JSX runtime, Fast Refresh, and a babel setup that only runs the React Compiler.
  const unknown = keys.find((key, i) => {
    const strings = key === "babel" && options[i].kind() === "pair" ? options[i].field("value").findAll({ rule: { kind: "string_fragment" } }).map((s) => s.text()) : [];
    return !["jsxRuntime", "jsxImportSource", "fastRefresh"].includes(key) && !(strings.length && strings.every((s) => s === "babel-plugin-react-compiler"));
  });
  const problem = !name ? "the React plugin is imported in a way this step doesn't rewrite"
    : !call || call.parent()?.kind() !== "array" || plugins?.kind() !== "pair" || plugins.field("key")?.text().replace(/["']/g, "") !== "plugins" ? `${name}() isn't called once, in plugins: [...]`
    : args.length > 1 || (args[0] && args[0].kind() !== "object") ? `${call.text()} takes options this step can't read`
    : unknown ? `the ${unknown} option of ${name}() has no counterpart in @solidjs/vite-plugin`
    : /\bsolid\b/.test(text) ? "`solid` is already a name in this file"
    // String indexes come from the nodes' text: codemod/ast-grep reports byte offsets.
    : [imports[0], call].some((node) => text.indexOf(node.text()) !== text.lastIndexOf(node.text())) ? "the plugin's import or call appears more than once"
    : null;
  if (problem) return { text, changes: [], flags: [{ kind: "build config", detail: `${problem}. By hand: import solid from "@solidjs/vite-plugin" and put solid() in plugins` }] };
  const out = [[imports[0], imports[0].text().replace(/^import\s+[\w$]+/, "import solid").replace(/@vitejs\/plugin-react(-swc)?/, "@solidjs/vite-plugin")], [call, "solid()"]]
    .reduce((t, [node, to]) => t.replace(node.text(), () => to), text);
  return { text: out, changes: [`${name}() -> solid() from @solidjs/vite-plugin${keys.length ? `, dropping the React-only ${keys.join(", ")} option${keys.length > 1 ? "s" : ""}` : ""}`], flags: [] };
}
