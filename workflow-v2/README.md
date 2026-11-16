# React to Solid 2, as a code-first workflow

**Status: prototype.** The [react-to-solid-codemod](https://github.com/devagrawal09/react-to-solid-codemod) passes, run as steps of `src/workflow.ts` on the code-first engine (codemod/codemod#2485, built at 9c91ebf, published as `codemod@2.0.0-alpha.3`). Nothing in the engine was changed for it. The package uses the layout `codemod init` scaffolds at that head: `codemod.yaml` at the root, the workflow and what it imports under `src/`, specs under `tests/`.

```sh
codemod workflow run -w src/workflow.ts -t <app> [--param include=src] [--param agent=true]
```

## Steps

| Step | Task | What it does |
|---|---|---|
| Read package.json files | `forEachFile` | Collects dependencies from every package.json |
| Check React libraries for Solid ports | function | Fails if nothing depends on `react`; lists React libraries with and without a Solid port (a table for now, the dependency step later) |
| branch / commit | `branch`, `commit` | Only with `--managed-git` |
| Run the React Compiler on each file | `forEachFile` | `babel-plugin-react-compiler@1.0.0` decides what each component-body value becomes; each file's result is a step output |
| Resolve hook contracts across files | function | The whole-program hook-contract pass, over every file's result |
| Rewrite values as signals, memos and accessors | `forEachFile` | Writes each decision, with a `// solid:` note |
| Apply the React to Solid rules | `forEachFile` | The rule pass (`src/rules/mechanical.mjs`, R1-R34); applied rules and flags are step outputs |
| Summarize the conversion | function | Decision counts, applied rules, flags |
| Install the Solid 2 lint, Lint | `shell` | `eslint-plugin-solid` 0.19.0, `configs/v2`, on the converted files |
| Finish flagged spots | `approval`, `agent` | Only with `--param agent=true` |

The run's result (in `run.json` of the run store) holds the summary, the flags and the lint counts.

## How the compiler runs without Node

`build/build.mjs` bundles the reactivity pass, Babel and the React Compiler into `src/lib/reactivity.mjs` (7 MB, ESM), which the workflow imports; each `forEachFile` worker loads it once, under QuickJS. Node built-ins are stubbed (`build/stubs/`): the pass never reads Babel config files, and the compiler's Reanimated check, which calls `require.resolve`, is turned off with `enableReanimatedCheck: false` (the one change to the pass's source). Node is only needed for the eslint step.

```sh
pnpm install && pnpm build   # rebuild src/lib/reactivity.mjs after changing src/reactivity/
```

## Layout

| Path | From |
|---|---|
| `src/reactivity/` | `src/` of react-to-solid-codemod, unchanged but for `enableReanimatedCheck` and the memo-alias fix |
| `src/rules/mechanical.mjs` | The extended rule pass (R1-R10 from `gate/mechanical.js`, R11-R34 from the screen ports) as `transform(src, { parse, Lang })`, so it runs under `@ast-grep/napi` and `codemod/ast-grep` |
| `src/lint/` | ESLint 9 with `eslint-plugin-solid/configs/v2`; the workflow finds it through `import.meta.dirname` |

## Tests

```sh
pnpm test                                        # reactivity (29) and rule (48) specs
CODEMOD_BIN=<codemod built from #2485> pnpm test # plus the workflow specs on tests/fixtures/todo-app (6, tagged slow)
```
