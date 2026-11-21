// The workspace packages a converted package depends on: with `workspace=true` the run converts the
// ones that depend on React in the same run (their source, package.json and tsconfig), and the hook
// contracts follow imports into them by package name. Like the rule pass, nothing here touches
// Node, so it runs in the workflow's sandbox.

// pnpm-workspace.yaml's `packages:` list, read line by line: `- packages/*`, quoted or not.
export function pnpmWorkspaces(text) {
  const globs = [];
  let inPackages = false;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) inPackages = /^packages\s*:/.test(line);
    else if (inPackages) {
      const item = line.match(/^\s+-\s*["']?([^"'#]+?)["']?\s*(#.*)?$/)?.[1];
      if (item) globs.push(item);
    }
  }
  return globs;
}

// `manifests`: every package.json as { path, name, deps } (deps: dependencies, devDependencies and
// peerDependencies, name to range). `globs`: the workspace's package globs (pnpm-workspace.yaml or
// the root package.json's `workspaces`), `!` for an exclusion. `owner`: the converted package's
// directory. Returns the workspace packages the owner depends on, directly or through another one,
// through a `workspace:` or `link:` range (or, in an npm or yarn workspace, by a member's name):
// `react` says whether each depends on React, and `usedBy` lists the other packages that depend on
// it, outside the owner and those packages.
export function workspaceDependencies(manifests, globs, owner, { pnpm = false } = {}) {
  const dirOf = (m) => m.path.replace(/\/?package\.json$/, "");
  const all = manifests.filter((m) => !m.path.includes("node_modules/"));
  const matches = (dir, glob) => new RegExp(`^${glob.replace(/^\.\//, "").replace(/\/$/, "").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*")}$`).test(dir);
  const members = all.filter((m) => globs.some((g) => !g.startsWith("!") && matches(dirOf(m), g)) && !globs.some((g) => g.startsWith("!") && matches(dirOf(m), g.slice(1))));
  const byName = new Map((members.length ? members : all).filter((m) => m.name).map((m) => [m.name, m]));
  const dependencies = (m) => Object.entries(m.deps).flatMap(([name, range]) => {
    if (typeof range !== "string") return [];
    if (range.startsWith("link:")) {
      const segments = [];
      for (const s of `${dirOf(m)}/${range.slice("link:".length)}`.split("/")) {
        if (s === "..") segments.pop();
        else if (s && s !== ".") segments.push(s);
      }
      return all.filter((d) => dirOf(d) === segments.join("/"));
    }
    // pnpm links a workspace package only for a workspace: range; npm and yarn link a member by name.
    const linked = range.startsWith("workspace:") || (!pnpm && members.includes(byName.get(name)));
    return linked && byName.has(name) ? [byName.get(name)] : [];
  });
  const start = all.find((m) => dirOf(m) === owner);
  const found = [];
  for (const queue = start ? [start] : []; queue.length;) {
    for (const d of dependencies(queue.shift())) {
      if (d === start || found.includes(d)) continue;
      found.push(d);
      queue.push(d);
    }
  }
  return found.map((m) => ({
    dir: dirOf(m),
    name: m.name,
    react: "react" in m.deps || "react-dom" in m.deps,
    usedBy: all.filter((u) => u !== start && !found.includes(u) && dependencies(u).includes(m)).map(dirOf).sort(),
  }));
}

// What an import of a workspace package by name resolves to, for the hook contracts: from its
// package.json's `exports` (each condition's target, in order), else its `source`, `types`, `module`
// and `main`, and `src/index` or `index`. A built target (`dist/index.js`) stands for its source
// (`src/index`), since only source files are converted. Paths are from the repo root with a leading
// `/`, without an extension, as resolveImport in src/reactivity/contracts.mjs reads them.
export function packageModules({ dir, name, exports, main, module, types, typings, source }) {
  const at = dir ? `/${dir}/` : "/";
  const candidates = (target) => {
    const bare = target.replace(/^\.\//, "").replace(/(\.d)?\.[mc]?[jt]sx?$/, "");
    const built = bare.match(/^(dist|build|lib|out)\/(.*)$/);
    return built ? [`${at}${bare}`, `${at}src/${built[2]}`] : [`${at}${bare}`];
  };
  const targets = (value) => (typeof value === "string" ? candidates(value) : Array.isArray(value) ? value.flatMap(targets) : value && typeof value === "object" ? Object.values(value).flatMap(targets) : []);
  const modules = {};
  const subpaths = exports && typeof exports === "object" && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith(".")) ? exports : exports ? { ".": exports } : null;
  if (subpaths) {
    for (const [key, value] of Object.entries(subpaths)) {
      if (!key.startsWith(".")) continue;
      const list = [...new Set(targets(value))];
      if (list.length) modules[key === "." ? name : `${name}/${key.replace(/^\.\//, "")}`] = list;
    }
  } else {
    modules[name] = [...new Set([...[source, types, typings, module, main].filter((v) => typeof v === "string").flatMap(candidates), `${at}src/index`, `${at}index`])];
    modules[`${name}/*`] = [`${at}src/*`, `${at}*`];
  }
  return modules;
}
