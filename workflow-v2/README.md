# React to Solid 2, as a code-first workflow

**Status: prototype.** The [react-to-solid-codemod](https://github.com/devagrawal09/react-to-solid-codemod) passes, run as steps of a `workflow.ts` on the code-first engine (codemod/codemod#2485). Nothing in the engine was changed for it.

```sh
codemod workflow run -w workflow.ts -t <app> [--param include=src] [--param agent=true]
```

## Steps

| Step | Task | What it does |
|---|---|---|
| Read package.json files | `forEachFile` | Collects dependencies from every package.json |
| Check React libraries for Solid ports | function | Fails if nothing depends on `react`; lists React libraries with and without a Solid port (a table for now, the dependency step later) |
| branch / commit | `branch`, `commit` | Only with `--managed-git` |
| Run the React Compiler on each file | `jssg` | `babel-plugin-react-compiler@1.0.0` decides what each component-body value becomes; each file's result goes to its own state key, `r2s.analysis:<file>` |
| Resolve hook contracts across files | `jssg` on one file | The whole-program hook-contract pass, over every file's result in state |
| Rewrite values as signals, memos and accessors | `jssg` | Writes each decision, with a `// solid:` note |
| Apply the React to Solid rules | `jssg` | The rule pass (`rules/mechanical.mjs`); flags go to state |
| Summarize the conversion | function | Decision counts, applied rules, flags; then clears the per-file keys, because shell steps get every state value as an environment variable |
| Install the Solid 2 lint, Lint | `shell` | `eslint-plugin-solid` 0.19.0, `configs/v2`, on the converted files |
| Finish flagged spots | `approval`, `agent` | Only with `--param agent=true` |

The run's result (in `run.json` of the run store) holds the summary, the flags and the lint counts.

## How the compiler runs without Node

`build/build.mjs` bundles the reactivity pass, Babel and the React Compiler into `lib/reactivity.mjs` (7 MB, ESM), which jssg loads under QuickJS. Node built-ins are stubbed (`build/stubs/`): the pass never reads Babel config files, and the compiler's Reanimated check, which calls `require.resolve`, is turned off with `enableReanimatedCheck: false` (the one change to the pass's source). Node is only needed for the eslint step.

```sh
pnpm install && pnpm build   # rebuild lib/reactivity.mjs after changing reactivity/
```

## Layout

| Path | From |
|---|---|
| `reactivity/` | `src/` of react-to-solid-codemod, unchanged but for `enableReanimatedCheck` |
| `rules/mechanical.mjs` | `gate/mechanical.js` as `transform(src, { parse, Lang })`, so it runs under `@ast-grep/napi` and `codemod:ast-grep` |
| `scripts/` | One jssg transform per step |
| `lint/` | ESLint 9 with `eslint-plugin-solid/configs/v2` |

## Tests

```sh
pnpm test                                        # reactivity specs (28)
CODEMOD_BIN=<codemod built from #2485> pnpm test # plus the workflow specs on test/fixtures/todo-app (6, tagged slow)
```
