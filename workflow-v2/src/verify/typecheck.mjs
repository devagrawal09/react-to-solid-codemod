// After apply: optionally installs the converted package's dependencies, then type-checks it with the
// project's own TypeScript, capped, in chunks. Run from the target's root:
//
//   node typecheck.mjs <package dir> [install <manager> [install args...]]
//
// The whole result (every error, with its line's text) goes to .react-to-solid/typecheck.json, which
// the workflow reads (a shell step only returns the last 1 MiB of output); its summary, without the
// errors, is the last line of stdout. Progress goes to stderr.
//
// Install: in the directory with the lockfile, from the package up to the target; in a pnpm or npm
// workspace, scoped to the package (pnpm --filter "{dir}...", npm -w dir), and not run for a yarn or
// bun workspace, whose scoped installs need plugins or a name. The type-check only runs when
// solid-js and @solidjs/web resolve from the package, inside the target, to versions its package.json
// allows: otherwise node_modules still holds React's install, and the errors would be against it.
//
// The type-check: each tsconfig the package's tsconfig.json stands for (the configs it references,
// when it lists no files of its own, as create-vite's does), through a config next to it that
// extends it with noEmit and no build info, listing its files in chunks of
// REACT_TO_SOLID_TYPECHECK_CHUNK (50). A chunk that runs out of memory or time (15 minutes) is halved;
// a single file that still fails is listed as unchecked. TypeScript 7 is a Go binary: it ignores
// --max-old-space-size, so it gets GOMEMLIMIT and --singleThreaded; TypeScript 6 and older get
// --max-old-space-size, both from REACT_TO_SOLID_TYPECHECK_MEMORY_MB (2048).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const target = process.cwd();
const pkg = path.resolve(target, process.argv[2] ?? ".");
const [mode, manager, ...installArgs] = process.argv.slice(3);
const chunkSize = Number(process.env.REACT_TO_SOLID_TYPECHECK_CHUNK ?? 50);
const memoryMb = Number(process.env.REACT_TO_SOLID_TYPECHECK_MEMORY_MB ?? 2048);
const out = path.join(target, ".react-to-solid");
const ERROR_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const LOCKFILES = { "pnpm-lock.yaml": "pnpm", "yarn.lock": "yarn", "bun.lock": "bun", "bun.lockb": "bun", "package-lock.json": "npm" };

fs.mkdirSync(out, { recursive: true });
if (!fs.existsSync(path.join(out, ".gitignore"))) fs.writeFileSync(path.join(out, ".gitignore"), "*\n");
const relative = (file) => path.relative(target, file) || ".";

function readJson(file) {
  try {
    // tsconfig files may hold comments and trailing commas.
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/("(?:\\.|[^"\\])*")|\/\/.*|\/\*[\s\S]*?\*\//g, (match, string) => string ?? "").replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return undefined;
  }
}

function finish(result) {
  fs.writeFileSync(path.join(out, "typecheck.json"), `${JSON.stringify(result)}\n`);
  const { errors, ...summary } = result;
  console.log(JSON.stringify({ ...summary, errors: errors?.length ?? 0 }));
  process.exit(0);
}

// 1. Install, when asked.
let install = null;
if (mode === "install") {
  let dir = pkg;
  while (!Object.keys(LOCKFILES).some((name) => fs.existsSync(path.join(dir, name))) && dir !== target && path.dirname(dir) !== dir) dir = path.dirname(dir);
  if (!Object.keys(LOCKFILES).some((name) => fs.existsSync(path.join(dir, name)))) dir = pkg;
  const scope = dir === pkg ? "." : path.relative(dir, pkg);
  const workspace = scope !== "." && (fs.existsSync(path.join(dir, "pnpm-workspace.yaml")) || readJson(path.join(dir, "package.json"))?.workspaces !== undefined);
  const args = ["install", ...(workspace && manager === "pnpm" ? ["--filter", `{${scope}}...`] : workspace && manager === "npm" ? ["-w", scope] : []), ...installArgs];
  const command = `${manager} ${args.map((arg) => (arg.includes("{") ? `"${arg}"` : arg)).join(" ")}`;
  if (workspace && manager !== "pnpm" && manager !== "npm") {
    finish({ status: "skipped", reason: `this is a ${manager} workspace, whose installs aren't scoped to one package here: run the install in ${relative(dir)}, then type-check`, install: { command, directory: relative(dir), ok: false } });
  }
  console.error(`Installing with ${command} in ${relative(dir)}`);
  const log = path.join(out, "install.log");
  const fd = fs.openSync(log, "w");
  const result = spawnSync(manager, args, { cwd: dir, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  const output = fs.readFileSync(log, "utf8");
  // pnpm 11 exits with an error after installing everything when it skipped a build script it
  // wasn't told to allow; the package can still be type-checked.
  const codes = new Set(output.match(/ERR_PNPM_[A-Z_]+/g) ?? []);
  const ok = result.status === 0 || (codes.size === 1 && codes.has("ERR_PNPM_IGNORED_BUILDS"));
  install = { command, directory: relative(dir), ok, log: relative(log) };
  if (!ok) finish({ status: "skipped", reason: `${command} failed (exit ${result.status ?? result.signal ?? result.error?.message}; its output is in ${relative(log)})`, install });
}

// 2. solid-js and @solidjs/web resolve inside the target, to what package.json allows; TypeScript is the project's.
const manifest = readJson(path.join(pkg, "package.json")) ?? {};
const declared = { ...manifest.peerDependencies, ...manifest.devDependencies, ...manifest.dependencies };
const found = {};
for (const name of ["solid-js", "@solidjs/web", "typescript"]) {
  for (let dir = pkg; ; dir = path.dirname(dir)) {
    const version = readJson(path.join(dir, "node_modules", name, "package.json"))?.version;
    if (version) {
      found[name] = { version: String(version), dir: path.join(dir, "node_modules", name) };
      break;
    }
    if (dir === target || path.dirname(dir) === dir) break;
  }
}
for (const name of ["solid-js", "@solidjs/web"]) {
  const range = declared[name] ?? "";
  const have = found[name];
  const hint = install ? "" : " (run the install, or pass --param install=true)";
  if (!have) finish({ status: "skipped", reason: `${name} isn't installed where ${relative(pkg)} resolves it${hint}`, install });
  const [major, minor, patch] = have.version.split(/[.-]/).map(Number);
  const m = range.match(/^([\^~]?)(\d+)\.(\d+)\.(\d+)/);
  const want = m ? m.slice(2, 5).map(Number) : [2, 0, 0];
  const atLeast = major > want[0] || (major === want[0] && (minor > want[1] || (minor === want[1] && patch >= want[2])));
  const allowed = !m ? major === 2 : m[1] === "^" ? major === want[0] && atLeast : m[1] === "~" ? major === want[0] && minor === want[1] && atLeast : have.version === m.slice(2, 5).join(".");
  if (!allowed) finish({ status: "skipped", reason: `${name} resolves to ${have.version} at ${relative(have.dir)}, which ${relative(pkg)}/package.json's ${range || "(no range)"} doesn't allow${hint}`, install });
}
if (!found.typescript) finish({ status: "skipped", reason: `TypeScript isn't installed where ${relative(pkg)} resolves it`, install });
const native = Number(found.typescript.version.split(".")[0]) >= 7;
const tsc = path.join(found.typescript.dir, "bin", "tsc");

// 3. The configs: tsconfig.json, or the ones it references when it lists no files of its own.
const root = readJson(path.join(pkg, "tsconfig.json"));
if (!root) finish({ status: "skipped", reason: `${relative(pkg)} has no tsconfig.json`, install });
const configs = Array.isArray(root.references) && Array.isArray(root.files) && root.files.length === 0
  ? root.references.map((r) => path.join(pkg, r.path.endsWith(".json") ? r.path : path.join(r.path, "tsconfig.json"))).filter((file) => fs.existsSync(file))
  : [path.join(pkg, "tsconfig.json")];

// 4. Each config in chunks, every error once.
const env = native ? { ...process.env, GOMEMLIMIT: `${memoryMb}MiB` } : { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=${memoryMb}`.trim() };
const flags = ["--noEmit", "--pretty", "false", "--skipLibCheck", ...(native ? ["--singleThreaded"] : [])];
const compilerOptions = { noEmit: true, incremental: false, composite: false, declaration: false, declarationMap: false, emitDeclarationOnly: false, tsBuildInfoFile: null };
const errors = new Map();
const unchecked = [];
let chunks = 0;
const written = [];
try {
  for (const config of configs) {
    const dir = path.dirname(config);
    const base = path.join(dir, "tsconfig.react-to-solid.json");
    fs.writeFileSync(base, JSON.stringify({ extends: `./${path.basename(config)}`, compilerOptions }, null, 2));
    written.push(base);
    console.error(`Type-checking ${relative(config)}`);
    const listed = spawnSync(process.execPath, [tsc, "-p", base, "--listFilesOnly"], { cwd: target, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    // A config that doesn't load lists no files: its errors are the result.
    if (listed.status !== 0) for (const line of listed.stdout.split("\n").filter((l) => /error TS\d+:/.test(l))) errors.set(line, { file: relative(config), line: 0, column: 0, code: line.match(/TS\d+/)[0], message: line.replace(/^.*error TS\d+: /, "") });
    const files = listed.stdout.split("\n").filter((file) => file && path.resolve(target, file).startsWith(`${target}${path.sep}`) && !file.includes("/node_modules/")).map((file) => path.resolve(target, file));
    const declarations = files.filter((file) => file.endsWith(".d.ts"));
    const sources = files.filter((file) => !file.endsWith(".d.ts"));
    const queue = [];
    for (let i = 0; i < sources.length; i += chunkSize) queue.push(sources.slice(i, i + chunkSize));
    while (queue.length) {
      const chunk = queue.shift();
      const file = path.join(dir, `tsconfig.react-to-solid-${chunks++}.json`);
      fs.writeFileSync(file, JSON.stringify({ extends: `./${path.basename(config)}`, compilerOptions, files: [...chunk, ...declarations].map((f) => path.relative(dir, f)), include: [] }, null, 2));
      written.push(file);
      const checked = spawnSync(process.execPath, [tsc, "-p", file, ...flags], { cwd: target, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 15 * 60 * 1000, killSignal: "SIGKILL" });
      fs.rmSync(file, { force: true });
      if (checked.status !== 0 && checked.status !== 1 && checked.status !== 2) {
        // Out of memory or time: halve the chunk.
        if (chunk.length === 1) unchecked.push(relative(chunk[0]));
        else queue.unshift(chunk.slice(0, chunk.length / 2), chunk.slice(chunk.length / 2));
        continue;
      }
      // An error is its place and code: TypeScript 5 prints a union's members in an order that
      // depends on the program, so two chunks can word the same error differently.
      for (const line of checked.stdout.split("\n")) {
        const m = line.match(ERROR_LINE);
        if (m && !errors.has(`${m[1]}(${m[2]},${m[3]}) ${m[4]}`)) errors.set(`${m[1]}(${m[2]},${m[3]}) ${m[4]}`, { file: path.relative(target, path.resolve(target, m[1])), line: Number(m[2]), column: Number(m[3]), code: m[4], message: m[5] });
        else if (/^error TS\d+:/.test(line)) errors.set(line, { file: "", line: 0, column: 0, code: line.match(/TS\d+/)[0], message: line.replace(/^error TS\d+: /, "") });
      }
    }
  }
} finally {
  for (const file of written) fs.rmSync(file, { force: true });
}

// 5. Each error with its line's text.
const texts = new Map();
const listed = [...errors.values()].map((e) => {
  if (!e.file) return e;
  if (!texts.has(e.file)) texts.set(e.file, fs.existsSync(path.join(target, e.file)) ? fs.readFileSync(path.join(target, e.file), "utf8").split("\n") : []);
  return { ...e, excerpt: (texts.get(e.file)[e.line - 1] ?? "").trim().slice(0, 200) };
}).sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.column - b.column));
finish({ status: "checked", typescript: found.typescript.version, configs: configs.map(relative), chunks, unchecked, install, errors: listed });
