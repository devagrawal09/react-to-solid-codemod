# React to Solid 2 as a workflow v2 workflow

> Copied from the project's shared files on Nov 17. Paths like `workflow-9c91ebf/`, `t3code-9c91ebf/` and `r2s-workflow.bundle` refer to that folder; in this repo the package is `workflow-v2/` and the run logs and summaries are in `docs/results/t3code-9c91ebf/`. Start with `HANDOFF.md` at the repo root.

**Result (Nov 16):** on Mo's head 9c91ebf (`codemod@2.0.0-alpha.3`), the workflow with the 24 extended rules converts t3code's `apps/web/src` in 10.9 minutes, against 28.3 minutes for the old jssg version, with 0 files that fail to parse and 28% fewer Solid lint problems (3,865 vs 5,370).

Prototype, local only: nothing pushed, no PR. Git bundle `r2s-workflow.bundle` has four branches:

- `engine-9c91ebf-layout` (copy in `workflow-9c91ebf/`): **current.** 9c91ebf, the `codemod init` layout (`codemod.yaml`, `src/`, `tests/`), the 24 extended rules.
- `engine-9c91ebf`: the same rules on the old root layout (superseded by the branch above).
- `engine-5a33930` (copy in `workflow-5a33930/`): Nov 13, public rules only.
- `master` (copy in `workflow/`): the first version, with `jssg` steps and per-file state.

Engine gap status per build: `ENGINE-GAPS.md`.

## Design (current branch)

| Step | Task | Notes |
|---|---|---|
| Read package.json files | `forEachFile` | |
| Check React libraries for Solid ports | function | Fails with nothing changed if no `react` dep. A PORTS table stands in for the dependency step |
| Run the React Compiler on each file | `forEachFile` | `babel-plugin-react-compiler@1.0.0` + the reactivity pass bundled to one 7 MB ESM file, run under QuickJS. No Node |
| Resolve hook contracts across files | function | Whole-program pass over every file's compiler result |
| Rewrite values as signals, memos and accessors | `forEachFile` | `src/reactivity/rewrite.mjs` |
| Apply the React to Solid rules | `forEachFile` | `src/rules/mechanical.mjs`: the solid channel's extended rules R1 to R34, as `transform(src, { parse, Lang })` |
| Summarize | function | Counts and flags |
| Install the Solid 2 lint, Lint | `shell` | ESLint 9.39, eslint-plugin-solid 0.19.0 `configs/v2`, found through `import.meta.dirname` |
| Finish flagged spots | `approval` + `agent` | Only with `--param agent=true` (not run) |

## Demo: small todo app (`tests/fixtures/todo-app`)

Output matches the Node codemod with the extended rules, except Node's duplicate `createMemo` import. Lint went from 4 warnings to 2. New rewrites from the extended rules: `untrack` reads, `let` + ref callback, `as const` defaults, object reads, `<Show>` fallback, keyed `<For>`, `onInput`.

## Scale: t3code `apps/web/src` (`t3code-9c91ebf/`)

Both runs on 9c91ebf, debug CLI with QuickJS at -O3, same machine.

| | New (extended rules) | Old (jssg, public rules) |
|---|---|---|
| Total time | **10.9 min** | 28.3 min |
| Compiler / contracts / rewrite / rules | 379 s / 16 s / 10 s / 106 s | 654 s / 18 s / 761 s / 153 s |
| Files changed | 883 (+61,978 / −55,606) | 872 |
| Files that fail to parse | **0** | 0 |
| Lint problems | **3,865** | 5,370 |
| solid/reactivity | 3,035 | 3,891 |
| components-return-once | 287 | 605 |
| no-boolean-enumerated-attribute | 23 | 191 |
| no-react-specific-props / no-destructure / no-unused-signal | 0 / 12 / 1 | 82 / 70 / 28 |
| Flags left for a person or agent | 6,773 | 6,910 |
| Rules step failures | 0 | 1 (`GuestPage.tsx`, see below) |

Compiler results (2,144 compiled, 82 not, 4 bailouts) and reactivity decisions are the same in both.

## Codemod bugs found and fixed (Nov 16)

The first t3code run with the extended rules left 202 files that didn't parse. Two causes, each fixed with a spec that fails without the fix:

1. **Non-ASCII text broke every edit after it** (201 files): `codemod/ast-grep` gives UTF-8 byte offsets, and the extended rules (written for `@ast-grep/napi`, which gives string indexes) sliced strings with them: `cclass"chip-x"`, `oprops.onRemove`. Now mapped before slicing. Spec: the workflow spec on the todo app, whose fixture has a `·` in a `title`.
2. **R21** called an inline `useReducer` init function without parentheses: `() => {...}(null)` (1 file). Spec: R21's second case.

The old public rules also fail on `GuestPage.tsx` (`const [{ credential, shareId }] = useState(...)` becomes an invalid regex). Earlier builds hid that failure; 9c91ebf reports the step as partial. The extended rules handle it. Not fixed in the public repo.

The Nov 13 fixes (memo alias, loop variable, `catch` shadowing) are carried into the current branch.

Still open: inline provider values aren't made getters; `contracts.mjs` hardcodes `~/` to `apps/web/src` instead of reading tsconfig paths.

## What's left

- The agent step is wired but not run.
- Swap the PORTS table for the dependency step when it lands.
- Port the fixes to the public repo, if wanted (not needed for this workflow, per Dev).

## What was run (Nov 16)

- `pnpm test` (vitest): 78 specs pass (29 reactivity, 49 rules); with `CODEMOD_BIN` set to the 9c91ebf build, 85 (plus 7 workflow specs, tagged slow).
- The workflow on the todo app, and on t3code `apps/web/src` three times (fixes in between; `t3code-9c91ebf/` holds the last), plus the old jssg workflow once. t3code clone reset afterwards.
- Not run: a release CLI build, the npm `codemod@2.0.0-alpha.3` package itself, `--managed-git`, the agent step, a typecheck or build of the converted t3code.
