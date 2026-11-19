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

function givenApp(edit = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r2s-"));
  fs.cpSync(fixture, dir, { recursive: true });
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

  it("reports what the rules could not convert, with file and line", () => {
    expect(run.output.flags).toContainEqual(expect.objectContaining({ file: "src/components/Clock.tsx", line: 8, kind: "effect" }));
  });

  it("reports eslint-plugin-solid's Solid 2 warnings by rule", () => {
    expect(run.output.lint.byRule).toEqual({ "solid/reactivity": 1 });
  });
});

describe.skipIf(!bin)("react-to-solid workflow without apply=true", { tags: ["slow"] }, () => {
  it("previews the conversion and writes nothing", () => {
    const app = givenApp();
    const run = migrate(app, []);
    expect(run.output.preview).toBe(true);
    expect(run.output.wouldChange).toContain("src/components/TodoList.tsx");
    expect(run.output.flags).toContainEqual(expect.objectContaining({ file: "src/components/Clock.tsx", line: 8, kind: "effect" }));
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
    fs.writeFileSync(path.join(repo, "apps/web/tsconfig.json"), `{\n  "extends": "../../tsconfig.base.json",\n  "include": ["src"]\n}\n`);
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
});

describe.skipIf(!bin)("react-to-solid workflow on an app with React libraries and a class component", { tags: ["slow"] }, () => {
  let run;
  beforeAll(() => {
    const app = givenApp((dir) => {
      const pkg = JSON.parse(read(dir, "package.json"));
      Object.assign(pkg.dependencies, { "lucide-react": "1.0.0", zustand: "5.0.0", "@dnd-kit/core": "6.0.0", "react-hotkeys-hook": "5.0.0", lodash: "4.0.0" });
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
      fs.writeFileSync(path.join(dir, "src/components/Boundary.tsx"), `import { Component, type ReactNode } from "react";\n\nexport class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {\n  state = { failed: false };\n  static getDerivedStateFromError() {\n    return { failed: true };\n  }\n  render() {\n    return this.state.failed ? <p>Failed</p> : this.props.children;\n  }\n}\n`);
    });
    run = migrate(app, []);
  }, 120_000);

  it("maps React libraries to their Solid 2 ports", () => {
    expect(run.output.plan.ported).toContain("lucide-react -> @lucide/solid@1.76.0");
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
  }, 240_000);
});
