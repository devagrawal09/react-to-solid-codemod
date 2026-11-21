import { describe, expect, it } from "vitest";
import { packageModules, pnpmWorkspaces, workspaceDependencies } from "../src/workspaces.mjs";

const pkg = (path, name, deps = {}) => ({ path, name, deps });

describe("pnpm-workspace.yaml", () => {
  it("reads the packages list, quoted or not, and leaves the other keys", () => {
    expect(pnpmWorkspaces(`packages:\n  - packages/*\n  - "apps/*"\n  - 'tooling/typescript' # shared config\n  - "!**/test/**"\n\ncatalog:\n  react: 19.2.0\nallowBuilds:\n  - esbuild\n`)).toEqual(["packages/*", "apps/*", "tooling/typescript", "!**/test/**"]);
  });
});

describe("workspace dependencies", () => {
  const manifests = [
    pkg("package.json", "repo"),
    pkg("apps/web/package.json", "web", { react: "19.2.0", "@repo/ui": "workspace:*", "@repo/config": "workspace:^", lodash: "4.0.0" }),
    pkg("apps/docs/package.json", "docs", { react: "19.2.0", "@repo/ui": "workspace:*" }),
    pkg("apps/admin/package.json", "admin", { react: "19.2.0", "@repo/hooks": "workspace:*" }),
    pkg("packages/ui/package.json", "@repo/ui", { react: "^19", "@repo/hooks": "workspace:*" }),
    pkg("packages/hooks/package.json", "@repo/hooks", { "react-dom": "^19" }),
    pkg("packages/config/package.json", "@repo/config"),
    pkg("node_modules/@repo/ui/package.json", "@repo/ui", { react: "^19" }),
  ];

  it("follows workspace: ranges transitively, says which depend on React, and which other packages use each", () => {
    expect(workspaceDependencies(manifests, ["apps/*", "packages/*"], "apps/web", { pnpm: true })).toEqual([
      { dir: "packages/ui", name: "@repo/ui", react: true, usedBy: ["apps/docs"] },
      { dir: "packages/config", name: "@repo/config", react: false, usedBy: [] },
      { dir: "packages/hooks", name: "@repo/hooks", react: true, usedBy: ["apps/admin"] },
    ]);
  });

  it("in a pnpm workspace, links a package by name only through workspace:", () => {
    const plain = [pkg("apps/web/package.json", "web", { react: "19.2.0", "@repo/ui": "^1.0.0" }), pkg("packages/ui/package.json", "@repo/ui", { react: "^19" })];
    expect(workspaceDependencies(plain, ["apps/*", "packages/*"], "apps/web", { pnpm: true })).toEqual([]);
  });

  it("in an npm or yarn workspace, links a member by name, but not a package outside the globs", () => {
    const npm = [
      pkg("apps/web/package.json", "web", { react: "19.2.0", "@repo/ui": "*", "@repo/legacy": "*" }),
      pkg("packages/ui/package.json", "@repo/ui", { react: "^19" }),
      pkg("legacy/package.json", "@repo/legacy", { react: "^19" }),
    ];
    expect(workspaceDependencies(npm, ["apps/*", "packages/*"], "apps/web").map((p) => p.dir)).toEqual(["packages/ui"]);
  });

  it("follows a link: range by its path, and leaves out excluded packages", () => {
    const linked = [
      pkg("apps/web/package.json", "web", { react: "19.2.0", ui: "link:../../packages/ui", "@repo/fixtures": "workspace:*" }),
      pkg("packages/ui/package.json", "ui", { react: "^19" }),
      pkg("packages/fixtures/package.json", "@repo/fixtures", { react: "^19" }),
    ];
    expect(workspaceDependencies(linked, ["apps/*", "packages/**", "!packages/fixtures"], "apps/web", { pnpm: true }).map((p) => p.dir)).toEqual(["packages/ui"]);
  });
});

describe("what an import of a workspace package resolves to", () => {
  it("reads exports, with a subpath pattern, each condition's target and a built file's source", () => {
    expect(packageModules({ dir: "packages/ui", name: "@repo/ui", exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./*": "./src/*.tsx", "./package.json": "./package.json" } })).toEqual({
      "@repo/ui": ["/packages/ui/dist/index", "/packages/ui/src/index"],
      "@repo/ui/*": ["/packages/ui/src/*"],
      "@repo/ui/package.json": ["/packages/ui/package.json"],
    });
  });

  it("takes a string or conditions-only exports as the package's entry", () => {
    expect(packageModules({ dir: "packages/a", name: "a", exports: "./src/index.ts" })).toEqual({ a: ["/packages/a/src/index"] });
    expect(packageModules({ dir: "packages/a", name: "a", exports: { import: "./lib/a.mjs" } })).toEqual({ a: ["/packages/a/lib/a", "/packages/a/src/a"] });
  });

  it("without exports, reads source, types and main, then src/index; a deep import goes to src/ or the root", () => {
    expect(packageModules({ dir: "packages/hooks", name: "@repo/hooks", main: "./dist/index.js", types: "./dist/index.d.ts" })).toEqual({
      "@repo/hooks": ["/packages/hooks/dist/index", "/packages/hooks/src/index", "/packages/hooks/index"],
      "@repo/hooks/*": ["/packages/hooks/src/*", "/packages/hooks/*"],
    });
  });
});
