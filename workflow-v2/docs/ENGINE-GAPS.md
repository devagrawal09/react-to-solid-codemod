# Workflow v2 engine gaps

Found while running the React to Solid 2 workflow on a todo app and on t3code `apps/web/src` (1,383 files). First found on codemod/codemod #2485 at 4caf9ed; rechecked on Nov 13 against 5a33930 and on Nov 16 against Mo's head 9c91ebf (published as `codemod@2.0.0-alpha.3`), each built locally (debug CLI, QuickJS at -O3).

The published `codemod@2.0.0-alpha.1` on npm is not this engine: its binary reports `codemod 1.18.7`, is built from main (205d920, which has no #2485), and rejects `workflow.ts` with a YAML parse error.

## Status at 9c91ebf (Nov 16)

| # | Gap | Status |
|---|---|---|
| 1 | No run-once JS task that can import npm code | **Fixed** (since 5a33930) |
| 2 | jssg can't return per-file outputs | **Changed**, as at 5a33930: `jssg` still returns only changes, unmodified count and failures; `forEachFile` returns per-file results |
| 3 | Every state value becomes `CODEMOD_STATE_<KEY>` | **Still open**: `tasks/shell.rs` still sets one per state key |
| 4 | `shell` cwd: CLI's directory without `cwd`, target-relative with it | **Still open, but no longer needed.** `import.meta.dirname` and the `shell` tagged template (each value quoted) let the workflow name its own files: `shell\`cd ${lintDir} && ...\`` |
| 5 | The workflow's return value is only in `run.json` | **Still open** |
| 6 | `workflow resume` rejects `--no-color` | **Still open** |
| 7 | A 7 MB bundle evaluated again per file | **Still open for `jssg`** (old workflow's rewrite step 760 s); fixed for `forEachFile` (13.6 s) |
| 8 | No `structuredClone` in function steps | **Still open** (`typeof structuredClone` is `"undefined"`) |
| 9 | Step outputs reject `undefined` fields | **Same**: a clear error, by design |
| 10 | `jssg` defaults to `semanticAnalysis: "file"` | **By design** now: `tasks/jssg.rs` says it matches `codemod jssg run` and `jssg test` |

## New at 9c91ebf

11. **Node offsets are UTF-8 byte offsets**, in `codemod/ast-grep` (`range().start.index`, and `startPos`/`endPos` from `replace()`), where `@ast-grep/napi` gives JS string indexes. Rules ported from napi that slice strings with them corrupt every edit after a non-ASCII character: the extended rules' first t3code run left 201 files that didn't parse (`cclass"chip-x"`, `oprops.onRemove`). Fixed in the workflow by mapping offsets before slicing. Worth documenting, or exposing a string index, since anyone porting napi code will hit it. `commitEdits` is not affected.
12. **Partly failed steps are now reported** (◐ partial). The old jssg workflow shows one failure, `GuestPage.tsx` (an invalid regex built from a destructured `useState` in the public rules). Earlier builds hid it; the t3code diff is identical to 5a33930's.
13. **`codemod init` layout**: `codemod.yaml` + `src/workflow.ts` + `tests/`. The workflow moved to it; nothing else needed changing.

## Status at 5a33930

| # | Gap | Status |
|---|---|---|
| 1 | No run-once JS task that can import npm code | **Fixed.** Function steps run in their own isolate and can import npm packages and local files. The contract pass is now a function step that imports the bundle |
| 2 | jssg can't return per-file outputs | **Changed.** `jssg` still can't, but `forEachFile` callbacks can now import npm and local modules, so the workflow moved off `jssg` and returns per-file results as step outputs. No state is used for them |
| 3 | Every state value becomes a shell environment variable (`CODEMOD_STATE_<KEY>`) | **Still open** in `tasks/shell.rs`. No longer hits this workflow, since it keeps big values out of state |
| 4 | `shell` without `cwd` runs in the CLI's directory; with `cwd` it is relative to the target | **Still open**, unchanged |
| 5 | The workflow's return value is only in `run.json` | **Still open.** `workflow status` lists steps only |
| 6 | `workflow resume` rejects `--no-color` | **Still open** |
| 7 | A 7 MB bundle is evaluated again for every file | **Fixed for `forEachFile`**, which keeps one runtime per worker: on t3code the rewrite step went from 510 s to 9 s. `jssg` still builds a runtime per file |

## New at 5a33930

8. **`structuredClone` is not defined in function steps.** Copying a frozen step result needs `JSON.parse(JSON.stringify(...))`.
9. **Step outputs reject `undefined` fields** (`return value.result.functions[0].tryPrestep[0].line is undefined, which is not JSON`), where `setState` silently dropped them. The error is clear; it failed 6 of 1,383 files until the workflow round-tripped its result through JSON.
10. **`jssg` now defaults to `semanticAnalysis: "file"`.** The unchanged jssg-based workflow got slower on t3code: 26.4 min vs 18.9 min at 4caf9ed (compiler step 584 s vs 436 s, rewrite 743 s vs 510 s). Likely from the new default; not profiled. Passing `semanticAnalysis: "none"` should restore it.

## t3code timings

| Build | Workflow | Total | Compiler | Contracts | Rewrite | Rules |
|---|---|---|---|---|---|---|
| 4caf9ed | jssg steps + per-file state | 18.9 min | 436 s | 11 s | 510 s | 109 s |
| 5a33930 | same, unchanged | 26.4 min | 584 s | 14 s | 743 s | 140 s |
| 5a33930 | forEachFile + function step | 8.9 min | 358 s | 15 s | 9 s | 31 s |
| 9c91ebf | jssg steps, unchanged | 28.3 min | 654 s | 18 s | 761 s | 153 s |
| 9c91ebf | forEachFile, src/ layout, 24 extended rules | 10.9 min | 379 s | 16 s | 10 s | 106 s |

The first four runs produce the same t3code diff. The last one adds the extended rules, which do more work (rules step 106 s vs 31 s) and change more code.
