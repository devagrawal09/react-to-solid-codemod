import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// src/verify/typecheck.mjs, run as the workflow runs it: from the target, on small packages.
const script = path.resolve(import.meta.dirname, "../src/verify/typecheck.mjs");
const modules = path.resolve(import.meta.dirname, "../node_modules");

function given(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r2s-tc-"));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), typeof text === "string" ? text : JSON.stringify(text, null, 2));
  }
  return dir;
}

// solid-js 2.0.3, @solidjs/web 2.0.3 and TypeScript 6.0.3, from this package's own devDependencies.
function linkSolid(dir, names = ["solid-js", "@solidjs/web", "typescript"]) {
  for (const name of names) {
    fs.mkdirSync(path.dirname(path.join(dir, "node_modules", name)), { recursive: true });
    fs.symlinkSync(path.join(modules, name), path.join(dir, "node_modules", name));
  }
}

function check(dir, args = ["."], env = {}) {
  const run = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
  expect(run.status, run.stderr).toBe(0);
  return { summary: JSON.parse(run.stdout.trimEnd().split("\n").pop()), result: JSON.parse(fs.readFileSync(path.join(dir, ".react-to-solid/typecheck.json"), "utf8")) };
}

const solidPackage = { name: "app", type: "module", dependencies: { "solid-js": "^2.0.3", "@solidjs/web": "^2.0.3" }, devDependencies: { typescript: "6.0.3" } };
const app = {
  "package.json": solidPackage,
  "tsconfig.json": { files: [], references: [{ path: "./tsconfig.app.json" }] },
  "tsconfig.app.json": { compilerOptions: { target: "ES2022", lib: ["ES2022", "DOM"], module: "ESNext", moduleResolution: "bundler", jsx: "preserve", jsxImportSource: "@solidjs/web", strict: true, noEmit: true }, include: ["src"] },
  "src/App.tsx": `import { createSignal } from "solid-js";\nexport function App() {\n  const [n, setN] = createSignal(0);\n  return <button onClick={() => setN(n + 1)}>{n()}</button>;\n}\n`,
  "src/format.ts": `export const pad = (n: number): string => n;\n`,
  "src/ok.ts": `export const ok = 1;\n`,
};

describe("the type-check after apply", () => {
  it("checks the configs tsconfig.json references with the project's TypeScript, against Solid 2, and lists each error with its line", () => {
    const dir = given(app);
    linkSolid(dir);
    const { summary, result } = check(dir);
    expect(result).toEqual({
      status: "checked",
      typescript: "6.0.3",
      configs: ["tsconfig.app.json"],
      chunks: 1,
      unchecked: [],
      install: null,
      errors: [
        { file: "src/App.tsx", line: 4, column: 38, code: "TS2365", message: "Operator '+' cannot be applied to types 'SourceAccessor<number>' and 'number'.", excerpt: "return <button onClick={() => setN(n + 1)}>{n()}</button>;" },
        { file: "src/format.ts", line: 1, column: 43, code: "TS2322", message: "Type 'number' is not assignable to type 'string'.", excerpt: "export const pad = (n: number): string => n;" },
      ],
    });
    expect(summary).toEqual({ ...result, errors: 2 });
    // The configs it wrote are gone; the directory it writes to ignores itself.
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("tsconfig.react-to-solid"))).toEqual([]);
    expect(fs.readFileSync(path.join(dir, ".react-to-solid/.gitignore"), "utf8")).toBe("*\n");
  });

  it("finds the same errors in chunks as in one go", () => {
    const dir = given(app);
    linkSolid(dir);
    const whole = check(dir).result;
    const chunked = check(dir, ["."], { REACT_TO_SOLID_TYPECHECK_CHUNK: "1" }).result;
    expect(chunked.chunks).toBe(3);
    expect(chunked.errors).toEqual(whole.errors);
  });

  it("doesn't check against React's install: solid-js has to resolve inside the target, to a version package.json allows", () => {
    const missing = given(app);
    expect(check(missing).result).toEqual({ status: "skipped", reason: "solid-js isn't installed where . resolves it (run the install, or pass --param install=true)", install: null });

    const old = given({ ...app, "node_modules/solid-js/package.json": { name: "solid-js", version: "1.9.9" } });
    expect(check(old).result.reason).toBe("solid-js resolves to 1.9.9 at node_modules/solid-js, which ./package.json's ^2.0.3 doesn't allow (run the install, or pass --param install=true)");

    // A copy above the target isn't the project's.
    const parent = given({});
    linkSolid(parent);
    const nested = path.join(parent, "app");
    fs.cpSync(given(app), nested, { recursive: true });
    expect(check(nested).result.reason).toMatch(/^solid-js isn't installed where \. resolves it/);

    const noTypeScript = given(app);
    linkSolid(noTypeScript, ["solid-js", "@solidjs/web"]);
    expect(check(noTypeScript).result.reason).toBe("TypeScript isn't installed where . resolves it");
  });

  // A stand-in for TypeScript: lists src/, and checks one file at a time (more is "out of memory",
  // and so is huge.ts), reporting what it ran with, and an error in common.ts that each chunk words
  // its own way (as TypeScript 5 does a union's members).
  const fakeTsc = `const fs = require("fs"), path = require("path");
const config = process.argv[process.argv.indexOf("-p") + 1];
const dir = path.dirname(config);
if (process.argv.includes("--listFilesOnly")) {
  for (const f of fs.readdirSync(path.join(dir, "src"))) console.log(path.join(dir, "src", f));
  process.exit(0);
}
const files = JSON.parse(fs.readFileSync(config, "utf8")).files.filter((f) => !f.endsWith(".d.ts"));
if (files.length > 1 || files.some((f) => f.endsWith("huge.ts"))) process.kill(process.pid, "SIGKILL");
const flags = process.argv.slice(2).filter((a) => a.startsWith("--")).join(" ");
console.log(\`\${path.relative(process.cwd(), path.join(dir, files[0]))}(1,1): error TS1000: GOMEMLIMIT=\${process.env.GOMEMLIMIT} NODE_OPTIONS=\${process.env.NODE_OPTIONS} \${flags}\`);
console.log(\`\${path.relative(process.cwd(), path.join(dir, "common.ts"))}(2,3): error TS2322: as seen from \${path.basename(files[0])}\`);
process.exit(2);
`;
  const withFakeTypeScript = (version, sources) => {
    const dir = given({
      "package.json": solidPackage,
      "tsconfig.json": { include: ["src"] },
      "node_modules/typescript/package.json": { name: "typescript", version },
      "node_modules/typescript/bin/tsc": fakeTsc,
      ...Object.fromEntries(sources.map((file) => [`src/${file}`, "export {};\n"])),
    });
    linkSolid(dir, ["solid-js", "@solidjs/web"]);
    return dir;
  };

  it("halves a chunk that runs out of memory, lists a file that does alone as unchecked, and keeps one error per place", () => {
    const { result } = check(withFakeTypeScript("6.0.3", ["a.ts", "b.ts", "huge.ts", "c.ts"]));
    expect(result.errors.map((e) => e.file)).toEqual(["common.ts", "src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(result.errors[0]).toEqual({ file: "common.ts", line: 2, column: 3, code: "TS2322", message: "as seen from a.ts", excerpt: "" });
    expect(result.unchecked).toEqual(["src/huge.ts"]);
    // [a b huge c], [a b], [a], [b], [huge c], [huge], [c]
    expect(result.chunks).toBe(7);
  });

  it("caps TypeScript 6 with --max-old-space-size, and TypeScript 7, a Go binary, with GOMEMLIMIT and --singleThreaded", () => {
    expect(check(withFakeTypeScript("6.0.3", ["a.ts"])).result.errors[1].message).toBe("GOMEMLIMIT=undefined NODE_OPTIONS=--max-old-space-size=2048 --noEmit --pretty --skipLibCheck");
    expect(check(withFakeTypeScript("7.0.2", ["a.ts"]), ["."], { REACT_TO_SOLID_TYPECHECK_MEMORY_MB: "1500" }).result.errors[1].message).toMatch(/^GOMEMLIMIT=1500MiB NODE_OPTIONS=\S* ?--noEmit --pretty --skipLibCheck --singleThreaded$/);
  });
});

describe("the install before the type-check (install=true)", () => {
  // Package managers that record how they were run, and fail when told to.
  function managers(dir, fail = {}) {
    const bin = path.join(dir, ".bin-fake");
    fs.mkdirSync(bin);
    for (const name of ["npm", "pnpm", "yarn"]) {
      const file = path.join(bin, name);
      fs.writeFileSync(file, `#!/bin/sh\necho "${name} $* @ $(pwd)" >> ${path.join(dir, "calls.log")}\n${fail[name] ? `echo "${fail[name]}"\nexit 1\n` : ""}`);
      fs.chmodSync(file, 0o755);
    }
    return { PATH: `${bin}:${process.env.PATH}` };
  }
  const calls = (dir) => (fs.existsSync(path.join(dir, "calls.log")) ? fs.readFileSync(path.join(dir, "calls.log"), "utf8").replaceAll(`${dir}`, "<target>").trim().split("\n") : []);

  it("runs the printed install where the lockfile is, then checks what it installed", () => {
    const dir = given({ ...app, "package-lock.json": "{}" });
    const { result } = check(dir, [".", "install", "npm"], managers(dir));
    expect(calls(dir)).toEqual(["npm install @ <target>"]);
    expect(result).toEqual({ status: "skipped", reason: "solid-js isn't installed where . resolves it", install: { command: "npm install", directory: ".", ok: true, log: ".react-to-solid/install.log" } });
  });

  it("scopes the install to the converted package in a pnpm or npm workspace", () => {
    const pnpm = given({ "pnpm-lock.yaml": "", "pnpm-workspace.yaml": "packages: [apps/*]\n", "package.json": { name: "root" }, "apps/web/package.json": solidPackage });
    expect(check(pnpm, ["apps/web", "install", "pnpm", "--config.strict-peer-dependencies=false"], managers(pnpm)).result.install.command).toBe(`pnpm install --filter "{apps/web}..." --config.strict-peer-dependencies=false`);
    expect(calls(pnpm)).toEqual(["pnpm install --filter {apps/web}... --config.strict-peer-dependencies=false @ <target>"]);

    const npm = given({ "package-lock.json": "{}", "package.json": { name: "root", workspaces: ["apps/*"] }, "apps/web/package.json": solidPackage });
    expect(check(npm, ["apps/web", "install", "npm"], managers(npm)).result.install.command).toBe("npm install -w apps/web");
    expect(calls(npm)).toEqual(["npm install -w apps/web @ <target>"]);
  });

  it("doesn't install a yarn workspace, whose install isn't scoped to one package here", () => {
    const dir = given({ "yarn.lock": "", "package.json": { name: "root", workspaces: ["apps/*"] }, "apps/web/package.json": solidPackage });
    const { result } = check(dir, ["apps/web", "install", "yarn"], managers(dir));
    expect(calls(dir)).toEqual([]);
    expect(result).toEqual({ status: "skipped", reason: "this is a yarn workspace, whose installs aren't scoped to one package here: run the install in ., then type-check", install: { command: "yarn install", directory: ".", ok: false } });
  });

  it("doesn't check after a failed install, and keeps its output; pnpm's skipped build scripts aren't a failure", () => {
    const failed = given({ ...app, "package-lock.json": "{}" });
    const { result } = check(failed, [".", "install", "npm"], managers(failed, { npm: "npm error ERESOLVE could not resolve" }));
    expect(result.reason).toBe("npm install failed (exit 1; its output is in .react-to-solid/install.log)");
    expect(fs.readFileSync(path.join(failed, ".react-to-solid/install.log"), "utf8")).toBe("npm error ERESOLVE could not resolve\n");

    const ignored = given({ ...app, "pnpm-lock.yaml": "" });
    expect(check(ignored, [".", "install", "pnpm"], managers(ignored, { pnpm: "ERR_PNPM_IGNORED_BUILDS Ignored build scripts: esbuild" })).result.install.ok).toBe(true);
  });
});
