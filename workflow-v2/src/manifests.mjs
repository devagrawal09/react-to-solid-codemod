// Moves a React app's package.json, tsconfig and Vite config to Solid 2. Each function takes a
// file's text and returns { text, changes, flags }: what it changed, and what it left for a person
// ({ kind, detail }). Edits keep the file's own formatting: comments, indentation, quotes and key
// order. Like the rule pass, nothing here touches Node, so it runs in the workflow's sandbox.

// Checked on npm against solid-js 2.0.3, Nov 19. A dependency step will replace these tables.
export const SOLID = "2.0.3";
// @solidjs/vite-plugin 3 needs Vite 8 or 9.
const VITE = "8.3.8";
// @solidjs/vite-plugin 3.0.1 takes @testing-library/jest-dom up to 7 (an optional peer): npm won't
// install 8 next to it.
const JEST_DOM = "7.0.1";

// What the React package's types are called, when the port doesn't export them.
const SOLID_QUERY_TYPE = "not exported by @tanstack/solid-query: use the closest one it has (UseQueryOptions, UseQueryResult, UseInfiniteQueryOptions, UseMutationOptions, UseMutationResult)";
const SOLID_TESTING_TYPE = "not exported by @solidjs/testing-library: use ReturnType<typeof render> or Parameters<typeof render>[1]";

// React libraries and their Solid 2 ports. With a version, apply mode installs the port in the
// React package's place (a prerelease exactly, a release with ^); without one, it's only reported.
// With `lacks`, the port exports the React package's names but those (each with what to use): the
// rule pass (R44) points the code's imports at the port and flags an import of one of them.
// Checked against each port's type declarations on Nov 19 (@tanstack/react-query 5.102.8,
// lucide-react 1.31.0, @testing-library/react 16.2.0).
export const PORTS = {
  react: { to: "solid-js", version: SOLID },
  "react-dom": { to: "@solidjs/web", version: SOLID },
  "@tanstack/react-query": {
    to: "@tanstack/solid-query",
    version: "6.0.0-rc.6",
    note: "the first version for Solid 2, on the rc tag",
    lacks: {
      useSuspenseQuery: "use useQuery: reading its data suspends under <Loading>, which is what useSuspenseQuery did",
      useSuspenseInfiniteQuery: "use useInfiniteQuery: reading its data suspends under <Loading>",
      useSuspenseQueries: "use useQueries: reading a query's data suspends under <Loading>",
      usePrefetchQuery: "call useQueryClient().prefetchQuery(...) in the component body",
      usePrefetchInfiniteQuery: "call useQueryClient().prefetchInfiniteQuery(...) in the component body",
      HydrationBoundary: "no HydrationBoundary: call hydrate(queryClient, state) (re-exported from @tanstack/query-core) before rendering",
      QueryErrorResetBoundary: "no error reset boundary: wrap the queries in <Errored fallback={(err, reset) => ...}> and call queryClient.resetQueries() before reset()",
      useQueryErrorResetBoundary: "no error reset boundary: wrap the queries in <Errored fallback={(err, reset) => ...}> and call queryClient.resetQueries() before reset()",
      IsRestoringProvider: "use IsRestoringContext, whose value is an accessor",
      ...Object.fromEntries(["AnyUseBaseQueryOptions", "AnyUseInfiniteQueryOptions", "AnyUseMutationOptions", "AnyUseQueryOptions", "AnyUseSuspenseInfiniteQueryOptions", "AnyUseSuspenseQueryOptions", "HydrationBoundaryProps", "QueriesOptions", "QueriesResults", "QueryErrorClearResetFunction", "QueryErrorIsResetFunction", "QueryErrorResetBoundaryFunction", "QueryErrorResetBoundaryProps", "QueryErrorResetFunction", "SuspenseQueriesOptions", "SuspenseQueriesResults", "UnusedSkipTokenInfiniteOptions", "UnusedSkipTokenOptions", "UseMutateAsyncFunction", "UsePrefetchInfiniteQueryOptions", "UsePrefetchQueryOptions", "UseSuspenseInfiniteQueryOptions", "UseSuspenseInfiniteQueryResult", "UseSuspenseQueryOptions", "UseSuspenseQueryResult"].map((name) => [name, SOLID_QUERY_TYPE])),
    },
  },
  // solid1Peers: its dependencies peer on solid-js 1, which pnpm's strict peer check rejects.
  "@tanstack/react-router": { to: "@tanstack/solid-router", version: "2.0.0-rc.11", note: "on the rc tag; it still depends on some Solid 1 helper packages, so expect peer warnings", solid1Peers: true },
  "react-router": { to: "@solidjs/router", version: "2.0.0", note: "a different API: routes, loaders and hooks need rewriting" },
  "react-router-dom": { to: "@solidjs/router", version: "2.0.0", note: "a different API: routes, loaders and hooks need rewriting" },
  // lucide-solid is the Solid 1 package.
  "lucide-react": {
    to: "@lucide/solid",
    version: "1.76.0",
    lacks: {
      createLucideIcon: "@lucide/solid has no createLucideIcon: render <Icon iconNode={...} /> (Icon from @lucide/solid)",
      useLucideContext: "@lucide/solid exports LucideContext: read it with useContext(LucideContext)",
    },
  },
  "@base-ui/react": { to: "@solidports/base-ui", note: "installs and works on Solid 2.0.x, with type errors on stable (HTMLAttributes gained a data-* index signature in @solidjs/web rc.16) and dev warnings in a few form components until a fix release; render takes a tag or a function, render={(p) => <a {...p} />}, not an element" },
  "@base-ui-components/react": { to: "@solidports/base-ui", note: "Base UI's old name. The port installs and works on Solid 2.0.x, with type errors on stable (HTMLAttributes gained a data-* index signature in @solidjs/web rc.16) and dev warnings in a few form components until a fix release; render takes a tag or a function, render={(p) => <a {...p} />}, not an element" },
  "@vitejs/plugin-react": { to: "@solidjs/vite-plugin", version: "3.0.1", note: "needs Vite 8 or 9 and Node 22.12 or newer" },
  "@vitejs/plugin-react-swc": { to: "@solidjs/vite-plugin", version: "3.0.1", note: "needs Vite 8 or 9 and Node 22.12 or newer" },
  "@testing-library/react": {
    to: "@solidjs/testing-library",
    version: "1.0.0-rc.2",
    note: "R46 converts the tests: render takes a function, render(() => <App />), and act and rerender become flush() and signals",
    lacks: {
      act: "@solidjs/testing-library has no act: Solid 2 applies writes on flush() (from solid-js); call it, or await a findBy query",
      ...Object.fromEntries(["RenderResult", "RenderOptions", "BaseRenderOptions", "ClientRenderOptions", "HydrateOptions", "RenderHookResult", "RenderHookOptions", "BaseRenderHookOptions", "ClientRenderHookOptions", "HydrateHookOptions"].map((name) => [name, SOLID_TESTING_TYPE])),
    },
  },
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
  "@testing-library/react-hooks": "renderHook is in @solidjs/testing-library, which replaces @testing-library/react: import it from there, with initialProps as an array of the hook's arguments and the hook's value as result (not result.current)",
  // Next.js and the libraries made for it.
  next: "Next.js has no Solid 2 equivalent: the closest is @solidjs/vite-plugin's start mode, with file routes through fileRoutes() from @solidjs/router/fs, or SolidStart",
  "next-themes": "made for Next.js: keep the theme in a signal and set it on <html>",
  nuqs: "made for Next.js: read and write search params with useSearchParams from @solidjs/router",
  "@t3-oss/env-nextjs": "made for Next.js: @t3-oss/env-core with Vite's import.meta.env",
  geist: "made for Next.js (next/font): load the Geist fonts with CSS @font-face or @fontsource",
  "next-intl": "made for Next.js: no Solid 2 port",
};
// React-only packages the converted app no longer needs.
const REMOVED = new Set(["@types/react", "@types/react-dom", "babel-plugin-react-compiler"]);
// Left in place: removing them breaks the lint config that loads them.
const LINT_PLUGINS = new Set(["eslint-plugin-react", "eslint-plugin-react-hooks", "eslint-plugin-react-refresh", "eslint-config-next"]);
// What a Next.js app moved to file routes (nextRoutes) runs on instead of next: the router in
// dependencies, the build in devDependencies, as solidjs/templates' solid-v2/fullstack has them.
const NEXT_ROUTES = { dependencies: [["@solidjs/router", "^2.0.0"]], devDependencies: [["@solidjs/vite-plugin", "^3.0.1"], ["filesystem-routing", "^0.5.0"], ["vite", `^${VITE}`]] };
// next's commands -> start mode's: `vite` serves and `vite build` builds both bundles; the build
// writes dist/server/node.js (start.nodeServer), which serves the app on PORT, 3000 by default.
const NEXT_SCRIPTS = { dev: "vite", build: "vite build", start: "node dist/server/node.js" };

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

// The packages in a lockfile that peer on react or react-dom, directly or through a peer that does
// (nuqs peers on next, which peers on react), by name; null when the lockfile doesn't record peers
// (yarn 1). npm's package-lock.json is JSON; pnpm-lock.yaml lists packages two spaces in under
// `packages:`, and yarn berry's yarn.lock at the top level, each with a `peerDependencies:` block,
// read line by line.
export function reactPeers(path, text) {
  const peersOf = new Map();
  if (path.endsWith("package-lock.json")) {
    for (const [key, entry] of Object.entries(JSON.parse(text).packages ?? {})) {
      const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
      if (name) peersOf.set(name, new Set([...(peersOf.get(name) ?? []), ...Object.keys(entry.peerDependencies ?? {})]));
    }
  } else {
    const pnpm = path.endsWith("pnpm-lock.yaml");
    if (!pnpm && !/^__metadata:/m.test(text)) return null;
    const entry = pnpm ? 2 : 0;
    let section = pnpm ? "" : "packages";
    let name = null;
    let peers = false;
    for (const line of text.split("\n")) {
      const indent = line.search(/\S/);
      if (indent < 0 || line.trimStart().startsWith("#")) continue;
      if (pnpm && indent === 0) section = line.trim();
      else if (section !== "packages:" && section !== "packages") continue;
      else if (indent === entry) {
        // 'name@1.0.0':, /name@1.0.0(peer@1):, "name@npm:^1, name@npm:^2":
        const key = line.trim().replace(/:$/, "").replace(/^["']|["']$/g, "").split(",")[0].trim().replace(/^\//, "");
        name = key.match(/^(@?[^@]+)@/)?.[1] ?? null;
        peers = false;
        if (name && !peersOf.has(name)) peersOf.set(name, new Set());
      } else if (indent === entry + 2) peers = line.trim() === "peerDependencies:";
      else if (peers && name && indent === entry + 4) {
        const peer = line.trim().match(/^["']?(@?[^"':]+)["']?:/)?.[1];
        if (peer) peersOf.get(name).add(peer);
      }
    }
  }
  return reactPeerClosure(peersOf);
}

// Of the packages in `peersOf` (each name and the names it peers on), those that peer on react or
// react-dom, directly or through a peer that does, sorted. The workflow builds `peersOf` from
// dependencyGraph (codemod/deps); reactPeers above builds it from a lockfile's text.
export function reactPeerClosure(peersOf) {
  const react = new Set(["react", "react-dom"]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, peers] of peersOf) {
      if (react.has(name) || ![...peers].some((p) => react.has(p))) continue;
      react.add(name);
      grew = true;
    }
  }
  return [...react].filter((name) => peersOf.has(name) && name !== "react" && name !== "react-dom").sort();
}

// package.json: React packages out, their Solid 2 ports in, each dependency list (peers included)
// rewritten in its own order with new names inserted alphabetically. A `catalog:` or `workspace:` range is defined
// elsewhere, so it's reported instead. `peers` (from reactPeers) says which other packages depend
// on React; without it, a name with "react" in it does. With `next` (nextRoutes), next goes too, the
// router and start mode's build come in (NEXT_ROUTES), and the scripts that run next run Vite.
export function migratePackageJson(text, peers = null, { next = false } = {}) {
  const changes = [];
  const flags = [];
  const root = parseJsonc(text);
  const sections = ["dependencies", "devDependencies", "peerDependencies"].map((key) => root.entries?.find((e) => e.key === key)).filter((pair) => pair?.value.entries);
  const present = new Set(sections.filter((pair) => pair.key !== "peerDependencies").flatMap((pair) => pair.value.entries.map((e) => e.key)));
  // A library (a workspace package converted with its app) peers on React: it peers on Solid instead,
  // and doesn't get its own copy in dependencies.
  const library = sections.some((pair) => pair.key === "peerDependencies" && pair.value.entries.some((e) => e.key === "react" || e.key === "react-dom"));
  const edits = [];
  for (const pair of sections) {
    const kept = [];
    const added = [];
    // Peers are their own list: a library peers on what it also has in devDependencies.
    const seen = pair.key === "peerDependencies" ? new Set(pair.value.entries.map((e) => e.key)) : present;
    const peer = pair.key === "peerDependencies" ? "peer " : "";
    let changed = false;
    for (const e of pair.value.entries) {
      const range = JSON.parse(text.slice(e.value.start, e.value.end));
      const port = PORTS[e.key];
      const elsewhere = /^(catalog|workspace):/.test(range);
      if (next && e.key === "next" && !elsewhere) {
        changes.push("removed next: @solidjs/vite-plugin's start mode serves and builds the app");
        changed = true;
        continue;
      }
      if (REMOVED.has(e.key) && !elsewhere) {
        changes.push(`removed ${peer}${e.key}`);
        changed = true;
        continue;
      }
      if (port?.version && !elsewhere) {
        const spec = port.version.includes("-") ? port.version : `^${port.version}`;
        if (!seen.has(port.to)) added.push([port.to, JSON.stringify(spec)]);
        seen.add(port.to);
        changes.push(`${peer}${e.key} -> ${port.to}@${spec}${port.note ? ` (${port.note})` : ""}`);
        changed = true;
        continue;
      }
      // The converted code already imports the port (R44), so it matches once the range is swapped.
      if (port?.version || REMOVED.has(e.key)) flags.push({ kind: "dependency", detail: `${e.key} is "${range}": ${port ? `replace it with ${port.to}@${port.version}` : "remove it"} where that range is defined${port?.lacks ? `; the converted files already import ${port.to}` : ""}` });
      else if (port) flags.push({ kind: "dependency", detail: `${e.key} -> ${port.to}: ${port.note}` });
      else if (NO_PORT[e.key]) flags.push({ kind: "dependency", detail: `${e.key} has no Solid 2 port: ${NO_PORT[e.key]}` });
      else if (LINT_PLUGINS.has(e.key)) flags.push({ kind: "dependency", detail: `${e.key} lints React code: remove it and its lint config, or switch to eslint-plugin-solid` });
      else if (peers ? peers.includes(e.key) : /react/i.test(e.key)) flags.push({ kind: "dependency", detail: peers ? `${e.key} depends on React (peer) and has no known Solid 2 port` : `${e.key} has no known Solid 2 port` });
      kept.push([e.key, text.slice(e.value.start, e.value.end)]);
    }
    if (pair.key === "dependencies" && !library) {
      for (const name of ["solid-js", "@solidjs/web"]) {
        if (present.has(name)) continue;
        present.add(name);
        added.push([name, JSON.stringify(`^${SOLID}`)]);
        changes.push(`added ${name}@^${SOLID}`);
        changed = true;
      }
    }
    // Build tools go in devDependencies, or in dependencies when there are none.
    const nextAdds = !next || pair.key === "peerDependencies" ? [] : pair.key === "dependencies" ? [...NEXT_ROUTES.dependencies, ...(sections.some((p) => p.key === "devDependencies") ? [] : NEXT_ROUTES.devDependencies)] : NEXT_ROUTES.devDependencies;
    for (const [name, spec] of nextAdds) {
      if (present.has(name)) continue;
      present.add(name);
      added.push([name, JSON.stringify(spec)]);
      changes.push(`added ${name}@${spec}`);
      changed = true;
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
    const jestDom = kept.find(([name]) => name === "@testing-library/jest-dom");
    if (jestDom && ["@vitejs/plugin-react", "@vitejs/plugin-react-swc"].some((name) => present.has(name)) && Number(JSON.parse(jestDom[1]).match(/^[\^~>=v\s]*(\d+)\./)?.[1]) > 7) {
      changes.push(`@testing-library/jest-dom ${JSON.parse(jestDom[1])} -> ^${JEST_DOM}: @solidjs/vite-plugin takes jest-dom up to 7, and npm won't install 8 next to it`);
      jestDom[1] = JSON.stringify(`^${JEST_DOM}`);
      changed = true;
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
  // `next dev`, `next build` and `next start` (with or without Turbopack) -> NEXT_SCRIPTS; any other
  // next command, or one with options, is flagged.
  for (const e of (next && root.entries?.find((s) => s.key === "scripts")?.value.entries) || []) {
    const command = JSON.parse(text.slice(e.value.start, e.value.end));
    if (typeof command !== "string") continue;
    const swapped = command.replace(/(^|[\s;&|])next (dev|build|start)(?: --turbo(?:pack)?)?(?=\s*($|&&|\|\||;))/g, (_, lead, cmd) => `${lead}${NEXT_SCRIPTS[cmd]}`);
    if (swapped !== command) {
      edits.push({ start: e.value.start, end: e.value.end, text: JSON.stringify(swapped) });
      changes.push(`scripts.${e.key}: ${command} -> ${swapped}`);
    }
    if (/(^|[\s;&|])next(\s|$)/.test(swapped)) flags.push({ kind: "dependency", detail: `scripts.${e.key} runs "${swapped}", and next is gone: run Vite instead (vite, vite build, vite preview), or remove it` });
  }
  // Next.js didn't need it; Vite and the built server are ES modules, which Node and Vite then
  // detect by reparsing, with a warning. Not added: a CommonJS .js config in the package would break.
  if (next && !root.entries?.some((e) => e.key === "type")) flags.push({ kind: "build config", detail: `package.json has no "type": "module": vite.config.ts and dist/server/node.js are ES modules, which Vite and Node reparse with a warning. Add it once no .js file in the package uses require or module.exports` });
  const out = edits.sort((a, b) => b.start - a.start).reduce((t, e) => t.slice(0, e.start) + e.text + t.slice(e.end), text);
  return { text: out, changes, flags };
}

// tsconfig: Solid's JSX. Only a file that sets `jsx` gets `jsxImportSource` (`jsx` says whether
// it's on); `types` loses React's. A `paths` entry into the source of another workspace package
// that depends on React is flagged: that source now compiles as Solid JSX. `dir` is the tsconfig's
// directory and `reactPackages` those packages' directories, both from the repo root.
export function migrateTsconfig(text, { dir = "", reactPackages = [] } = {}) {
  const changes = [];
  const flags = [];
  const root = parseJsonc(text);
  const options = root.entries?.find((e) => e.key === "compilerOptions")?.value;
  if (!options?.entries) return { text, changes, flags, jsx: false };
  const baseUrl = options.entries.find((e) => e.key === "baseUrl");
  const base = [dir, baseUrl ? JSON.parse(text.slice(baseUrl.value.start, baseUrl.value.end)) : ""].filter(Boolean).join("/");
  for (const path of options.entries.find((e) => e.key === "paths")?.value.entries ?? []) {
    for (const target of path.value.entries ?? []) {
      const to = JSON.parse(text.slice(target.start, target.end));
      const segments = [];
      for (const s of `${to.startsWith("/") ? "" : base}/${to.replace(/\*.*$/, "")}`.split("/")) {
        if (s === "..") segments.pop();
        else if (s && s !== ".") segments.push(s);
      }
      const resolved = segments.join("/");
      const pkg = reactPackages.find((p) => resolved === p || resolved.startsWith(`${p}/`));
      if (pkg) flags.push({ kind: "build config", detail: `paths maps "${path.key}" to ${to}, the source of ${pkg}, which depends on React: with "jsxImportSource": "@solidjs/web" it now compiles as Solid JSX. Convert ${pkg} too, or point the path at its built output` });
    }
  }
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

// vite.config and vitest.config: `import react from "@vitejs/plugin-react"` and `plugins: [react()]`
// become Solid's plugin. Options that only mean something to React (the React Compiler's babel
// setup, the JSX runtime, Fast Refresh) are dropped; any other shape is flagged. In test mode the
// plugin sets up Solid's tests itself (the browser and development conditions, solid-js inlined,
// jest-dom's matchers), so the test block only needs a DOM environment.
export function migrateViteConfig(text, { parse, Lang, vitest = false }) {
  const root = parse(Lang.Tsx, text).root();
  const imports = root.findAll({ rule: { kind: "import_statement", has: { field: "source", regex: "^['\"]@vitejs/plugin-react(-swc)?['\"]$" } } });
  const tests = [];
  // A node environment is the plugin's sign of server tests: it resolves Solid's server build.
  for (const environment of root.findAll({ rule: { kind: "pair", has: { field: "key", regex: "^['\"]?environment['\"]?$" }, inside: { kind: "pair", has: { field: "key", regex: "^['\"]?test['\"]?$" }, stopBy: "end" } } })) {
    const value = environment.field("value")?.text().replace(/^["'`]|["'`]$/g, "");
    if (value === "node" || value === "edge-runtime") tests.push({ kind: "build config", detail: `test.environment is "${value}", which @solidjs/vite-plugin takes for server tests: it resolves Solid's server build, where render() throws. Use "jsdom" (or "happy-dom") for component tests, and set "${value}" per file (// @vitest-environment ${value}) where a test needs it` });
  }
  if (vitest && !imports.length && !/@solidjs\/vite-plugin|\bmergeConfig\b/.test(text)) tests.push({ kind: "build config", detail: "this Vitest config doesn't load @solidjs/vite-plugin, which compiles Solid's JSX in tests: add solid() from it to plugins, or mergeConfig this config with vite.config" });
  if (!imports.length) return { text, changes: [], flags: tests };
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
  if (problem) return { text, changes: [], flags: [{ kind: "build config", detail: `${problem}. By hand: import solid from "@solidjs/vite-plugin" and put solid() in plugins` }, ...tests] };
  const out = [[imports[0], imports[0].text().replace(/^import\s+[\w$]+/, "import solid").replace(/@vitejs\/plugin-react(-swc)?/, "@solidjs/vite-plugin")], [call, "solid()"]]
    .reduce((t, [node, to]) => t.replace(node.text(), () => to), text);
  return { text: out, changes: [`${name}() -> solid() from @solidjs/vite-plugin${keys.length ? `, dropping the React-only ${keys.join(", ")} option${keys.length > 1 ? "s" : ""}` : ""}`], flags: tests };
}
