import { expect, it } from "vitest";
import { parse, Lang } from "@ast-grep/napi";
import { migratePackageJson, migrateTsconfig, migrateViteConfig } from "../src/manifests.mjs";

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

it("package.json bumps Vite below 8 when it adds Solid's plugin, and says so", () => {
  const { text, changes } = migratePackageJson(`{\n  "devDependencies": {\n    "@vitejs/plugin-react-swc": "^3.0.0",\n    "vite": "^7.1.0"\n  }\n}\n`);
  expect(text).toContain(`"vite": "^8.3.8"`);
  expect(changes).toContainEqual(expect.stringMatching(/^vite \^7\.1\.0 -> \^8\.3\.8: @solidjs\/vite-plugin needs Vite 8 or 9/));
});

it("package.json installs each verified port in the React package's place: a prerelease exactly, a release with ^", () => {
  const { text, changes } = migratePackageJson(`{\n  "dependencies": {\n    "@tanstack/react-query": "^5.0.0",\n    "lucide-react": "^0.500.0",\n    "react": "^19.0.0",\n    "react-router": "^7.0.0",\n    "react-router-dom": "^7.0.0"\n  },\n  "devDependencies": {\n    "@testing-library/react": "^16.0.0"\n  }\n}\n`);
  expect(text).toBe(`{\n  "dependencies": {\n    "@lucide/solid": "^1.76.0",\n    "@solidjs/router": "^2.0.0",\n    "@solidjs/web": "^2.0.3",\n    "@tanstack/solid-query": "6.0.0-rc.6",\n    "solid-js": "^2.0.3"\n  },\n  "devDependencies": {\n    "@solidjs/testing-library": "1.0.0-rc.2"\n  }\n}\n`);
  expect(changes).toContainEqual(expect.stringContaining("@testing-library/react -> @solidjs/testing-library@1.0.0-rc.2 (tests aren't converted: render takes a function"));
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
