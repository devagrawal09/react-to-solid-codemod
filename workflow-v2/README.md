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
| `include` | `src` | Directory whose `.ts`/`.tsx` files are converted (tests and `.d.ts` files are skipped). In a monorepo, point it at one app: `--param include=apps/web/src` |
| `apply` | `false` | `true` writes the converted files and lints them; otherwise the run is a preview |
| `agent` | `false` | `true` (with `apply=true`) asks for approval, then hands the flagged spots to a coding agent. Untested |

The run's result holds the summary: the plan (which React libraries have a Solid 2 port), the compiler's decisions, the rules applied, the `package.json`, `tsconfig` and Vite config changes, every flag with its file and line, and the lint counts.

### What it changes in the project

With `apply=true`, the package that owns the converted directory moves to Solid 2. Nothing is installed; the run ends by printing the install command for your package manager.

- **`package.json`**: `react` and `react-dom` become `solid-js` and `@solidjs/web` (`^2.0.3`); `@types/react`, `@types/react-dom` and `babel-plugin-react-compiler` are removed; `@vitejs/plugin-react` (or `-swc`) becomes `@solidjs/vite-plugin`, and a `vite` range below 8 is raised to `^8.3.8`, which that plugin needs (it also needs Node 22.12 or newer). Each library with a verified Solid 2 port is replaced by it (see below). New names go in alphabetically; the rest of the file keeps its order and indentation.
- **`tsconfig*.json`** between the package and the converted directory: `"jsx": "preserve"` and `"jsxImportSource": "@solidjs/web"`, and React's entries leave `types`. Comments and trailing commas are kept.
- **`vite.config.{ts,js,mts,mjs}`**: `import react from "@vitejs/plugin-react"` and `plugins: [react()]` become `import solid from "@solidjs/vite-plugin"` and `solid()`. React-only options (a `babel` setup that only runs the React Compiler, `jsxRuntime`, `jsxImportSource`, `fastRefresh`) are dropped; any other shape is flagged with what to write.
- **Entry**: `createRoot(el).render(<StrictMode><App /></StrictMode>)` becomes `render(() => <App />, el)` from `@solidjs/web`.

It flags rather than changes: a `catalog:` or `workspace:` range (change it where the catalog defines it), a `package.json` or `tsconfig` above the package (shared with the rest of a monorepo), the React lint plugins (`eslint-plugin-react-hooks` and the like, which your lint config loads), a `next.config.*`, and every React library without a Solid 2 port. A library counts as a React library when the lockfile (`pnpm-lock.yaml`, `package-lock.json`, or yarn berry's `yarn.lock`) says it peers on `react` or `react-dom`, directly or through another peer (`nuqs` peers on `next`); without such a lockfile, when its name contains "react".

### Next.js

Next.js has no Solid 2 equivalent; the closest is `@solidjs/vite-plugin`'s start mode (file routes through `fileRoutes()` from `@solidjs/router/fs`) or SolidStart. So a Next.js app is converted component by component, and the Next.js parts are flagged, not rewritten:

- **Async components** (React Server Components, such as an `async` page) are left as they are, but for JSX attribute names, and flagged `server component`: a Solid component can't be async. Load the data in the route with an async `createMemo` (Solid 2 memos can be async; reads suspend under `<Loading>`) or a server function, and render synchronously.
- **Each `next/*` import** is flagged once, with what to use: `next/link` → `<a href>` (`@solidjs/router` 2 has no link component and intercepts plain anchors); `next/navigation` → `useNavigate`, `useLocation`, `useSearchParams` and `useParams` from `@solidjs/router`, `redirect` from `@solidjs/web`, and a catch-all route for `notFound`; `next/image` → `<img>`; `next/dynamic` → `lazy` from `solid-js`; `next/headers` and `next/server` → server functions; `next/script` → `<script>` or `useHead`; `Metadata` from `next` → `useHead` from `@solidjs/web`.
- **`next`, `next-themes`, `nuqs`, `@t3-oss/env-nextjs`, `geist` and `next-intl`** are flagged as dependencies with no Solid 2 port.

### React libraries and their Solid 2 ports

The table is in `src/manifests.mjs`, checked on npm on Nov 19 against `solid-js@2.0.3`. A dependency step will replace it.

| React | Solid 2 | |
|---|---|---|
| `@tanstack/react-query` | `@tanstack/solid-query@6.0.0-rc.6` | the `rc` tag |
| `@tanstack/react-router` | `@tanstack/solid-router@2.0.0-rc.11` | the `rc` tag; still depends on some Solid 1 helper packages, so expect peer warnings |
| `react-router`, `react-router-dom` | `@solidjs/router@^2.0.0` | a different API |
| `lucide-react` | `@lucide/solid@^1.76.0` | `lucide-solid` is the Solid 1 package |
| `@testing-library/react` | `@solidjs/testing-library@1.0.0-rc.2` | tests aren't converted: `render(() => <App />)` |
| `@base-ui/react`, `@base-ui-components/react` | `@solidports/base-ui` | reported, not installed. It installs and works on 2.0.x, with type errors on stable and dev warnings in a few form components until a fix release; `render` takes a tag or a function, not an element |
| `react-markdown` | none | `solid-markdown` is Solid 1 only: render with `unified` and `hast-util-to-jsx-runtime`, given `jsx`, `jsxs` and `Fragment` from `@solidjs/h/jsx-runtime` (`elementAttributeNameCase: "html"`, `stylePropertyNameCase: "css"`) |

No Solid 2 port yet, so these stay and are reported as blockers: `zustand`'s React hook (`solid-zustand` is Solid 1 only; a small bridge into a signal works), `@effect/atom-react` (Solid 2 support is unreleased), `@tanstack/react-pacer` (`@tanstack/pacer`'s `Debouncer` and `Throttler` work as they are), `@clerk/react`, `@clerk/electron`, `@legendapp/list`, `gt-react`, `react-day-picker`, `@pierre/diffs` and `@pierre/trees` (their `/react` entries), and `@dnd-kit/*`.

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

Flagged and left as React code (`effect`): no deps array (it ran after every render; a Solid component doesn't re-render), deps that aren't an array literal or have a spread, a ref in the deps (`ref.current`, or a `let` from the ref rule), an async callback (it returns a promise, which Solid rejects as a cleanup), a callback that isn't an inline function, an effect not at the top of a component or hook body, and an effect in an async component. Converted but flagged: `effect dep` when a dep is a plain value in Solid, declared in the body or from a hook, so tracking it never re-runs the effect (make it an accessor and track `x()`; setters and values the compiler found stable aren't flagged), and `effect read` when apply reads a signal, memo or prop that isn't a dep (it warns in dev: add it to compute, or `untrack` it for a deliberate snapshot).

Differences that remain: Solid's effects don't compare, so a dep like `user()?.id` re-runs the effect whenever `user()` changes (React's effects must already tolerate extra runs); cleanups on dispose run in reverse creation order; and there is no loop guard for an effect that always writes its own dep.

### After it runs

1. Run the install command it printed.
2. Finish each flagged spot. The most common are custom hook results, values read in a component body (which runs once in Solid), class components (Solid has none; an error boundary becomes `<Errored>`), server components, Next.js imports, effect deps that are plain values (see [Effects](#effects)), and libraries without a Solid 2 port.
3. Type-check, build and run the app.

On create-vite's React TypeScript template (create-vite 9.3.4, Nov 19), `apply=true`, then `npm install` and `npm run build`, builds with no hand edits; with two components added that subscribe in an effect and log on mount, it builds too, and a jsdom test shows the effect subscribe, re-subscribe on a prop change and clean up. On t3code's `apps/web/src`, 0.1.3 converted every file and was type-checked against Solid 2.0.1, which is where the 0.1.3 fixes came from; a large app still needs its flagged spots and libraries finished by hand, and t3code hasn't been built.

## Steps

| Step | Task | What it does |
|---|---|---|
| Read package.json files | `forEachFile` | Collects dependencies from every package.json |
| Read the lockfile | `forEachFile` | Which packages peer on React, and the install command |
| Check React libraries for Solid ports | function | Fails if nothing on the way to the converted directory depends on `react`; lists React libraries with and without a Solid 2 port, and which package.json owns the directory |
| branch / commit | `branch`, `commit` | Only with `--param apply=true` and `--managed-git` |
| Run the React Compiler on each file | `forEachFile` | `babel-plugin-react-compiler@1.0.0` decides what each component-body value becomes; each file's result is a step output |
| Resolve hook contracts across files | function | The whole-program hook-contract pass, over every file's result |
| Convert each file to Solid 2 (preview: Preview the conversion of each file) | `forEachFile` | Writes each decision with a `// solid:` note, then runs the rule pass (`src/rules/mechanical.mjs`, R1-R41) on that text; applied rules and flags are step outputs. A preview writes nothing |
| Move package.json, tsconfig and the Vite config to Solid 2 (preview: Preview the package.json, tsconfig and Vite config changes) | `forEachFile` | `src/manifests.mjs`, as above. A preview writes nothing |
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
| `src/rules/mechanical.mjs` | The rule pass, R1-R41 (R1-R10 from the root `gate/mechanical.js`, R11-R34 from hand-converted screens, R35-R40 from later runs on apps, R41 effects), as `transform(src, { parse, Lang })`, so it runs under `@ast-grep/napi` and `codemod/ast-grep` |
| `src/manifests.mjs` | The port table, the lockfile's React peers, and the `package.json`, `tsconfig` and Vite config edits |
| `src/lint/` | ESLint 9 with `eslint-plugin-solid/configs/v2`; the workflow finds it through `import.meta.dirname` |
| `workflow.yaml` | A stub: codemod 2.0.0-alpha.4 won't start a registry package without one. `codemod.yaml` runs `src/workflow.ts` |
| `docs/` | The Nov 16 report on t3code, engine gaps found along the way, and that run's logs |

## Tests

```sh
pnpm test                                       # reactivity (36), rule (96), project file (23) and Solid effect behavior (10) specs
CODEMOD_BIN=<path to codemod@alpha> pnpm test   # plus the workflow specs (22, tagged slow), which run the CLI on copies of tests/fixtures/todo-app
```
