# react-to-solid-codemod

**Status: prototype.** A codemod that converts React components to [Solid 2](https://github.com/solidjs/solid) (tested against `solid-js@2.0.0-rc.21`). It does the deterministic part of a migration and marks everything it can't decide for an agent or a person to finish. More rules are being added.

The hard part of moving React code to Solid isn't syntax. A React component body reruns on every render, so every `const` in it is implicitly recomputed. A Solid component body runs once, so each of those values has to become a memo, an accessor, a plain const, or be read where it's used. Getting it wrong is silent: the UI just goes stale. Apps built with the React Compiler make this worse, because they drop `useMemo`/`useCallback` and rely on the compiler to memoize.

This codemod lets the React Compiler make that call. The compiler already knows which values are reactive and what each one depends on; the codemod reads that out of the compiler's IR and turns it into Solid code.

## The two passes

### 1. Reactivity pass (`src/`)

Runs `babel-plugin-react-compiler@1.0.0` on each file and reads its final reactive IR (through the public `Logger.debugLogIRs` hook): the reactive scopes, their dependencies, and whether each value is reactive. A Babel pass alongside records what the compiler doesn't (how each value is declared and where it's read). Each value then gets one decision:

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

Then a whole-program **hook-contract** pass works out what each hook hands back in Solid (stable, accessor, object of getters, tuple), leaf hooks first through imports, and re-decides the callers: a value that only reads stable results drops to static. Library hooks come from a table in `src/contracts.mjs`.

Two **pre-steps** (`src/try-prestep.mjs`, `src/condition-prestep.mjs`) work around React Compiler 1.0.0 bail-outs on `try/catch` and on `?.`/`&&` inside conditions. They only feed the compiler's analysis; the output keeps the original code. Where the compiler still gives up, an AST fallback decides values from what they read.

The rewrite puts a `// solid:` note above every value saying what it became and why.

### 2. Rule pass (`gate/mechanical.js`)

An ast-grep script for the mechanical rewrites:

- `useState` → `createSignal`, `useMemo` → `createMemo`, React imports → `solid-js`
- destructured props → `props.x`, with defaults through `merge` and rest through `omit`
- `.map(...)` in JSX → `<For>`, `key` removed
- `className` → `class`, `htmlFor` → `for` and the other DOM attribute renames, `dangerouslySetInnerHTML` → `innerHTML`
- `Ctx.Provider` → `Ctx`, `ReactNode` → `JSX.Element`, `React.ComponentProps` → `ComponentProps`, `"use client"` dropped

Anything it can't do safely (refs, effects, custom hook calls, controlled inputs, list indexes, render-dependent reads, unusual prop patterns) it reports as a flag instead of guessing.

`gate/pipeline.cjs` chains both passes over a project and lints the result with `eslint-plugin-solid` 0.19's Solid 2 config.

## Run

```sh
npm ci
npm test                                   # specs for the reactivity pass

# one or more files: writes <name>.solid.tsx, <name>.report.md and <name>.json per file
node src/cli.mjs out path/to/Component.tsx path/to/useThing.ts

# rule pass on a file
(cd gate && npm ci)
node gate/mechanical.js out/Component.solid.tsx out/Component.final.tsx   # prints applied rules and flags as JSON
```

Pass the files that share hooks together so their contracts resolve. Running both passes by hand leaves a duplicate `createMemo` import; `gate/pipeline.cjs` strips it.

Whole app (currently expects an `apps/web/src` layout, as in t3code):

```sh
node src/scan.mjs <checkout> out/scan --write out/decided   # decisions.jsonl, summary.json, rewritten files
node gate/pipeline.cjs <checkout> out/decided out/gate      # rule pass on original and rewritten files, then Solid lint
```

`eval/` has the scripts and rubric used for blind accuracy reviews: `accuracy-sample.mjs` draws components into review packets, a reviewer classifies each value without seeing the tool's answers, and `accuracy-score.mjs` compares.

## Results so far

Measured on the web app of [t3code](https://github.com/pingdotgg/t3code), a React Compiler codebase that bans `useMemo`/`useCallback`:

- **Coverage:** 4,164 of 4,369 component-body values (95%) get a decision; 205 are flagged.
- **Hook results:** 6,601 of 6,708 values that come from a hook call get a decision from the hook's contract; 105 stay open because their libraries aren't in the table yet.
- **Accuracy:** in a blind review of 20 held-out components, reviewers and the tool agreed on whether each value needs a reactive wrapper for 110 of 111 values, with no value wrongly made static. An earlier sample of 25 components agreed on 200 of 201 after fixes. All 24 decisions in three hand-converted components match.
- **Bail-outs:** the pre-steps clear 32 of the 34 functions the compiler gave up on.
- **Lint:** after both passes, `solid/reactivity` warnings drop 31% compared with the rule pass alone.
- **Speed:** about 1.5 minutes for 1,165 files with 3 workers.

Whole screens converted with both passes plus hand fixes compile and run on Solid 2. The hand fixes that keep repeating are what the next rules target.

## Limits

- **Pinned compiler.** It reads the React Compiler's internal IR, which changes between versions. Use exactly `babel-plugin-react-compiler@1.0.0`; the pre-steps are written against its specific gaps.
- **Library hooks** need an entry in the contract table (`BUILTIN` in `src/contracts.mjs`) describing what their Solid port returns.
- **Left for an agent or a person:** setting state during render (`if (x !== prev) setPrev(x)`), effects, refs, values filled by a loop during render, reassigned `let`s, and early returns.
- **Partial output by design.** The result is a partial conversion; library imports (UI kits, icons, routers) still need Solid equivalents.
- **Memo grouping.** The compiler's scopes are finer than a person's would be: correct, sometimes more memos than needed.
