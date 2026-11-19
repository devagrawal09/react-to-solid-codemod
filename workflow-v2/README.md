# React to Solid 2

**Status: public preview.** Converts React components to Solid 2 (`solid-js@2.0.1`). The React Compiler decides what each component-body value becomes (a signal, a memo, an accessor or a plain value), deterministic rules rewrite props, hooks, JSX and imports, and eslint-plugin-solid's Solid 2 config checks the result. It converts most of a component; what it can't convert safely, it flags with a file and line for you or an agent to finish. Expect to finish flagged spots and move your dependencies by hand.

## Run it

This is a Codemod workflow v2 package, which is in alpha: pin `codemod@2.0.0-alpha.4`, because `codemod@latest` is still the 1.x CLI and can't run it. Run it from the root of a React app in a clean git checkout.

```sh
# Preview (default): converts every file in memory and reports what would change,
# with the flagged spots. Nothing is written.
npx codemod@2.0.0-alpha.4 run react-to-solid --target .

# Apply: rewrites the files, then lints them with eslint-plugin-solid.
npx codemod@2.0.0-alpha.4 run react-to-solid --target . --param apply=true
```

| Param | Default | What it does |
|---|---|---|
| `include` | `src` | Directory whose `.ts`/`.tsx` files are converted (tests and `.d.ts` files are skipped) |
| `apply` | `false` | `true` writes the converted files and lints them; otherwise the run is a preview |
| `agent` | `false` | `true` (with `apply=true`) asks for approval, then hands the flagged spots to a coding agent. Untested |

The run's result holds the summary: the compiler's decisions, the rules applied, every flag with its file and line, and the lint counts.

### After it runs

The workflow only rewrites source. To finish the migration:

1. Finish each flagged spot. The most common are effects (`useEffect` becomes `createEffect(compute, apply)` or `onSettled`), custom hook results, and values read in a component body, which runs once in Solid.
2. Replace `react` and `react-dom` with `solid-js@^2.0.1` and `@solidjs/web@^2.0.1`, and `@vitejs/plugin-react` with `@solidjs/vite-plugin` (plus `@solidjs/babel-plugin` and `@babel/core`). The plan in the result lists which React libraries have a Solid port.
3. In `tsconfig`, set `"jsx": "preserve"` and `"jsxImportSource": "@solidjs/web"`.
4. Type-check, build and run the app.

Verified on create-vite's React TypeScript template and on the todo app in `tests/fixtures/todo-app`, moved into that template: after the steps above, both type-check, build with Vite, and behave the same in the browser (jsdom). It has not yet been verified on a large production app; a run on t3code parsed every file but wasn't built.

## Steps

| Step | Task | What it does |
|---|---|---|
| Read package.json files | `forEachFile` | Collects dependencies from every package.json |
| Check React libraries for Solid ports | function | Fails if nothing depends on `react`; lists React libraries with and without a Solid port (a table for now, the dependency step later) |
| branch / commit | `branch`, `commit` | Only with `--param apply=true` and `--managed-git` |
| Run the React Compiler on each file | `forEachFile` | `babel-plugin-react-compiler@1.0.0` decides what each component-body value becomes; each file's result is a step output |
| Resolve hook contracts across files | function | The whole-program hook-contract pass, over every file's result |
| Convert each file to Solid 2 (preview: Preview the conversion of each file) | `forEachFile` | Writes each decision with a `// solid:` note, then runs the rule pass (`src/rules/mechanical.mjs`, R1-R36) on that text; applied rules and flags are step outputs. A preview writes nothing |
| Summarize the conversion | function | Decision counts, applied rules, flags |
| Install the Solid 2 lint, Lint | `shell` | Only with `--param apply=true`: `eslint-plugin-solid` 0.19.0, `configs/v2`, on the converted files; the summary is the last line of the lint step's output |
| Finish flagged spots | `approval`, `agent` | Only with `--param apply=true --param agent=true` |

The run's result (in `run.json` of the run store) holds the summary, the flags and the lint counts.

## How the compiler runs without Node

`build/build.mjs` bundles the reactivity pass, Babel and the React Compiler into `src/lib/reactivity.mjs` (7 MB, ESM), which the workflow imports; each `forEachFile` worker loads it once, under QuickJS. Node built-ins are stubbed (`build/stubs/`): the pass never reads Babel config files, and the compiler's Reanimated check, which calls `require.resolve`, is turned off with `enableReanimatedCheck: false` (the one change to the pass's source). Node is only needed for the eslint step.

The bundle is one IIFE assigned to one `const`, with its exports after it, and has no setup code of its own at the top level. `codemod publish` replaces `src/workflow.ts` with a Rolldown bundle of everything it imports, and each workflow callback then gets only the bindings it uses from that file: top-level setup statements would be dropped, and a reassigned module-level binding can't be copied at all. Rolldown also replaces `process.env.NODE_ENV` with `"development"`, which turns on the compiler's dev-only cache checks, so the build sets it to `undefined`, as jssg has it. The slow spec "as codemod publish bundles it" bundles the package the same way and checks the result matches the unbundled run.

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
pnpm test                                        # reactivity (30) and rule (55) specs
CODEMOD_BIN=<path to codemod 2.0.0-alpha.4> pnpm test # plus the workflow specs on tests/fixtures/todo-app (9, tagged slow)
```
