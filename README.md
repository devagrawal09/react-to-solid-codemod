# react-to-solid

A codemod that converts a React app to [Solid 2](https://github.com/solidjs/solid). It does the deterministic part of a migration and marks everything it can't decide, with a `// solid:` note or a flag, for you or a coding agent to finish.

**Status: public preview**, targeting stable Solid 2 (`solid-js@2.0.3`). It's published on the Codemod Registry as `react-to-solid`.

## Run it

From the root of a React app, in a clean git checkout:

```sh
# Preview: converts every file in memory and reports what would change. Writes nothing.
npx codemod@alpha run react-to-solid

# Apply: writes the changes.
npx codemod@alpha run react-to-solid --param apply=true
```

Why `@alpha`: this is a Codemod workflow v2 package, and workflow v2 needs the 2.0 alpha of the Codemod CLI. Plain `codemod` (`codemod@latest`) is still the 1.x CLI and can't run it.

### Troubleshooting

If the run fails with `YAML error: invalid type: string "import { agent, approval, ... } from \"codemod/workflow\"; ...", expected struct Workflow`, the CLI that ran is older than codemod 2.0.0-alpha.2 (the 1.x `codemod`, or 2.0.0-alpha.1): it reads the TypeScript workflow as YAML. npx re-resolves `@alpha` by itself, so a stale one usually comes from a registry mirror or proxy, or an npm `prefer-offline`/`offline` setting. Pin the CLI (`codemod --version` prints `1.18.7` on the 2.0 alpha too, so it can't tell them apart):

```sh
npx codemod@2.0.0-alpha.4 run react-to-solid   # or: pnpm dlx codemod@alpha run react-to-solid
npm view codemod dist-tags.alpha               # what your registry calls alpha
```

The converted directory is `src` by default; in a monorepo, point it at one app with `--param include=apps/web/src`. The parameters, the steps and the full list of what changes are in [`workflow-v2/README.md`](workflow-v2/README.md).

## What it does

**Converts:**

- Component-body values: each becomes a signal, a memo, an accessor or a plain value, as the React Compiler's analysis says (see below), with a `// solid:` note saying which and why.
- Hooks and React APIs: `useState` → `createSignal`, `useMemo` → `createMemo`, `useReducer` → a signal and a dispatch, `useCallback` and `memo` dropped, `useRef` → a `let` and a ref callback (or a plain `{ current }` object when it's passed on), `useId` → `createUniqueId`, `<Suspense>` → `<Loading>`, `createRoot(el).render(...)` → `render(() => ..., el)`, `createPortal` → `<Portal mount>`.
- Effects: `useEffect` and `useLayoutEffect` with a deps array → `createEffect(compute, apply)`, the deps as compute and the ones the body reads handed to apply as parameters (so a cleanup sees its own run's values, as in React); with `[]` → `onSettled`, which keeps the returned cleanup.
- Props: destructured props → `props.x`, defaults through `merge` (a default that reads another prop becomes a getter), rest through `omit`, a prop used as a JSX tag (`{ icon: Icon }`) → `const Icon = dynamic(() => props.icon)`.
- Class components that are only `render()` (and optionally `static defaultProps`) and read nothing of `this` but `this.props` → function components, `defaultProps` through `merge`.
- zustand store hooks: a selected action (`useStore((s) => s.reset)`) is called directly, selected state is read as an accessor, and each store is flagged once with the ~10-line bridge that makes both work in Solid 2.
- JSX: `.map` → `<For>` (keyed the way React keyed it), early returns → `<Show>` or `<Switch>`/`<Match>`, `className` → `class` and the other DOM attribute names, `onChange` on text fields → `onInput`, inline style keys → CSS names, `Ctx.Provider` → `Ctx`, React types → Solid's (a custom hook annotated with its value's type now returns `Accessor<T>`), a guarded accessor read (`{x().icon && <I name={x().icon} />}`) → `<Show>`'s callback, so TypeScript still narrows it.
- Tests (`*.test.*`, `*.spec.*`, `__tests__/`), through the same rules, plus `@testing-library/react` → `@solidjs/testing-library`: `render(<X />)` → `render(() => <X />)`, `act(fn)` → its body and `flush()` (Solid 2 applies writes on `flush()`), a `flush()` after each `fireEvent`, a `rerender` with new literal props → a signal per prop and `flush()`, and `renderHook`'s `initialProps` → an array, `result.current` → `result`, `unmount` → `cleanup`.
- The project: `react` and `react-dom` → `solid-js` and `@solidjs/web`, React libraries → their Solid 2 ports where one is verified (and the code's imports of `lucide-react`, `@tanstack/react-query` and `@testing-library/react` → the port, whose names match), `@vitejs/plugin-react` → `@solidjs/vite-plugin` (in `vite.config` and `vitest.config`), and `tsconfig` → Solid's JSX. It doesn't install anything; it prints the install command.

**Flags** (with its file, and line where there is one, in the run's result) what it can't convert safely: effects without a deps array, with refs or non-literal deps, or with an async callback, and effect deps that changed in React but are plain values in Solid (so tracking them never re-runs the effect; values stable in React too, such as a `useForm()` object or Next.js's router, aren't flagged); refs it can't turn into a `let`, custom hook results, values read once in a component body, class components with state, lifecycle methods or other uses of `this` (an error boundary becomes `<Errored>`), zustand stores (with the bridge), async components (React Server Components, left as they are), each Next.js import with what to use from Solid 2 instead, names a port lacks (such as `useSuspenseQuery`), test shapes it can't convert (a `rerender` with values that aren't literals, `act` used as a value, a hook's whole value read off `renderHook`'s result, React-only `render` options, `asFragment`), a Vitest `node` environment and a Jest config, React APIs it has no conversion for (with what to use), React libraries without a Solid 2 port (found through the lockfile's peer dependencies), tsconfig `paths` into another workspace package's React source, and build config it can't rewrite mechanically.

**Leaves to a person or an agent:** the flagged spots and replacing libraries that have no Solid 2 port yet. With `--param agent=true`, the workflow can hand the flagged spots to a coding agent after an approval; that step is untested.

On create-vite's React TypeScript template, an apply run followed by `npm install` and `npm run build` builds with no hand edits; with Vitest, Testing Library and tests for a component with state, a `rerender` and a `renderHook`, the converted tests pass too. A large app gets most of each component converted and a list of flagged spots to finish. Next.js apps convert component by component; Next.js itself has no Solid 2 equivalent, so its routing, server components and APIs are flagged for a person to move.

## How the React Compiler drives reactivity

The hard part of moving React code to Solid isn't syntax. A React component body reruns on every render, so every `const` in it is implicitly recomputed. A Solid component body runs once, so each of those values has to become a memo, an accessor, a plain const, or be read where it's used. Getting it wrong is silent: the UI just goes stale. Apps built with the React Compiler make this worse, because they drop `useMemo`/`useCallback` and rely on the compiler to memoize.

This codemod lets the React Compiler make that call. The compiler already knows which values are reactive and what each one depends on; the codemod reads that out of the compiler's IR and turns it into Solid code.

It runs `babel-plugin-react-compiler@1.0.0` on each file and reads its final reactive IR (through the public `Logger.debugLogIRs` hook): the reactive scopes, their dependencies, and whether each value is reactive. A Babel pass alongside records what the compiler doesn't (how each value is declared and where it's read). Each value then gets one decision:

| Decision | When | Solid output |
|---|---|---|
| static | the compiler says it isn't reactive | plain `const` |
| memo | reactive with its own compiler scope | `createMemo(() => ...)` |
| accessor | reactive but cheap (the compiler didn't memoize it) | `() => ...` |
| call-time | only read in handlers, effects or callbacks | read when called |
| function | a function capturing reactive values | unchanged, reads happen on call |
| inline / jsx-fn | JSX used once / more than once | moved to its use / `() => <...>` |
| getter-object | a context provider `value` | object of getters, so consumers keep `ctx.x` |
| flag | reassigned, mutated during render, hook call inside, used as a JSX tag, compiler bailed | left for an agent or a person |

Then a whole-program **hook-contract** pass works out what each hook hands back in Solid (stable, accessor, object of getters, tuple), leaf hooks first through imports (relative ones, and the `~/` and `@/` aliases for the app's `src`), and re-decides the callers: a value that only reads stable results drops to static. Library hooks come from tables in `contracts.mjs`: React's and the routers' by name, and libraries whose results keep their identity across renders (react-hook-form's `useForm`, Next.js's `useRouter`, PostHog, Lexical, TanStack Virtual, react-redux) by import source. A zustand store created in the app is read off its `create(...)` call: the keys of its initial state that are functions are its actions.

Two **pre-steps** (`try-prestep.mjs`, `condition-prestep.mjs`) work around React Compiler 1.0.0 bail-outs on `try/catch` and on `?.`/`&&` inside conditions. They only feed the compiler's analysis; the output keeps the original code. Where the compiler still gives up, an AST fallback decides values from what they read.

The pass reads the compiler's internal IR, which changes between versions, so it's pinned to exactly `babel-plugin-react-compiler@1.0.0`. It needs nothing from your app's own compiler setup; apps that don't use the React Compiler get the same analysis. The compiler's scopes are finer than a person's would be, so the output is correct but sometimes has more memos than needed.

## Repository layout

| Path | What |
|---|---|
| `workflow-v2/` | **The published package**: the codemod as a Codemod workflow v2 package. The reactivity pass, Babel and the React Compiler are bundled to run inside the Codemod CLI with no Node; the rule pass, the project file edits and the specs are here. Start with its [README](workflow-v2/README.md) |
| `src/` | The original prototype of the reactivity pass, as a Node CLI: `cli.mjs` converts the files you give it, `scan.mjs` runs it over a whole app (t3code's `apps/web` layout) in worker threads |
| `gate/` | The original prototype of the rule pass (`mechanical.js`, ten rules) and `pipeline.cjs`, which chains both passes over an app and lints the result with eslint-plugin-solid; pinned to `solid-js@2.0.0-rc.21` |
| `test/` | Specs for the prototype's reactivity pass (`npm test` at the root) |
| `eval/` | The blind accuracy review: `accuracy-sample.mjs` draws components into review packets, a reviewer classifies each value with `accuracy-rubric.md` without seeing the tool's answers, and `accuracy-score.mjs` compares |
| `HANDOFF.md` | Notes from Nov 17, when the workflow v2 port was handed off, before it was released: what ran, the numbers on t3code then, and the engine gaps |

The prototype is kept as the reference the package came from. It doesn't have the fixes made since (see `workflow-v2/src/reactivity/`), so use the package to convert an app.

To run the prototype:

```sh
npm ci && npm test                                     # the reactivity pass's specs
node src/cli.mjs out path/to/Component.tsx path/to/useThing.ts   # writes <name>.solid.tsx, .report.md and .json per file
```

## Measurements

These were taken on [t3code](https://github.com/pingdotgg/t3code)'s web app, a React Compiler codebase, while the codemod was being built. They describe those versions, not the current one.

- **Prototype, Nov 10:** in a blind review of 20 held-out components, reviewers and the reactivity pass agreed on whether each value needs a reactive wrapper for 110 of 111 values, with no value wrongly made static.
- **Workflow v2, Nov 16:** converted all 1,383 files of `apps/web/src` with no parse errors in 10.9 minutes (`workflow-v2/docs/REPORT.md`).
- **0.1.3, Nov 19:** type-checking the converted app against Solid 2.0.1 found the errors the 0.1.3 rules fix (see its commit message).
- **0.1.7, Nov 19:** type-checking a large Next.js app converted with 0.1.5 found the bugs 0.1.7 fixes (see its commit message); the same app converted with 0.1.7 has 11,089 type errors, down from 13,038 (the rest is mostly React-typed workspace packages and libraries without a port, and the flagged spots).
