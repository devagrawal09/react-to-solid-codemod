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

The converted directory is `src` by default; in a monorepo, point it at one app with `--param include=apps/web/src`. The parameters, the steps and the full list of what changes are in [`workflow-v2/README.md`](workflow-v2/README.md).

## What it does

**Converts:**

- Component-body values: each becomes a signal, a memo, an accessor or a plain value, as the React Compiler's analysis says (see below), with a `// solid:` note saying which and why.
- Hooks and React APIs: `useState` → `createSignal`, `useMemo` → `createMemo`, `useReducer` → a signal and a dispatch, `useCallback` and `memo` dropped, simple `useRef`s → a `let` and a ref callback, `useId` → `createUniqueId`, `<Suspense>` → `<Loading>`, `createRoot(el).render(...)` → `render(() => ..., el)`.
- Props: destructured props → `props.x`, defaults through `merge`, rest through `omit`.
- JSX: `.map` → `<For>` (keyed the way React keyed it), early returns → `<Show>` or `<Switch>`/`<Match>`, `className` → `class` and the other DOM attribute names, `onChange` on text fields → `onInput`, inline style keys → CSS names, `Ctx.Provider` → `Ctx`, React types → Solid's.
- The project: `react` and `react-dom` → `solid-js` and `@solidjs/web`, React libraries → their Solid 2 ports where one is verified, `@vitejs/plugin-react` → `@solidjs/vite-plugin`, and `tsconfig` → Solid's JSX. It doesn't install anything; it prints the install command.

**Flags** (with its file, and line where there is one, in the run's result) what it can't convert safely: effects, refs it can't turn into a `let`, custom hook results, values read once in a component body, class components (an error boundary becomes `<Errored>`), React libraries without a Solid 2 port, and build config it can't rewrite mechanically.

**Leaves to a person or an agent:** the flagged spots, tests (`*.test.*` and `*.spec.*` files aren't converted), and replacing libraries that have no Solid 2 port yet. With `--param agent=true`, the workflow can hand the flagged spots to a coding agent after an approval; that step is untested.

On create-vite's React TypeScript template, an apply run followed by `npm install` and `npm run build` builds with no hand edits. A large app gets most of each component converted and a list of flagged spots to finish.

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

Then a whole-program **hook-contract** pass works out what each hook hands back in Solid (stable, accessor, object of getters, tuple), leaf hooks first through imports, and re-decides the callers: a value that only reads stable results drops to static. Library hooks come from a table in `contracts.mjs`.

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
