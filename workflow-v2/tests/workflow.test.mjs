import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import { rolldown } from "rolldown";
import { beforeAll, describe, expect, it } from "vitest";

// Needs a codemod CLI with the code-first engine: codemod@2.0.0-alpha.4 or newer.
const bin = process.env.CODEMOD_BIN;
const workflow = path.resolve(import.meta.dirname, "../src/workflow.ts");
const fixture = path.resolve(import.meta.dirname, "fixtures/todo-app");
// A pnpm monorepo: apps/web uses @repo/ui (workspace:*), which uses @repo/hooks; apps/docs uses
// @repo/ui too, and @repo/tsconfig doesn't depend on React.
const monorepo = path.resolve(import.meta.dirname, "fixtures/pnpm-monorepo");

function givenApp(edit = () => {}, from = fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r2s-"));
  fs.cpSync(from, dir, { recursive: true });
  edit(dir);
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=spec@example.com", "-c", "user.name=spec", "commit", "-qm", "fixture");
  return dir;
}

function migrate(dir, params = ["apply=true"], workflowFile = workflow) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "r2s-runs-"));
  const cli = spawnSync(bin, ["workflow", "run", "-w", workflowFile, "-t", dir, ...params.flatMap((p) => ["--param", p]), "--no-interactive", "--approve", "--disable-analytics", "--no-color"], {
    env: { ...process.env, CODEMOD_RUN_STORE_DIR: store },
    encoding: "utf8",
  });
  const id = `${cli.stdout}${cli.stderr}`.match(/^Run (\S+)/m)[1];
  return JSON.parse(fs.readFileSync(path.join(store, id, "run.json"), "utf8"));
}

const read = (dir, file) => fs.readFileSync(path.join(dir, file), "utf8");

describe.skipIf(!bin)("react-to-solid workflow on a small todo app", { tags: ["slow"] }, () => {
  let app;
  let run;
  beforeAll(() => {
    app = givenApp();
    run = migrate(app);
  }, 120_000);

  it("turns useState into createSignal, reading props through props", () => {
    expect(read(app, "src/components/TodoList.tsx")).toContain("const [todos, setTodos] = createSignal(props.initial);");
  });

  it("makes a value the React Compiler memoized a createMemo", () => {
    expect(read(app, "src/components/TodoList.tsx")).toContain("const visible = createMemo(() =>");
  });

  it("rewrites code after a non-ASCII character in the same file", () => {
    expect(read(app, "src/components/TodoItem.tsx")).toContain('<li title="To do · item" class={className()}>\n      <label for={merged.todo.id}>');
  });

  it("leaves a component with nothing to convert unchanged", () => {
    expect(read(app, "src/App.tsx")).toBe(read(fixture, "src/App.tsx"));
  });

  it("turns an effect into createEffect, handing apply the prop it tracks", () => {
    expect(read(app, "src/components/Clock.tsx")).toContain("  createEffect(() => props.tickMs, (tickMs) => {\n    const id = setInterval(() => setNow(new Date()), tickMs);\n    return () => clearInterval(id);\n  });");
  });

  it("reports what the rules could not convert, with file and line", () => {
    expect(run.output.flags).toContainEqual(expect.objectContaining({ file: "src/components/TodoList.tsx", line: 14, kind: "custom hook call" }));
  });

  it("reports eslint-plugin-solid's Solid 2 warnings by rule: none on the fixture", () => {
    expect(run.output.lint).toMatchObject({ files: 6, problems: 0, parseErrors: 0, byRule: {} });
  });
});

describe.skipIf(!bin)("react-to-solid workflow without apply=true", { tags: ["slow"] }, () => {
  it("previews the conversion and writes nothing", () => {
    const app = givenApp();
    const run = migrate(app, []);
    expect(run.output.preview).toBe(true);
    expect(run.output.wouldChange).toContain("src/components/TodoList.tsx");
    expect(run.output.flags).toContainEqual(expect.objectContaining({ file: "src/components/TodoList.tsx", line: 14, kind: "custom hook call" }));
    expect(run.output.config).toContainEqual({ file: "package.json", changes: expect.arrayContaining(["react -> solid-js@^2.0.3"]) });
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: app, encoding: "utf8" })).toBe("");
  });
});

// create-vite's react-ts template, Nov 19
const viteConfig = `import react from '@vitejs/plugin-react'\nimport { defineConfig } from 'vite'\n\n// https://vite.dev/config/\nexport default defineConfig({\n  plugins: [react()],\n})\n`;
const tsconfigApp = `{\n  "compilerOptions": {\n    "types": ["vite/client"],\n    "skipLibCheck": true,\n\n    /* Bundler mode */\n    "moduleResolution": "bundler",\n    "jsx": "react-jsx",\n\n    /* Linting */\n    "strict": true\n  },\n  "include": ["src"]\n}\n`;

describe.skipIf(!bin)("react-to-solid workflow on a Vite app with apply=true", { tags: ["slow"] }, () => {
  let app;
  let run;
  beforeAll(() => {
    app = givenApp((dir) => {
      const pkg = JSON.parse(read(dir, "package.json"));
      pkg.devDependencies = { ...pkg.devDependencies, "@vitejs/plugin-react": "^6.1.2", vite: "^8.3.6" };
      fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
      fs.writeFileSync(path.join(dir, "vite.config.ts"), viteConfig);
      fs.writeFileSync(path.join(dir, "tsconfig.app.json"), tsconfigApp);
      fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    });
    run = migrate(app);
  }, 120_000);

  it("moves package.json to Solid 2", () => {
    expect(JSON.parse(read(app, "package.json"))).toEqual({
      name: "todo-demo",
      private: true,
      type: "module",
      dependencies: { "@solidjs/web": "^2.0.3", "solid-js": "^2.0.3" },
      devDependencies: { "@solidjs/vite-plugin": "^3.0.1", typescript: "5.9.3", vite: "^8.3.6" },
    });
  });

  it("gives the tsconfig Solid's JSX", () => {
    expect(read(app, "tsconfig.app.json")).toContain(`"jsx": "preserve",\n    "jsxImportSource": "@solidjs/web",\n\n    /* Linting */`);
  });

  it("swaps the React Vite plugin for Solid's", () => {
    expect(read(app, "vite.config.ts")).toBe(viteConfig.replace("import react from '@vitejs/plugin-react'", "import solid from '@solidjs/vite-plugin'").replace("react()", "solid()"));
  });

  it("names the install command for the project's package manager, without running it", () => {
    expect(run.output.plan.install).toBe("pnpm install");
    expect(fs.existsSync(path.join(app, "node_modules"))).toBe(false);
  });
});

describe.skipIf(!bin)("react-to-solid workflow on a pnpm app with a port that still peers on Solid 1 helpers", { tags: ["slow"] }, () => {
  it("names the install command with strict peer dependencies off, and why", () => {
    const app = givenApp((dir) => {
      const pkg = JSON.parse(read(dir, "package.json"));
      pkg.packageManager = "pnpm@12.14.0";
      pkg.dependencies = { ...pkg.dependencies, "@tanstack/react-router": "^1.120.0" };
      fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    });
    const run = migrate(app, []);
    expect(run.output.plan.install).toBe("pnpm install --config.strict-peer-dependencies=false");
    expect(run.output.plan.installNote).toMatch(/^@tanstack\/solid-router still depends on Solid 1 helper packages, which peer on solid-js 1: pnpm's strict-peer-dependencies \(fatal by default in pnpm 12\) rejects them, so install with --config\.strict-peer-dependencies=false, or allow solid-js 2 for them with a peerDependencyRules\.allowedVersions entry/);
  }, 120_000);
});

describe.skipIf(!bin)("react-to-solid workflow on a Next.js app", { tags: ["slow"] }, () => {
  let app;
  let run;
  const page = `import Link from "next/link";\n\nexport default async function Page({ searchParams }: { searchParams: Promise<{ q?: string }> }) {\n  const { q } = await searchParams;\n  const label = q ? \`Results for \${q}\` : "Search";\n  return <Link href="/" className="title">{label}</Link>;\n}\n`;
  beforeAll(() => {
    app = givenApp((dir) => {
      const pkg = JSON.parse(read(dir, "package.json"));
      Object.assign(pkg.dependencies, { next: "16.0.0", "framer-motion": "12.0.0" });
      fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
      fs.writeFileSync(path.join(dir, "next.config.mjs"), "export default {};\n");
      fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), `lockfileVersion: '9.0'\n\npackages:\n\n  framer-motion@12.0.0:\n    peerDependencies:\n      react: ^18.0.0 || ^19.0.0\n\n  next@16.0.0:\n    peerDependencies:\n      react: ^19.0.0\n`);
      fs.mkdirSync(path.join(dir, "src/app"));
      fs.writeFileSync(path.join(dir, "src/app/page.tsx"), page);
    });
    run = migrate(app);
  }, 120_000);

  it("leaves an async page as it is, but for the JSX attribute names, and flags it as a server component", () => {
    expect(read(app, "src/app/page.tsx")).toBe(page.replace(`className="title"`, `class="title"`));
    expect(run.output.flags).toContainEqual(expect.objectContaining({ file: "src/app/page.tsx", line: 3, kind: "server component" }));
  });

  it("flags Next.js imports, next.config and the next dependency", () => {
    expect(run.output.flags).toContainEqual(expect.objectContaining({ file: "src/app/page.tsx", line: 1, kind: "Next.js", detail: expect.stringContaining("use <a href>") }));
    expect(run.output.flags).toContainEqual(expect.objectContaining({ file: "next.config.mjs", kind: "build config" }));
    expect(run.output.flags).toContainEqual(expect.objectContaining({ file: "package.json", detail: expect.stringMatching(/^next has no Solid 2 port: Next.js has no Solid 2 equivalent/) }));
  });

  it("flags a dependency the lockfile says peers on React", () => {
    expect(run.output.plan.noPort).toContain("framer-motion");
    expect(run.output.flags).toContainEqual(expect.objectContaining({ file: "package.json", detail: "framer-motion depends on React (peer) and has no known Solid 2 port" }));
  });
});

// A create-next-app 16.4.6 app (TypeScript) with a dynamic page that loads data, a segment
// loading.tsx, a route handler and a client component: in src/ (--src-dir), or with app/,
// components/ and lib/ at the root and @/* pointing at ./*.
function givenNextApp({ src = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r2s-next-"));
  const files = {
    "package.json": `{\n  "name": "next-app",\n  "private": true,\n  "scripts": {\n    "dev": "next dev",\n    "build": "next build",\n    "start": "next start"\n  },\n  "dependencies": {\n    "next": "16.4.6",\n    "react": "19.3.0",\n    "react-dom": "19.3.0"\n  },\n  "devDependencies": {\n    "@types/react": "^19",\n    "typescript": "^5"\n  }\n}\n`,
    "tsconfig.json": `{\n  "compilerOptions": {\n    "jsx": "react-jsx",\n    "paths": {\n      "@/*": ["${src ? "./src/*" : "./*"}"]\n    }\n  }\n}\n`,
    "next.config.ts": `import type { NextConfig } from "next";\n\nconst nextConfig: NextConfig = {\n  images: { remotePatterns: [] },\n};\n\nexport default nextConfig;\n`,
    "src/app/globals.css": "body { margin: 0; }\n",
    "src/app/favicon.ico": "icon",
    "src/app/layout.tsx": `import type { Metadata } from "next";\nimport "./globals.css";\n\nexport const metadata: Metadata = { title: "Shop" };\n\nexport default function RootLayout({ children }: LayoutProps<"/">) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`,
    "src/app/page.tsx": `import Link from "next/link";\nimport Counter from "@/components/Counter";\nimport styles from "./page.module.css";\n\nexport default function Home() {\n  return (\n    <main className={styles.main}>\n      <Link href="/items/1">First item</Link>\n      <Counter />\n    </main>\n  );\n}\n`,
    "src/app/page.module.css": ".main { padding: 1rem; }\n",
    "src/app/items/loading.tsx": `export default function Loading() {\n  return <p>Loading…</p>;\n}\n`,
    "src/app/items/[id]/page.tsx": `import { getItem } from "@/lib/items";\n\nexport default async function ItemPage({ params }: PageProps<"/items/[id]">) {\n  const { id } = await params;\n  const item = await getItem(id);\n  return <h1>{item.name}</h1>;\n}\n`,
    "src/app/api/items/route.ts": `import { NextResponse } from "next/server";\nimport { getItems } from "@/lib/items";\n\nexport async function GET() {\n  return NextResponse.json(await getItems());\n}\n`,
    "src/lib/items.ts": `export async function getItems() {\n  return [{ id: "1", name: "Mug" }];\n}\n\nexport async function getItem(id: string) {\n  return (await getItems()).find((item) => item.id === id) ?? { id, name: "None" };\n}\n`,
    "src/components/Counter.tsx": `"use client";\n\nimport { useState } from "react";\n\nexport default function Counter() {\n  const [count, setCount] = useState(0);\n  return <button onClick={() => setCount(count + 1)}>{count}</button>;\n}\n`,
  };
  for (const [name, text] of Object.entries(files)) {
    const file = src || !name.startsWith("src/") ? name : name.slice("src/".length);
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=spec@example.com", "-c", "user.name=spec", "commit", "-qm", "fixture");
  return dir;
}

describe.skipIf(!bin)("react-to-solid workflow with nextRoutes on a Next.js app", { tags: ["slow"] }, () => {
  let app;
  let run;
  const exists = (file) => fs.existsSync(path.join(app, file));
  beforeAll(() => {
    app = givenNextApp();
    run = migrate(app, ["apply=true", "nextRoutes=true"]);
  }, 120_000);

  it("moves the App Router's route files to src/routes and the root layout to src/Document.tsx", () => {
    expect(run.output.nextjs.moved).toEqual({
      "src/app/api/items/route.ts": "src/routes/api/items.ts",
      "src/app/items/[id]/page.tsx": "src/routes/items/[id]/index.tsx",
      "src/app/layout.tsx": "src/Document.tsx",
      "src/app/page.tsx": "src/routes/index.tsx",
    });
    for (const [from, to] of Object.entries(run.output.nextjs.moved)) {
      expect(exists(from)).toBe(false);
      expect(exists(to)).toBe(true);
    }
    expect(read(app, "src/routes/index.tsx")).toContain(`import styles from "../app/page.module.css";`);
    expect(read(app, "src/routes/index.tsx")).toContain(`<a href="/items/1">First item</a>`);
    expect(read(app, "src/Document.tsx")).toContain("<HydrationScript />");
    expect(exists("src/app/items/loading.tsx")).toBe(true);
  });

  it("loads the async page's data in a server function, read through an async memo", () => {
    const page = read(app, "src/routes/items/[id]/index.tsx");
    expect(page).toContain(`const loadItemPage = query(async (params: RouteProps<"/items/:id">["params"]) => {\n  "use server";`);
    expect(page).toContain(`const data = createMemo(() => loadItemPage({ ...props.params }));\n  return <h1>{data().item.name}</h1>;`);
    expect(run.output.flags.filter((f) => f.kind === "server component")).toEqual([]);
  });

  it("writes start mode's files: App.tsx, vite.config.ts, the segment's layout, a 404 route and the API middleware", () => {
    expect(run.output.nextjs.created).toEqual(["src/App.tsx", "src/routes/[...404].tsx", "src/routes/items.tsx", "src/middleware.ts", "src/vite-env.d.ts", "vite.config.ts"]);
    expect(read(app, "src/App.tsx")).toContain(`import "./app/globals.css";`);
    expect(read(app, "src/App.tsx")).toContain(`useHead([{ tag: "title", props: { children: "Shop" } }]);`);
    expect(read(app, "src/routes/items.tsx")).toContain(`return <Loading fallback={<SegmentLoading />}>{props.children}</Loading>;`);
    expect(read(app, "vite.config.ts")).toContain("resolve: { tsconfigPaths: true },");
    expect(read(app, "src/routes/api/items.ts")).toContain("export const GET: APIHandler = (event) => nextGET();");
    expect(read(app, "public/favicon.ico")).toBe("icon");
    expect(exists("src/app/favicon.ico")).toBe(false);
  });

  it("moves package.json to start mode, and flags what next.config.ts sets", () => {
    const pkg = JSON.parse(read(app, "package.json"));
    expect(pkg.scripts).toEqual({ dev: "vite", build: "vite build", start: "node dist/server/node.js" });
    expect(pkg.dependencies).toEqual({ "@solidjs/router": "^2.0.0", "@solidjs/web": "^2.0.3", "solid-js": "^2.0.3" });
    expect(Object.keys(pkg.devDependencies)).toEqual(["@solidjs/vite-plugin", "filesystem-routing", "typescript", "vite"]);
    expect(run.output.flags).toContainEqual(expect.objectContaining({ file: "next.config.ts", detail: expect.stringMatching(/^next.config.ts sets images, which Next.js applied/) }));
  });

  it("lints the moved and written files where they are", () => {
    expect(run.output.lint).toMatchObject({ parseErrors: 0 });
    // the 7 converted files, and App.tsx, the 404 route, the segment layout and the middleware
    expect(run.output.lint.files).toBe(11);
    expect(run.output.failures).toEqual([]);
  });
});

describe.skipIf(!bin)("react-to-solid workflow with nextRoutes on a Next.js app without src/", { tags: ["slow"] }, () => {
  let app;
  let run;
  const exists = (file) => fs.existsSync(path.join(app, file));
  beforeAll(() => {
    app = givenNextApp({ src: false });
    run = migrate(app, ["apply=true", "nextRoutes=true"]);
  }, 120_000);

  it("converts from the root, moving only the route files into src/", () => {
    expect(run.output.nextjs.moved).toEqual({
      "app/api/items/route.ts": "src/routes/api/items.ts",
      "app/items/[id]/page.tsx": "src/routes/items/[id]/index.tsx",
      "app/layout.tsx": "src/Document.tsx",
      "app/page.tsx": "src/routes/index.tsx",
    });
    expect(exists("app/layout.tsx")).toBe(false);
    expect(read(app, "components/Counter.tsx")).toContain("createSignal(0)");
    expect(read(app, "lib/items.ts")).toContain("export async function getItems()");
    expect(read(app, "app/items/loading.tsx")).toContain("Loading…");
    expect(read(app, "next.config.ts")).toContain("images: { remotePatterns: [] }");
  });

  it("re-points the moved files' relative imports and keeps the @/ ones, which vite.config.ts resolves", () => {
    expect(read(app, "src/routes/index.tsx")).toContain(`import styles from "../../app/page.module.css";`);
    expect(read(app, "src/routes/index.tsx")).toContain(`import Counter from "@/components/Counter";`);
    expect(read(app, "src/routes/items/[id]/index.tsx")).toContain(`import { getItem } from "@/lib/items";`);
    expect(read(app, "src/App.tsx")).toContain(`import "../app/globals.css";`);
    expect(read(app, "src/routes/items.tsx")).toContain(`import SegmentLoading from "../../app/items/loading";`);
    expect(read(app, "vite.config.ts")).toContain("resolve: { tsconfigPaths: true },");
  });

  it("writes start mode's files in src/, and moves the favicon to public/", () => {
    expect(run.output.nextjs.created).toEqual(["src/App.tsx", "src/routes/[...404].tsx", "src/routes/items.tsx", "src/middleware.ts", "src/vite-env.d.ts", "vite.config.ts"]);
    expect(read(app, "public/favicon.ico")).toBe("icon");
    expect(run.output.lint).toMatchObject({ files: 11, parseErrors: 0 });
    expect(run.output.failures).toEqual([]);
  });
});

describe.skipIf(!bin)("react-to-solid workflow with nextRoutes, as a preview or without an App Router", { tags: ["slow"] }, () => {
  it("previews the moves and the files it would write, and writes nothing", () => {
    const app = givenNextApp();
    const run = migrate(app, ["nextRoutes=true"]);
    expect(run.output.preview).toBe(true);
    expect(run.output.nextjs.moved["src/app/page.tsx"]).toBe("src/routes/index.tsx");
    expect(run.output.nextjs.created).toContain("vite.config.ts");
    expect(fs.existsSync(path.join(app, "src/routes"))).toBe(false);
    expect(fs.existsSync(path.join(app, "vite.config.ts"))).toBe(false);
  });

  it("moves nothing when the App Router isn't at src/app, and says why", () => {
    const app = givenApp((dir) => fs.mkdirSync(path.join(dir, "app")));
    const run = migrate(app, ["apply=true", "nextRoutes=true"]);
    expect(run.output.nextjs).toBeUndefined();
    expect(run.output.flags).toContainEqual(expect.objectContaining({ file: "src", kind: "Next.js route", detail: expect.stringMatching(/^no App Router at src\/app$/) }));
  });
});

describe.skipIf(!bin)("react-to-solid workflow on one app of a monorepo", { tags: ["slow"] }, () => {
  let repo;
  let run;
  const rootPackage = `{\n  "name": "repo",\n  "private": true,\n  "workspaces": ["apps/*"],\n  "devDependencies": {\n    "@types/react": "^19.0.0",\n    "typescript": "5.9.3"\n  }\n}\n`;
  const baseTsconfig = `{\n  "compilerOptions": {\n    "jsx": "react-jsx",\n    "strict": true\n  }\n}\n`;
  const otherPackage = `{\n  "name": "other",\n  "dependencies": {\n    "react": "19.2.0"\n  }\n}\n`;
  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "r2s-mono-"));
    fs.writeFileSync(path.join(repo, "package.json"), rootPackage);
    fs.writeFileSync(path.join(repo, "tsconfig.base.json"), baseTsconfig);
    fs.mkdirSync(path.join(repo, "apps/web"), { recursive: true });
    fs.cpSync(path.join(fixture, "src"), path.join(repo, "apps/web/src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "apps/web/package.json"), `{\n  "name": "web",\n  "dependencies": {\n    "react": "19.2.0",\n    "react-dom": "19.2.0"\n  },\n  "devDependencies": {\n    "@vitejs/plugin-react": "^5.0.0",\n    "vite": "^7.1.0"\n  }\n}\n`);
    fs.writeFileSync(path.join(repo, "apps/web/tsconfig.json"), `{\n  "extends": "../../tsconfig.base.json",\n  "compilerOptions": {\n    "paths": { "@other/*": ["../other/src/*"], "~/*": ["./src/*"] }\n  },\n  "include": ["src"]\n}\n`);
    fs.writeFileSync(path.join(repo, "apps/web/vite.config.ts"), viteConfig);
    fs.mkdirSync(path.join(repo, "apps/other"), { recursive: true });
    fs.writeFileSync(path.join(repo, "apps/other/package.json"), otherPackage);
    const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.email=spec@example.com", "-c", "user.name=spec", "commit", "-qm", "fixture");
    run = migrate(repo, ["apply=true", "include=apps/web/src"]);
  }, 120_000);

  it("moves the package that owns the converted directory, bumping Vite for Solid's plugin", () => {
    expect(read(repo, "apps/web/package.json")).toBe(`{\n  "name": "web",\n  "dependencies": {\n    "@solidjs/web": "^2.0.3",\n    "solid-js": "^2.0.3"\n  },\n  "devDependencies": {\n    "@solidjs/vite-plugin": "^3.0.1",\n    "vite": "^8.3.8"\n  }\n}\n`);
    expect(read(repo, "apps/web/vite.config.ts")).toContain("plugins: [solid()]");
  });

  it("leaves the workspace's shared files and the other apps alone, reporting what the shared ones need", () => {
    expect(read(repo, "package.json")).toBe(rootPackage);
    expect(read(repo, "tsconfig.base.json")).toBe(baseTsconfig);
    expect(read(repo, "apps/other/package.json")).toBe(otherPackage);
    expect(run.output.flags).toContainEqual(expect.objectContaining({ file: "tsconfig.base.json", kind: "shared config", detail: `shared with the workspace, so not changed: jsx "react-jsx" -> "preserve"` }));
    expect(run.output.flags).toContainEqual(expect.objectContaining({ file: "package.json", kind: "shared config", detail: "shared with the workspace, so not changed: removed @types/react" }));
    expect(run.output.flags).toContainEqual(expect.objectContaining({ file: "apps/web", kind: "build config", detail: expect.stringContaining("no tsconfig on the way to apps/web/src sets jsx") }));
  });

  it("flags a tsconfig path into the source of another package that depends on React, which now compiles as Solid JSX", () => {
    expect(run.output.flags.filter((f) => f.file === "apps/web/tsconfig.json")).toEqual([{ file: "apps/web/tsconfig.json", line: 0, kind: "build config", detail: expect.stringMatching(/^paths maps "@other\/\*" to \.\.\/other\/src\/\*, the source of apps\/other, which depends on React/) }]);
  });
});

describe.skipIf(!bin)("react-to-solid workflow with workspace=true on a pnpm monorepo", { tags: ["slow"] }, () => {
  let repo;
  let run;
  beforeAll(() => {
    repo = givenApp(() => {}, monorepo);
    run = migrate(repo, ["apply=true", "include=apps/web/src", "workspace=true"]);
  }, 120_000);

  it("converts the workspace packages the app depends on, transitively, with the hook contract across the package boundary", () => {
    expect(read(repo, "packages/hooks/src/index.ts")).toBe(`import { createSignal } from "solid-js";\n\nexport function useToggle(initial: boolean) {\n  // solid: on: accessor (useState hands back an accessor: read it as \`on()\`); setOn: static (useState hands back a stable value)\n  const [on, setOn] = createSignal(initial);\n  // solid: toggle: function (reads on, setOn when called)\n  const toggle = () => setOn(!on());\n  // solid: return: getter-object (a hook's returned object: callers keep \`r.k\`)\n  return { get on() { return on(); }, get toggle() { return toggle; } };\n}\n`);
    // @repo/hooks resolves through its package.json (main: ./dist/index.js, so src/index.ts).
    expect(read(repo, "packages/ui/src/toggle.tsx")).toBe(`import { Check } from "@lucide/solid";\nimport { useToggle } from "@repo/hooks";\n\nexport function Toggle(props: { label: string }) {\n  // solid: on: getter-read (destructured from useToggle's getters: keep the object, read \`r.on\`); toggle: static (useToggle hands back a stable function; calling it reads reactive values)\n  const toggle2 = useToggle(false);\n  return (\n    <button class="toggle" onClick={toggle2.toggle}>\n      {toggle2.on && <Check />}\n      {props.label}\n    </button>\n  );\n}\n`);
    expect(read(repo, "apps/web/src/App.tsx")).toContain("const [count, setCount] = createSignal(0);");
    expect(run.output.analyzed).toBe(3);
  });

  it("moves each converted package's package.json and tsconfig: a library peers on Solid", () => {
    expect(JSON.parse(read(repo, "packages/ui/package.json"))).toMatchObject({ dependencies: { "@lucide/solid": "^1.76.0", "@repo/hooks": "workspace:*" }, devDependencies: { "solid-js": "^2.0.3" }, peerDependencies: { "solid-js": "^2.0.3" } });
    expect(JSON.parse(read(repo, "packages/hooks/package.json")).peerDependencies).toEqual({ "solid-js": "^2.0.3" });
    expect(read(repo, "packages/ui/tsconfig.json")).toContain(`"jsx": "preserve",\n    "jsxImportSource": "@solidjs/web"`);
    expect(read(repo, "apps/web/vite.config.ts")).toContain("plugins: [solid()]");
  });

  it("reports the converted packages, and flags the unconverted app that uses one; the tsconfig paths flag is gone", () => {
    expect(run.output.workspace).toEqual([{ dir: "packages/ui", name: "@repo/ui", usedBy: ["apps/docs"] }, { dir: "packages/hooks", name: "@repo/hooks", usedBy: [] }]);
    expect(run.output.flags.filter((f) => f.kind === "workspace")).toEqual([{ file: "packages/ui/package.json", line: 0, kind: "workspace", detail: "@repo/ui was converted with apps/web, and apps/docs depends on it too: apps/docs breaks until it's converted as well, or uses a React copy of packages/ui" }]);
    expect(run.output.flags.filter((f) => f.file === "apps/web/tsconfig.json")).toEqual([]);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).split("\n").filter((line) => /apps\/docs|packages\/tsconfig|^ M package\.json/.test(line))).toEqual([]);
    expect(run.output.failures).toEqual([]);
  });

  it("changes nothing when run again", () => {
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=spec@example.com", "-c", "user.name=spec", "commit", "-qm", "converted"], { cwd: repo });
    const again = migrate(repo, ["apply=true", "include=apps/web/src", "workspace=true"]);
    expect(again.status).toBe("succeeded");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" })).toBe("");
    expect(again.output.alreadySolid).toEqual(["apps/web/src/App.tsx"]);
  });
});

describe.skipIf(!bin)("react-to-solid workflow on a pnpm monorepo without workspace=true", { tags: ["slow"] }, () => {
  it("converts only the app, and flags each React workspace package it uses with the param that converts it", () => {
    const repo = givenApp(() => {}, monorepo);
    const run = migrate(repo, ["apply=true", "include=apps/web/src"]);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean).map((line) => line.slice(3)).sort()).toEqual(["apps/web/package.json", "apps/web/src/App.tsx", "apps/web/tsconfig.json", "apps/web/vite.config.ts"]);
    expect(run.output.workspace).toBeUndefined();
    expect(run.output.flags.filter((f) => f.kind === "workspace")).toEqual([
      { file: "apps/web/package.json", line: 0, kind: "workspace", detail: "@repo/ui (packages/ui) is a workspace package that depends on React, and this run doesn't convert it, so apps/web still imports React code from it: run with --param workspace=true to convert it in the same run, which changes it for apps/docs too" },
      { file: "apps/web/package.json", line: 0, kind: "workspace", detail: "@repo/hooks (packages/hooks) is a workspace package that depends on React, and this run doesn't convert it, so apps/web still imports React code from it: run with --param workspace=true to convert it in the same run" },
    ]);
    expect(run.output.flags).toContainEqual(expect.objectContaining({ file: "apps/web/tsconfig.json", detail: expect.stringMatching(/^paths maps "@repo\/ui\/\*" to \.\.\/\.\.\/packages\/ui\/src\/\*, the source of packages\/ui, which depends on React/) }));
  }, 120_000);
});

describe.skipIf(!bin)("react-to-solid workflow run twice", { tags: ["slow"] }, () => {
  let app;
  let first;
  // Already Solid: converting them again wrapped merge() in a memo and called solid-query's result.
  const badge = `import { merge } from "solid-js";\nimport { Check } from "@lucide/solid";\n\nexport function Badge(props: { icon?: typeof Check; text: string }) {\n  const merged = merge({ icon: Check }, props);\n  const Icon = merged.icon;\n  return <span><Icon />{merged.text}</span>;\n}\n`;
  const count = `import { useQuery } from "@tanstack/solid-query";\n\nexport function Count() {\n  const query2 = useQuery(() => ({ queryKey: ["count"], queryFn: () => 1 }));\n  return <p>{query2.data}</p>;\n}\n`;
  beforeAll(() => {
    app = givenApp((dir) => {
      const pkg = JSON.parse(read(dir, "package.json"));
      pkg.devDependencies = { ...pkg.devDependencies, "@vitejs/plugin-react": "^6.1.2", vite: "^8.3.6" };
      fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
      fs.writeFileSync(path.join(dir, "vite.config.ts"), viteConfig);
      fs.writeFileSync(path.join(dir, "tsconfig.app.json"), tsconfigApp);
      fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      fs.writeFileSync(path.join(dir, "src/components/Badge.tsx"), badge);
      fs.writeFileSync(path.join(dir, "src/components/Count.tsx"), count);
    });
    first = migrate(app);
  }, 120_000);

  it("skips files that are already Solid, and says how many", () => {
    expect(read(app, "src/components/Badge.tsx")).toBe(badge);
    expect(read(app, "src/components/Count.tsx")).toBe(count);
    expect(first.output.alreadySolid).toEqual(["src/components/Badge.tsx", "src/components/Count.tsx"]);
  });

  it("changes nothing the second time: source, package.json, tsconfig and the Vite config", () => {
    execFileSync("git", ["add", "-A"], { cwd: app });
    execFileSync("git", ["-c", "user.email=spec@example.com", "-c", "user.name=spec", "commit", "-qm", "converted"], { cwd: app });
    const again = migrate(app);
    expect(again.status).toBe("succeeded");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: app, encoding: "utf8" })).toBe("");
    expect(again.output.config).toEqual([]);
    // App.tsx imports nothing from Solid or React, so it goes through the rules again, unchanged.
    expect(again.output.alreadySolid).toEqual(["src/components/Badge.tsx", "src/components/Clock.tsx", "src/components/Count.tsx", "src/components/ThemeContext.tsx", "src/components/TodoItem.tsx", "src/components/TodoList.tsx", "src/hooks/useFilter.ts"]);
    expect(again.output.flags).toEqual([]);
  }, 120_000);
});

describe.skipIf(!bin)("react-to-solid workflow on an app with React libraries and a class component", { tags: ["slow"] }, () => {
  let run;
  let app;
  beforeAll(() => {
    app = givenApp((dir) => {
      const pkg = JSON.parse(read(dir, "package.json"));
      Object.assign(pkg.dependencies, { "lucide-react": "1.0.0", zustand: "5.0.0", "@dnd-kit/core": "6.0.0", "react-hotkeys-hook": "5.0.0", lodash: "4.0.0" });
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
      fs.writeFileSync(path.join(dir, "src/components/Boundary.tsx"), `import { Component, type ReactNode } from "react";\n\nexport class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {\n  state = { failed: false };\n  static getDerivedStateFromError() {\n    return { failed: true };\n  }\n  render() {\n    return this.state.failed ? <p>Failed</p> : this.props.children;\n  }\n}\n`);
      fs.writeFileSync(path.join(dir, "src/components/Hint.tsx"), `import { Component } from "react";\n\nexport class Hint extends Component<{ text: string; tone?: string }> {\n  static defaultProps = { tone: "muted" };\n  render() {\n    return <small className={this.props.tone}>{this.props.text}</small>;\n  }\n}\n`);
      fs.writeFileSync(path.join(dir, "src/components/Done.tsx"), `import { Check, createLucideIcon } from "lucide-react";\n\nexport const Star = createLucideIcon("star", []);\nexport function Done() {\n  return <Check className="ok" />;\n}\n`);
      fs.writeFileSync(path.join(dir, "src/chat-store.ts"), `import { create } from "zustand";\n\nexport const useChat = create<{ threadId: string | null; setThreadId: (id: string) => void }>()((set) => ({\n  threadId: null,\n  setThreadId: (id) => set({ threadId: id }),\n}));\n`);
      fs.writeFileSync(path.join(dir, "src/components/Thread.tsx"), `import { useEffect } from "react";\nimport { useChat } from "../chat-store";\n\nexport function Thread({ id }: { id: string }) {\n  const threadId = useChat((s) => s.threadId);\n  const setThreadId = useChat((s) => s.setThreadId);\n  useEffect(() => {\n    document.title = threadId ?? "";\n  }, [threadId]);\n  return <button onClick={() => setThreadId(id)}>{threadId}</button>;\n}\n`);
    });
    run = migrate(app);
  }, 120_000);

  it("turns a class with only render() into a function component, its defaultProps into merge", () => {
    expect(read(app, "src/components/Hint.tsx")).toBe(`import { merge } from "solid-js";\n\nexport function Hint(props: { text: string; tone?: string }) {\n  const merged = merge({ tone: "muted" as const }, props);\n  return <small class={merged.tone}>{merged.text}</small>;\n}\n`);
  });

  it("reads a zustand store's selected state as an accessor, calls its action directly, and flags the store once with the bridge", () => {
    const thread = read(app, "src/components/Thread.tsx");
    expect(thread).toContain("createEffect(() => threadId(), (threadId) => {");
    expect(thread).toContain("<button onClick={() => setThreadId(props.id)}>{threadId()}</button>");
    expect(run.output.flags.filter((f) => f.kind === "zustand store")).toEqual([{ file: "src/chat-store.ts", line: 3, kind: "zustand store", detail: expect.stringContaining("export const useChat = Object.assign((selector) =>") }]);
    expect(run.output.flags.filter((f) => f.kind === "effect dep")).toEqual([]);
  });

  it("maps React libraries to their Solid 2 ports", () => {
    expect(run.output.plan.ported).toContain("lucide-react -> @lucide/solid@1.76.0");
  });

  it("imports a ported library from its port, flagging a name the port doesn't have", () => {
    expect(read(app, "src/components/Done.tsx")).toContain(`import { Check, createLucideIcon } from "@lucide/solid";`);
    expect(run.output.flags.filter((f) => f.kind === "ported library")).toEqual([{ file: "src/components/Done.tsx", line: 1, kind: "ported library", detail: expect.stringMatching(/^createLucideIcon from @lucide\/solid: @lucide\/solid has no createLucideIcon/) }]);
  });

  it("lists libraries without a Solid 2 port, with what to do when the table knows", () => {
    expect(run.output.plan.noPort).toEqual([
      "@dnd-kit/core: no verified Solid 2 port",
      "react-hotkeys-hook",
      expect.stringMatching(/^zustand: the React hook \(create\) has no Solid 2 port/),
    ]);
  });

  it("flags a class component, which the React Compiler pass leaves alone", () => {
    expect(run.output.flags).toContainEqual(expect.objectContaining({ file: "src/components/Boundary.tsx", kind: "class component", detail: expect.stringContaining("<Errored") }));
    expect(run.output.failures).toEqual([]);
  });
});

describe.skipIf(!bin)("react-to-solid workflow on an app with tests", { tags: ["slow"] }, () => {
  let run;
  let app;
  const test = `import { act, fireEvent, render, screen } from "@testing-library/react";\nimport { Clock } from "./Clock";\n\nit("ticks", () => {\n  vi.useFakeTimers();\n  const { rerender } = render(<Clock tickMs={1000} />);\n  act(() => {\n    vi.advanceTimersByTime(1000);\n  });\n  fireEvent.click(screen.getByRole("button"));\n  rerender(<Clock tickMs={500} />);\n});\n`;
  beforeAll(() => {
    app = givenApp((dir) => {
      const pkg = JSON.parse(read(dir, "package.json"));
      pkg.devDependencies = { ...pkg.devDependencies, "@testing-library/jest-dom": "^8.0.0", "@testing-library/react": "^16.3.3", "@vitejs/plugin-react": "^6.1.2", vite: "^8.3.6", vitest: "^5.1.1" };
      fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
      fs.writeFileSync(path.join(dir, "vitest.config.ts"), `import react from "@vitejs/plugin-react";\nimport { defineConfig } from "vitest/config";\n\nexport default defineConfig({\n  plugins: [react()],\n  test: { environment: "node" },\n});\n`);
      fs.writeFileSync(path.join(dir, "src/components/Clock.test.tsx"), test);
      fs.writeFileSync(path.join(dir, "jest.config.js"), "export default { testEnvironment: \"jsdom\" };\n");
    });
    run = migrate(app);
  }, 120_000);

  it("converts a test file: render takes a function, act and fireEvent flush, and rerender sets a signal", () => {
    expect(read(app, "src/components/Clock.test.tsx")).toBe(`import { createSignal, flush } from "solid-js";\nimport type { ComponentProps } from "@solidjs/web";\nimport { fireEvent, render, screen } from "@solidjs/testing-library";\nimport { Clock } from "./Clock";\n\nit("ticks", () => {\n  vi.useFakeTimers();\n  const [tickMs, setTickMs] = createSignal<ComponentProps<typeof Clock>["tickMs"]>(1000);\n  render(() => <Clock tickMs={tickMs()} />);\n  vi.advanceTimersByTime(1000);\n  flush();\n  fireEvent.click(screen.getByRole("button"));\n  flush();\n  setTickMs(500);\n  flush();\n});\n`);
    expect(run.output.flags.filter((f) => f.file === "src/components/Clock.test.tsx")).toEqual([]);
  });

  it("moves vitest.config to Solid's plugin, flags its node environment, and takes jest-dom back to 7", () => {
    expect(read(app, "vitest.config.ts")).toContain(`import solid from "@solidjs/vite-plugin";`);
    expect(run.output.flags).toContainEqual(expect.objectContaining({ file: "vitest.config.ts", kind: "build config", detail: expect.stringMatching(/^test\.environment is "node"/) }));
    expect(JSON.parse(read(app, "package.json")).devDependencies).toMatchObject({ "@solidjs/testing-library": "1.0.0-rc.2", "@testing-library/jest-dom": "^7.0.1" });
  });

  it("flags a Jest config: Solid's test setup is Vitest", () => {
    expect(run.output.flags).toContainEqual(expect.objectContaining({ file: "jest.config.js", kind: "build config", detail: expect.stringMatching(/^jest\.config\.js runs the tests on Jest/) }));
  });
});

describe.skipIf(!bin)("react-to-solid workflow on a project without React", { tags: ["slow"] }, () => {
  it("fails before changing any file", () => {
    const app = givenApp((dir) => fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "not-react" })));
    expect(migrate(app).error).toContain("No package.json here depends on react");
  });
});

// `codemod publish` replaces src/workflow.ts with a Rolldown bundle of it and everything it imports
// (default options, the runtime's modules external). A workflow callback then gets only the
// bindings it uses from that one file, so setup code and reassigned module-level bindings, which
// work unbundled, break once published.
describe.skipIf(!bin)("react-to-solid workflow as codemod publish bundles it", { tags: ["slow"] }, () => {
  it("writes the same files as the unbundled workflow", async () => {
    const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "r2s-published-"));
    const root = path.resolve(import.meta.dirname, "..");
    fs.cpSync(root, pkg, { recursive: true, filter: (p) => !p.includes(`${path.sep}node_modules`) });
    const external = (id) => /^codemod[:/]/.test(id) || id.startsWith("node:") || builtinModules.includes(id);
    const { output } = await (await rolldown({ input: workflow, cwd: root, external })).generate({ format: "esm" });
    fs.writeFileSync(path.join(pkg, "src/workflow.ts"), output[0].code);

    const [unbundled, bundled] = [givenApp(), givenApp()];
    migrate(unbundled);
    const run = migrate(bundled, ["apply=true"], path.join(pkg, "src/workflow.ts"));
    expect(run.status).toBe("succeeded");
    for (const file of ["src/App.tsx", "src/components/TodoList.tsx", "src/components/ThemeContext.tsx", "src/hooks/useFilter.ts"]) {
      expect(read(bundled, file)).toBe(read(unbundled, file));
    }
    // nextRoutes runs src/nextjs.mjs in its steps and callbacks too.
    const [plainNext, bundledNext] = [givenNextApp(), givenNextApp()];
    migrate(plainNext, ["apply=true", "nextRoutes=true"]);
    expect(migrate(bundledNext, ["apply=true", "nextRoutes=true"], path.join(pkg, "src/workflow.ts")).status).toBe("succeeded");
    for (const file of ["src/App.tsx", "src/Document.tsx", "src/routes/items/[id]/index.tsx", "src/routes/items.tsx", "vite.config.ts", "package.json"]) {
      expect(read(bundledNext, file)).toBe(read(plainNext, file));
    }
  }, 360_000);
});
