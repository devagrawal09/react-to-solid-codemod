# React to Solid 2

**Status: public preview.** Converts a React app to Solid 2 (`solid-js@2.0.3`). The React Compiler decides what each component-body value becomes (a signal, a memo, an accessor or a plain value), deterministic rules rewrite props, hooks, JSX and imports, the project's `package.json`, `tsconfig` and Vite config move to Solid 2, and eslint-plugin-solid's Solid 2 config checks the result. It converts most of a component; what it can't convert safely, it flags with a file and line, and lists in a work list with every type error left, in fix order, for you or an agent to finish.

## Run it

This is a Codemod workflow v2 package. Workflow v2 needs the 2.0 alpha of the Codemod CLI, `codemod@alpha`; plain `codemod` (`codemod@latest`) is still the 1.x CLI and can't run it. Run it from the root of a React app, in a clean git checkout.

```sh
# Preview (default): converts every file in memory and reports what would change,
# with the flagged spots. Nothing is written but the work list.
npx codemod@alpha run react-to-solid

# Apply: rewrites the files, lints them with eslint-plugin-solid, and type-checks them
# once Solid 2 is installed.
npx codemod@alpha run react-to-solid --param apply=true

# Apply, then install with the project's package manager and type-check.
npx codemod@alpha run react-to-solid --param apply=true --param install=true
```

| Param | Default | What it does |
|---|---|---|
| `include` | `src` | Directory whose `.ts`/`.tsx` files are converted, tests included (`.d.ts` files are skipped); `.` is the package root. In a monorepo, point it at one app: `--param include=apps/web/src`. With `nextRoutes` and no `include`, a Next.js app with `app/` at its root is converted from the root |
| `apply` | `false` | `true` writes the converted files, lints them, and type-checks them when Solid 2 is installed; otherwise the run is a preview |
| `install` | `false` | `true` (with `apply=true`) runs the install before the type-check: see [Type-check after apply](#type-check-after-apply) |
| `typecheck` | `true` | `false` skips the type-check after apply |
| `agent` | `false` | `true` (with `apply=true`) asks for approval, then hands the work list to a coding agent. Untested |
| `nextRoutes` | `false` | `true` moves a Next.js App Router (`src/app`, or `app/` at the package root) to Solid's file routes in `@solidjs/vite-plugin`'s start mode: see [Next.js App Router to file routes](#nextjs-app-router-to-file-routes) |
| `workspace` | `false` | `true` also converts the workspace packages the converted package depends on that depend on React, transitively, in the same run: see [Workspace packages](#workspace-packages) |
| `workspaceExclude` | none | With `workspace=true`, comma-separated package names or directories (globs) to leave unconverted: see [Workspace packages](#workspace-packages) |
| `cache` | `true` | With `--allow-fs`, each file's React Compiler result is kept in `$XDG_CACHE_HOME/react-to-solid` (`~/.cache/react-to-solid`), so a rerun (a preview, then apply, or a run after a few edits) compiles only the files that changed; `false` neither reads nor writes it. See [The compiler cache](#the-compiler-cache) |

The run's result holds the summary: the plan (which React libraries have a Solid 2 port), how many files the compiler cache answered (`compilerCache`), the compiler's decisions, the rules applied, the `package.json`, `tsconfig` and Vite config changes, every flag with its file and line, the files skipped as already Solid (`alreadySolid`), the lint counts, the type-check's summary, and where the work list is.

### Running it again

A file that's already Solid is skipped. That's a file that imports `solid-js`, `@solidjs/*` or a Solid port from the table below (`@lucide/solid`, `@tanstack/solid-query`, ...), or has the `// solid:` notes this workflow writes, and imports nothing from `react` or from a library whose port takes its names (`lucide-react`, `@tanstack/react-query`, `@testing-library/react`, whose imports the conversion moves). Converting such a file again changes working Solid code: `merge({ icon: Check }, props)` became `createMemo(() => merge(...))`, a solid-query result `query.data` became `query().data`, and each note was written twice. What a converted file still imports doesn't count against it: React's `Component` kept for a class R39 leaves, `react-dom` names other than `createPortal`, and React libraries without such a port (`react-router`, `react-hook-form`, ...), all flagged by the first run. A file with neither Solid imports nor notes (a util, or a component the rules had nothing to do in) goes through the rules as before, which leave it as it is. A file that still imports `react` is converted, and its Solid names join its own imports. The summary counts the skipped files ("already Solid: 5 files, skipped"). So a second run on a converted project changes nothing, including `package.json`, `tsconfig` and the Vite config, and a project that already depends on `solid-js` but not `react` is run rather than refused.

### Troubleshooting

If the run fails with `YAML error: invalid type: string "import { agent, approval, ... } from \"codemod/workflow\"; ...", expected struct Workflow`, the CLI that ran is older than codemod 2.0.0-alpha.2 (the 1.x `codemod`, or 2.0.0-alpha.1): it reads the TypeScript workflow as YAML. npx re-resolves `@alpha` by itself, so a stale one usually comes from a registry mirror or proxy, or an npm `prefer-offline`/`offline` setting. Pin the CLI (`codemod --version` prints `1.18.7` on the 2.0 alpha too, so it can't tell them apart):

```sh
npx codemod@2.0.0-alpha.4 run react-to-solid   # or: pnpm dlx codemod@alpha run react-to-solid
npm view codemod dist-tags.alpha               # what your registry calls alpha
```

### The work list

Every run ends by writing `.react-to-solid/worklist.md` in the target: one Markdown file for a coding agent or a person, made by `src/worklist.mjs`.

- **Files** in dependency order: `package.json`, the configs and the other files with project flags first, by path, then the converted files, each after the local files it imports (the hook-contract pass's import graph, through relative, `~/` and `@/` imports), so a hook or module comes before the files that call it.
- **Tasks** in line order, one per flag, each with its severity: **will not build** (a React API whose import was removed, an effect or a class left as React code, a dependency with no port, ...), **behaves differently** (a value read once in a component body, a custom hook's result, an effect dep that is a plain value, a list key, ...) or **cleanup** (an effect that reads a value it doesn't track, which warns in dev). Then the flag's kind and detail, the converted line with the `// solid:` note above it, what to do, and a link to the section of Solid 2's migration guide it needs, pinned to the Solid commit 2.0.3 was released from (`68406c2`). Every kind of flag the run raises has its severity and guidance in `KINDS`; a spec fails when one doesn't.
- **Type errors** (after an apply, see below) go with the flag on their line, or else with the innermost flagged code around them (a flag on a class, an async component or an effect covers its lines). The others are tasks of their own, "unflagged", one per line, with what that error code usually means after this codemod.
- **Re-verify** last: the install command, the project's `typecheck` (or `type-check`, `check-types`, `tsc`) script or `tsc --noEmit -p` for each config the type-check read, and its `lint`, `test` and `build` scripts.

A preview writes it too: what would be left after an apply, at the lines the converted files would have, without type errors. It's a file rather than the run's output because a workflow's console output goes to stderr, between the CLI's step lines, where it can't be captured on its own; and it's written by a `forEachFile` step into a file a shell step makes, because a shell step's arguments can't hold a big app's list (128 KB per argument; bulletproof-react's is 260 KB). `.react-to-solid/` holds a `.gitignore` of `*`, so git doesn't see it and the apply commit leaves it out; the next run replaces it. A flag's line is its line in the converted file, and each flag in the run's result also has the line's text (`excerpt`), the `// solid:` note above it (`note`), and, when the flagged code spans lines, its last line (`end`). With `agent=true`, the work list is the agent's prompt.

### Type-check after apply

After the lint, an apply run type-checks the converted package with the project's own TypeScript (`src/verify/typecheck.mjs`, run with Node) and adds the errors to the work list. It runs once Solid 2 is installed: `solid-js` and `@solidjs/web` have to resolve from the package, inside the target, to versions its `package.json` allows. Otherwise `node_modules` still holds React's install (the codemod doesn't install by default), and the work list says the type-check was skipped, and why. `--param install=true` runs the install first, as the printed command would: in the directory with the lockfile, from the package up to the target; in a pnpm or npm workspace, scoped to the package (`pnpm install --filter "{apps/web}..."`, `npm install -w apps/web`); and not in a yarn or bun workspace, whose installs aren't scoped to one package here. Its output goes to `.react-to-solid/install.log`, and a failed install skips the type-check. `--param typecheck=false` turns the type-check off.

It checks the package's `tsconfig.json`, or the configs it references when it lists no files of its own (create-vite's `tsconfig.app.json` and `tsconfig.node.json`), each through a config written next to it for the run (`tsconfig.react-to-solid.json`, removed afterwards) that extends it with `noEmit` and no build info, with `--skipLibCheck`. The files go to tsc in chunks of 50 (`REACT_TO_SOLID_TYPECHECK_CHUNK`), as the release corpus checks big apps; a chunk that runs out of memory or time (15 minutes) is halved, and a file that still does on its own is listed as unchecked. Memory is capped at 2048 MB (`REACT_TO_SOLID_TYPECHECK_MEMORY_MB`): with `--max-old-space-size` for TypeScript 6 and older, and with `GOMEMLIMIT` and `--singleThreaded` for TypeScript 7, a Go binary that ignores `--max-old-space-size`. An error is its file, line, column and code, kept once, since TypeScript 5 words a union differently in different chunks. Every error goes to `.react-to-solid/typecheck.json` (a shell step only returns the last 1 MiB of output); the run's result has the summary.

On the release corpus's create-vite app (TypeScript 7.0.2, npm) and bulletproof-react (TypeScript 5.4.5, yarn 1), Nov 20, `apply=true install=true` installed and type-checked both. create-vite: 4 errors, 2 in the class component's code and 2 unflagged. bulletproof-react: 298 errors in 3 chunks, 102 in flagged code and 196 unflagged; an unchunked `tsc` over the same project found the same 298 places, and each is in the list once.

### The compiler cache

Running the React Compiler on each file is most of a run: on t3code's `apps/web/src` (1,965 files with its tests, 2 CPUs, `apply=true`), 522 of 702 seconds. With `--allow-fs`, the run keeps each file's result (what the compiler and the per-file pass decided) in `$XDG_CACHE_HOME/react-to-solid`, or `~/.cache/react-to-solid`, so the next run on the same files, a preview and then `apply=true`, or a run after a few edits, skips them:

```sh
npx codemod@alpha run react-to-solid --allow-fs                    # preview, fills the cache
npx codemod@alpha run react-to-solid --allow-fs --param apply=true  # compiles only what changed since
```

An entry is keyed by the SHA-256 of the file's path, its text and the pass's build (`CACHE_KEY` in `src/lib/reactivity.mjs`: the compiler's version and a hash of the bundle, so any change to the pass, Babel or the compiler misses every entry); the stored key is checked when it's read, and an entry that can't be read is computed again. Only what a file decides on its own is cached: the hook contracts, which depend on every other file, are worked out on every run, so editing one file still updates its callers. Without `--allow-fs` the workflow has no file system to keep it in (a workflow callback can't import `fs`, and `capabilities` in `codemod.yaml` doesn't grant it under `codemod workflow run`), so every run compiles every file and `compilerCache` is `"off"`; `--param cache=false` does the same with `--allow-fs`. It's outside the project, so it never shows in `git status`, and the run never deletes it: `rm -rf ~/.cache/react-to-solid` clears it (t3code's entries take 29 MB).

On that t3code run, the compiler step took 488 s with an empty cache and 2.7 s with a full one (the whole run: 657 s, then 168 s; the hook contracts, the rule pass and the lint still run); after appending a line to 3 files, 3.2 s (157 s). On bulletproof-react (127 files, 6 CPUs) the step went from 2.0 s to 0.6 s. In each case the converted tree was byte-identical to a run without the cache.

### What it changes in the project

With `apply=true`, the package that owns the converted directory moves to Solid 2. Nothing is installed unless `install=true`; the run ends by printing the install command for your package manager.

- **`package.json`**: `react` and `react-dom` become `solid-js` and `@solidjs/web` (`^2.0.3`); `@types/react`, `@types/react-dom` and `babel-plugin-react-compiler` are removed; `@vitejs/plugin-react` (or `-swc`) becomes `@solidjs/vite-plugin`, and a `vite` range below 8 is raised to `^8.3.8`, which that plugin needs (it also needs Node 22.12 or newer); `@testing-library/jest-dom` 8 goes back to `^7.0.1`, since the plugin takes jest-dom up to 7 (an optional peer) and npm won't install 8 next to it. Each library with a verified Solid 2 port is replaced by it (see below). New names go in alphabetically; the rest of the file keeps its order and indentation.
- **`tsconfig*.json`** between the package and the converted directory: `"jsx": "preserve"` and `"jsxImportSource": "@solidjs/web"`, and React's entries leave `types`. Comments and trailing commas are kept. A `paths` entry into the source of another workspace package that depends on React is flagged: that source now compiles as Solid JSX, so convert the package too (`--param workspace=true`) or point the path at its built output.
- **`vite.config.{ts,js,mts,mjs}`** and **`vitest.config.*`**: `import react from "@vitejs/plugin-react"` and `plugins: [react()]` become `import solid from "@solidjs/vite-plugin"` and `solid()`. React-only options (a `babel` setup that only runs the React Compiler, `jsxRuntime`, `jsxImportSource`, `fastRefresh`) are dropped; any other shape is flagged with what to write. See [Test files](#test-files) for the `test` block.
- **Entry**: `createRoot(el).render(<StrictMode><App /></StrictMode>)` becomes `render(() => <App />, el)` from `@solidjs/web`.

A library's `peerDependencies` move too (`react` → `solid-js`, `react-dom` → `@solidjs/web`), and a package that peers on React doesn't get `solid-js` added to its `dependencies`, so the app's copy is the only one.

It flags rather than changes: a `catalog:` or `workspace:` range (change it where the catalog defines it; for a library imported by name, below, the flag says the converted files already import the port), a `package.json` or `tsconfig` above the package (shared with the rest of a monorepo), the React lint plugins (`eslint-plugin-react-hooks` and the like, which your lint config loads), a `next.config.*`, a `jest.config.*` (see [Test files](#test-files)), and every React library without a Solid 2 port. A library counts as a React library when the lockfile (`pnpm-lock.yaml`, `package-lock.json`, or yarn berry's `yarn.lock`) says it peers on `react` or `react-dom`, directly or through another peer (`nuqs` peers on `next`); without such a lockfile, when its name contains "react".

### Workspace packages

In a monorepo, an app usually imports internal packages that are still React: a shared `ui` package through `workspace:*`, often with a tsconfig `paths` entry into its source. Converting only the app leaves it compiling their React source as Solid JSX. With `--param workspace=true`, the run follows the converted package's `workspace:` and `link:` dependencies (in an npm or yarn workspace, a dependency named after a workspace member too), and theirs in turn, and converts each one that depends on React in the same run, as it converts the app:

- **Source**: every `.ts`/`.tsx` file in the package but `*.d.ts`, its `*.config.*` files, `dist/`, `build/`, `.next/` and `.turbo/`.
- **`package.json`, the `tsconfig*.json` files at its root, and its Vite config**, the same way as the app's. A library's `peerDependencies` on React become Solid's.
- **Hook contracts across packages**: an import by package name (`@repo/hooks`, `@repo/ui/toggle`) resolves to the package's source, through its `package.json`'s `exports` (each condition's target; a built file, `dist/index.js`, stands for `src/index`), or else its `source`, `types`, `module` and `main`, then `src/index`; a deep import goes to `src/` or the package root. A hook from another package then hands back what it returns there, as a hook from another file does.

The workspace's packages come from `pnpm-workspace.yaml`, or from the root `package.json`'s `workspaces` (an array or `{ packages }`); `!` excludes. The tsconfig `paths` flag no longer fires for a package that's converted. A converted package that another, unconverted package also depends on is flagged (`workspace`) with that package's name: converting it changes it for that app too, which then needs converting as well, or a React copy of the package. Without the param, each React workspace package the app depends on is flagged on the app's `package.json`, with the other packages that use it, and nothing outside the app changes. The result's `workspace` lists those packages and their other users.

`--param workspaceExclude=<names or globs>`, comma-separated, leaves some of those packages as they are: a package that has to stay React, such as one whose email templates render React to HTML on the server. Each entry is a package name or a directory from the repository root, with `*` within a segment and `**` across segments (`workspaceExclude=@repo/email`, `workspaceExclude=@repo/email-*,packages/legacy`). An excluded package isn't converted, its dependencies don't join the port plan, and it gets the flag an unconverted package gets, on the app's `package.json`, naming the param; the converted packages that import it treat its hooks as a React library's (flagged at each call). A pattern that matches no React workspace package the app depends on is flagged too, since it's likely a typo. In the result's `workspace`, an excluded package has `excluded: true`. A package the app reaches only through an excluded one is still converted unless it's excluded as well.

It's off by default because it changes packages other apps share: the default run touches only the app's directory, its `package.json`, tsconfig and Vite config, and says which packages it leaves.

### Next.js

Next.js has no Solid 2 equivalent; the closest is `@solidjs/vite-plugin`'s start mode (file routes through `fileRoutes()` from `@solidjs/router/fs`) or SolidStart. By default a Next.js app is converted component by component, and the Next.js parts are flagged, not rewritten (with `nextRoutes=true`, the App Router moves to start mode; see the next section):

- **Async components** (React Server Components, such as an `async` page) are left as they are, but for JSX attribute names, and flagged `server component`: a Solid component can't be async. Load the data in the route with an async `createMemo` (Solid 2 memos can be async; reads suspend under `<Loading>`) or a server function, and render synchronously.
- **Each `next/*` import** is flagged once, with what to use: `next/link` → `<a href>` (`@solidjs/router` 2 has no link component and intercepts plain anchors); `next/navigation` → `useNavigate`, `useLocation`, `useSearchParams` and `useParams` from `@solidjs/router`, `redirect` from `@solidjs/web`, and a catch-all route for `notFound`; `next/image` → `<img>`; `next/dynamic` → `lazy` from `solid-js`; `next/headers` and `next/server` → server functions; `next/script` → `<script>` or `useHead`; `Metadata` from `next` → `useHead` from `@solidjs/web`.
- **`next`, `next-themes`, `nuqs`, `@t3-oss/env-nextjs`, `geist` and `next-intl`** are flagged as dependencies with no Solid 2 port.

### Next.js App Router to file routes

`--param nextRoutes=true` (with or without `apply=true`) also moves the App Router (the package's `src/app`, or its `app/`) to the setup of solidjs/templates' `solid-v2/fullstack`: `@solidjs/vite-plugin@3`'s SSR start mode, `filesystem-routing@0.5`'s Vite plugin, which reads `src/routes` with SolidStart's file names, and `@solidjs/router@2`'s `fileRoutes()`. It's a param of the same workflow rather than its own step, because the moves happen in the per-file conversion (a route file is converted, then renamed, and its relative imports re-pointed) and the route rules need to know which App Router file they're converting. It's opt-in because it moves files and writes new ones. For an `app/` at the package root (create-next-app without `--src-dir`), the run finds it by itself when `include` isn't given and converts from the package root (`include=.`; `*.config.*`, `.next/` and `dist/` aren't converted): the route files move into `src/routes` and the root layout to `src/Document.tsx`, start mode's files go in `src/`, and everything else (`components/`, `lib/`, `app/`'s colocated files and `loading.tsx`) stays where it is. A moved file's relative imports are re-pointed; `@/` imports are left as they are, since `vite.config.ts` sets `resolve.tsconfigPaths` and Vite 8 then resolves tsconfig's `@/*` (`./*` here) itself, with no `resolve.alias` or `vite-tsconfig-paths`. The compiler pass's cross-file hook contracts only follow `@/` into a `src/` directory, so in such an app they don't follow `@/` imports.

| Next.js | Solid 2 | |
|---|---|---|
| `app/page.tsx`, `app/x/page.tsx` | `routes/index.tsx`, `routes/x/index.tsx` | moved |
| `app/x/layout.tsx` | `routes/x.tsx`, the file paired with the folder, which filesystem-routing nests the folder's routes in; `{children}` is `props.children` | moved |
| `app/layout.tsx` | `src/Document.tsx`, start mode's document: `<HydrationScript />` and the charset and viewport meta tags go in its `<head>`. Its stylesheet imports and string `title`/`description` move to `src/App.tsx` (the document is server-only and isn't hydrated) | moved; a `<body>` with more than `{children}` is flagged |
| `(group)` folders, `[id]` | the same names | moved |
| `[...slug]`, `[[...slug]]` | `[...slug].tsx` in the parent folder (the router's catch-all also matches nothing) | moved; flagged: the param is one string, `"a/b"`, not an array |
| `loading.tsx`, `error.tsx` | stay where they are, as components; the segment's layout wraps its children in `<Errored fallback={(err, reset) => ...}>` and `<Loading fallback={...}>`, where Next.js put its error boundary and Suspense. With no layout, one is written; the root's go in `src/App.tsx` | wrapped |
| `app/not-found.tsx` | `routes/[...404].tsx`, with `export const route = { preload: () => httpStatus(404) }`; without one, a 404 page is written | moved; a nested `not-found.tsx` is flagged |
| `route.ts` | `routes/x.ts`, an API route: each handler is kept as `nextGET` and exported as `GET: APIHandler = (event) => nextGET(event.request)`; `NextResponse.json` is `Response.json`. `src/middleware.ts` serves them (`createAPIHandler` in `start.middleware`) | moved; a handler that takes params is flagged (they're `Record<string, string>`) |
| an async page or layout: `const` declarations (awaiting `params`, `searchParams`, data), then JSX | a sync component: the declarations move into `query(async (params) => { "use server"; ...; return { names } }, key)`, and the JSX reads `data().name` from `createMemo(() => load({ ...props.params }))`. The data still loads on the server only (during SSR a direct call, on a client navigation a GET to `/_server/data/<id>`), and reads suspend under the nearest `<Loading>` | converted; any other shape stays and is flagged `server component` |
| `metadata` (string `title`, `description`) | `useHead([{ tag: "title", props: { children } }, ...])` from `@solidjs/web` in the component | converted; anything else, and `generateMetadata`, flagged |
| `PageProps<"/x/[id]">`, `LayoutProps<...>` | `RouteProps<"/x/:id">` from `@solidjs/router`, `ParentProps` | converted |
| `<Link href>` (next/link) | `<a href>`, which the router intercepts; `scroll={false}` is `noscroll`, `prefetch` is dropped | converted; an object `href` or `legacyBehavior` is flagged |
| `<Image>` (next/image) | `<img loading="lazy" decoding="async">`; `priority` is `fetchpriority="high"`; `quality` and `unoptimized` are dropped | converted; `fill`, placeholders, loaders and spreads flagged |
| `dynamic(() => import("./x"))` (next/dynamic) | `lazy(() => import("./x"))` from `solid-js` | converted; options flagged |
| `next/font` loaders | an object with empty class names, so the code that reads them still works | flagged: load the font with CSS |
| `app/favicon.ico` | `public/favicon.ico` | moved |
| `next/navigation`, `next/headers`, middleware or `proxy.ts`, `template.tsx`, `default.tsx`, parallel (`@slot`) and intercepting (`(.)x`) routes, metadata files (`sitemap.ts`, `opengraph-image.tsx`, ...) | | flagged, left in place |
| `next.config.*` | | left in place; flagged with the keys it sets (`images`, `redirects`, ...) to port, or that it sets nothing |

It writes `src/App.tsx` (the router over `virtual:file-routes`, rendering the routes in the root layout's `<Errored>`/`<Loading>` when there's a root `error.tsx` or `loading.tsx`, and with no boundary otherwise, as in Next.js), `vite.config.ts` (`solid({ start: { nodeServer: true }, ssr: true, serverFunctions: true, extensions: [".jsx", ".tsx"] })` and `fileRoutes()`, with `resolve.tsconfigPaths` when the tsconfig maps paths like `@/*`), `src/vite-env.d.ts` and the files above, each only when the path is free (a kept one is flagged). `package.json` loses `next` and gains `@solidjs/router`, and in devDependencies `@solidjs/vite-plugin`, `filesystem-routing` and `vite`; `next dev`, `next build` and `next start` (with or without Turbopack) become `vite`, `vite build` and `node dist/server/node.js`, and any other `next` command is flagged. A missing `"type": "module"` is flagged, not added: Vite and Node reparse `vite.config.ts` and the built server as ES modules with a warning, and adding it breaks a CommonJS `.js` config.

On create-next-app 16.4.6 (`--ts --app --no-tailwind --no-eslint`, with `--src-dir` and without it, Nov 20) with an `items` layout and `loading.tsx`, an async list page, an `[id]` page that awaits `params` and loads its item, a `useState` counter, `next/link` links and a `route.ts`, `apply=true nextRoutes=true`, `npm install` and `npm run build` build with no hand edits, in both layouts. `node dist/server/node.js` serves `/` with the counter, `/items` streamed behind the segment's fallback, `/items/1` with its item, `/api/items` as JSON and `/nope` as a 404, and the item's query answers `GET /_server/data/<id>` as a client navigation calls it. The flags were the two `next/font` loaders, `next.config.ts`, the missing `"type": "module"` and the counter's initial-value prop. `tsc` finds two errors: `next.config.ts`, which still imports `next`, and a `data().item ? data().item.name : ...` that TypeScript doesn't narrow. Hydration and client-side navigation weren't checked in a browser.

### React libraries and their Solid 2 ports

The table is in `src/manifests.mjs`, checked on npm on Nov 19 against `solid-js@2.0.3`. A dependency step will replace it.

Three ports export the React library's names, so the code's imports move with the dependency (R44): `lucide-react` → `@lucide/solid` (every icon name, with its `Icon` and `Lucide` aliases, `LucideIcon` and `LucideProps`), `@tanstack/react-query` → `@tanstack/solid-query`, and `@testing-library/react` → `@solidjs/testing-library`. Each was compared with the port's type declarations; an import of a name the port lacks is flagged (`ported library`) with what to use: `createLucideIcon`, `useLucideContext`; `useSuspenseQuery` and the other suspense hooks (solid-query's `useQuery` suspends under `<Loading>` when its data is read), `usePrefetchQuery`, `HydrationBoundary`, `QueryErrorResetBoundary` and some types; the render option and result types, and an `act` that R46 couldn't convert (see [Test files](#test-files)). A subpath (`lucide-react/dynamic`) is flagged too. `react-dom`'s `createPortal(children, el)` becomes `<Portal mount={el}>` from `@solidjs/web` (R45); any other `react-dom` name left is flagged.

| React | Solid 2 | |
|---|---|---|
| `@tanstack/react-query` | `@tanstack/solid-query@6.0.0-rc.6` | the `rc` tag |
| `@tanstack/react-router` | `@tanstack/solid-router@2.0.0-rc.11` | the `rc` tag; still depends on some Solid 1 helper packages (`@solid-primitives/*`, `@solid-devtools/logger`, `@solidjs/meta`) that peer on `solid-js` 1, so expect peer warnings. pnpm's `strict-peer-dependencies` (fatal by default in pnpm 12) rejects them, so for a pnpm project the printed command is `pnpm install --config.strict-peer-dependencies=false`, with a note naming the alternative: a `peerDependencyRules.allowedVersions` entry (`"solid-js": "2"`) in `pnpm-workspace.yaml` |
| `react-router`, `react-router-dom` | `@solidjs/router@^2.0.0` | a different API |
| `lucide-react` | `@lucide/solid@^1.76.0` | `lucide-solid` is the Solid 1 package |
| `@testing-library/react` | `@solidjs/testing-library@1.0.0-rc.2` | the tests' API is converted: see [Test files](#test-files) |
| `@base-ui/react`, `@base-ui-components/react` | `@solidports/base-ui` | reported, not installed. It installs and works on 2.0.x, with type errors on stable and dev warnings in a few form components until a fix release; `render` takes a tag or a function, not an element |
| `react-markdown` | none | `solid-markdown` is Solid 1 only: render with `unified` and `hast-util-to-jsx-runtime`, given `jsx`, `jsxs` and `Fragment` from `@solidjs/h/jsx-runtime` (`elementAttributeNameCase: "html"`, `stylePropertyNameCase: "css"`) |

No Solid 2 port yet, so these stay and are reported as blockers: `zustand`'s React hook (`solid-zustand` is Solid 1 only; see [zustand stores](#zustand-stores)), `@effect/atom-react` (Solid 2 support is unreleased), `@tanstack/react-pacer` (`@tanstack/pacer`'s `Debouncer` and `Throttler` work as they are), `@clerk/react`, `@clerk/electron`, `@testing-library/react-hooks` (its `renderHook` is in `@solidjs/testing-library`), `@legendapp/list`, `gt-react`, `react-day-picker`, `@pierre/diffs` and `@pierre/trees` (their `/react` entries), and `@dnd-kit/*`.

### Effects

R41 converts `useEffect` and `useLayoutEffect` at the top of a component or custom hook:

| React | Solid 2 |
|---|---|
| `useEffect(() => { sub(id); return () => unsub(id); }, [id])` | `createEffect(() => props.id, (id) => { sub(id); return () => unsub(id); })` |
| `useEffect(() => { log(a, b); }, [a, b, c])` | `createEffect(() => ({ a: a(), b: b(), c: c() }), ({ a, b }) => { log(a, b); })` |
| `useEffect(() => { ping(); }, [a, b])` | `createEffect(() => [a(), b()], () => { ping(); })` |
| `useEffect(() => { ...; return cleanup; }, [])` | `onSettled(() => { ...; return cleanup; })` |
| `useEffect(() => setX(0), [id])` | `createEffect(() => props.id, () => { setX(0); })` |

The deps become compute, and apply takes the ones its body reads as parameters, named after them (renamed when the name is taken). That is what Solid asks for: a signal read directly in apply warns `STRICT_READ_UNTRACKED` in dev. It also keeps React's semantics for closures: a cleanup or a listener in the effect sees its own run's value, not the next one's. A setter call gets a block body, because a setter returns its value and Solid throws on a cleanup that isn't a function. `useLayoutEffect` converts the same way: Solid's effect runs after the DOM is updated and before paint (on mount, inside `render()`), which is `useLayoutEffect`'s timing; React's `useEffect` ran after paint, so it now runs earlier. Writes in apply are allowed, with no diagnostic. `tests/solid-effects.test.mjs` pins all of this down on solid-js 2.0.3.

Flagged and left as React code (`effect`): no deps array (it ran after every render; a Solid component doesn't re-render), deps that aren't an array literal or have a spread, a ref in the deps (`ref.current`, or a `let` from the ref rule), an async callback (it returns a promise, which Solid rejects as a cleanup), a callback that isn't an inline function, an effect not at the top of a component or hook body, and an effect in an async component. Converted but flagged: `effect dep` when a dep is a plain value in Solid, declared in the body or from a hook, so tracking it never re-runs the effect (make it an accessor and track `x()`). Only deps that changed in React are flagged: setters, values the compiler found stable, and library hook results whose identity React keeps across renders (react-hook-form's `useForm()` object, Next.js's `useRouter()`, `usePostHog()`, Lexical's editor, TanStack Virtual's virtualizer, react-redux's `useDispatch` and `useStore`, a zustand store's actions; the `LIBRARY` table in `src/reactivity/contracts.mjs`, by import source) were in the deps only for exhaustive-deps, so they're tracked as they are, silently, and `effect read` when apply reads a signal, memo or prop that isn't a dep (it warns in dev: add it to compute, or `untrack` it for a deliberate snapshot).

Differences that remain: Solid's effects don't compare, so a dep like `user()?.id` re-runs the effect whenever `user()` changes (React's effects must already tolerate extra runs); cleanups on dispose run in reverse creation order; and there is no loop guard for an effect that always writes its own dep.

### zustand stores

zustand's React hook has no Solid 2 binding, so a store made with `create(...)` (or `createWithEqualityFn` from `zustand/traditional`) in the converted directory is read off its definition: the keys of its initial state that are functions, through middleware such as `persist`, are its actions. A caller that selects an action (`const reset = useStore((s) => s.reset)`) gets a plain value and calls it directly, as zustand makes actions once; one that selects state gets an accessor (`count()`); one that takes the whole store (`useStore()`) is left as an unknown hook result. Each store is flagged once (`zustand store`, R43) with the bridge those callers were written for:

```ts
const store = createStore(/* the same state creator */); // from zustand/vanilla
export const useStore = Object.assign((selector) => {
  const initial = selector(store.getState());
  if (typeof initial === "function") return initial;
  const [value, setValue] = createSignal(initial, { ownedWrite: true });
  onCleanup(store.subscribe((state) => setValue(() => selector(state))));
  return value;
}, store);
```

`ownedWrite` is needed: a store write made while a component or a computation runs would otherwise throw `REACTIVE_WRITE_IN_OWNED_SCOPE`. `tests/solid-effects.test.mjs` runs this bridge on solid-js 2.0.3, over a store with `zustand/vanilla`'s API.

### Props, refs and types

- **Destructured props** (R8) become `props.x`. Defaults go through `merge`, each literal with `as const` so a union-typed prop keeps its type. A default that reads another prop (`{ showRefresh = !isMarkdown }`) becomes a getter, `get showRefresh() { return !props.isMarkdown; }`, which `merge` keeps live. An empty `[]` or `{}` default is applied where the prop is read (`(merged.tags ?? [])`): in `merge` it would type the prop `never[] | T[]`, whose `.map` doesn't type-check. A prop used as a JSX tag (`{ icon: Icon }` and `<Icon />`) becomes `const Icon = dynamic(() => props.icon)`, `@solidjs/web`'s replacement for `<Dynamic>`; in a file with a `dynamic` of its own (Next.js's), it's flagged. A member tag on state or a memo (`<activeTeam.logo />`) can't become `<activeTeam().logo />`, which isn't JSX, so it becomes `const ActiveTeamLogo = dynamic(() => activeTeam().logo)` after the state (R5/R6), flagged the same way.
- **`useRef`** (R27) used only as `x.current` and `ref={x}` becomes a `let` and a ref callback. Passed on as a value (to a hook, or returned), it becomes a plain `{ current }` object, which is what `useRef` was in a body that runs once; one written while the component renders (`latest.current = value`) is converted the same way and flagged, since it now keeps its first value.
- **Custom hooks' params** (R55): a param a hook reads where reading keeps happening after its body ran once (in JSX, an effect, a closure, a memo or accessor, its return value) or forwards to such a param of another hook (TanStack Query's options included) becomes an accessor, worked out across files by the hook-contract pass: `id: string` becomes `id: Accessor<string>` and its reads `id()` (an effect tracks it as it tracks a signal), and a destructured options object becomes one accessor, as TanStack Query's Solid port takes its options (`useQuery(() => options)`): `{ id, enabled = true }: Options` becomes `options: Accessor<Options>`, read `options().id` and `(options().enabled ?? true)`. A closure in the hook that reads the param more than once reads the accessor once, at its start (`const refValue = ref();`, or `const { id, enabled = true } = options();`), an expression body becoming a block: TypeScript doesn't narrow a call, so `if (!ref) return; ref.id` keeps type-checking, and each call sees one value, as each render's closure did in React. Every call in the converted files passes such an argument as an accessor, whatever it is: a signal, memo or accessor as it is (`useThing(id)`), anything else as a function (`useThing(() => props.id)`, `useThing(() => "fixed")`, `useItem(() => ({ id: id(), enabled }))`), so a hook's param has one type. A param the hook only reads once, or calls (a callback), stays a plain value. Flagged (`hook param`): a hook that now takes accessors and isn't called from any converted file (its callers elsewhere, or in another package, still pass values), a call that spreads its arguments, and a reactive param whose pattern has a rest element or nested destructuring.
- **Narrowing**: TypeScript doesn't narrow a call, so `{x() && <A v={x().foo} />}`, and the same over a field (`{x().icon ? <I name={x().icon} /> : <Dot />}`), become `<Show when={...} fallback={...}>` with a callback that reads the narrowed value (R30).
- **Types** (R9, R31): `FC`, `FunctionComponent`, `ComponentType` → `Component`, `VFC`, `VoidFunctionComponent` → `VoidComponent` (on the component: `const App: React.FC = () =>` → `const App: Component = () =>`), `PropsWithChildren` → `ParentProps`, `ElementType` → `ValidComponent`, each imported; a custom hook annotated with its value's type that now returns an accessor gets `Accessor<T>`. React APIs with no conversion are flagged where they're used, with what to use (`React API`).
- **Attributes** (R1): React's camelCase HTML attributes are spelled as `@solidjs/web`'s JSX types spell them (`frameBorder` → `frameborder`, `httpEquiv` → `http-equiv`, ...), on intrinsic elements; `suppressHydrationWarning` and the React Compiler's `"use memo"` directives are dropped.
- **Imports** (R10): Solid names join the file's own `solid-js` or `@solidjs/web` import, so a second run, or a file already partly in Solid, doesn't import a name twice.

### Test files

Test files (`*.test.*`, `*.spec.*`, and everything under `__tests__/`) go through the same pass as the rest of the code, so a component, hook or JSX in a test is converted like any other. When the project moves `@testing-library/react` to `@solidjs/testing-library@1.0.0-rc.2`, R46 also converts its API, compared with that version's type declarations and source:

| `@testing-library/react` | `@solidjs/testing-library` | R46 |
|---|---|---|
| `render(<X />, options)` | `render(() => <X />, options)`: a function, run under the render's root | wraps the element; a function is left as it is |
| `act(() => { ... })`, `await act(async () => ...)` | no `act`. Solid 2 batches writes and applies them on `flush()` from `solid-js` | the callback's body, then `flush()`; an awaited act keeps its awaits. A body that declares a name keeps its block |
| `fireEvent.click(el)` (RTL wraps it in `act`) | `fireEvent` from `@testing-library/dom`, not wrapped: the DOM updates on the next `flush()` | adds `flush()` after each `fireEvent` statement |
| `const { rerender } = render(<X a={1} />); rerender(<X a={2} />)` | no `rerender`: a component runs once and reads its props where they're used | `const [a, setA] = createSignal<ComponentProps<typeof X>["a"]>(1); render(() => <X a={a()} />); setA(2); flush();`, for each prop that changes, when every value that changes is a literal |
| `renderHook(fn, { initialProps: p })` | `renderHook(fn, { initialProps: [p] })`: the hook's arguments | wraps `initialProps` in an array |
| `result.current` | `result`: the value the hook returned, once | `result.current.x` → `result.x` (a hook's returned object becomes getters, so `x` stays live) |
| `unmount` from `renderHook` | `cleanup` | renamed |
| `screen`, `within`, `waitFor`, `findBy*`, `cleanup`, `configure` | the same names (`@testing-library/dom` is re-exported) | the import moves (R44) |
| `asFragment()` | the container's `innerHTML`, a string | flagged |

`@testing-library/user-event` works as it is: its calls are async, and Solid applies the writes before they resolve. jest/vitest mocks, timers and matchers are left alone. React 19's `act` from `react` converts the same way.

Flagged (`act`, `rerender`, `render`, `renderHook`): an `act` that isn't a statement, returns from its callback, or is async and not awaited; a `rerender` whose changing values aren't literals (a function would be read as the setter's updater), whose element or children change, or that isn't destructured from `render`; `renderHook`'s `rerender`; options passed to `renderHook` as a variable; a hook's whole value read off the result (`result.current`, `result.current[0]`), which is `result()` when the converted hook returns an accessor; an element made before `render` runs (`render(ui)` in a custom render helper); React-only `render` options (`legacyRoot`, `reactStrictMode`, `onCaughtError`, ...); and `asFragment`.

**Vitest.** `@solidjs/vite-plugin` sets up Solid's tests itself in test mode: the `browser` and `development` conditions, `solid-js` and `@solidjs/web` inlined, and jest-dom's matchers added to `setupFiles` when `@testing-library/jest-dom` is installed (a setup file that imports it already works as it is). So the `test` block keeps its `environment: "jsdom"`, `globals` (both testing libraries clean up after each test through a global `afterEach`) and `setupFiles`. Flagged: `environment: "node"` or `"edge-runtime"`, which the plugin takes for server tests and resolves Solid's server build for, where `render` throws; a `vitest.config.*` that neither loads the plugin nor merges `vite.config`; and a `jest.config.*`, since Solid's test setup is Vitest.

### Class components

R42 converts a class component that is only `render()` (and optionally `static defaultProps`) and reads nothing of `this` but `this.props`: it becomes `function X(props: P)`, `this.props` becomes `props`, and `defaultProps` becomes `const merged = merge({ ... }, props)`, each literal default with `as const`. Its render can only return, after an optional `const { ... } = this.props`, which moves into the parameter for R8 to convert; with `defaultProps` too, each destructured name gets its default there (`{ name, punctuation = '!' }`), which R8 turns into `merge` (not when a name has a default of its own, a rest would miss a default, or the return also reads `this.props`). Anything else stays a class and is flagged (`class component`, R39) with what its lifecycle methods become: state, lifecycle or error-boundary methods, instance fields, other statics, other uses of `this`, a value computed above the return (Solid would compute it once), or `X.defaultProps = ...` after the class. A class left as it is keeps its import of `Component` or `PureComponent` from `react` (as `ReactComponent` when the file also uses Solid's `Component` type).

### After it runs

1. Run the install command it printed (or pass `install=true`), and re-run the type-check the work list names.
2. Work through `.react-to-solid/worklist.md`. The most common spots are custom hook results, values read in a component body (which runs once in Solid), class components with state or lifecycle methods (Solid has none; an error boundary becomes `<Errored>`), server components, zustand stores (see [zustand stores](#zustand-stores)), Next.js imports, effect deps that are plain values (see [Effects](#effects)), and libraries without a Solid 2 port.
3. Type-check, build and run the app.

On create-vite's React TypeScript template with Vitest 5.1.1, `@testing-library/react` 16.3.3, user-event, jest-dom 8 and jsdom added, and tests for a component with state and a click (`fireEvent`, user-event, and `act` around a component defined in the test), a `rerender` and two `renderHook`s (Nov 20), `apply=true`, `npm install` and `npx vitest run` pass all 6 converted tests, and `npm run build` type-checks them, with no hand edits; two more tests in the shapes R46 flags (a `rerender` with a value read from a variable, and a hook's tuple read off `result.current[0]`) fail at runtime and in `tsc` at exactly their flagged lines, and pass once the flags' fixes are made. On the same template (create-vite 9.3.4, Nov 19), `apply=true`, then `npm install` and `npm run build`, builds with no hand edits; with two components added that subscribe in an effect and log on mount, it builds too, and a jsdom test shows the effect subscribe, re-subscribe on a prop change and clean up. With 0.1.7 (Nov 20), the template plus a component that uses `lucide-react` icons (one passed as a prop and rendered as a tag), `useQuery` and a `useMemo`, under a `QueryClientProvider`, converts to `@lucide/solid` and `@tanstack/solid-query` and passes `tsc -b && vite build` with no hand edits. On a large Next.js app, type errors went from 13,038 with 0.1.5 to 11,089 with 0.1.7; most of the rest come from workspace packages and libraries that are still React. On t3code's `apps/web/src`, 0.1.3 converted every file and was type-checked against Solid 2.0.1, which is where the 0.1.3 fixes came from; a large app still needs its flagged spots and libraries finished by hand, and t3code hasn't been built.

## Steps

| Step | Task | What it does |
|---|---|---|
| Find the App Router | `forEachFile` | Only with `nextRoutes` and no `include`: whether the App Router is `app/` at the root (then the run converts from the root) or `src/app` |
| Read package.json files | `forEachFile` | Collects dependencies from every package.json |
| Read the lockfile | `forEachFile` | Which packages peer on React, and the install command |
| Read the workspace definition | `forEachFile` | `pnpm-workspace.yaml`'s packages (npm and yarn list theirs in the root `package.json`) |
| Check React libraries for Solid ports | function | Fails if nothing on the way to the converted directory depends on `react` or `solid-js`; lists React libraries with and without a Solid 2 port, which package.json owns the directory, and the React workspace packages it depends on (`src/workspaces.mjs`) |
| branch / commit | `branch`, `commit` | Only with `--param apply=true` and `--managed-git` |
| Run the React Compiler on each file | `forEachFile` | Skips a file that's already Solid; `babel-plugin-react-compiler@1.0.0` decides what each component-body value becomes; each file's result is a step output, read from the [compiler cache](#the-compiler-cache) when it has it |
| Resolve hook contracts across files | function | The whole-program hook-contract pass, over every file's result, with imports of converted workspace packages resolved to their source: what each hook returns, which of its params callers pass as accessors, and the files in dependency order |
| Plan the Next.js routes | function | Only with `--param nextRoutes=true`: where each App Router file goes (`src/nextjs.mjs`) |
| Convert each file to Solid 2 (preview: Preview the conversion of each file) | `forEachFile` | Writes each decision with a `// solid:` note, then runs the rule pass (`src/rules/mechanical.mjs`, R1-R55) on that text; applied rules and flags are step outputs. With `nextRoutes`, a route file is renamed where the plan says, its relative imports re-pointed. A preview writes nothing |
| Move package.json, tsconfig and the Vite config to Solid 2 (preview: Preview the package.json, tsconfig and Vite config changes) | `forEachFile` | `src/manifests.mjs`, as above, with `vitest.config.*`; `next.config.*` and `jest.config.*` are flagged. A preview writes nothing |
| Plan start mode's files, Write *file*, Move the favicon to public/ | function, `shell` | Only with `nextRoutes`: `src/App.tsx`, `vite.config.ts` and the rest, each written by a shell step (a `forEachFile` step only changes files that exist) unless the path is taken; the shell steps only run with `apply=true` |
| Summarize the conversion | function | Decision counts, applied rules, flags |
| Install the Solid 2 lint, Lint | `shell` | Only with `--param apply=true`: `eslint-plugin-solid` 0.19.0, `configs/v2`, on the converted files; the summary is the last line of the lint step's output |
| Type-check with the project's TypeScript (with `install`: Install, then type-check with the project's TypeScript), Read the type-check | `shell`, `forEachFile` | Only with `--param apply=true`, unless `typecheck=false`: `src/verify/typecheck.mjs`, then its `.react-to-solid/typecheck.json` (see [Type-check after apply](#type-check-after-apply)) |
| Write the work list, Make .react-to-solid/, Save the work list | function, `shell`, `forEachFile` | `src/worklist.mjs`, written to `.react-to-solid/worklist.md`; in a preview too |
| Finish flagged spots | `approval`, `agent` | Only with `--param apply=true --param agent=true`: the work list is the prompt |

The run's result (in `run.json` of the run store) holds the summary, the flags, the lint counts and the type-check's summary.

## How the compiler runs without Node

`build/build.mjs` bundles the reactivity pass, Babel and the React Compiler into `src/lib/reactivity.mjs` (7 MB, ESM), which the workflow imports; each `forEachFile` worker loads it once, under QuickJS. Node built-ins are stubbed (`build/stubs/`): the pass never reads Babel config files, and the compiler's Reanimated check, which calls `require.resolve`, is turned off with `enableReanimatedCheck: false`. Node is only needed for the eslint step.

The bundle is one IIFE assigned to one `const`, with its exports after it, and has no setup code of its own at the top level. `codemod publish` replaces `src/workflow.ts` with a Rolldown bundle of everything it imports, and each workflow callback then gets only the bindings it uses from that file: top-level setup statements would be dropped, and a reassigned module-level binding can't be copied at all. Rolldown also replaces `process.env.NODE_ENV` with `"development"`, which turns on the compiler's dev-only cache checks, so the build sets it to `undefined`, as jssg has it. The slow spec "as codemod publish bundles it" bundles the package the same way and checks the result matches the unbundled run.

```sh
pnpm install && pnpm build   # rebuild src/lib/reactivity.mjs after changing src/reactivity/
```

## Layout

| Path | What |
|---|---|
| `src/workflow.ts` | The workflow |
| `src/reactivity/` | The reactivity pass: the root `src/` of this repo with fixes found on t3code, and `enableReanimatedCheck` off |
| `src/lib/reactivity.mjs` | `src/reactivity/` with Babel and the React Compiler, bundled by `pnpm build`; committed, so the workflow runs without a build step |
| `src/rules/mechanical.mjs` | The rule pass, R1-R55 (R1-R10 from the root `gate/mechanical.js`, R11-R34 from hand-converted screens, R35-R40 from later runs on apps, R41 effects, R42 render-only class components, R43 zustand stores, R44 ported libraries' imports, R45 `createPortal`, R46 Testing Library, R47-R54 and the route files' rules for `nextRoutes`, R55 custom hooks' params), as `transform(src, { parse, Lang, ports, next, hooks })`, so it runs under `@ast-grep/napi` and `codemod/ast-grep` |
| `src/manifests.mjs` | The port table, the lockfile's React peers, and the `package.json`, `tsconfig` and Vite config edits |
| `src/workspaces.mjs` | `workspace`: the workspace packages a package depends on, and what an import of one by name resolves to |
| `src/nextjs.mjs` | `nextRoutes`: where each App Router file goes, a moved file's imports, `next.config`'s keys, and the files start mode needs |
| `src/worklist.mjs` | The work list: each flag kind's severity, guidance and guide section, and the Markdown |
| `src/verify/typecheck.mjs` | The type-check after apply (and the install with `install=true`), run with Node from the target |
| `src/lint/` | ESLint 9 with `eslint-plugin-solid/configs/v2`; the workflow finds it through `import.meta.dirname` |
| `workflow.yaml` | A stub: codemod 2.0.0-alpha.4 won't start a registry package without one. `codemod.yaml` runs `src/workflow.ts` |
| `docs/` | The Nov 16 report on t3code, engine gaps found along the way, and that run's logs |

## Tests

```sh
pnpm test                                       # reactivity (58), rule (201), project file (34), workspace (8), Next.js route (15), Solid behavior (12), work list (8) and type-check (9) specs
CODEMOD_BIN=<path to codemod@alpha> pnpm test   # plus the workflow specs (55, tagged slow), which run the CLI on copies of tests/fixtures/todo-app, tests/fixtures/pnpm-monorepo and tests/fixtures/worklist-app, and on Next.js apps the specs write
```

### Release corpus

```sh
pnpm test:corpus               # every corpus app against tests/corpus/baseline.json
pnpm corpus:update-baseline    # the same, then rewrites the baseline
pnpm test:release              # pnpm test, then the corpus
```

`pnpm test:corpus` runs the workflow with `apply=true` (and `typecheck=false`: it installs and type-checks each app itself) on the apps in `tests/corpus/corpus.json`, each pinned to a commit: create-vite 9.3.4's `react-ts` template with `tests/corpus/create-vite-overlay/` on top (lucide-react, `useQuery`, `useMemo`, effects with deps, class components, and a lockfile), bulletproof-react's Vite app, shadcn-admin, react-admin-dashboard, shlink-web-client and t3code's `apps/web` (why each is there is in its `notes`). For each app it records the files analyzed and changed, workflow failures, flags by kind, lint problems by rule, converted files that don't parse (TypeScript's parser, and `await` outside an async function), and, after installing the converted app with `--ignore-scripts`, its TypeScript 7 type errors: in all files, in converted files, and the codemod's own (in converted files whose React source imports no React-only library, one without a port that keeps its names, less that file's errors in the React app, which is type-checked once per commit and should have none). It fails on a file that doesn't parse, on more failures or more of the codemod's own type errors than `tests/corpus/baseline.json` has, and on any change in files changed, flags or lint, printing what moved. When the change is intended, run `pnpm corpus:update-baseline` and commit the baseline with the change, listing each moved count in the commit message.

Test files are converted too (since 0.1.8), so they're in the counts: 12 in bulletproof-react, 21 in shadcn-admin and 582 in t3code. A test that renders through a helper the run doesn't convert, because it's outside the converted directory (t3code's `apps/web/test/render.tsx`) or re-exports Testing Library's `render` under another name (bulletproof-react's `rtlRender`), still passes an element where React's types want a `ReactNode`, and those errors count as the codemod's own.

One run uses a cache at a time: a run holds `<cache>/corpus.lock` (its pid, start time and command line) and removes it when it ends, and a second run on the same cache stops at once, naming the first, since it would reset the first's work copies and overwrite its results. `REACT_TO_SOLID_CORPUS_WAIT=<minutes>` waits for the first instead; a lock whose run has exited (or whose pid another process has since taken) is taken over.

It isn't part of `pnpm test`: it needs the network the first time and takes about 25 minutes on a cold cache and 15 on a warm one (t3code is most of it: 9 minutes of workflow on 2 CPUs and 5.5 of chunked type-checks), with a peak of about 2.5 GB. Clones, installs (reused while package.json files and the lockfile don't change), the pinned TypeScript and Codemod CLI, and per-file results live in `~/.cache/react-to-solid-corpus` (`REACT_TO_SOLID_CORPUS_CACHE`). Each install, workflow run and type-check runs in a `systemd-run` scope capped at 3,000 MB, and each type-check waits for 4,000 MB to be available; t3code is type-checked in chunks of 50 files. `REACT_TO_SOLID_CORPUS_ONLY=shadcn-admin` runs one app, `REACT_TO_SOLID_CORPUS_WORKFLOW=<dir>/src/workflow.ts` runs another version's workflow against the same baseline, and `REACT_TO_SOLID_CORPUS_PRIVATE_REPO` with `REACT_TO_SOLID_CORPUS_PRIVATE_INCLUDE` adds a local repository, with its baseline kept in the cache. The header of `tests/corpus.test.mjs` has the details.
