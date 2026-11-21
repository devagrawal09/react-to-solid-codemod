// React -> Solid 2 migration on the code-first engine.
//
//   codemod workflow run -w src/workflow.ts -t <app> [--param include=src] [--param apply=true] [--param install=true] [--param agent=true]
//
// Without apply=true the run is a preview: it converts every file in memory and reports
// what it would change, flags included, and writes nothing but the work list.
//
// 1. Guard: the target is a React app, and which of its libraries have a Solid port.
// 2. Reactivity pass: the React Compiler (run inside jssg, no Node) decides what each
//    component-body value becomes; a whole-program pass works out what each hook returns.
// 3. Rule pass: mechanical rewrites (props, hooks, JSX, imports), with flags for the rest.
// 4. Project: package.json, tsconfig and the Vite config move to Solid 2 (no install).
// 5. Verify: eslint-plugin-solid's Solid 2 config on the migrated files, then, once Solid 2 is
//    installed (install=true runs the install), the project's own TypeScript (src/verify/).
// 6. The work list: every flag and type error, in .react-to-solid/worklist.md (src/worklist.mjs),
//    which the run also writes in a preview. Optionally handed to an agent, after an approval.
//
// With --param nextRoutes=true, a Next.js App Router (src/app, or app/ at the package root) also
// moves to Solid's file routes (src/nextjs.mjs): route files go to src/routes, the root layout
// becomes src/Document.tsx, and start mode's files (src/App.tsx, vite.config.ts, ...) are written.
//
// With --param workspace=true, the workspace packages the converted package depends on that depend
// on React (src/workspaces.mjs) are converted in the same run: their files, package.json, tsconfig
// and Vite config, with hook contracts followed into them by package name.
//
// A file that's already Solid (it imports Solid and nothing from React) is skipped, so a second run
// changes nothing.
import { step, forEachFile, shell, agent, approval, branch, commit } from "codemod/workflow";
import { parse } from "codemod/ast-grep";
import { applyContracts, decide, extract, rewrite } from "./lib/reactivity.mjs";
import { transform } from "./rules/mechanical.mjs";
import { NO_PORT, PORTS, migratePackageJson, migrateTsconfig, migrateViteConfig, reactPeers } from "./manifests.mjs";
import { moveImports, nextAppFiles, nextConfigKeys, planNextRoutes } from "./nextjs.mjs";
import { packageModules, pnpmWorkspaces, workspaceDependencies } from "./workspaces.mjs";
import { renderWorklist } from "./worklist.mjs";

const NOT_SHIPPED = /^(@types\/|babel-plugin-react-compiler$|eslint-plugin-react|typescript$)/;

export default async function main({ params }: { params: { include?: string; apply?: boolean | string; install?: boolean | string; typecheck?: boolean | string; agent?: boolean | string; nextRoutes?: boolean | string; workspace?: boolean | string } }) {
  // --param values arrive as JSON when they parse as JSON, so true is a boolean.
  const apply = params.apply === true || params.apply === "true";
  const install = params.install === true || params.install === "true";
  const typecheck = params.typecheck !== false && params.typecheck !== "false";
  const nextRoutes = params.nextRoutes === true || params.nextRoutes === "true";
  // nextRoutes without include: a Next.js app with app/ at its root (create-next-app without
  // --src-dir) is converted from the root, where its components/ and lib/ are too.
  const rootApp = nextRoutes && params.include === undefined
    ? (await step("Find the App Router", forEachFile(["app/layout.tsx", "app/layout.jsx", "app/layout.ts", "app/layout.js", "src/app/layout.tsx", "src/app/layout.jsx"], (file) => file.path))).outputs
    : [];
  const fallback = rootApp.some((f) => f.startsWith("app/")) && !rootApp.some((f) => f.startsWith("src/")) ? "." : "src";
  // "" is the target's root (include=.).
  const root = (params.include ?? fallback).replace(/\/$/, "").replace(/^\.$/, "");
  const at = root ? `${root}/` : "";
  const workspace = params.workspace === true || params.workspace === "true";

  // A package's name and entry points say what an import of it by name resolves to (workspace=true).
  const manifests = await step("Read package.json files", forEachFile("**/package.json", (file) => {
    const pkg = JSON.parse(file.text);
    return {
      path: file.path,
      deps: { ...pkg.peerDependencies, ...pkg.devDependencies, ...pkg.dependencies },
      packageManager: pkg.packageManager ?? null,
      scripts: Object.keys(pkg.scripts ?? {}),
      name: typeof pkg.name === "string" ? pkg.name : null,
      workspaces: Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? null,
      entry: { exports: pkg.exports ?? null, main: pkg.main ?? null, module: pkg.module ?? null, types: pkg.types ?? null, typings: pkg.typings ?? null, source: pkg.source ?? null },
    };
  }));
  // The lockfile names the package manager, and which packages peer on React.
  const lockfiles = await step("Read the lockfile", forEachFile(["pnpm-lock.yaml", "yarn.lock", "bun.lock", "package-lock.json"], (file) => ({ path: file.path, peers: reactPeers(file.path, file.text) })));
  const peers = lockfiles.outputs.find((l) => l.peers)?.peers ?? null;
  // pnpm's workspace packages; npm and yarn list theirs in the root package.json's `workspaces`.
  const pnpmWorkspace = await step("Read the workspace definition", forEachFile(["pnpm-workspace.yaml"], (file) => pnpmWorkspaces(file.text)));
  const plan = await step("Check React libraries for Solid ports", () => {
    // Only the package.json files on the way to the converted directory: in a monorepo, the
    // other apps' dependencies say nothing about this one. The deepest one owns the directory.
    const deps: Record<string, string> = {};
    let owner: string | null = null;
    for (const m of manifests.outputs) {
      const dir = m.path.replace(/\/?package\.json$/, "");
      if (dir === "" || root === dir || root.startsWith(`${dir}/`)) {
        Object.assign(deps, m.deps);
        if (owner === null || dir.length > owner.length) owner = dir;
      }
    }
    // A package already on solid-js is a second run, or one a person finished: its files that are
    // already Solid are skipped, and the rest converted.
    if (!deps.react && !deps["solid-js"]) throw new Error("No package.json here depends on react; nothing to migrate.");
    // The workspace packages it depends on that depend on React: converted too with workspace=true,
    // and their dependencies are then this run's as well.
    const globs = pnpmWorkspace.outputs[0] ?? manifests.outputs.find((m) => m.path === "package.json")?.workspaces ?? [];
    const linked = workspaceDependencies(manifests.outputs, globs, owner ?? "", { pnpm: pnpmWorkspace.outputs.length > 0 }).filter((p) => p.react && p.dir !== "" && !(root === p.dir || root.startsWith(`${p.dir}/`)));
    const used = workspace ? Object.assign({}, deps, ...linked.map((p) => manifests.outputs.find((m) => m.path === `${p.dir}/package.json`)?.deps)) : deps;
    const names = linked.map((p) => p.name);
    // Without a lockfile that records peers, a name with "react" in it stands in for a React peer.
    const reactish = Object.keys(used).filter((name) => ((peers ? peers.includes(name) : /react/i.test(name)) || name in PORTS || name in NO_PORT) && !NOT_SHIPPED.test(name) && !names.includes(name)).sort();
    // The root package.json's packageManager field, then the lockfile.
    const managers: Record<string, string> = { "pnpm-lock.yaml": "pnpm", "yarn.lock": "yarn", "bun.lock": "bun", "package-lock.json": "npm" };
    const manager = manifests.outputs.find((m) => m.path === "package.json")?.packageManager?.replace(/@.*$/, "") ?? managers[lockfiles.outputs[0]?.path ?? ""] ?? "npm";
    // Some ports' dependencies still peer on solid-js 1: pnpm (strict-peer-dependencies, fatal by
    // default in pnpm 12) won't install them as they are.
    const solid1 = manager === "pnpm" ? reactish.filter((name) => PORTS[name]?.solid1Peers).map((name) => PORTS[name].to) : [];
    return {
      react: deps.react ?? null,
      usesReactCompiler: "babel-plugin-react-compiler" in deps,
      manifest: owner ? `${owner}/package.json` : "package.json",
      manager,
      install: `${manager} install${solid1.length ? " --config.strict-peer-dependencies=false" : ""}`,
      installNote: solid1.length ? `${solid1.join(", ")} still depends on Solid 1 helper packages, which peer on solid-js 1: pnpm's strict-peer-dependencies (fatal by default in pnpm 12) rejects them, so install with --config.strict-peer-dependencies=false, or allow solid-js 2 for them with a peerDependencyRules.allowedVersions entry ("solid-js": "2") in pnpm-workspace.yaml` : null,
      ported: reactish.filter((name) => PORTS[name]).map((name) => `${name} -> ${PORTS[name].to}${PORTS[name].version ? `@${PORTS[name].version}` : ""}${PORTS[name].note ? ` (${PORTS[name].note})` : ""}`),
      noPort: reactish.filter((name) => !PORTS[name]).map((name) => (NO_PORT[name] ? `${name}: ${NO_PORT[name]}` : name)),
      // Ports that export the React library's names: the rule pass imports them instead (R44).
      byName: reactish.filter((name) => PORTS[name]?.lacks),
      // The workspace packages that depend on React (converted with workspace=true), and the other
      // packages that use each.
      workspace: linked.map((p) => ({ dir: p.dir, name: p.name, usedBy: p.usedBy })),
    };
  });
  const ports = Object.fromEntries(plan.byName.map((name) => [name, PORTS[name]]));
  const packages = workspace ? plan.workspace.map((p) => p.dir) : [];
  // Test files too: the rule pass converts @testing-library/react's API to @solidjs/testing-library's.
  // From a package's root, the config files (next.config.ts, ...) and build output aren't its code.
  const sources = {
    include: [`${at}**/*.tsx`, `${at}**/*.ts`, ...packages.flatMap((dir) => [`${dir}/**/*.tsx`, `${dir}/**/*.ts`])],
    exclude: ["**/*.d.ts", ...(root ? [] : ["*.config.*", "**/node_modules/**", ".next/**", "dist/**"]), ...(packages.length ? ["**/node_modules/**"] : []), ...packages.flatMap((dir) => [`${dir}/*.config.*`, `${dir}/.next/**`, `${dir}/.turbo/**`, `${dir}/dist/**`, `${dir}/build/**`])],
  };
  // Libraries whose port takes their names: the rule pass moves their imports (R44), so a file that
  // still imports one wasn't converted. Other React libraries stay in converted files, flagged.
  const movedByName = Object.keys(PORTS).filter((name) => PORTS[name].lacks);
  const solidPorts = Object.values(PORTS).map((port) => port.to).filter((name) => !(name in PORTS));

  if (apply) await step(branch("react-to-solid-2"));
  // Each step returns its per-file results; nothing goes through state.
  const analyzed = await step("Run the React Compiler on each file", forEachFile(sources, (file) => {
    // Already Solid (a second run, or a file a person converted): it imports solid-js, @solidjs/* or
    // a Solid port, or has the `// solid:` notes this workflow writes (a converted file that needs
    // no Solid import, such as one whose hooks come from react-router), and it imports nothing from
    // react or a library whose port takes its names. Converting it again would wrap merge() in a
    // memo, call solid-query's results and write each note twice. The rule pass removes every
    // react import but R39's (React's Component or PureComponent, or `* as React` for
    // React.Component, kept for a class it leaves), which doesn't make a file React; it leaves
    // react-dom's other names and React libraries without such a port, flagged, so those don't
    // either. A file with neither Solid imports nor notes (a util, or a component the rules had
    // nothing to do in) is converted as before; the rules leave it alone.
    const imports = parse(file.text, { language: "tsx" }).root().children()
      .filter((node) => node.kind() === "import_statement" || node.kind() === "export_statement")
      .map((node) => ({ text: node.text(), source: node.field("source")?.text().slice(1, -1) ?? "" }))
      .filter((i) => i.source)
      .map((i) => ({ ...i, name: i.source.split("/").slice(0, i.source.startsWith("@") ? 2 : 1).join("/") }));
    const solid = /^[ \t]*\/\/ solid: /m.test(file.text) || imports.some((i) => i.name === "solid-js" || i.name.startsWith("@solidjs/") || solidPorts.includes(i.name));
    const react = imports.some((i) => {
      if (i.source === "react") {
        const named = i.text.match(/^import\s*\{([^}]*)\}\s*from/)?.[1];
        if (named !== undefined && named.split(",").map((s) => s.trim()).filter(Boolean).every((s) => /^(Pure)?Component(\s+as\s+[\w$]+)?$/.test(s))) return false;
        if (/^import\s*\*\s*as\s+React\s+from/.test(i.text) && [...file.text.matchAll(/\bReact\.(\w+)/g)].every((m) => /^(Pure)?Component$/.test(m[1]))) return false;
      }
      return i.source === "react" || i.source.startsWith("react/") || movedByName.includes(i.name);
    });
    if (solid && !react) return { file: file.path, solid: true, result: null };
    // contracts.mjs finds `~/` imports by an absolute-looking path. The round trip drops the
    // `undefined` fields the pass leaves, which step outputs reject.
    return { file: file.path, solid: false, result: JSON.parse(JSON.stringify(decide(extract(file.text, `/${file.path}`)))) };
  }));
  const files = analyzed.outputs.map((o) => o.file);
  const alreadySolid = analyzed.outputs.filter((o) => o.solid).map((o) => o.file);
  if (files.length === 0) return { plan, files: 0, note: `no .ts/.tsx files under ${root}` };
  const decided = await step("Resolve hook contracts across files", () => {
    // Step results are frozen; applyContracts edits its input. (No structuredClone in function steps.)
    const pending = analyzed.outputs.filter((o) => o.result);
    const results = pending.map((o) => JSON.parse(JSON.stringify(o.result)));
    // An import of a converted workspace package by name resolves to its source.
    const modules = Object.assign({}, ...manifests.outputs.filter((m) => packages.includes(m.path.replace(/\/?package\.json$/, "")) && m.name).map((m) => packageModules({ dir: m.path.replace(/\/?package\.json$/, ""), name: m.name, ...m.entry })));
    // The pass names files by an absolute-looking path (above); the order is the work list's.
    const order = applyContracts(results, { modules }).map((file: string) => file.slice(1));
    return { byFile: Object.fromEntries(pending.map((o, i) => [o.file, results[i]])), order };
  });
  // nextRoutes: where each App Router file goes. The App Router is the package's src/app (converted
  // from src/) or its app/ (converted from the package root); either way the routes go to src/routes
  // and start mode's files to src/, where start mode and filesystem-routing look by default.
  const owner = plan.manifest.replace(/\/?package\.json$/, "");
  const routing = !nextRoutes ? null : await step("Plan the Next.js routes", () => {
    const pkg = owner ? `${owner}/` : "";
    const src = `${pkg}src`;
    const fail = (detail: string) => ({ routes: null, flags: [{ file: root || ".", line: 0, kind: "Next.js route", detail }] });
    if (root !== src && root !== owner) return fail(`nextRoutes moves the App Router at ${src}/app or ${pkg}app, and converts from ${src} or the package's root; ${root || "."} is neither: run it with include=${src} or include=${owner || "."}`);
    const app = `${root ? `${root}/` : ""}app`;
    if (!files.some((f) => f.startsWith(`${app}/`))) return fail(`no App Router at ${app}`);
    const routes = planNextRoutes(files, { app, src });
    const middleware = files.filter((f) => [`${pkg}middleware.ts`, `${pkg}proxy.ts`, `${src}/middleware.ts`, `${src}/proxy.ts`].includes(f));
    return { routes, flags: [...routes.flags, ...middleware.map((file) => ({ file, line: 0, kind: "Next.js route", detail: "Next.js middleware: port it to a start-mode middleware, (event, next) => Response, listed in start.middleware in vite.config.ts" }))] };
  });
  const routes = routing?.routes ?? null;
  const moves: Record<string, string> = routes ? Object.fromEntries(Object.entries(routes.entries).map(([file, entry]) => [file, entry.to])) : {};
  // One pass per file: the compiler's decisions, then the rules on that text. A preview
  // stops before writing. With nextRoutes, a route file moves where the plan says, its relative
  // imports re-pointed from there.
  const converted = await step(apply ? "Convert each file to Solid 2" : "Preview the conversion of each file", forEachFile(sources, (file) => {
    if (alreadySolid.includes(file.path)) return { file: file.path, changed: false, applied: {}, flags: [], to: null, document: null };
    const result = decided.byFile[file.path];
    const route = routes?.entries[file.path] ?? null;
    let code = file.text;
    if (result && !result.parseError) {
      // The rewrite adds its own createMemo import; the rule pass writes the full solid-js import.
      code = rewrite(code, result).code.replace(/^import \{ createMemo \} from "solid-js";\n/m, "");
    }
    if (route) code = moveImports(code, file.path, route.to, moves);
    const next = !routes ? null : { kind: route?.kind ?? null, pattern: route?.pattern ?? null, key: route?.key ?? null, wrap: route?.wrap ?? null };
    const { code: out, applied, flags, document } = transform(code, { parse: (language: string, text: string) => parse(text, { language }), Lang: { Tsx: "tsx" }, ports, next });
    const changed = out !== file.text;
    if (apply && changed) file.write(out);
    if (apply && route) file.rename(route.to);
    // For the work list: each flagged line as converted, and the `// solid:` note above it.
    const lines = out.split("\n");
    const quoted = flags.map((f) => (f.line ? { ...f, excerpt: lines[f.line - 1].trim().slice(0, 200), note: /^\s*\/\/ solid:/.test(lines[f.line - 2] ?? "") ? lines[f.line - 2].trim() : null } : f));
    return { file: file.path, changed, applied, flags: quoted, to: route?.to ?? null, document: document ?? null };
  }));
  // The package that owns the converted directory moves to Solid 2: its package.json, the
  // tsconfig files between it and the directory, and its Vite config. A package.json or tsconfig
  // above it is shared with the rest of the workspace, so what would change there is reported.
  // With workspace=true, the workspace packages it depends on move the same way: their package.json,
  // the tsconfig files at their root, and their Vite config.
  // The other workspace packages that depend on React, which this run doesn't convert.
  const reactPackages = manifests.outputs.map((m) => ({ dir: m.path.replace(/\/?package\.json$/, ""), react: "react" in m.deps })).filter((m) => m.react && !(m.dir === "" || root === m.dir || root.startsWith(`${m.dir}/`)) && !packages.includes(m.dir)).map((m) => m.dir);
  const configs = await step(apply ? "Move package.json, tsconfig and the Vite config to Solid 2" : "Preview the package.json, tsconfig and Vite config changes", forEachFile({
    include: [
      "**/package.json", "**/tsconfig*.json",
      "**/vite.config.ts", "**/vite.config.js", "**/vite.config.mts", "**/vite.config.mjs",
      "**/vitest.config.ts", "**/vitest.config.js", "**/vitest.config.mts", "**/vitest.config.mjs",
      "**/next.config.ts", "**/next.config.js", "**/next.config.mjs", "**/next.config.cjs",
      "**/jest.config.ts", "**/jest.config.js", "**/jest.config.mjs", "**/jest.config.cjs",
    ],
    exclude: ["**/node_modules/**"],
  }, (file) => {
    const dir = file.path.replace(/\/?[^/]+$/, "");
    const name = file.path.slice(dir ? dir.length + 1 : 0);
    const linked = packages.includes(dir);
    if (!(dir === "" || root === dir || root.startsWith(`${dir}/`)) && !linked) return undefined;
    const shared = !linked && !(owner === "" || dir === owner || dir.startsWith(`${owner}/`));
    let edit;
    if (name.startsWith("next.config")) {
      if (dir !== owner) return undefined;
      // With nextRoutes the app no longer runs on Next.js: what the config sets is listed.
      const keys = routes ? nextConfigKeys(file.text, { parse: (language: string, text: string) => parse(text, { language }), Lang: { Tsx: "tsx" } }) : [];
      const detail = !routes ? `${name} configures Next.js, which has no Solid 2 equivalent: move what it sets (rewrites, redirects, headers, images, env) to @solidjs/vite-plugin's start mode or SolidStart and vite.config, then delete it`
        : keys.length ? `${name} sets ${keys.join(", ")}, which Next.js applied and start mode doesn't read: port each to vite.config.ts or a start-mode middleware (redirects, rewrites and headers are a middleware; env is Vite's import.meta.env or the plugin's env.ts), then delete it`
        : `${name} sets nothing: delete it`;
      return { file: file.path, shared: false, changes: [], flags: [{ kind: "build config", detail }], jsx: false, paths: false, vite: false, linked: false };
    }
    if (name.startsWith("jest.config")) {
      if (dir !== owner) return undefined;
      return { file: file.path, shared: false, changes: [], flags: [{ kind: "build config", detail: `${name} runs the tests on Jest, and Solid's test setup is Vitest with @solidjs/vite-plugin, which compiles Solid's JSX and resolves Solid's browser build: move the tests to Vitest (the converted tests import @solidjs/testing-library), or give Jest babel-preset-solid and the "browser" and "development" export conditions` }], jsx: false, paths: false, vite: false, linked: false };
    }
    if (name === "package.json") edit = migratePackageJson(file.text, peers, { next: !!routes && !shared && dir === owner });
    else if (name.startsWith("tsconfig")) edit = migrateTsconfig(file.text, { dir, reactPackages });
    else if (dir === owner || linked) edit = migrateViteConfig(file.text, { parse: (language: string, text: string) => parse(text, { language }), Lang: { Tsx: "tsx" }, vitest: name.startsWith("vitest.config") });
    else return undefined;
    // nextRoutes: start mode's vite.config.ts is written unless the package has one, and asks Vite to
    // resolve tsconfig paths when the package's tsconfig maps any.
    const vite = name.startsWith("vite.config") && !linked;
    if (vite && routes) edit = { ...edit, flags: [...edit.flags, { kind: "build config", detail: `${name} was already here, so start mode's isn't written: add solid({ start: { nodeServer: true }, ssr: true, serverFunctions: true, extensions: [".jsx", ".tsx"] }) and fileRoutes() from filesystem-routing/vite to its plugins` }] };
    if (apply && !shared && edit.text !== file.text) file.write(edit.text);
    return { file: file.path, shared, changes: edit.changes, flags: edit.flags, jsx: !shared && "jsx" in edit && edit.jsx, paths: dir === owner && name.startsWith("tsconfig") && /"paths"\s*:/.test(file.text), vite, linked };
  }));
  // nextRoutes: the files start mode needs (App.tsx, vite.config.ts, ...), written by a shell step
  // each, since a forEachFile step only changes files that exist. One already there is kept.
  const created = !routes ? [] : (await step("Plan start mode's files", () => {
    const document = converted.outputs.find((o) => o.document)?.document ?? null;
    const api = Object.values(routes.entries).some((e) => e.kind === "route");
    const middleware = files.includes(`${routes.src}/middleware.ts`) ? `${routes.src}/start-middleware.ts` : `${routes.src}/middleware.ts`;
    const tsconfigPaths = configs.outputs.some((o) => o.paths);
    const hasVite = configs.outputs.some((o) => o.vite && !o.shared);
    return nextAppFiles(routes, { document, api, tsconfigPaths, middleware }).filter((f) => !(hasVite && /(^|\/)vite\.config\.ts$/.test(f.path)));
  })).map((f) => ({ path: f.path, text: f.text }));
  const kept: string[] = [];
  const favicon: string[] = [];
  if (apply && routes) {
    for (const f of created) {
      const written = await step(`Write ${f.path}`, shell({ cwd: "." })`if [ -e ${f.path} ]; then echo kept; else mkdir -p ${f.path.replace(/\/?[^/]+$/, "") || "."} && printf '%s' ${f.text} > ${f.path}; fi`);
      if (written.stdout?.trim() === "kept") kept.push(f.path);
    }
    // Next.js served app/favicon.ico at /favicon.ico; Vite serves public/.
    const icon = [`${routes.app}/favicon.ico`, `${owner ? `${owner}/` : ""}public/favicon.ico`];
    const moved = await step("Move the favicon to public/", shell({ cwd: "." })`if [ -f ${icon[0]} ] && [ ! -e ${icon[1]} ]; then mkdir -p ${icon[1].replace(/\/?[^/]+$/, "") || "."} && mv ${icon[0]} ${icon[1]} && echo moved; fi`);
    if (moved.stdout?.trim() === "moved") favicon.push(...icon);
  }
  const configChanges = configs.outputs.filter((o) => !o.shared && o.changes.length).map((o) => ({ file: o.file, changes: o.changes }));
  const changed = converted.outputs.filter((o) => o.changed).map((o) => o.file);
  const report = await step("Summarize the conversion", () => {
    // A moved route file's flags are reported where it now is; the plan's flags have no line.
    const fileFlags = converted.outputs.map((o) => ({ file: (apply && o.to) || o.file, applied: o.applied, flags: o.flags }));
    const routeFlags = [...(routing?.flags ?? []), ...kept.map((file) => ({ file, line: 0, kind: "Next.js route", detail: "was already here, so start mode's version of it wasn't written: check it does what the README's nextRoutes section describes" }))]
      .map((f) => ({ file: f.file, applied: {}, flags: [{ line: f.line, kind: f.kind, detail: f.detail }] }));
    // Project flags have no line; a shared file's changes are left for a person.
    const projectFlags = configs.outputs.map((o) => ({
      file: o.file,
      applied: {},
      flags: [...o.flags, ...(o.shared ? o.changes.map((change) => ({ kind: "shared config", detail: `shared with the workspace, so not changed: ${change}` })) : [])].map((f) => ({ line: 0, ...f })),
    }));
    if (configs.outputs.some((o) => o.file.includes("tsconfig") && !o.shared && !o.linked) && !configs.outputs.some((o) => o.jsx && !o.linked)) {
      projectFlags.push({ file: owner || ".", applied: {}, flags: [{ line: 0, kind: "build config", detail: `no tsconfig on the way to ${root || "."} sets jsx: set "jsx": "preserve" and "jsxImportSource": "@solidjs/web" in the one that covers it` }] });
    }
    for (const dir of packages) {
      const own = configs.outputs.filter((o) => o.linked && o.file.startsWith(`${dir}/tsconfig`));
      if (own.length && !own.some((o) => o.jsx)) projectFlags.push({ file: dir, applied: {}, flags: [{ line: 0, kind: "build config", detail: `no tsconfig in ${dir} sets jsx: set "jsx": "preserve" and "jsxImportSource": "@solidjs/web" in the one it extends, or in its own` }] });
    }
    // A workspace package that depends on React: converted with workspace=true, which changes it for
    // the other packages that use it too; otherwise this app keeps importing React code from it.
    const workspaceFlags = plan.workspace.map((p) => ({
      file: workspace ? `${p.dir}/package.json` : plan.manifest,
      applied: {},
      flags: workspace
        ? p.usedBy.map((user) => ({ line: 0, kind: "workspace", detail: `${p.name ?? p.dir} was converted with ${owner || "."}, and ${user} depends on it too: ${user} breaks until it's converted as well, or uses a React copy of ${p.dir}` }))
        : [{ line: 0, kind: "workspace", detail: `${p.name ?? p.dir} (${p.dir}) is a workspace package that depends on React, and this run doesn't convert it, so ${owner || "."} still imports React code from it: run with --param workspace=true to convert it in the same run${p.usedBy.length ? `, which changes it for ${p.usedBy.join(", ")} too` : ""}` }],
    }));
    return summarize(files, decided.byFile, [...fileFlags, ...routeFlags, ...projectFlags, ...workspaceFlags]);
  });
  // nextRoutes: which App Router files moved where, and the files written for start mode.
  const nextjs = routes ? { moved: moves, created: created.map((f) => f.path).filter((path) => !kept.includes(path)) } : undefined;
  // workspace=true: the workspace packages converted with the app.
  const result = { plan, analyzed: files.length, alreadySolid, failures: [...analyzed.failures, ...converted.failures, ...configs.failures], ...report, config: configChanges, ...(workspace ? { workspace: plan.workspace } : {}), ...(nextjs ? { nextjs } : {}) };
  const extra = `${packages.length ? `, ${packages.length} workspace package${packages.length > 1 ? "s" : ""} included` : ""}${alreadySolid.length ? ` (already Solid: ${alreadySolid.length} file${alreadySolid.length > 1 ? "s" : ""}, skipped)` : ""}`;

  let lint = {};
  if (apply) {
    await step(commit("Convert React components to Solid 2", { add: [...files, ...Object.values(moves), ...(nextjs?.created ?? []), ...favicon, ...configChanges.map((c) => c.file)] }));

    const lintDir = `${import.meta.dirname}/lint`;
    await step("Install the Solid 2 lint", shell`cd ${lintDir} && { [ -x node_modules/.bin/eslint ] || npm ci --silent --no-audit --no-fund >&2; }`);
    // Paths are relative to the target, so the command runs there (cwd "."), not in the CLI's
    // directory. summarize.mjs prints its summary as the last line of stdout.
    // Moved route files are linted where they now are, with the components nextRoutes wrote.
    const lintFiles = [...files.map((f) => moves[f] ?? f), ...(nextjs?.created ?? []).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts") && routes !== null && f.startsWith(`${routes.src}/`))];
    const linted = await step("Lint with eslint-plugin-solid (Solid 2 config)", shell({ cwd: "." })`${lintDir}/node_modules/.bin/eslint -c ${lintDir}/eslint.config.mjs -f json ${lintFiles} | node ${lintDir}/summarize.mjs`);
    try {
      lint = JSON.parse(linted.stdout?.trimEnd().split("\n").pop() ?? "");
    } catch {
      // A dry run skips shell steps; only the last 1 MiB of output comes back.
    }
  }

  // The project's own TypeScript, once Solid 2 resolves (install=true installs it first, as the
  // printed command would). typecheck.mjs writes every error to .react-to-solid/typecheck.json: a
  // shell step only returns the last 1 MiB of output, less than a big app's errors.
  const [, , ...installArgs] = plan.install.split(" ");
  const ran = apply && typecheck ? await step(install ? "Install, then type-check with the project's TypeScript" : "Type-check with the project's TypeScript", shell({ cwd: "." })`node ${import.meta.dirname}/verify/typecheck.mjs ${owner || "."} ${install ? ["install", plan.manager, ...installArgs] : []}`) : null;
  const types = ran && !ran.skipped ? (await step("Read the type-check", forEachFile([".react-to-solid/typecheck.json"], (file) => JSON.parse(file.text)))).outputs[0] ?? null : null;

  // The work list, in both modes: a preview's is what would be left. It goes in .react-to-solid/,
  // which ignores itself, so the run changes nothing git sees and the commit leaves it out. A
  // workflow's console output goes to stderr between the step lines, and a shell step's arguments
  // can't hold a big app's list, so it's written by a forEachFile step into a file a shell step makes.
  const scripts = manifests.outputs.find((m) => m.path === plan.manifest)?.scripts ?? [];
  const cd = owner ? `cd ${owner} && ` : "";
  const typecheckScript = ["typecheck", "type-check", "check-types", "tsc"].find((name) => scripts.includes(name));
  const commands = [
    ...(apply ? [] : ["npx codemod@alpha run react-to-solid --param apply=true"]),
    plan.install,
    ...(typecheckScript ? [`${cd}${plan.manager} run ${typecheckScript}`] : types?.configs ? types.configs.map((config: string) => `npx tsc --noEmit -p ${config}`) : [`${cd}npx tsc --noEmit`]),
    ...["lint", "test", "build"].filter((name) => scripts.includes(name)).map((name) => `${cd}${plan.manager} run ${name}`),
  ];
  const checked = !apply ? null
    : !typecheck ? { status: "skipped", detail: "typecheck=false" }
    : !types ? { status: "skipped", detail: "a dry run runs no commands" }
    : types.status === "checked" ? { status: "checked", detail: `TypeScript ${types.typescript} on ${types.configs.join(", ")}, ${types.chunks} ${types.chunks === 1 ? "chunk" : "chunks"}${types.unchecked.length ? `; not checked, out of memory or time: ${types.unchecked.join(", ")}` : ""}` }
    : { status: "skipped", detail: types.reason };
  const worklist = await step("Write the work list", () => renderWorklist({
    mode: apply ? "apply" : "preview",
    root,
    flags: report.flags,
    errors: types?.errors ?? [],
    order: decided.order.map((file: string) => (apply && moves[file]) || file),
    typecheck: checked,
    commands,
  }));
  await step("Make .react-to-solid/", shell({ cwd: "." })`mkdir -p .react-to-solid && { [ -e .react-to-solid/.gitignore ] || printf '*\n' > .react-to-solid/.gitignore; } && : > .react-to-solid/worklist.md`);
  await step("Save the work list", forEachFile([".react-to-solid/worklist.md"], (file) => file.write(worklist)));
  const listed = ".react-to-solid/worklist.md";

  if (!apply) {
    console.log(`Preview: ${changed.length} of ${files.length} files would change${extra}, and ${configChanges.length} package.json, tsconfig or Vite config files, with ${report.flags.length} flagged spots to finish by hand, listed in ${listed}. Nothing else was written; run again with --param apply=true to convert them, then ${plan.install}${plan.installNote ? ` (${plan.installNote})` : ""}.`);
    return { ...result, preview: true, wouldChange: changed, worklist: listed };
  }
  if ((params.agent === true || params.agent === "true") && report.flags.length) {
    await step(approval(`Hand ${report.flags.length} flagged spots to an agent?`));
    await step("Finish flagged spots", agent(worklist, { maxSteps: 40 }));
  }
  const routed = nextjs ? `, moved ${Object.keys(moves).length} App Router files to Solid's file routes and wrote ${nextjs.created.length} start-mode files` : "";
  const typed = types?.status === "checked" ? `${types.errors.length} type errors` : `type-check skipped (${checked?.detail})`;
  const next = types?.install?.ok ? "" : ` Next: ${plan.install}${plan.installNote ? ` (${plan.installNote})` : ""}, then type-check and build.`;
  console.log(`Converted ${changed.length} of ${files.length} files${extra} and ${configChanges.length} package.json, tsconfig or Vite config files${routed}, with ${report.flags.length} flagged spots to finish by hand and ${typed}, listed in ${listed}.${next}`);
  // The errors themselves are in the work list and .react-to-solid/typecheck.json.
  return { ...result, changed, lint, typecheck: types ? { ...types, errors: types.errors?.length ?? 0 } : checked, worklist: listed };
}


function summarize(files: string[], decided: Record<string, any>, ruleResults: { file: string; applied: Record<string, number>; flags: any[] }[]) {
  const decisions: Record<string, number> = {};
  const compiler: Record<string, number> = {};
  for (const file of files) {
    for (const fn of decided[file]?.functions ?? []) {
      compiler[fn.compiler?.status ?? "none"] = (compiler[fn.compiler?.status ?? "none"] ?? 0) + 1;
      for (const v of fn.values ?? []) decisions[v.decision] = (decisions[v.decision] ?? 0) + 1;
    }
  }
  const applied: Record<string, number> = {};
  const flags: { file: string; line: number; kind: string; detail: string }[] = [];
  for (const r of ruleResults) {
    for (const [rule, n] of Object.entries(r.applied)) applied[rule] = (applied[rule] ?? 0) + n;
    for (const f of r.flags) flags.push({ file: r.file, ...f });
  }
  return { compiler, decisions, applied, flags };
}
