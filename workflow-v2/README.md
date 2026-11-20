# React to Solid 2

**Status: public preview.** Converts a React app to Solid 2 (`solid-js@2.0.3`). The React Compiler decides what each component-body value becomes (a signal, a memo, an accessor or a plain value), deterministic rules rewrite props, hooks, JSX and imports, the project's `package.json`, `tsconfig` and Vite config move to Solid 2, and eslint-plugin-solid's Solid 2 config checks the result. It converts most of a component; what it can't convert safely, it flags with a file and line for you or an agent to finish.

## Run it

This is a Codemod workflow v2 package. Workflow v2 needs the 2.0 alpha of the Codemod CLI, `codemod@alpha`; plain `codemod` (`codemod@latest`) is still the 1.x CLI and can't run it. Run it from the root of a React app, in a clean git checkout.

```sh
# Preview (default): converts every file in memory and reports what would change,
# with the flagged spots. Nothing is written.
npx codemod@alpha run react-to-solid

# Apply: rewrites the files, then lints them with eslint-plugin-solid.
npx codemod@alpha run react-to-solid --param apply=true
```

| Param | Default | What it does |
|---|---|---|
| `include` | `src` | Directory whose `.ts`/`.tsx` files are converted (tests and `.d.ts` files are skipped); `.` is the package root. In a monorepo, point it at one app: `--param include=apps/web/src`. With `nextRoutes` and no `include`, a Next.js app with `app/` at its root is converted from the root |
| `apply` | `false` | `true` writes the converted files and lints them; otherwise the run is a preview |
| `agent` | `false` | `true` (with `apply=true`) asks for approval, then hands the flagged spots to a coding agent. Untested |
| `nextRoutes` | `false` | `true` moves a Next.js App Router (`src/app`, or `app/` at the package root) to Solid's file routes in `@solidjs/vite-plugin`'s start mode: see [Next.js App Router to file routes](#nextjs-app-router-to-file-routes) |

The run's result holds the summary: the plan (which React libraries have a Solid 2 port), the compiler's decisions, the rules applied, the `package.json`, `tsconfig` and Vite config changes, every flag with its file and line, and the lint counts.

### Troubleshooting

If the run fails with `YAML error: invalid type: string "import { agent, approval, ... } from \"codemod/workflow\"; ...", expected struct Workflow`, the CLI that ran is older than codemod 2.0.0-alpha.2 (the 1.x `codemod`, or 2.0.0-alpha.1): it reads the TypeScript workflow as YAML. npx re-resolves `@alpha` by itself, so a stale one usually comes from a registry mirror or proxy, or an npm `prefer-offline`/`offline` setting. Pin the CLI (`codemod --version` prints `1.18.7` on the 2.0 alpha too, so it can't tell them apart):

```sh
npx codemod@2.0.0-alpha.4 run react-to-solid   # or: pnpm dlx codemod@alpha run react-to-solid
npm view codemod dist-tags.alpha               # what your registry calls alpha
```

### What it changes in the project

With `apply=true`, the package that owns the converted directory moves to Solid 2. Nothing is installed; the run ends by printing the install command for your package manager.

- **`package.json`**: `react` and `react-dom` become `solid-js` and `@solidjs/web` (`^2.0.3`); `@types/react`, `@types/react-dom` and `babel-plugin-react-compiler` are removed; `@vitejs/plugin-react` (or `-swc`) becomes `@solidjs/vite-plugin`, and a `vite` range below 8 is raised to `^8.3.8`, which that plugin needs (it also needs Node 22.12 or newer). Each library with a verified Solid 2 port is replaced by it (see below). New names go in alphabetically; the rest of the file keeps its order and indentation.
- **`tsconfig*.json`** between the package and the converted directory: `"jsx": "preserve"` and `"jsxImportSource": "@solidjs/web"`, and React's entries leave `types`. Comments and trailing commas are kept. A `paths` entry into the source of another workspace package that depends on React is flagged: that source now compiles as Solid JSX, so convert the package too or point the path at its built output.
- **`vite.config.{ts,js,mts,mjs}`**: `import react from "@vitejs/plugin-react"` and `plugins: [react()]` become `import solid from "@solidjs/vite-plugin"` and `solid()`. React-only options (a `babel` setup that only runs the React Compiler, `jsxRuntime`, `jsxImportSource`, `fastRefresh`) are dropped; any other shape is flagged with what to write.
- **Entry**: `createRoot(el).render(<StrictMode><App /></StrictMode>)` becomes `render(() => <App />, el)` from `@solidjs/web`.

It flags rather than changes: a `catalog:` or `workspace:` range (change it where the catalog defines it; for a library imported by name, below, the flag says the converted files already import the port), a `package.json` or `tsconfig` above the package (shared with the rest of a monorepo), the React lint plugins (`eslint-plugin-react-hooks` and the like, which your lint config loads), a `next.config.*`, and every React library without a Solid 2 port. A library counts as a React library when the lockfile (`pnpm-lock.yaml`, `package-lock.json`, or yarn berry's `yarn.lock`) says it peers on `react` or `react-dom`, directly or through another peer (`nuqs` peers on `next`); without such a lockfile, when its name contains "react".

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

Three ports export the React library's names, so the code's imports move with the dependency (R44): `lucide-react` → `@lucide/solid` (every icon name, with its `Icon` and `Lucide` aliases, `LucideIcon` and `LucideProps`), `@tanstack/react-query` → `@tanstack/solid-query`, and `@testing-library/react` → `@solidjs/testing-library`. Each was compared with the port's type declarations; an import of a name the port lacks is flagged (`ported library`) with what to use: `createLucideIcon`, `useLucideContext`; `useSuspenseQuery` and the other suspense hooks (solid-query's `useQuery` suspends under `<Loading>` when its data is read), `usePrefetchQuery`, `HydrationBoundary`, `QueryErrorResetBoundary` and some types; `act` and the render option and result types. A subpath (`lucide-react/dynamic`) is flagged too. `react-dom`'s `createPortal(children, el)` becomes `<Portal mount={el}>` from `@solidjs/web` (R45); any other `react-dom` name left is flagged.

| React | Solid 2 | |
|---|---|---|
| `@tanstack/react-query` | `@tanstack/solid-query@6.0.0-rc.6` | the `rc` tag |
| `@tanstack/react-router` | `@tanstack/solid-router@2.0.0-rc.11` | the `rc` tag; still depends on some Solid 1 helper packages, so expect peer warnings |
| `react-router`, `react-router-dom` | `@solidjs/router@^2.0.0` | a different API |
| `lucide-react` | `@lucide/solid@^1.76.0` | `lucide-solid` is the Solid 1 package |
| `@testing-library/react` | `@solidjs/testing-library@1.0.0-rc.2` | tests aren't converted: `render(() => <App />)` |
| `@base-ui/react`, `@base-ui-components/react` | `@solidports/base-ui` | reported, not installed. It installs and works on 2.0.x, with type errors on stable and dev warnings in a few form components until a fix release; `render` takes a tag or a function, not an element |
| `react-markdown` | none | `solid-markdown` is Solid 1 only: render with `unified` and `hast-util-to-jsx-runtime`, given `jsx`, `jsxs` and `Fragment` from `@solidjs/h/jsx-runtime` (`elementAttributeNameCase: "html"`, `stylePropertyNameCase: "css"`) |

No Solid 2 port yet, so these stay and are reported as blockers: `zustand`'s React hook (`solid-zustand` is Solid 1 only; see [zustand stores](#zustand-stores)), `@effect/atom-react` (Solid 2 support is unreleased), `@tanstack/react-pacer` (`@tanstack/pacer`'s `Debouncer` and `Throttler` work as they are), `@clerk/react`, `@clerk/electron`, `@legendapp/list`, `gt-react`, `react-day-picker`, `@pierre/diffs` and `@pierre/trees` (their `/react` entries), and `@dnd-kit/*`.

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

- **Destructured props** (R8) become `props.x`. Defaults go through `merge`, each literal with `as const` so a union-typed prop keeps its type. A default that reads another prop (`{ showRefresh = !isMarkdown }`) becomes a getter, `get showRefresh() { return !props.isMarkdown; }`, which `merge` keeps live. An empty `[]` or `{}` default is applied where the prop is read (`(merged.tags ?? [])`): in `merge` it would type the prop `never[] | T[]`, whose `.map` doesn't type-check. A prop used as a JSX tag (`{ icon: Icon }` and `<Icon />`) becomes `const Icon = dynamic(() => props.icon)`, `@solidjs/web`'s replacement for `<Dynamic>`; in a file with a `dynamic` of its own (Next.js's), it's flagged.
- **`useRef`** (R27) used only as `x.current` and `ref={x}` becomes a `let` and a ref callback. Passed on as a value (to a hook, or returned), it becomes a plain `{ current }` object, which is what `useRef` was in a body that runs once; one written while the component renders (`latest.current = value`) is converted the same way and flagged, since it now keeps its first value.
- **Narrowing**: TypeScript doesn't narrow a call, so `{x() && <A v={x().foo} />}`, and the same over a field (`{x().icon ? <I name={x().icon} /> : <Dot />}`), become `<Show when={...} fallback={...}>` with a callback that reads the narrowed value (R30).
- **Types** (R9, R31): `FC`, `ComponentType` → `Component`, `PropsWithChildren` → `ParentProps`, `ElementType` → `ValidComponent`, each imported; a custom hook annotated with its value's type that now returns an accessor gets `Accessor<T>`. React APIs with no conversion are flagged where they're used, with what to use (`React API`).
- **Attributes** (R1): React's camelCase HTML attributes are spelled as `@solidjs/web`'s JSX types spell them (`frameBorder` → `frameborder`, `httpEquiv` → `http-equiv`, ...), on intrinsic elements; `suppressHydrationWarning` and the React Compiler's `"use memo"` directives are dropped.
- **Imports** (R10): Solid names join the file's own `solid-js` or `@solidjs/web` import, so a second run, or a file already partly in Solid, doesn't import a name twice.

### Class components

R42 converts a class component that is only `render()` (and optionally `static defaultProps`) and reads nothing of `this` but `this.props`: it becomes `function X(props: P)`, `this.props` becomes `props`, and `defaultProps` becomes `const merged = merge({ ... }, props)`, each literal default with `as const`. Its render can only return, after an optional `const { ... } = this.props`, which moves into the parameter for R8 to convert. Anything else stays a class and is flagged (`class component`, R39) with what its lifecycle methods become: state, lifecycle or error-boundary methods, instance fields, other statics, other uses of `this`, a value computed above the return (Solid would compute it once), or `X.defaultProps = ...` after the class.

### After it runs

1. Run the install command it printed.
2. Finish each flagged spot. The most common are custom hook results, values read in a component body (which runs once in Solid), class components with state or lifecycle methods (Solid has none; an error boundary becomes `<Errored>`), server components, zustand stores (see [zustand stores](#zustand-stores)), Next.js imports, effect deps that are plain values (see [Effects](#effects)), and libraries without a Solid 2 port.
3. Type-check, build and run the app.

On create-vite's React TypeScript template (create-vite 9.3.4, Nov 19), `apply=true`, then `npm install` and `npm run build`, builds with no hand edits; with two components added that subscribe in an effect and log on mount, it builds too, and a jsdom test shows the effect subscribe, re-subscribe on a prop change and clean up. With 0.1.7 (Nov 20), the template plus a component that uses `lucide-react` icons (one passed as a prop and rendered as a tag), `useQuery` and a `useMemo`, under a `QueryClientProvider`, converts to `@lucide/solid` and `@tanstack/solid-query` and passes `tsc -b && vite build` with no hand edits. On a large Next.js app, type errors went from 13,038 with 0.1.5 to 11,089 with 0.1.7; most of the rest come from workspace packages and libraries that are still React. On t3code's `apps/web/src`, 0.1.3 converted every file and was type-checked against Solid 2.0.1, which is where the 0.1.3 fixes came from; a large app still needs its flagged spots and libraries finished by hand, and t3code hasn't been built.

## Steps

| Step | Task | What it does |
|---|---|---|
| Find the App Router | `forEachFile` | Only with `nextRoutes` and no `include`: whether the App Router is `app/` at the root (then the run converts from the root) or `src/app` |
| Read package.json files | `forEachFile` | Collects dependencies from every package.json |
| Read the lockfile | `forEachFile` | Which packages peer on React, and the install command |
| Check React libraries for Solid ports | function | Fails if nothing on the way to the converted directory depends on `react`; lists React libraries with and without a Solid 2 port, and which package.json owns the directory |
| branch / commit | `branch`, `commit` | Only with `--param apply=true` and `--managed-git` |
| Run the React Compiler on each file | `forEachFile` | `babel-plugin-react-compiler@1.0.0` decides what each component-body value becomes; each file's result is a step output |
| Resolve hook contracts across files | function | The whole-program hook-contract pass, over every file's result |
| Plan the Next.js routes | function | Only with `--param nextRoutes=true`: where each App Router file goes (`src/nextjs.mjs`) |
| Convert each file to Solid 2 (preview: Preview the conversion of each file) | `forEachFile` | Writes each decision with a `// solid:` note, then runs the rule pass (`src/rules/mechanical.mjs`, R1-R53) on that text; applied rules and flags are step outputs. With `nextRoutes`, a route file is renamed where the plan says, its relative imports re-pointed. A preview writes nothing |
| Move package.json, tsconfig and the Vite config to Solid 2 (preview: Preview the package.json, tsconfig and Vite config changes) | `forEachFile` | `src/manifests.mjs`, as above. A preview writes nothing |
| Plan start mode's files, Write *file*, Move the favicon to public/ | function, `shell` | Only with `nextRoutes`: `src/App.tsx`, `vite.config.ts` and the rest, each written by a shell step (a `forEachFile` step only changes files that exist) unless the path is taken; the shell steps only run with `apply=true` |
| Summarize the conversion | function | Decision counts, applied rules, flags |
| Install the Solid 2 lint, Lint | `shell` | Only with `--param apply=true`: `eslint-plugin-solid` 0.19.0, `configs/v2`, on the converted files; the summary is the last line of the lint step's output |
| Finish flagged spots | `approval`, `agent` | Only with `--param apply=true --param agent=true` |

The run's result (in `run.json` of the run store) holds the summary, the flags and the lint counts.

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
| `src/rules/mechanical.mjs` | The rule pass, R1-R53 (R1-R10 from the root `gate/mechanical.js`, R11-R34 from hand-converted screens, R35-R40 from later runs on apps, R41 effects, R42 render-only class components, R43 zustand stores, R44 ported libraries' imports, R45 `createPortal`, R46-R53 and the route files' rules for `nextRoutes`), as `transform(src, { parse, Lang, ports, next })`, so it runs under `@ast-grep/napi` and `codemod/ast-grep` |
| `src/manifests.mjs` | The port table, the lockfile's React peers, and the `package.json`, `tsconfig` and Vite config edits |
| `src/nextjs.mjs` | `nextRoutes`: where each App Router file goes, a moved file's imports, `next.config`'s keys, and the files start mode needs |
| `src/lint/` | ESLint 9 with `eslint-plugin-solid/configs/v2`; the workflow finds it through `import.meta.dirname` |
| `workflow.yaml` | A stub: codemod 2.0.0-alpha.4 won't start a registry package without one. `codemod.yaml` runs `src/workflow.ts` |
| `docs/` | The Nov 16 report on t3code, engine gaps found along the way, and that run's logs |

## Tests

```sh
pnpm test                                       # reactivity (54), rule (163), project file (28), Next.js route (15) and Solid behavior (12) specs
CODEMOD_BIN=<path to codemod@alpha> pnpm test   # plus the workflow specs (36, tagged slow), which run the CLI on copies of tests/fixtures/todo-app and on Next.js apps the specs write
```
