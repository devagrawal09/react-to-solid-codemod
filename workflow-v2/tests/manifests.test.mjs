import { expect, it } from "vitest";
import { parse, Lang } from "@ast-grep/napi";
import { migratePackageJson, migrateTsconfig, migrateViteConfig, reactPeers } from "../src/manifests.mjs";

const viteConfig = (code) => migrateViteConfig(code, { parse, Lang });

// create-vite's react-ts template, Nov 19
const createVite = `{
  "name": "app",
  "private": true,
  "type": "module",
  "dependencies": {
    "react": "^19.3.1",
    "react-dom": "^19.3.1"
  },
  "devDependencies": {
    "@types/node": "^24.19.2",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@vitejs/plugin-react": "^6.1.2",
    "oxlint": "^1.90.0",
    "typescript": "~7.0.2",
    "vite": "^8.3.6"
  }
}
`;

it("package.json swaps React for Solid 2 and the React Vite plugin for Solid's, in alphabetical order", () => {
  const { text, flags } = migratePackageJson(createVite);
  expect(text).toBe(`{
  "name": "app",
  "private": true,
  "type": "module",
  "dependencies": {
    "@solidjs/web": "^2.0.3",
    "solid-js": "^2.0.3"
  },
  "devDependencies": {
    "@solidjs/vite-plugin": "^3.0.1",
    "@types/node": "^24.19.2",
    "oxlint": "^1.90.0",
    "typescript": "~7.0.2",
    "vite": "^8.3.6"
  }
}
`);
  expect(flags).toEqual([]);
});

it("package.json keeps the file's indentation and its own key order", () => {
  const { text } = migratePackageJson(`{\n\t"dependencies": {\n\t\t"zod": "^4.0.0",\n\t\t"react": "^19.0.0",\n\t\t"clsx": "^2.0.0"\n\t}\n}`);
  expect(text).toBe(`{\n\t"dependencies": {\n\t\t"@solidjs/web": "^2.0.3",\n\t\t"solid-js": "^2.0.3",\n\t\t"zod": "^4.0.0",\n\t\t"clsx": "^2.0.0"\n\t}\n}`);
});

it("package.json of a library that peers on React peers on Solid instead, keeps its development copy, and gets none in dependencies", () => {
  const { text, changes } = migratePackageJson(`{\n  "name": "@repo/ui",\n  "dependencies": {\n    "clsx": "^2.0.0",\n    "lucide-react": "1.0.0"\n  },\n  "devDependencies": {\n    "@types/react": "^19.0.0",\n    "react": "19.2.0"\n  },\n  "peerDependencies": {\n    "react": "^19.0.0",\n    "react-dom": "^19.0.0"\n  }\n}\n`);
  expect(text).toBe(`{\n  "name": "@repo/ui",\n  "dependencies": {\n    "@lucide/solid": "^1.76.0",\n    "clsx": "^2.0.0"\n  },\n  "devDependencies": {\n    "solid-js": "^2.0.3"\n  },\n  "peerDependencies": {\n    "@solidjs/web": "^2.0.3",\n    "solid-js": "^2.0.3"\n  }\n}\n`);
  expect(changes).toEqual(["lucide-react -> @lucide/solid@^1.76.0", "removed @types/react", "react -> solid-js@^2.0.3", "peer react -> solid-js@^2.0.3", "peer react-dom -> @solidjs/web@^2.0.3"]);
});

it("package.json bumps Vite below 8 when it adds Solid's plugin, and says so", () => {
  const { text, changes } = migratePackageJson(`{\n  "devDependencies": {\n    "@vitejs/plugin-react-swc": "^3.0.0",\n    "vite": "^7.1.0"\n  }\n}\n`);
  expect(text).toContain(`"vite": "^8.3.8"`);
  expect(changes).toContainEqual(expect.stringMatching(/^vite \^7\.1\.0 -> \^8\.3\.8: @solidjs\/vite-plugin needs Vite 8 or 9/));
});

it("package.json installs each verified port in the React package's place: a prerelease exactly, a release with ^", () => {
  const { text, changes } = migratePackageJson(`{\n  "dependencies": {\n    "@tanstack/react-query": "^5.0.0",\n    "lucide-react": "^0.500.0",\n    "react": "^19.0.0",\n    "react-router": "^7.0.0",\n    "react-router-dom": "^7.0.0"\n  },\n  "devDependencies": {\n    "@testing-library/react": "^16.0.0"\n  }\n}\n`);
  expect(text).toBe(`{\n  "dependencies": {\n    "@lucide/solid": "^1.76.0",\n    "@solidjs/router": "^2.0.0",\n    "@solidjs/web": "^2.0.3",\n    "@tanstack/solid-query": "6.0.0-rc.6",\n    "solid-js": "^2.0.3"\n  },\n  "devDependencies": {\n    "@solidjs/testing-library": "1.0.0-rc.2"\n  }\n}\n`);
  expect(changes).toContainEqual(expect.stringContaining("@testing-library/react -> @solidjs/testing-library@1.0.0-rc.2 (R46 converts the tests: render takes a function"));
});

it("package.json leaves libraries without a Solid 2 port, React lint plugins and ports it can't install, and flags them", () => {
  const { text, flags } = migratePackageJson(`{\n  "dependencies": {\n    "@base-ui/react": "^1.9.0",\n    "react": "^19.0.0",\n    "react-hotkeys-hook": "^5.0.0",\n    "zustand": "^5.0.0"\n  },\n  "devDependencies": {\n    "eslint-plugin-react-hooks": "^7.0.0"\n  }\n}\n`);
  for (const name of ["@base-ui/react", "react-hotkeys-hook", "zustand", "eslint-plugin-react-hooks"]) expect(text).toContain(`"${name}"`);
  expect(flags.map((f) => f.detail)).toEqual([
    expect.stringMatching(/^@base-ui\/react -> @solidports\/base-ui: installs and works on Solid 2\.0\.x/),
    "react-hotkeys-hook has no known Solid 2 port",
    expect.stringMatching(/^zustand has no Solid 2 port: the React hook \(create\)/),
    expect.stringMatching(/^eslint-plugin-react-hooks lints React code/),
  ]);
});

it("package.json reports a catalog: or workspace: range instead of replacing it", () => {
  const { text, flags } = migratePackageJson(`{\n  "dependencies": {\n    "react": "catalog:",\n    "react-dom": "catalog:"\n  },\n  "devDependencies": {\n    "@types/react": "catalog:"\n  }\n}\n`);
  expect(text).toBe(`{\n  "dependencies": {\n    "@solidjs/web": "^2.0.3",\n    "react": "catalog:",\n    "react-dom": "catalog:",\n    "solid-js": "^2.0.3"\n  },\n  "devDependencies": {\n    "@types/react": "catalog:"\n  }\n}\n`);
  expect(flags.map((f) => f.detail)).toEqual([
    `react is "catalog:": replace it with solid-js@2.0.3 where that range is defined`,
    `react-dom is "catalog:": replace it with @solidjs/web@2.0.3 where that range is defined`,
    `@types/react is "catalog:": remove it where that range is defined`,
  ]);
});

it("tsconfig with comments and trailing commas gets Solid's JSX, keeping everything else", () => {
  const code = `{
  // app code
  "compilerOptions": {
    "target": "es2023",
    "types": ["vite/client", "react"], /* React's globals */
    "jsx": "react-jsx", // JSX
    /* Linting */
    "strict": true,
  },
  "include": ["src"],
}
`;
  expect(migrateTsconfig(code)).toEqual({
    text: `{
  // app code
  "compilerOptions": {
    "target": "es2023",
    "types": ["vite/client"], /* React's globals */
    "jsx": "preserve", // JSX
    "jsxImportSource": "@solidjs/web",
    /* Linting */
    "strict": true,
  },
  "include": ["src"],
}
`,
    changes: [`jsx "react-jsx" -> "preserve"`, `added jsxImportSource "@solidjs/web"`, `removed "react" from types`],
    flags: [],
    jsx: true,
  });
});

it("tsconfig replaces React's jsxImportSource, and adds one after a last jsx option", () => {
  expect(migrateTsconfig(`{ "compilerOptions": { "jsxImportSource": "react", "jsx": "react-jsx" } }`).text).toBe(`{ "compilerOptions": { "jsxImportSource": "@solidjs/web", "jsx": "preserve" } }`);
  expect(migrateTsconfig(`{\n  "compilerOptions": {\n    "jsx": "react-jsx"\n  }\n}`).text).toBe(`{\n  "compilerOptions": {\n    "jsx": "preserve",\n    "jsxImportSource": "@solidjs/web"\n  }\n}`);
});

it("tsconfig without jsx is left alone", () => {
  const code = `{\n  "compilerOptions": { "types": ["node"] },\n  "include": ["vite.config.ts"]\n}\n`;
  expect(migrateTsconfig(code)).toEqual({ text: code, changes: [], flags: [], jsx: false });
});

it("vite.config swaps the React plugin for Solid's, in the file's quote style", () => {
  const { text, changes } = viteConfig(`import react from '@vitejs/plugin-react'\nimport { defineConfig } from 'vite'\n\n// https://vite.dev/config/\nexport default defineConfig({\n  plugins: [react()],\n})\n`);
  expect(text).toBe(`import solid from '@solidjs/vite-plugin'\nimport { defineConfig } from 'vite'\n\n// https://vite.dev/config/\nexport default defineConfig({\n  plugins: [solid()],\n})\n`);
  expect(changes).toEqual(["react() -> solid() from @solidjs/vite-plugin"]);
});

it("vite.config drops a babel option that only runs the React Compiler", () => {
  const { text, changes } = viteConfig(`import react from "@vitejs/plugin-react";\nexport default {\n  plugins: [\n    react({\n      babel: { plugins: [["babel-plugin-react-compiler"]] },\n    }),\n    other(),\n  ],\n};\n`);
  expect(text).toBe(`import solid from "@solidjs/vite-plugin";\nexport default {\n  plugins: [\n    solid(),\n    other(),\n  ],\n};\n`);
  expect(changes).toEqual(["react() -> solid() from @solidjs/vite-plugin, dropping the React-only babel option"]);
});

it.each([
  ["an option Solid's plugin has no counterpart for", `import react from "@vitejs/plugin-react";\nexport default { plugins: [react({ babel: { plugins: ["babel-plugin-styled-components"] } })] };\n`, "the babel option of react() has no counterpart"],
  ["a named import next to the default", `import react, { reactCompilerPreset } from "@vitejs/plugin-react";\nexport default { plugins: [react()] };\n`, "imported in a way this step doesn't rewrite"],
  ["a plugin call outside plugins: [...]", `import react from "@vitejs/plugin-react";\nconst plugins = [react()];\nexport default { plugins };\n`, "isn't called once, in plugins: [...]"],
])("vite.config flags %s and changes nothing", (_shape, code, detail) => {
  const { text, flags } = viteConfig(code);
  expect(text).toBe(code);
  expect(flags).toEqual([{ kind: "build config", detail: expect.stringContaining(detail) }]);
});

it("vite.config without the React plugin is left alone", () => {
  const code = `import { defineConfig } from "vite";\nexport default defineConfig({});\n`;
  expect(viteConfig(code)).toEqual({ text: code, changes: [], flags: [] });
});

it.each([
  ["pnpm-lock.yaml", "pnpm 9", `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      jotai:
        specifier: ^2.0.0
        version: 2.10.0(react@19.0.0)

packages:

  '@radix-ui/react-slot@1.1.0':
    resolution: {integrity: sha512-x}
    peerDependencies:
      '@types/react': '*'
      react: ^16.8 || ^17.0 || ^18.0 || ^19.0

  jotai@2.10.0:
    resolution: {integrity: sha512-x}
    engines: {node: '>=12.20.0'}
    peerDependencies:
      '@types/react': '>=17.0.0'
      react: '>=17.0.0'
    peerDependenciesMeta:
      react:
        optional: true

  motion@11.0.0:
    resolution: {integrity: sha512-x}
    peerDependencies:
      react-dom: ^18.0.0 || ^19.0.0

  zod@3.23.0:
    resolution: {integrity: sha512-x}

snapshots:

  jotai@2.10.0(react@19.0.0):
    optionalDependencies:
      react: 19.0.0
`],
  ["pnpm-lock.yaml", "pnpm 6", `lockfileVersion: '6.0'

packages:

  /@radix-ui/react-slot@1.1.0(react@18.2.0):
    resolution: {integrity: sha512-x}
    peerDependencies:
      react: ^18.0
    dev: false

  /jotai@2.10.0(react@18.2.0):
    peerDependencies:
      react: '>=17.0.0'

  /motion@11.0.0:
    peerDependencies:
      react-dom: ^18.0.0

  /zod@3.23.0:
    dev: false
`],
  ["package-lock.json", "npm", JSON.stringify({ lockfileVersion: 3, packages: {
    "": { dependencies: { jotai: "^2.0.0" } },
    "node_modules/@radix-ui/react-slot": { version: "1.1.0", peerDependencies: { react: "^18" } },
    "node_modules/jotai": { version: "2.10.0", peerDependencies: { "@types/react": ">=17", react: ">=17" } },
    "node_modules/a/node_modules/motion": { version: "11.0.0", peerDependencies: { "react-dom": "^18" } },
    "node_modules/zod": { version: "3.23.0" },
  } }, null, 2)],
  ["yarn.lock", "yarn berry", `__metadata:
  version: 8
  cacheKey: 10

"@radix-ui/react-slot@npm:^1.1.0":
  version: 1.1.0
  resolution: "@radix-ui/react-slot@npm:1.1.0"
  peerDependencies:
    react: ^18.0
  checksum: 10/x

"jotai@npm:^2.0.0, jotai@npm:^2.10.0":
  version: 2.10.0
  peerDependencies:
    "@types/react": ">=17.0.0"
    react: ">=17.0.0"

"motion@npm:^11.0.0":
  version: 11.0.0
  peerDependencies:
    react-dom: ^18.0.0

"zod@npm:^3.23.0":
  version: 3.23.0
`],
])("the %s of %s says which packages peer on React", (path, _manager, text) => {
  expect(reactPeers(path, text)).toEqual(["@radix-ui/react-slot", "jotai", "motion"]);
});

it("a yarn 1 lockfile records no peers", () => {
  expect(reactPeers("yarn.lock", `# yarn lockfile v1\n\njotai@^2.0.0:\n  version "2.10.0"\n`)).toBeNull();
});

it("package.json flags a dependency that peers on React, from the lockfile, instead of guessing from its name", () => {
  const code = `{\n  "dependencies": {\n    "jotai": "^2.0.0",\n    "react": "^19.0.0",\n    "react-use-measure": "^2.0.0",\n    "zod": "^3.0.0"\n  }\n}\n`;
  expect(migratePackageJson(code, ["jotai"]).flags).toEqual([{ kind: "dependency", detail: "jotai depends on React (peer) and has no known Solid 2 port" }]);
  expect(migratePackageJson(code).flags).toEqual([{ kind: "dependency", detail: "react-use-measure has no known Solid 2 port" }]);
});

it("package.json flags Next.js and the libraries made for it", () => {
  const { flags } = migratePackageJson(`{\n  "dependencies": {\n    "next": "^15.0.0",\n    "next-themes": "^0.4.0",\n    "react": "^19.0.0"\n  }\n}\n`);
  expect(flags.map((f) => f.detail)).toEqual([
    expect.stringMatching(/^next has no Solid 2 port: Next.js has no Solid 2 equivalent: the closest is @solidjs\/vite-plugin's start mode, with file routes through fileRoutes\(\) from @solidjs\/router\/fs, or SolidStart$/),
    expect.stringMatching(/^next-themes has no Solid 2 port: made for Next.js/),
  ]);
});

it("a package that peers on a React package depends on React too", () => {
  const lock = `lockfileVersion: '9.0'\n\npackages:\n\n  next@16.0.0:\n    peerDependencies:\n      react: ^19.0.0\n      sass: ^1.3.0\n\n  nuqs@1.20.0:\n    peerDependencies:\n      next: '>=13.4'\n\n  sass@1.99.0:\n    resolution: {integrity: sha512-x}\n\n  zundo@2.3.0:\n    peerDependencies:\n      zustand: ^5.0.0\n\n  zustand@5.0.9:\n    peerDependencies:\n      '@types/react': '>=18'\n      react: '>=18'\n`;
  expect(reactPeers("pnpm-lock.yaml", lock)).toEqual(["next", "nuqs", "zundo", "zustand"]);
});

it("package.json tells a catalog range of a library imported by name that the converted files already import its port", () => {
  const { flags } = migratePackageJson(`{\n  "dependencies": {\n    "lucide-react": "catalog:",\n    "react": "^19.0.0",\n    "react-router": "catalog:"\n  }\n}\n`);
  expect(flags.map((f) => f.detail)).toEqual([
    `lucide-react is "catalog:": replace it with @lucide/solid@1.76.0 where that range is defined; the converted files already import @lucide/solid`,
    `react-router is "catalog:": replace it with @solidjs/router@2.0.0 where that range is defined`,
  ]);
});

it("tsconfig flags a path into the source of another workspace package that depends on React, resolved from baseUrl", () => {
  const code = `{\n  "compilerOptions": {\n    "baseUrl": ".",\n    "jsx": "preserve",\n    "paths": {\n      "@acme/ui/*": ["../../packages/ui/src/*"],\n      "@acme/db": ["../../packages/db/src/index.ts"],\n      "~/*": ["./src/*"]\n    }\n  }\n}\n`;
  const { flags } = migrateTsconfig(code, { dir: "apps/web", reactPackages: ["packages/ui", "packages/ui-kit"] });
  expect(flags).toEqual([{ kind: "build config", detail: expect.stringMatching(/^paths maps "@acme\/ui\/\*" to \.\.\/\.\.\/packages\/ui\/src\/\*, the source of packages\/ui, which depends on React: with "jsxImportSource": "@solidjs\/web" it now compiles as Solid JSX/) }]);
});

it("package.json takes jest-dom 8 back to 7 next to Solid's Vite plugin, which npm won't install with 8", () => {
  const code = `{\n  "devDependencies": {\n    "@testing-library/jest-dom": "^8.0.0",\n    "@testing-library/react": "^16.3.3",\n    "@vitejs/plugin-react": "^6.1.2",\n    "vite": "^8.3.6"\n  }\n}\n`;
  const { text, changes } = migratePackageJson(code);
  expect(text).toBe(`{\n  "devDependencies": {\n    "@solidjs/testing-library": "1.0.0-rc.2",\n    "@solidjs/vite-plugin": "^3.0.1",\n    "@testing-library/jest-dom": "^7.0.1",\n    "vite": "^8.3.6"\n  }\n}\n`);
  expect(changes).toContain("@testing-library/jest-dom ^8.0.0 -> ^7.0.1: @solidjs/vite-plugin takes jest-dom up to 7, and npm won't install 8 next to it");
  expect(migratePackageJson(`{\n  "devDependencies": {\n    "@testing-library/jest-dom": "^8.0.0"\n  }\n}\n`).text).toContain(`"@testing-library/jest-dom": "^8.0.0"`);
});

it("package.json flags @testing-library/react-hooks, whose renderHook is in @solidjs/testing-library", () => {
  const { flags } = migratePackageJson(`{\n  "devDependencies": {\n    "@testing-library/react-hooks": "^8.0.1"\n  }\n}\n`);
  expect(flags).toEqual([{ kind: "dependency", detail: expect.stringMatching(/^@testing-library\/react-hooks has no Solid 2 port: renderHook is in @solidjs\/testing-library/) }]);
});

it("vitest.config swaps the React plugin and keeps a DOM test environment as it is", () => {
  const code = `import react from "@vitejs/plugin-react";\nimport { defineConfig } from "vitest/config";\nexport default defineConfig({\n  plugins: [react()],\n  test: { environment: "jsdom", setupFiles: ["./vitest.setup.ts"] },\n});\n`;
  const { text, flags } = migrateViteConfig(code, { parse, Lang, vitest: true });
  expect(text).toBe(code.replace(`import react from "@vitejs/plugin-react"`, `import solid from "@solidjs/vite-plugin"`).replace("react()", "solid()"));
  expect(flags).toEqual([]);
});

it("a Vite or Vitest config flags a node test environment, which Solid's plugin takes for server tests", () => {
  const code = `import react from "@vitejs/plugin-react";\nexport default { plugins: [react()], test: { environment: "node" } };\n`;
  expect(viteConfig(code).flags).toEqual([{ kind: "build config", detail: expect.stringMatching(/^test\.environment is "node", which @solidjs\/vite-plugin takes for server tests/) }]);
});

it("vitest.config flags a config that doesn't load Solid's plugin, unless it merges vite.config", () => {
  const alone = `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { environment: "jsdom" } });\n`;
  expect(migrateViteConfig(alone, { parse, Lang, vitest: true }).flags).toEqual([{ kind: "build config", detail: expect.stringMatching(/^this Vitest config doesn't load @solidjs\/vite-plugin/) }]);
  const merged = `import { defineConfig, mergeConfig } from "vitest/config";\nimport viteConfig from "./vite.config";\nexport default mergeConfig(viteConfig, defineConfig({ test: { environment: "jsdom" } }));\n`;
  expect(migrateViteConfig(merged, { parse, Lang, vitest: true }).flags).toEqual([]);
  expect(viteConfig(alone).flags).toEqual([]);
});

// create-next-app 16.4.6 (TypeScript, App Router, no Tailwind or ESLint), Nov 20
const createNextApp = `{
  "name": "next-app",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "next": "16.4.6",
    "react": "19.3.0",
    "react-dom": "19.3.0"
  },
  "devDependencies": {
    "@types/node": "^20",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "typescript": "^5"
  }
}
`;

it("package.json with nextRoutes: next out, the router and start mode's build in, and the scripts run Vite", () => {
  const { text, changes, flags } = migratePackageJson(createNextApp, null, { next: true });
  expect(text).toBe(`{
  "name": "next-app",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "start": "node dist/server/node.js"
  },
  "dependencies": {
    "@solidjs/router": "^2.0.0",
    "@solidjs/web": "^2.0.3",
    "solid-js": "^2.0.3"
  },
  "devDependencies": {
    "@solidjs/vite-plugin": "^3.0.1",
    "@types/node": "^20",
    "filesystem-routing": "^0.5.0",
    "typescript": "^5",
    "vite": "^8.3.8"
  }
}
`);
  expect(changes).toContain("scripts.dev: next dev -> vite");
  expect(flags).toEqual([{ kind: "build config", detail: expect.stringMatching(/^package.json has no "type": "module"/) }]);
});

it("package.json with nextRoutes swaps Turbopack's next commands too, and flags one it can't", () => {
  const { text, flags } = migratePackageJson(`{\n  "type": "module",\n  "scripts": { "dev": "next dev --turbopack", "lint": "next lint", "ci": "next build && vitest" },\n  "dependencies": { "next": "15.0.0", "react": "19.0.0" }\n}\n`, null, { next: true });
  expect(text).toContain(`"scripts": { "dev": "vite", "lint": "next lint", "ci": "vite build && vitest" }`);
  expect(text).toContain(`"dependencies": { "@solidjs/router": "^2.0.0", "@solidjs/vite-plugin": "^3.0.1", "@solidjs/web": "^2.0.3", "filesystem-routing": "^0.5.0", "solid-js": "^2.0.3", "vite": "^8.3.8" }`);
  expect(flags).toEqual([{ kind: "dependency", detail: `scripts.lint runs "next lint", and next is gone: run Vite instead (vite, vite build, vite preview), or remove it` }]);
});

it("package.json without nextRoutes keeps next and its scripts, flagged", () => {
  const { text, flags } = migratePackageJson(createNextApp);
  expect(text).toContain(`"next": "16.4.6"`);
  expect(text).toContain(`"dev": "next dev"`);
  expect(flags).toContainEqual({ kind: "dependency", detail: expect.stringMatching(/^next has no Solid 2 port/) });
});
