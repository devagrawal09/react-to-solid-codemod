import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { PORTS, reactPeers } from "../src/manifests.mjs";
import { lockCorpus } from "./corpus/lock.mjs";

/**
 * Release check (`pnpm test:corpus`, part of `pnpm test:release`, not of `pnpm test`): runs the
 * workflow with apply=true on real React apps, pinned in `tests/corpus/corpus.json`, and compares
 * what it did with `tests/corpus/baseline.json`. It needs network access the first time, and an
 * hour or so on a cold cache; later runs reuse clones and installs.
 *
 * An entry is { name, url, commit, license, subdirectory?, include, tsconfig?, chunk?, compilerOptions?, notes }:
 * - `url` + `commit` (a full hash): fetched by hash, so the input never moves. The create-vite entry
 *   has `createVite` (the create-vite version) and `overlay` (files copied over the template)
 *   instead of a url; its `commit` is the hash of the generated tree, committed with a fixed date
 *   and author, so a different template or overlay shows up as a different commit;
 * - `subdirectory`: the app's package inside the clone, where the workflow runs and the install
 *   happens (default: the clone's root); `include`: the workflow's include param, relative to it;
 * - `tsconfig`: the project's tsconfig, relative to `subdirectory` (default tsconfig.json);
 * - `chunk`: type-check in chunks of this many files, for apps too big to check in one go;
 * - `workflowCpus`: run the workflow on this many CPUs (it starts a worker per CPU);
 * - `compilerOptions`: overrides for both the React and the Solid type-check (say why in notes);
 * - `params`: more workflow params, as `name=value` (`workspace=true`). With workspace=true, the
 *   workspace packages the run converts count as converted directories too.
 *
 * For each entry it:
 * 1. clones the repository at the pinned commit (or generates the create-vite app) into the cache;
 * 2. once per commit, installs the React app as its lockfile says and type-checks it: the React
 *    baseline, cached, which should be 0 (a file's React errors are subtracted from its Solid ones);
 * 3. runs the workflow with apply=true on a fresh copy (reset with git, node_modules kept), and
 *    typecheck=false: step 6 type-checks after its own install, with the pinned TypeScript;
 * 4. checks that every converted file still parses (TypeScript's parser) and has no `await`
 *    outside an async function;
 * 5. installs the converted app (package.json, tsconfig and Vite config as the workflow left them),
 *    skipped when package.json files and the lockfile are what the last install saw;
 * 6. type-checks it with TypeScript 7, and counts errors: in all files, in converted files, and the
 *    codemod's own, in converted files whose React source imports no React-only library (one the
 *    lockfile says peers on react, other than react, react-dom and the ports that keep its names),
 *    less each file's React errors;
 * 7. prints one JSON line per entry, writes the details (errors per file, flags, timings, peak
 *    memory) to `<cache>/results/<label>/<name>.json`, and compares the counts with the baseline.
 *
 * It fails on a converted file that doesn't parse, on more workflow failures or codemod type errors
 * than the baseline, and on any change in files analyzed or changed, flags by kind or lint problems
 * by rule. Fewer type errors or failures are printed, not failed. Refreshing the baseline is
 * deliberate: `pnpm corpus:update-baseline` (`node tests/corpus.test.mjs --update-baseline`) runs
 * everything and rewrites each entry's counts; commit the diff with the change that caused it, and
 * list each intended change in the commit message. Timings are never part of the baseline.
 *
 * Environment:
 * - REACT_TO_SOLID_CORPUS_CACHE: clones, installs, tools and results (default
 *   ~/.cache/react-to-solid-corpus; not under /tmp, which WSL wipes, and never inside this repo);
 * - REACT_TO_SOLID_CORPUS_WAIT: minutes to wait for another run on the same cache (default 0: fail
 *   at once, naming it). One run holds <cache>/corpus.lock (its pid, start time and command) while
 *   it runs: two runs on one cache reset each other's work copies and overwrite each other's
 *   results. A lock whose process has exited is taken over (tests/corpus/lock.mjs);
 * - REACT_TO_SOLID_CORPUS_ONLY: comma-separated entry names to run;
 * - REACT_TO_SOLID_CORPUS_WORKFLOW: another workflow.ts to run (an older release's src/), compared
 *   with the same baseline; REACT_TO_SOLID_CORPUS_LABEL names its results directory;
 * - REACT_TO_SOLID_CORPUS_PRIVATE_REPO, _PRIVATE_INCLUDE (and _PRIVATE_TSCONFIG, default the
 *   include's parent's tsconfig.json): a local git repository to run as one more entry, at its
 *   HEAD, chunked; its baseline is kept in the cache, never in this repo. Skipped when unset.
 *   _PRIVATE_PARAMS: its `params`, comma-separated (workspace=true);
 * - REACT_TO_SOLID_CORPUS_MEMORY (default 3000M), _CPUS (a taskset list), _GOMEMLIMIT (default
 *   2000MiB), _MIN_AVAILABLE_MB (default 4000): each install, workflow run and type-check runs in a
 *   systemd-run scope with that memory cap, when systemd-run is there, and each type-check waits
 *   (up to 40 minutes) until that much memory is available. TypeScript 7 is a Go binary, which
 *   ignores --max-old-space-size, so GOMEMLIMIT and the scope cap it;
 * - CODEMOD_BIN: a codemod CLI to use instead of the pinned one installed into the cache.
 */
const packageDirectory = path.resolve(import.meta.dirname, "..");
const corpus = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "corpus/corpus.json"), "utf8"));
const updateBaseline = process.argv.includes("--update-baseline");
const env = process.env;
const cache = path.resolve(env.REACT_TO_SOLID_CORPUS_CACHE ?? path.join(os.homedir(), ".cache/react-to-solid-corpus"));
const workflow = path.resolve(env.REACT_TO_SOLID_CORPUS_WORKFLOW ?? path.join(packageDirectory, "src/workflow.ts"));
const label = env.REACT_TO_SOLID_CORPUS_LABEL ?? (env.REACT_TO_SOLID_CORPUS_WORKFLOW ? path.basename(path.dirname(path.dirname(workflow))) : "current");
const only = env.REACT_TO_SOLID_CORPUS_ONLY?.split(",").map((name) => name.trim());
const minAvailableMb = Number(env.REACT_TO_SOLID_CORPUS_MIN_AVAILABLE_MB ?? 4000);
// The pinned tools: the type-checker and the CLI that runs the workflow.
const TOOLS = { typescript: "7.0.2", codemod: "2.0.0-alpha.4" };
// Bump to throw away cached React baselines (when what they measure changes).
const REACT_CACHE_VERSION = 1;
// The Solid install allows unmet peers: some Solid 2 ports still peer on Solid 1 helpers.
const INSTALL = {
  npm: { react: ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], solid: ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"] },
  pnpm: { react: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"], solid: ["pnpm", "install", "--no-frozen-lockfile", "--ignore-scripts", "--config.strict-peer-dependencies=false"] },
  yarn: { react: ["yarn", "install", "--frozen-lockfile", "--ignore-scripts", "--non-interactive"], solid: ["yarn", "install", "--ignore-scripts", "--non-interactive"] },
  bun: { react: ["bun", "install", "--frozen-lockfile", "--ignore-scripts"], solid: ["bun", "install", "--ignore-scripts"] },
};
const LOCKFILES = { "pnpm-lock.yaml": "pnpm", "yarn.lock": "yarn", "bun.lock": "bun", "package-lock.json": "npm" };
// Packages whose installed version explains a moved type-error count.
const RESOLVED = ["solid-js", "@solidjs/web", "@solidjs/router", "@tanstack/solid-query", "@lucide/solid", "typescript"];
const ERROR_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

const repositoryRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: packageDirectory, encoding: "utf8" }).stdout.trim();
assert.ok(path.relative(repositoryRoot, cache).startsWith(".."), `the corpus cache (${cache}) must be outside this repository`);
fs.mkdirSync(cache, { recursive: true });
lockCorpus(path.join(cache, "corpus.lock"), { waitSeconds: Number(env.REACT_TO_SOLID_CORPUS_WAIT ?? 0) * 60 });

if (env.REACT_TO_SOLID_CORPUS_PRIVATE_REPO) {
  const repo = path.resolve(env.REACT_TO_SOLID_CORPUS_PRIVATE_REPO);
  const include = env.REACT_TO_SOLID_CORPUS_PRIVATE_INCLUDE;
  assert.ok(include, "REACT_TO_SOLID_CORPUS_PRIVATE_INCLUDE must name the directory to convert, such as apps/web/src");
  corpus.push({
    name: "private",
    url: `file://${repo}`,
    commit: spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim(),
    include,
    tsconfig: env.REACT_TO_SOLID_CORPUS_PRIVATE_TSCONFIG ?? path.join(path.dirname(include), "tsconfig.json"),
    chunk: 50,
    params: env.REACT_TO_SOLID_CORPUS_PRIVATE_PARAMS?.split(",").map((param) => param.trim()) ?? [],
    private: true,
  });
}
const publicBaseline = path.join(import.meta.dirname, "corpus/baseline.json");
const privateBaseline = path.join(cache, "private-baseline.json");
const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback);

const scoped = spawnSync("systemd-run", ["--user", "--scope", "-q", "true"], { stdio: "ignore" }).status === 0;
const timed = fs.existsSync("/usr/bin/time");
let peakRssMb = 0;

/**
 * Runs a command in a memory-capped systemd scope (when there is one), under /usr/bin/time for its
 * peak RSS. Output goes to `log` when given (type-checks print a lot), else it's returned.
 */
function run(argv, { cwd, log, extraEnv = {}, timeoutSeconds, cpus = env.REACT_TO_SOLID_CORPUS_CPUS } = {}) {
  const prefix = [
    ...(scoped ? ["systemd-run", "--user", "--scope", "-q", "-p", `MemoryMax=${env.REACT_TO_SOLID_CORPUS_MEMORY ?? "3000M"}`, "-p", "MemorySwapMax=0"] : []),
    ...(cpus ? ["taskset", "-c", cpus] : []),
    ...(timeoutSeconds ? ["timeout", "-s", "KILL", String(timeoutSeconds)] : []),
    ...(timed ? ["/usr/bin/time", "-f", "corpus-maxrss %M"] : []),
  ];
  const [command, ...args] = [...prefix, ...argv];
  const fd = log ? fs.openSync(log, "w") : null;
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...env, CI: "true", NO_COLOR: "1", FORCE_COLOR: "0", GIT_TERMINAL_PROMPT: "0", ...extraEnv },
    stdio: fd === null ? "pipe" : ["ignore", fd, fd],
    maxBuffer: 256 * 1024 * 1024,
  });
  if (fd !== null) fs.closeSync(fd);
  assert.equal(result.error, undefined, `${argv[0]} could not be spawned: ${result.error?.message}`);
  const output = fd === null ? `${result.stdout}${result.stderr}` : fs.readFileSync(log, "utf8");
  const rssMb = Math.round(Number(output.match(/^corpus-maxrss (\d+)$/m)?.[1] ?? 0) / 1024);
  peakRssMb = Math.max(peakRssMb, rssMb);
  return { status: result.status, output, rssMb };
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed in ${cwd}:\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

const hashOf = (texts) => createHash("sha256").update(texts.join("\0")).digest("hex");

test("the corpus manifest is well-formed", () => {
  const names = new Set();
  for (const entry of corpus) {
    for (const key of ["name", "commit", "include"]) assert.equal(typeof entry[key], "string", `${entry.name ?? "?"}: ${key} must be a string`);
    if (!entry.private) for (const key of ["license", "notes"]) assert.equal(typeof entry[key], "string", `${entry.name}: ${key} must be a string`);
    assert.match(entry.commit, /^[0-9a-f]{40}$/, `${entry.name}: commit must be a full hash`);
    assert.ok(entry.url || (entry.createVite && entry.overlay), `${entry.name}: needs a url, or createVite and overlay`);
    assert.ok(!names.has(entry.name), `${entry.name}: duplicate name`);
    names.add(entry.name);
  }
});

let tools;
for (const entry of corpus.filter((e) => !only || only.includes(e.name))) {
  test(`${entry.name}: converts, parses and type-checks no worse than the baseline`, { timeout: 4 * 60 * 60 * 1000 }, () => {
    const elapsedMs = {};
    let started = performance.now();
    const lap = (phase) => {
      elapsedMs[phase] = (elapsedMs[phase] ?? 0) + Math.round(performance.now() - started);
      started = performance.now();
    };

    // The pinned type-checker and CLI, installed once into the cache.
    if (!tools) {
      const dir = path.join(cache, "tools");
      const manifest = `${JSON.stringify({ private: true, dependencies: TOOLS }, null, 2)}\n`;
      const current = fs.existsSync(path.join(dir, "package.json")) ? fs.readFileSync(path.join(dir, "package.json"), "utf8") : null;
      if (current !== manifest || !fs.existsSync(path.join(dir, "node_modules/.bin/tsc"))) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "package.json"), manifest);
        const install = run(["npm", "install", "--no-audit", "--no-fund"], { cwd: dir });
        assert.equal(install.status, 0, `installing ${JSON.stringify(TOOLS)} failed:\n${install.output}`);
      }
      tools = { tsc: path.join(dir, "node_modules/.bin/tsc"), codemod: env.CODEMOD_BIN ?? path.join(dir, "node_modules/.bin/codemod") };
    }

    // 1. The pristine input, at the pinned commit.
    const pristine = path.join(cache, "repos", `${entry.name}-${entry.commit.slice(0, 12)}`);
    if (!fs.existsSync(path.join(pristine, ".git"))) {
      const staging = `${pristine}.staging`;
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true });
      if (entry.url) {
        git(staging, ["init", "-q"]);
        git(staging, ["remote", "add", "origin", entry.url]);
        git(staging, ["fetch", "-q", "--depth", "1", "origin", entry.commit]);
        git(staging, ["checkout", "-q", "FETCH_HEAD"]);
      } else {
        // create-vite's template, the overlay on top, committed with a fixed author and date so the
        // same template and overlay always give the same commit.
        const scaffold = run(["npx", "-y", `create-vite@${entry.createVite}`, "app", "--template", "react-ts", "--no-interactive"], { cwd: staging });
        assert.equal(scaffold.status, 0, `create-vite failed:\n${scaffold.output}`);
        fs.cpSync(path.join(packageDirectory, entry.overlay), path.join(staging, "app"), { recursive: true });
        const fixed = { GIT_AUTHOR_NAME: "corpus", GIT_AUTHOR_EMAIL: "corpus@example.com", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_NAME: "corpus", GIT_COMMITTER_EMAIL: "corpus@example.com", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
        for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", `create-vite@${entry.createVite} react-ts with ${entry.overlay}`]]) {
          const result = spawnSync("git", args, { cwd: path.join(staging, "app"), encoding: "utf8", env: { ...env, ...fixed } });
          assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
        }
      }
      fs.renameSync(entry.url ? staging : path.join(staging, "app"), pristine);
      fs.rmSync(staging, { recursive: true, force: true });
    }
    const head = git(pristine, ["rev-parse", "HEAD"]).trim();
    if (head !== entry.commit) fs.rmSync(pristine, { recursive: true, force: true });
    assert.equal(head, entry.commit, `${entry.name}: the input is at ${head}, not the pinned ${entry.commit} (for create-vite: the template or overlay changed; pin the new commit and refresh the baseline)`);
    lap("clone");

    const subdirectory = entry.subdirectory ?? "";
    const include = path.posix.join(subdirectory, entry.include);
    const tsconfigPath = path.posix.join(subdirectory, entry.tsconfig ?? "tsconfig.json");
    const resultsDirectory = path.join(cache, "results", label);
    fs.mkdirSync(resultsDirectory, { recursive: true });
    const reactCache = path.join(cache, "results", "react", `${entry.name}-${hashOf([entry.commit, TOOLS.typescript, tsconfigPath, JSON.stringify(entry.compilerOptions ?? {}), String(entry.chunk ?? 0), String(REACT_CACHE_VERSION)]).slice(0, 16)}.json`);
    const measured = { react: readJson(reactCache, null), solid: null };
    let conversion = null;

    // 2-6. The React app (once per commit), then the converted one, each in its own working copy so
    // each keeps its node_modules between runs.
    for (const variant of ["react", "solid"]) {
      if (measured[variant]) continue;
      const work = path.join(cache, "work", entry.name, variant);
      if (!fs.existsSync(path.join(work, ".git"))) {
        fs.rmSync(work, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(work), { recursive: true });
        git(path.dirname(work), ["clone", "-q", "--shared", "--no-checkout", pristine, work]);
      }
      git(work, ["fetch", "-q", pristine, entry.commit]);
      git(work, ["reset", "-q", "--hard", entry.commit]);
      git(work, ["clean", "-q", "-fdx", "-e", "node_modules"]);
      const target = path.join(work, subdirectory);
      lap(`${variant}: reset`);

      if (variant === "solid") {
        // 3. The workflow, as a user runs it, with its run store in the cache.
        const store = path.join(cache, "runs", label, entry.name);
        fs.rmSync(store, { recursive: true, force: true });
        fs.mkdirSync(store, { recursive: true });
        // The CLI runs a worker per CPU, each with its own copy of the React Compiler: on a big app
        // that can outgrow the memory cap, so `workflowCpus` runs it on the first few allowed CPUs.
        const allowed = fs.readFileSync("/proc/self/status", "utf8").match(/^Cpus_allowed_list:\s*(\S+)/m)[1].split(",").flatMap((range) => {
          const [from, to = from] = range.split("-").map(Number);
          return Array.from({ length: to - from + 1 }, (_, i) => from + i);
        });
        const cli = run([tools.codemod, "workflow", "run", "-w", workflow, "-t", target, "--param", `include=${entry.include}`, "--param", "apply=true", "--param", "typecheck=false", ...(entry.params ?? []).flatMap((param) => ["--param", param]), "--no-interactive", "--approve", "--disable-analytics", "--no-color"], {
          cwd: packageDirectory,
          extraEnv: { CODEMOD_RUN_STORE_DIR: store },
          cpus: entry.workflowCpus ? allowed.slice(0, entry.workflowCpus).join(",") : undefined,
        });
        fs.writeFileSync(path.join(resultsDirectory, `${entry.name}.workflow.log`), cli.output);
        const id = cli.output.match(/^Run (\S+)/m)?.[1];
        assert.ok(id && fs.existsSync(path.join(store, id, "run.json")), `the workflow didn't finish (exit ${cli.status}):\n${cli.output.slice(-4000)}`);
        const runJson = JSON.parse(fs.readFileSync(path.join(store, id, "run.json"), "utf8"));
        assert.ok(runJson.output, `the workflow returned nothing (exit ${cli.status}):\n${cli.output.slice(-4000)}`);
        const output = runJson.output;
        lap("workflow");

        // React-only libraries, from the React app's package.json files (on the way to the converted
        // directory, and of the workspace packages converted with it) and lockfile: every library
        // that peers on React but react, react-dom and the ports that export its names (lucide-react,
        // @tanstack/react-query, @testing-library/react), which the workflow can convert. A converted
        // file whose React source imported one is left out of the codemod's count; going by the React
        // source keeps that set the same for every version.
        const converted = (output.workspace ?? []).map((p) => path.posix.join(subdirectory, p.dir));
        const deps = new Set(["react", "react-dom"]);
        for (const dir of [subdirectory, ...entry.include.split("/").map((_, i, parts) => path.posix.join(subdirectory, ...parts.slice(0, i + 1))), ...converted]) {
          const pkg = readJson(path.join(pristine, dir, "package.json"), {});
          for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies })) deps.add(name);
        }
        const lockfile = Object.keys(LOCKFILES).find((name) => fs.existsSync(path.join(pristine, subdirectory, name)));
        const peers = lockfile ? reactPeers(lockfile, fs.readFileSync(path.join(pristine, subdirectory, lockfile), "utf8")) : null;
        const reactLibraries = new Set([...deps].filter((name) => name !== "react" && name !== "react-dom" && !PORTS[name]?.lacks && (peers ? peers.includes(name) : /react/i.test(name))));

        // 4. Every converted file parses, and awaits only inside async functions.
        const changed = git(work, ["status", "--porcelain", "-z", "--untracked-files=all", "--", include, ...converted])
          .split("\0")
          .filter(Boolean)
          .map((line) => line.slice(3))
          .filter((file) => /\.tsx?$/.test(file))
          .sort();
        const parseFailures = [];
        const ownFiles = [];
        for (const file of changed) {
          const text = fs.readFileSync(path.join(work, file), "utf8");
          const { diagnostics = [] } = ts.transpileModule(text, { fileName: file, reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } });
          for (const d of diagnostics) parseFailures.push(`${file}:${d.file ? d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1 : 0} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
          const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
          const visit = (node) => {
            if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier)) {
              const fn = ts.findAncestor(node.parent, ts.isFunctionLike);
              if (fn && !(ts.getCombinedModifierFlags(fn) & ts.ModifierFlags.Async)) parseFailures.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} await outside an async function`);
            }
            ts.forEachChild(node, visit);
          };
          visit(source);
          // The codemod's own: a converted file whose React source imports no React-only library.
          const original = ts.createSourceFile(file, fs.readFileSync(path.join(pristine, file), "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
          const imports = original.statements.filter((s) => (ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier)).map((s) => s.moduleSpecifier.text);
          if (!imports.some((spec) => reactLibraries.has(spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/")))) ownFiles.push(file);
        }
        const flags = {};
        for (const flag of output.flags ?? []) flags[flag.kind] = (flags[flag.kind] ?? 0) + 1;
        conversion = {
          analyzed: output.analyzed,
          changed: changed.length,
          failures: output.failures ?? [],
          flags: Object.fromEntries(Object.entries(flags).sort(([a], [b]) => a.localeCompare(b))),
          lint: { problems: output.lint?.problems ?? null, parseErrors: output.lint?.parseErrors ?? null, byRule: Object.fromEntries(Object.entries(output.lint?.byRule ?? {}).sort(([a], [b]) => a.localeCompare(b))) },
          parseFailures,
          changedFiles: changed,
          ownFiles,
          reactLibraries: [...reactLibraries].sort(),
        };
        lap("parse");
      }

      // 5. Install, unless package.json files, lockfile and command are what the last one saw.
      const manager = LOCKFILES[Object.keys(LOCKFILES).find((name) => fs.existsSync(path.join(target, name)))] ?? "npm";
      const command = INSTALL[manager][variant];
      const manifests = git(work, ["ls-files", "-z", "--", "*package.json", ...Object.keys(LOCKFILES).map((name) => path.posix.join(subdirectory, name))]).split("\0").filter(Boolean);
      const installHash = hashOf([command.join(" "), ...manifests.flatMap((file) => [file, fs.readFileSync(path.join(work, file), "utf8")])]);
      const stamp = path.join(cache, "work", entry.name, `${variant}.install`);
      if (!(fs.existsSync(path.join(target, "node_modules")) && readJson(stamp, null)?.hash === installHash)) {
        fs.rmSync(stamp, { force: true });
        const install = run(command, { cwd: target, log: path.join(resultsDirectory, `${entry.name}.${variant}.install.log`) });
        assert.equal(install.status, 0, `${command.join(" ")} failed for the ${variant} app:\n${install.output.slice(-4000)}`);
        fs.writeFileSync(stamp, JSON.stringify({ hash: installHash }));
      }
      const resolved = {};
      for (const name of RESOLVED) {
        for (let dir = path.join(work, include); ; dir = path.dirname(dir)) {
          const pkg = readJson(path.join(dir, "node_modules", name, "package.json"), null);
          if (pkg) {
            resolved[name] = pkg.version;
            break;
          }
          if (dir === work) break;
        }
      }
      lap(`${variant}: install`);

      // 6. Type-check with TypeScript 7 through a tsconfig that extends the app's: one for the whole
      // project, or one per chunk of its files (each chunk's errors, deduplicated).
      const tsconfig = path.join(work, tsconfigPath);
      const configDir = path.dirname(tsconfig);
      const compilerOptions = { noEmit: true, incremental: false, composite: false, declaration: false, declarationMap: false, emitDeclarationOnly: false, tsBuildInfoFile: null, plugins: [], ...entry.compilerOptions };
      const base = path.join(configDir, "tsconfig.corpus.json");
      fs.writeFileSync(base, JSON.stringify({ extends: `./${path.basename(tsconfig)}`, compilerOptions }, null, 2));
      let queue = [null];
      let declarations = [];
      if (entry.chunk) {
        const listed = run([tools.tsc, "-p", base, "--listFilesOnly"], { cwd: configDir });
        assert.ok(listed.status === 0, `tsc --listFilesOnly failed:\n${listed.output.slice(-4000)}`);
        const files = listed.output.split("\n").filter((file) => file.startsWith(work) && !file.includes("/node_modules/")).map((file) => path.relative(configDir, file));
        declarations = files.filter((file) => file.endsWith(".d.ts"));
        const sources = files.filter((file) => !file.endsWith(".d.ts"));
        queue = [];
        for (let i = 0; i < sources.length; i += entry.chunk) queue.push(sources.slice(i, i + entry.chunk));
      }
      const errors = new Map();
      const unchecked = [];
      let chunks = 0;
      while (queue.length) {
        const chunk = queue.shift();
        const config = chunk ? path.join(configDir, `tsconfig.corpus-${chunks}.json`) : base;
        if (chunk) fs.writeFileSync(config, JSON.stringify({ extends: `./${path.basename(tsconfig)}`, compilerOptions, files: [...chunk, ...declarations], include: [] }, null, 2));
        chunks++;
        // Wait for memory: other processes share this machine.
        for (let waited = 0; ; waited += 120) {
          const available = Number(fs.readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)/m)?.[1] ?? Infinity) / 1024;
          if (available >= minAvailableMb) break;
          assert.ok(waited < 40 * 60, `only ${Math.round(available)} MB available after 40 minutes; need ${minAvailableMb}`);
          console.error(`${entry.name}: waiting for memory (${Math.round(available)} MB available, need ${minAvailableMb})`);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120_000);
        }
        const log = path.join(resultsDirectory, `${entry.name}.${variant}.tsc${chunk ? `-${chunks}` : ""}.log`);
        const checked = run([tools.tsc, "-p", config, "--noEmit", "--pretty", "false", "--skipLibCheck", "--singleThreaded"], { cwd: work, log, timeoutSeconds: 1800, extraEnv: { GOMEMLIMIT: env.REACT_TO_SOLID_CORPUS_GOMEMLIMIT ?? "2000MiB" } });
        if (checked.status !== 0 && checked.status !== 1 && checked.status !== 2) {
          // Out of memory or out of time: halve the chunk; a single file that still fails is recorded.
          assert.ok(chunk, `tsc exited ${checked.status} on the whole ${variant} project; set "chunk" for ${entry.name}:\n${checked.output.slice(-2000)}`);
          if (chunk.length === 1) unchecked.push(chunk[0]);
          else queue.unshift(chunk.slice(0, chunk.length / 2), chunk.slice(chunk.length / 2));
          continue;
        }
        for (const line of checked.output.split("\n")) {
          const match = line.match(ERROR_LINE);
          const file = match ? path.relative(work, path.resolve(work, match[1])) : "";
          if (match) errors.set(`${file}(${match[2]},${match[3]}): ${match[4]}: ${match[5]}`, { file, code: match[4] });
          else if (/^error TS\d+:/.test(line)) errors.set(line, { file, code: line.match(/TS\d+/)[0] });
        }
      }
      const byFile = {};
      for (const { file } of errors.values()) byFile[file] = (byFile[file] ?? 0) + 1;
      measured[variant] = { total: errors.size, byFile, errors: [...errors.entries()].map(([text, { file, code }]) => ({ text, file, code })), unchecked, chunks, resolved };
      if (variant === "react") fs.mkdirSync(path.dirname(reactCache), { recursive: true });
      if (variant === "react") fs.writeFileSync(reactCache, JSON.stringify(measured.react));
      lap(`${variant}: type-check`);
    }

    // 7. The counts, the details, and the comparison with the baseline.
    const react = measured.react;
    const solid = measured.solid;
    const net = (files) => files.reduce((sum, file) => sum + Math.max(0, (solid.byFile[file] ?? 0) - (react.byFile[file] ?? 0)), 0);
    const ownByCode = {};
    const own = new Set(conversion.ownFiles);
    for (const { file, code } of solid.errors) if (own.has(file)) ownByCode[code] = (ownByCode[code] ?? 0) + 1;
    const counts = {
      commit: entry.commit,
      analyzed: conversion.analyzed,
      changed: conversion.changed,
      failures: conversion.failures.length,
      flags: conversion.flags,
      lint: conversion.lint,
      parseFailures: conversion.parseFailures.length,
      typeErrors: {
        react: react.total,
        total: solid.total,
        convertedFiles: net(conversion.changedFiles),
        own: net(conversion.ownFiles),
        ownFiles: conversion.ownFiles.length,
        ownByCode: Object.fromEntries(Object.entries(ownByCode).sort(([, a], [, b]) => b - a)),
      },
      resolved: solid.resolved,
    };
    const memory = { peakRssMb, harnessRssMb: Math.round(process.resourceUsage().maxRSS / 1024) };
    console.log(JSON.stringify({ name: entry.name, label, ...counts, elapsedMs, memory }));
    fs.writeFileSync(path.join(resultsDirectory, `${entry.name}.json`), `${JSON.stringify({ name: entry.name, label, workflow, counts, elapsedMs, memory, conversion, react, solid }, null, 1)}\n`);

    const baselinePath = entry.private ? privateBaseline : publicBaseline;
    const baseline = readJson(baselinePath, {});
    if (updateBaseline) {
      assert.ok(!env.REACT_TO_SOLID_CORPUS_WORKFLOW, "--update-baseline records this package's own workflow only");
      baseline[entry.name] = counts;
      const ordered = {};
      for (const { name } of corpus) if (baseline[name] !== undefined) ordered[name] = baseline[name];
      fs.writeFileSync(baselinePath, `${JSON.stringify(ordered, null, 2)}\n`);
    }
    const expected = baseline[entry.name];
    assert.ok(expected, `${entry.name} has no baseline; run \`pnpm corpus:update-baseline\` and review the diff`);
    assert.equal(expected.commit, counts.commit, `${entry.name}: the baseline was recorded at ${expected.commit}, but the manifest pins ${counts.commit}; refresh the baseline`);

    // A per-line delta (+3, -1, new, gone), so a reviewer sees what moved without diffing JSON.
    const failed = [];
    const noted = [];
    const delta = (key, before, after, fail) => {
      if (before === after) return;
      const change = before === undefined ? `new (${after})` : after === undefined ? `gone (was ${before})` : `${after - before > 0 ? "+" : ""}${after - before} (${before} -> ${after})`;
      (fail ? failed : noted).push(`  ${key}: ${change}`);
    };
    for (const key of ["analyzed", "changed"]) delta(key, expected[key], counts[key], true);
    delta("failures", expected.failures, counts.failures, counts.failures > expected.failures);
    for (const [key, before, after] of [["flags", expected.flags, counts.flags], ["lint", expected.lint.byRule, counts.lint.byRule], ["type errors by code (codemod's own)", expected.typeErrors.ownByCode, counts.typeErrors.ownByCode]]) {
      for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) delta(`${key}: ${name}`, before[name], after[name], key !== "type errors by code (codemod's own)");
    }
    for (const key of ["problems", "parseErrors"]) delta(`lint ${key}`, expected.lint[key], counts.lint[key], true);
    delta("type errors, codemod's own", expected.typeErrors.own, counts.typeErrors.own, counts.typeErrors.own > expected.typeErrors.own);
    for (const key of ["react", "total", "convertedFiles", "ownFiles"]) delta(`type errors, ${key}`, expected.typeErrors[key], counts.typeErrors[key], false);
    for (const name of [...new Set([...Object.keys(expected.resolved ?? {}), ...Object.keys(counts.resolved)])]) {
      if (expected.resolved?.[name] !== counts.resolved[name]) noted.push(`  installed ${name}: ${expected.resolved?.[name]} -> ${counts.resolved[name]}`);
    }
    if (conversion.parseFailures.length) failed.push(`  ${conversion.parseFailures.length} converted files don't parse:`, ...conversion.parseFailures.map((line) => `    ${line}`));
    if (counts.failures > expected.failures) failed.push(...conversion.failures.map((f) => `    ${JSON.stringify(f).slice(0, 300)}`));
    if (solid.unchecked.length) noted.push(`  not type-checked (tsc ran out of memory or time on these alone): ${solid.unchecked.join(", ")}`);
    if (noted.length) console.error(`${entry.name}, against the baseline:\n${noted.join("\n")}`);
    assert.ok(failed.length === 0, `${entry.name} differs from ${entry.private ? privateBaseline : "tests/corpus/baseline.json"}:\n${[...failed, ...noted].join("\n")}\nIf the change is intended, run \`pnpm corpus:update-baseline\` and commit the diff with it, listing each change in the commit message.`);
  });
}
