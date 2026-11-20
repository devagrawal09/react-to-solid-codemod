import { expect, it } from "vitest";
import { parse, Lang } from "@ast-grep/napi";
import { moveImports, nextAppFiles, nextConfigKeys, planNextRoutes } from "../src/nextjs.mjs";

const plan = (files) => planNextRoutes(files.map((f) => `src/app/${f}`), "src");
const to = (p) => Object.fromEntries(Object.entries(p.entries).map(([file, e]) => [file.slice("src/app/".length), [e.kind, e.to, e.pattern]]));

it("maps the App Router's pages, layouts, route handlers and root not-found to Solid's file routes", () => {
  expect(to(plan(["page.tsx", "layout.tsx", "not-found.tsx", "about/page.tsx", "items/layout.tsx", "items/page.tsx", "items/[id]/page.tsx", "api/items/route.ts", "api/items/[id]/route.ts"]))).toEqual({
    "page.tsx": ["page", "src/routes/index.tsx", "/"],
    "layout.tsx": ["document", "src/Document.tsx", "/"],
    "not-found.tsx": ["not-found", "src/routes/[...404].tsx", "/"],
    "about/page.tsx": ["page", "src/routes/about/index.tsx", "/about"],
    "items/layout.tsx": ["layout", "src/routes/items.tsx", "/items"],
    "items/page.tsx": ["page", "src/routes/items/index.tsx", "/items"],
    "items/[id]/page.tsx": ["page", "src/routes/items/[id]/index.tsx", "/items/:id"],
    "api/items/route.ts": ["route", "src/routes/api/items.ts", "/api/items"],
    "api/items/[id]/route.ts": ["route", "src/routes/api/items/[id].ts", "/api/items/:id"],
  });
});

it("keeps route groups, which nest without a path, and puts a catch-all page in its parent, flagging its param's shape", () => {
  const p = plan(["(marketing)/layout.tsx", "(marketing)/about/page.tsx", "docs/[...slug]/page.tsx", "shop/[[...path]]/page.tsx"]);
  expect(to(p)).toEqual({
    "(marketing)/layout.tsx": ["layout", "src/routes/(marketing).tsx", "/"],
    "(marketing)/about/page.tsx": ["page", "src/routes/(marketing)/about/index.tsx", "/about"],
    "docs/[...slug]/page.tsx": ["page", "src/routes/docs/[...slug].tsx", "/docs/*slug"],
    "shop/[[...path]]/page.tsx": ["page", "src/routes/shop/[...path].tsx", "/shop/*path"],
  });
  expect(p.flags.map((f) => [f.file, f.detail])).toEqual([
    ["src/app/docs/[...slug]/page.tsx", expect.stringMatching(/^\[\.\.\.slug\]: params\.slug is the rest of the path as one string/)],
    ["src/app/shop/[[...path]]/page.tsx", expect.stringMatching(/^\[\[\.\.\.path\]\]: params\.path is the rest of the path/)],
  ]);
});

it("leaves colocated files, private folders, parallel and intercepting routes and the conventions with no counterpart, flagging the last three", () => {
  const p = plan(["items/ItemCard.tsx", "_lib/page.tsx", "@modal/page.tsx", "(.)photo/page.tsx", "items/template.tsx", "items/not-found.tsx", "sitemap.ts", "items/default.tsx"]);
  expect(p.entries).toEqual({});
  expect(p.flags.map((f) => f.file.slice("src/app/".length))).toEqual(["@modal/page.tsx", "(.)photo/page.tsx", "items/template.tsx", "items/not-found.tsx", "sitemap.ts", "items/default.tsx"]);
  expect(p.flags[2].detail).toMatch(/make it a layout/);
});

it("hands a segment's loading.tsx and error.tsx to its layout, or to a layout it makes, and the root's to App.tsx", () => {
  const p = plan(["loading.tsx", "error.tsx", "items/layout.tsx", "items/loading.tsx", "items/[id]/error.tsx", "items/[id]/page.tsx"]);
  expect(p.entries["src/app/items/layout.tsx"].wrap).toEqual({ loading: "../app/items/loading" });
  expect(p.layouts).toEqual([{ path: "src/routes/items/[id].tsx", error: "../../app/items/[id]/error" }]);
  expect(p.top).toEqual({ loading: "src/app/loading.tsx", error: "src/app/error.tsx" });
});

it("leaves a file whose route file another one takes, flagged", () => {
  const p = plan(["docs/[...slug]/layout.tsx", "docs/[...slug]/page.tsx"]);
  expect(Object.keys(p.entries)).toEqual(["src/app/docs/[...slug]/layout.tsx"]);
  expect(p.flags.at(-1)).toEqual({ file: "src/app/docs/[...slug]/page.tsx", line: 0, kind: "Next.js route", detail: "would be src/routes/docs/[...slug].tsx, the route of src/app/docs/[...slug]/layout.tsx: left in place" });
});

it("re-points a moved file's relative imports, following the files that moved too", () => {
  const text = `import styles from "./page.module.css";\nimport Card from "../ItemCard";\nimport { x } from "@/lib/x";\nimport "./local.css";\nconst Lazy = lazy(() => import("./chart"));\nexport { y } from "../../../lib/y";\n`;
  expect(moveImports(text, "src/app/items/[id]/page.tsx", "src/routes/items/[id]/index.tsx")).toBe(`import styles from "../../../app/items/[id]/page.module.css";\nimport Card from "../../../app/items/ItemCard";\nimport { x } from "@/lib/x";\nimport "../../../app/items/[id]/local.css";\nconst Lazy = lazy(() => import("../../../app/items/[id]/chart"));\nexport { y } from "../../../lib/y";\n`);
  expect(moveImports(`import "./globals.css";\nimport Page from "./page";\n`, "src/app/layout.tsx", "src/Document.tsx", { "src/app/page.tsx": "src/routes/index.tsx" })).toBe(`import "./app/globals.css";\nimport Page from "./routes/index";\n`);
});

it("lists what a next.config sets", () => {
  expect(nextConfigKeys(`import type { NextConfig } from "next";\n\nconst nextConfig: NextConfig = {\n  /* config options here */\n};\n\nexport default nextConfig;\n`, { parse, Lang })).toEqual([]);
  expect(nextConfigKeys(`export default {\n  images: { remotePatterns: [] },\n  async redirects() { return []; },\n  "basePath": "/app",\n};\n`, { parse, Lang })).toEqual(["images", "redirects", "basePath"]);
  expect(nextConfigKeys(`module.exports = withMDX({ reactStrictMode: true, env: { A: "1" } });\n`, { parse, Lang })).toEqual(["reactStrictMode", "env"]);
});

it("writes App.tsx with the router, the root layout's stylesheets and head, and the root loading.tsx and error.tsx", () => {
  const p = plan(["layout.tsx", "page.tsx", "loading.tsx", "error.tsx"]);
  const [app] = nextAppFiles(p, { document: { css: ["./app/globals.css"], head: [{ tag: "title", props: { children: "App" } }] } });
  expect(app).toEqual({
    path: "src/App.tsx",
    text: `// The app's root in @solidjs/vite-plugin's start mode, made by react-to-solid from the Next.js
// App Router: the routes are src/routes (filesystem-routing's virtual:file-routes), and
// src/Document.tsx, the root layout, renders the document around this.
import { pageRoutes } from "virtual:file-routes";
import { createRouter } from "@solidjs/router";
import { fileRoutes } from "@solidjs/router/fs";
import { Errored, Loading } from "solid-js";
import { useHead } from "@solidjs/web";
import "./app/globals.css";
import RootLoading from "./app/loading";
import RootError from "./app/error";

const Router = createRouter({ routes: fileRoutes(pageRoutes) });

export default function App() {
  useHead([{ tag: "title", props: { children: "App" } }]);
  return (
    <Router>
      {(props) => (
        <Errored
          fallback={(err, reset) => {
            const error = err();
            return <RootError error={error instanceof Error ? error : new Error(String(error))} reset={reset} />;
          }}
        >
          <Loading fallback={<RootLoading />}>{props.children}</Loading>
        </Errored>
      )}
    </Router>
  );
}
`,
  });
});

it("renders the routes without a boundary when the root has no loading.tsx, as Next.js did", () => {
  const [app] = nextAppFiles(plan(["page.tsx"]));
  expect(app.text).toContain(`    <Router>\n      {(props) => props.children}\n    </Router>`);
  expect(app.text).not.toMatch(/solid-js|useHead/);
});

it("writes start mode's vite.config.ts, with the API middleware and tsconfig paths when the app has them", () => {
  const files = nextAppFiles(plan(["page.tsx", "api/items/route.ts"]), { api: true, tsconfigPaths: true });
  expect(files.map((f) => f.path)).toEqual(["src/App.tsx", "src/routes/[...404].tsx", "src/middleware.ts", "src/vite-env.d.ts", "vite.config.ts"]);
  expect(files.at(-1).text).toContain(`    solid({
      start: { middleware: "./src/middleware.ts", nodeServer: true },
      ssr: true,
      serverFunctions: true,
      // also compile the route modules fileRoutes() emits (their ids end in a query string)
      extensions: [".jsx", ".tsx"],
    }),
    fileRoutes({ httpMethods: true }),
  ],
  // tsconfig.json's paths (@/*), which Next.js resolved by itself
  resolve: { tsconfigPaths: true },`);
  expect(files[2].text).toContain(`export default [createAPIHandler(routes)] satisfies StartMiddleware[];`);
  expect(files[1].text).toContain(`export const route = { preload: () => httpStatus(404) };`);
  const plain = nextAppFiles(plan(["page.tsx", "not-found.tsx"]));
  expect(plain.map((f) => f.path)).toEqual(["src/App.tsx", "src/vite-env.d.ts", "vite.config.ts"]);
  expect(plain.at(-1).text).toContain(`      start: { nodeServer: true },`);
  expect(plain.at(-1).text).toContain(`    fileRoutes(),`);
  expect(plain.at(-1).text).not.toContain("tsconfigPaths");
});

it("puts start mode's files in the package that owns src/", () => {
  const files = nextAppFiles(planNextRoutes(["apps/web/src/app/page.tsx", "apps/web/src/app/api/x/route.ts"], "apps/web/src"), { api: true, middleware: "apps/web/src/middleware.ts" });
  expect(files.map((f) => f.path)).toEqual(["apps/web/src/App.tsx", "apps/web/src/routes/[...404].tsx", "apps/web/src/middleware.ts", "apps/web/src/vite-env.d.ts", "apps/web/vite.config.ts"]);
  expect(files.at(-1).text).toContain(`start: { middleware: "./src/middleware.ts", nodeServer: true }`);
});

it("writes a layout for a segment whose loading.tsx or error.tsx had none to go in", () => {
  const layout = nextAppFiles(plan(["items/[id]/page.tsx", "items/[id]/loading.tsx", "items/[id]/error.tsx"])).find((f) => f.path === "src/routes/items/[id].tsx");
  expect(layout.text).toBe(`// The segment's loading.tsx and error.tsx wrapped its pages in Next.js; this layout does in Solid.
import { Errored, Loading } from "solid-js";
import type { ParentProps } from "solid-js";
import SegmentLoading from "../../app/items/[id]/loading";
import SegmentError from "../../app/items/[id]/error";

export default function IdLayout(props: ParentProps) {
  return (
    <Errored
      fallback={(err, reset) => {
        const error = err();
        return <SegmentError error={error instanceof Error ? error : new Error(String(error))} reset={reset} />;
      }}
    >
      <Loading fallback={<SegmentLoading />}>{props.children}</Loading>
    </Errored>
  );
}
`);
  expect(nextAppFiles(plan(["items/page.tsx", "items/error.tsx"])).find((f) => f.path === "src/routes/items.tsx").text).toContain(`    >\n      {props.children}\n    </Errored>\n  );`);
  expect(nextAppFiles(plan(["items/page.tsx", "items/loading.tsx"])).find((f) => f.path === "src/routes/items.tsx").text).toContain(`  return <Loading fallback={<SegmentLoading />}>{props.children}</Loading>;`);
});
