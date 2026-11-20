// Next.js's App Router -> Solid 2 file routes, with --param nextRoutes=true: where each App Router
// file goes, how a moved file's relative imports follow it, and the files start mode needs that a
// Next.js app doesn't have. The target is @solidjs/vite-plugin's SSR start mode (src/App.tsx is the
// root, src/Document.tsx the document) with filesystem-routing's Vite plugin, which reads src/routes
// with SolidStart's file names, and fileRoutes() from @solidjs/router/fs. Checked against
// @solidjs/vite-plugin 3.0.1, @solidjs/router 2.0.1 and filesystem-routing 0.5.0 on Nov 20, and
// against solidjs/templates' solid-v2/fullstack. Like manifests.mjs, nothing here touches Node.

// The App Router's file conventions, by file name.
const CONVENTIONS = new Set(["page", "layout", "route", "not-found", "loading", "error", "template", "default", "global-error", "forbidden", "unauthorized"]);
// Metadata files: Next.js serves them itself.
const METADATA = /^(sitemap|robots|manifest|opengraph-image|twitter-image|icon|apple-icon)$/;

// Removes `.` and `..` segments from a /-separated path.
function normalize(path) {
  const out = [];
  for (const s of path.split("/")) {
    if (s === "..") out.pop();
    else if (s && s !== ".") out.push(s);
  }
  return out.join("/");
}

// A relative import specifier from directory `from` to the file or directory `to`.
function specifier(from, to) {
  const a = from ? from.split("/") : [];
  const b = to.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const up = a.length - i;
  return `${up ? "../".repeat(up) : "./"}${b.slice(i).join("/")}`;
}

const dirOf = (path) => path.slice(0, Math.max(path.lastIndexOf("/"), 0));

// Where each App Router file under `app` goes. `files` are the converted .ts/.tsx files, `app` the
// App Router's directory (the package's src/app, or app/ at its root) and `src` the package's src/,
// where start mode looks for App.tsx and Document.tsx and filesystem-routing for routes/. With
// app/ at the root, only the route files move into src/; the rest of the app stays where it is.
//   entries: { [file]: { kind, to, pattern, key, wrap? } } for the files that move: a page to
//            routes/<dir>/index.tsx (a catch-all page to routes/<parent>/[...x].tsx: a pattern can't
//            go on after its catch-all), a layout to routes/<dir>.tsx (the file paired with the
//            directory, as filesystem-routing nests them), the root layout to Document.tsx, a route
//            handler to routes/<dir>.ts, the root not-found to routes/[...404].tsx.
//   segments: the loading.tsx and error.tsx of each directory, which stay where they are (they are
//            plain components now) and are rendered by the layout around the segment: its own
//            layout's (entries[layout].wrap), a generated one (`layouts`), or src/App.tsx for the root.
//   flags: what has no counterpart, with the file.
export function planNextRoutes(files, { app, src }) {
  const routes = `${src}/routes`;
  const entries = {};
  const segments = {};
  const flags = [];
  const flag = (file, detail) => flags.push({ file, line: 0, kind: "Next.js route", detail });
  for (const file of files) {
    if (!file.startsWith(`${app}/`)) continue;
    const rel = file.slice(app.length + 1);
    const ext = file.slice(file.lastIndexOf("."));
    const name = rel.slice(rel.lastIndexOf("/") + 1, -ext.length);
    const dir = dirOf(rel);
    const parts = dir ? dir.split("/") : [];
    // A private folder isn't routed; a file without a convention's name is colocated.
    if (parts.some((p) => p.startsWith("_")) || (!CONVENTIONS.has(name) && !METADATA.test(name))) continue;
    if (METADATA.test(name)) {
      flag(file, `${name}${ext} is a metadata file Next.js serves itself: serve it from public/ or an API route`);
      continue;
    }
    const unsupported = parts.find((p) => p.startsWith("@") || /^\(\.{1,3}\)/.test(p));
    if (unsupported) {
      flag(file, `${unsupported} is a ${unsupported.startsWith("@") ? "parallel route slot" : "intercepting route"}, which @solidjs/router has no counterpart for: left in place`);
      continue;
    }
    // [[...x]] -> [...x]: the router's catch-all also matches nothing.
    const solid = parts.map((p) => p.replace(/^\[\[\.\.\.(.+)\]\]$/, "[...$1]"));
    const pattern = `/${solid.filter((p) => !/^\(.*\)$/.test(p)).map((p) => p.replace(/^\[\.\.\.(.+)\]$/, "*$1").replace(/^\[(.+)\]$/, ":$1")).join("/")}`;
    const catchAll = /^\[\.\.\./.test(solid.at(-1) ?? "");
    const at = (path) => `${routes}/${path}`;
    if (name === "page") {
      entries[file] = { kind: "page", to: catchAll ? at(`${solid.join("/")}${ext}`) : at(`${solid.length ? `${solid.join("/")}/` : ""}index${ext}`), pattern, key: file };
      if (catchAll) flag(file, `${parts.at(-1)}: params.${solid.at(-1).slice(4, -1)} is the rest of the path as one string ("a/b") in Solid's router, where Next.js gave an array (["a", "b"])`);
    } else if (name === "layout") entries[file] = dir ? { kind: "layout", to: at(`${solid.join("/")}${ext}`), pattern, key: file } : { kind: "document", to: `${src}/Document${ext}`, pattern, key: file };
    else if (name === "route") entries[file] = { kind: "route", to: at(`${solid.length ? solid.join("/") : "index"}${ext}`), pattern, key: file };
    else if (name === "not-found" && !dir) entries[file] = { kind: "not-found", to: at(`[...404]${ext}`), pattern, key: file };
    else if (name === "loading" || name === "error") segments[dir] = { ...segments[dir], [name]: file };
    else if (name === "not-found") flag(file, "a not-found.tsx below the root: the router has one catch-all per level; add routes/<dir>/[...404].tsx for unmatched URLs here, and render it where the segment called notFound()");
    else flag(file, `${name}${ext} has no counterpart in Solid's file routes${name === "template" ? ": make it a layout (it remounted on navigation)" : name === "global-error" ? ": wrap src/App.tsx's routes in <Errored>" : ""}: left in place`);
  }
  // Two App Router files can't land on one route file (a layout and a catch-all page, or a layout
  // and a route handler with the same path).
  const taken = new Map();
  for (const [file, entry] of Object.entries(entries)) {
    const key = entry.to.replace(/\.tsx?$/, "");
    if (taken.has(key)) {
      flag(file, `would be ${entry.to}, the route of ${taken.get(key)}: left in place`);
      delete entries[file];
    } else taken.set(key, file);
  }
  const layouts = [];
  for (const [dir, { loading, error }] of Object.entries(segments)) {
    if (!dir) continue;
    const layout = Object.keys(entries).find((f) => f === `${app}/${dir}/layout${f.slice(f.lastIndexOf("."))}`);
    const to = layout ? entries[layout].to : `${routes}/${dir.split("/").map((p) => p.replace(/^\[\[\.\.\.(.+)\]\]$/, "[...$1]")).join("/")}.tsx`;
    const wrap = { ...(loading ? { loading: specifier(dirOf(to), loading.replace(/\.tsx?$/, "")) } : {}), ...(error ? { error: specifier(dirOf(to), error.replace(/\.tsx?$/, "")) } : {}) };
    if (layout) entries[layout].wrap = wrap;
    else if (taken.has(to.replace(/\.tsx$/, ""))) flag(loading ?? error, `the segment's layout would be ${to}, which another file takes: wrap its pages in <Loading> or <Errored> by hand`);
    else layouts.push({ path: to, ...wrap });
  }
  return { app, routes, src, entries, top: { loading: segments[""]?.loading ?? null, error: segments[""]?.error ?? null }, layouts, flags };
}

// A moved file's relative imports, re-pointed from where it was (`from`) to where it is (`to`). An
// import of another moved file follows that file (`moves`: old path -> new path).
export function moveImports(text, from, to, moves = {}) {
  const was = dirOf(from);
  const now = dirOf(to);
  if (was === now) return text;
  const moved = Object.fromEntries(Object.entries(moves).map(([a, b]) => [a.replace(/\.(tsx|ts|jsx|js)$/, ""), b.replace(/\.(tsx|ts|jsx|js)$/, "")]));
  return text.replace(/(\bfrom\s*|\bimport\s*\(?\s*)(["'])(\.\.?\/[^"']*|\.\.?)\2/g, (m, lead, quote, spec) => {
    const target = normalize(`${was}/${spec}`);
    return `${lead}${quote}${specifier(now, moved[target] ?? target)}${quote}`;
  });
}

// The keys a next.config sets, read off its config object: what is left to port by hand.
export function nextConfigKeys(text, { parse, Lang }) {
  const root = parse(Lang.Tsx, text).root();
  const object = root.findAll({ rule: { kind: "object" } }).find((o) => {
    const p = o.parent();
    return ["variable_declarator", "export_statement", "assignment_expression"].includes(p?.kind()) || (p?.kind() === "arguments" && p.parent()?.parent()?.kind() !== "object");
  });
  return object ? object.children().filter((c) => c.kind() === "pair" || c.kind() === "method_definition" || c.kind() === "shorthand_property_identifier").map((c) => (c.kind() === "shorthand_property_identifier" ? c.text() : c.field(c.kind() === "pair" ? "key" : "name").text().replace(/["']/g, ""))) : [];
}

// The files start mode needs, with their contents, for a Next.js app converted by the plan:
// src/App.tsx (the router, the root layout's stylesheets and head tags, and the root loading.tsx
// and error.tsx), vite.config.ts, src/vite-env.d.ts, a 404 route when the app had no not-found.tsx,
// src/middleware.ts serving the route handlers, and a layout for each segment whose loading.tsx or
// error.tsx had no layout to go in. `document` is the root layout's conversion result (its css and
// head), `api` whether there are route handlers, `tsconfigPaths` whether the tsconfig maps paths
// (create-next-app's @/*), which Vite resolves only when asked.
export function nextAppFiles(plan, { document = null, api = false, tsconfigPaths = false, middleware = "src/middleware.ts" } = {}) {
  const src = plan.src;
  const owner = dirOf(src);
  const local = (path) => specifier(src, path.replace(/\.tsx?$/, ""));
  const files = [];
  const { loading, error } = plan.top;
  const head = (document?.head ?? []).map((t) => `{ tag: ${JSON.stringify(t.tag)}, props: { ${Object.entries(t.props).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")} } }`);
  // No <Loading> without a loading.tsx, as Next.js had no boundary there: the render waits for the
  // page's data, and a navigation keeps the current page until the next one is ready.
  const routesView = loading ? `<Loading fallback={<RootLoading />}>{props.children}</Loading>` : "props.children";
  const view = error ? `<Errored\n          fallback={(err, reset) => {\n            const error = err();\n            return <RootError error={error instanceof Error ? error : new Error(String(error))} reset={reset} />;\n          }}\n        >\n          ${loading ? routesView : `{${routesView}}`}\n        </Errored>` : routesView;
  files.push({
    path: `${src}/App.tsx`,
    text: [
      "// The app's root in @solidjs/vite-plugin's start mode, made by react-to-solid from the Next.js",
      "// App Router: the routes are src/routes (filesystem-routing's virtual:file-routes), and",
      "// src/Document.tsx, the root layout, renders the document around this.",
      `import { pageRoutes } from "virtual:file-routes";`,
      `import { createRouter } from "@solidjs/router";`,
      `import { fileRoutes } from "@solidjs/router/fs";`,
      ...(loading || error ? [`import { ${[error && "Errored", loading && "Loading"].filter(Boolean).join(", ")} } from "solid-js";`] : []),
      ...(head.length ? [`import { useHead } from "@solidjs/web";`] : []),
      ...(document?.css ?? []).map((css) => `import ${JSON.stringify(css)};`),
      ...(loading ? [`import RootLoading from ${JSON.stringify(local(loading))};`] : []),
      ...(error ? [`import RootError from ${JSON.stringify(local(error))};`] : []),
      "",
      "const Router = createRouter({ routes: fileRoutes(pageRoutes) });",
      "",
      "export default function App() {",
      ...(head.length ? [`  useHead([${head.join(", ")}]);`] : []),
      "  return (",
      "    <Router>",
      ...(loading || error ? ["      {(props) => (", `        ${view}`, "      )}"] : ["      {(props) => props.children}"]),
      "    </Router>",
      "  );",
      "}",
      "",
    ].join("\n"),
  });
  if (!Object.values(plan.entries).some((e) => e.kind === "not-found")) {
    files.push({
      path: `${plan.routes}/[...404].tsx`,
      text: `// Next.js's built-in 404 page, as the catch-all route. httpStatus() sets the status during SSR.\nimport { httpStatus } from "@solidjs/web";\n\nexport const route = { preload: () => httpStatus(404) };\n\nexport default function NotFound() {\n  return (\n    <main>\n      <h1>404</h1>\n      <p>This page could not be found.</p>\n    </main>\n  );\n}\n`,
    });
  }
  for (const layout of plan.layouts) {
    const name = layout.path.slice(layout.path.lastIndexOf("/") + 1, -4).replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ?? "").toUpperCase()).replace(/^./, (c) => c.toUpperCase());
    const routes = layout.loading ? `<Loading fallback={<SegmentLoading />}>{props.children}</Loading>` : "{props.children}";
    const body = layout.error ? `(\n    <Errored\n      fallback={(err, reset) => {\n        const error = err();\n        return <SegmentError error={error instanceof Error ? error : new Error(String(error))} reset={reset} />;\n      }}\n    >\n      ${routes}\n    </Errored>\n  )` : routes;
    files.push({
      path: layout.path,
      text: [
        "// The segment's loading.tsx and error.tsx wrapped its pages in Next.js; this layout does in Solid.",
        `import { ${[layout.error && "Errored", layout.loading && "Loading"].filter(Boolean).join(", ")} } from "solid-js";`,
        `import type { ParentProps } from "solid-js";`,
        ...(layout.loading ? [`import SegmentLoading from ${JSON.stringify(layout.loading)};`] : []),
        ...(layout.error ? [`import SegmentError from ${JSON.stringify(layout.error)};`] : []),
        "",
        `export default function ${/^[A-Z]/.test(name) ? name : `Segment${name}`}Layout(props: ParentProps) {`,
        `  return ${body};`,
        "}",
        "",
      ].join("\n"),
    });
  }
  if (api) {
    files.push({
      path: middleware,
      text: `// Serves the API routes (the route.ts handlers, now GET/POST/... exports in src/routes) ahead of the\n// pages: start mode runs this chain on every request (start.middleware in vite.config.ts).\nimport type { StartMiddleware } from "@solidjs/vite-plugin";\nimport { createAPIHandler } from "filesystem-routing/api";\nimport routes from "virtual:file-routes";\n\nexport default [createAPIHandler(routes)] satisfies StartMiddleware[];\n`,
    });
  }
  files.push({
    path: `${src}/vite-env.d.ts`,
    text: `/// <reference types="vite/client" />\n/// <reference types="filesystem-routing/types" />\n/// <reference types="@solidjs/vite-plugin/boundary-modules" />\n`,
  });
  const start = [api && `middleware: "./${middleware.slice(owner ? owner.length + 1 : 0)}"`, "nodeServer: true"].filter(Boolean).join(", ");
  files.push({
    path: `${owner ? `${owner}/` : ""}vite.config.ts`,
    text: [
      "// @solidjs/vite-plugin's SSR start mode, made by react-to-solid from the Next.js app: the plugin",
      "// generates the entries around src/App.tsx and src/Document.tsx, builds the client to dist/client",
      "// and the server to dist/server (node dist/server/node.js serves it), and compiles \"use server\"",
      "// functions. filesystem-routing's plugin turns src/routes into virtual:file-routes.",
      `import { defineConfig } from "vite";`,
      `import solid from "@solidjs/vite-plugin";`,
      `import { fileRoutes } from "filesystem-routing/vite";`,
      "",
      "export default defineConfig({",
      "  plugins: [",
      "    solid({",
      `      start: { ${start} },`,
      "      ssr: true,",
      "      serverFunctions: true,",
      "      // also compile the route modules fileRoutes() emits (their ids end in a query string)",
      `      extensions: [".jsx", ".tsx"],`,
      "    }),",
      `    fileRoutes(${api ? "{ httpMethods: true }" : ""}),`,
      "  ],",
      ...(tsconfigPaths ? ["  // tsconfig.json's paths (@/*), which Next.js resolved by itself", "  resolve: { tsconfigPaths: true },"] : []),
      "  server: { port: 3000 },",
      "});",
      "",
    ].join("\n"),
  });
  return files;
}
