# Handoff: react-to-solid-codemod as a workflow v2 workflow

Branch `handoff/workflow-v2`, as of Nov 17, 2026. Nothing here is merged into `main`. No PR has been opened.

## The goal

Rewrite this codemod as a **Codemod workflow v2** package (the code-first TypeScript engine, codemod/codemod#2485, Mo's branch `engine/code-first`). The aim is a real-world proof that the v2 engine can replace the YAML workflow engine: simpler to write, and fast on a large app.

The codemod has three parts, and all three run as workflow steps:

1. **Reactivity pass.** The React Compiler decides what becomes a signal, memo or accessor.
2. **Rule pass.** ast-grep rules do the mechanical rewrites.
3. **Lint.** `eslint-plugin-solid` with its Solid 2 config checks the result.

## Where things are

| Path | What |
|---|---|
| `workflow-v2/` | **The workflow package.** This is the current work, and it is the only part of this branch that changed. Its git history (11 commits, from the first prototype on Nov 13) is merged in |
| `workflow-v2/src/workflow.ts` | The workflow |
| `workflow-v2/src/rules/mechanical.mjs` | The extended rule pass, R1 to R34 |
| `workflow-v2/src/reactivity/` | The reactivity pass, a copy of the root `src/` with fixes (see below) |
| `workflow-v2/src/lib/reactivity.mjs` | The reactivity pass + Babel + React Compiler bundled into one 7 MB ESM file. Built output, committed so the workflow runs without a build step |
| `workflow-v2/docs/REPORT.md` | Full report: design, numbers, bugs found |
| `workflow-v2/docs/ENGINE-GAPS.md` | Engine gaps per engine build (4caf9ed, 5a33930, 9c91ebf) |
| `workflow-v2/docs/results/t3code-9c91ebf/` | Step logs and result summaries for both t3code runs |
| `src/`, `gate/`, `test/`, `eval/` (root) | The original Node prototype, unchanged from `main` |

The full t3code diffs (about 2 MB gzipped each) and the complete `run.json` files are not in the repo. They are in the project's shared files under `v2-react-to-solid/t3code-9c91ebf/`, next to a git bundle of every branch (`r2s-workflow.bundle`).

## What's done

- **The workflow runs end to end on #2485** at Mo's head 9c91ebf, published to npm as `codemod@2.0.0-alpha.3`. It uses the package layout `codemod init` scaffolds at that head: `codemod.yaml`, `src/`, `tests/`.
- **Steps:**
  - read `package.json` files (`forEachFile`)
  - check React libraries for Solid ports (function step; a table stands in for the dependency step)
  - React Compiler (`forEachFile`)
  - hook contracts across files (function step)
  - rewrite (`forEachFile`)
  - rules (`forEachFile`)
  - summarize (function step)
  - install the lint and lint (`shell`)
  - an `approval` + `agent` step to finish flagged spots, only with `--param agent=true`. **This step has never been run.**
- **The 24 extended rules (R11 to R34) from the solid channel are in**, with one spec each. Dev's call on Nov 16: copy them into the workflow package and don't spend effort on the public code.
- **The React Compiler runs under QuickJS, with no Node.** Node is only used by the eslint step.
- **Bugs found by running on t3code, fixed, each with a spec that fails without the fix:**
  - **Memo alias double edit (Nov 13).** `const a = b` with `b` a memo became `canChooseProject() canChooseProject());`. Fixed in `src/reactivity/rewrite.mjs`.
  - **Loop variable rewritten (Nov 13).** A loop variable named like a signal became `for (const size() of sizes)`.
  - **Shadowed prop rewritten (Nov 13).** A `catch (error)` shadowing a destructured prop became `catch (props.error)`.
  - **Non-ASCII text corrupted every later edit (Nov 16, 201 t3code files).** `codemod/ast-grep` reports UTF-8 byte offsets, where `@ast-grep/napi` reports JS string indexes. The extended rules sliced strings with them, giving output like `cclass"chip-x"`. Offsets are now mapped before slicing.
  - **R21 broke inline `useReducer` init functions (Nov 16, 1 file).** The output was `() => {...}(null)`. The function is now wrapped in parentheses.
- **Not ported to the root `src/` and `gate/mechanical.js`:** the three Nov 13 fixes and the R21 fix. Dev's call was that the public code doesn't matter. The byte-offset fix only matters under the codemod sandbox.

## Numbers on t3code

Target: [pingdotgg/t3code](https://github.com/pingdotgg/t3code) at `95cb068c`, `apps/web/src`, 1,383 files. Both runs used the same machine and a debug CLI built from 9c91ebf with QuickJS at -O3.

| | New workflow (this branch) | Old workflow (jssg steps, public rules) |
|---|---|---|
| Total time | **10.9 min** (653 s) | 28.3 min (1,695 s) |
| React Compiler step | 379 s | 654 s |
| Contracts / rewrite / rules | 16 s / 10 s / 106 s | 18 s / 761 s / 153 s |
| Files changed | 883 (+61,978 / −55,606) | 872 |
| Files that fail to parse | **0** | 0 |
| Solid lint problems | **3,865** | 5,370 |
| `solid/reactivity` | 3,035 | 3,891 |
| `components-return-once` | 287 | 605 |
| Flags left for a person or an agent | 6,773 | 6,910 |
| Rule step failures | 0 | 1 (`GuestPage.tsx`, an invalid regex in the public rules) |

The compiler results are the same in both runs: 2,144 functions compiled, 82 not compiled, 4 bailouts.

The earlier builds compare like this:

- **At 5a33930 (Nov 13):** the `forEachFile` version with the public rules took 8.9 min.
- **The rules step:** it now takes 106 s instead of 31 s, because the extended rules do far more work.
- **The compiler step:** it is 58% of the run and has not been profiled.

**Small todo app** (`workflow-v2/tests/fixtures/todo-app`):

- The output matches the Node codemod with the extended rules, apart from Node's duplicate `createMemo` import.
- Lint warnings went from 4 to 2.

## Exactly what was tested

What ran:

- **`pnpm test`** in `workflow-v2/` (vitest 4): **78 specs pass.** That is 29 reactivity specs and 49 rule specs, run under `@ast-grep/napi`.
- **`CODEMOD_BIN=<9c91ebf build> pnpm test`:** **85 specs pass.** The extra 7 are workflow specs, tagged `slow`, that run the real CLI on the todo-app fixture. One of them covers the non-ASCII bug.
- I reran both commands from this branch's `workflow-v2/` before pushing, and both passed.
- **The workflow on t3code** ran three times on Nov 16 at 9c91ebf: two runs found the two bugs, and the third is the numbers above. The old jssg workflow ran once.

What did **not** run:

- **The npm package.** The published `codemod@2.0.0-alpha.3` itself was never run, only local builds of 9c91ebf. `codemod --version` prints `1.18.7` even on a 9c91ebf build, so the version string can't tell you which engine you have.
- **A release (`--release`) CLI build.**
- **`--managed-git`** (the `branch` and `commit` steps).
- **The agent step**, and any model call.
- **A typecheck, build or run** of the converted t3code. Zero parse errors does not mean it typechecks or works.
- **Any app other than** the todo fixture and t3code `apps/web/src`.
- **Windows or macOS.** Everything ran on Linux.

## How to run it

1. **Build the CLI from #2485.** This needs Rust; 1.97.1 was used. The two `--config` flags compile QuickJS optimized. Without them, a debug build is several times slower.

   ```sh
   git clone https://github.com/codemod/codemod && cd codemod
   git checkout 9c91ebf        # or the latest engine/code-first
   cargo build -p codemod --bin codemod \
     --config 'profile.dev.package.rquickjs-sys.opt-level=3' \
     --config 'profile.dev.package.rquickjs-core.opt-level=3'
   export CODEMOD_BIN=$PWD/target/debug/codemod
   ```

2. **Install and test the package.**

   ```sh
   cd workflow-v2
   pnpm install
   pnpm test                 # 78 specs, no CLI needed
   CODEMOD_BIN=$CODEMOD_BIN pnpm test   # 85, adds the slow workflow specs
   ```

3. **Run it on an app.** The target must be a git repository.

   ```sh
   $CODEMOD_BIN workflow run -w workflow-v2/src/workflow.ts -t <app> \
     --param include=apps/web/src --no-interactive --approve --no-color
   ```

   - The run's result (summary, flags, lint counts) is in `run.json` in the run store. Set `CODEMOD_RUN_STORE_DIR` to choose where the run store goes.
   - The lint step installs its own eslint on the first run (`npm ci` in `src/lint`).
   - Add `--param agent=true` for the agent step. That step is untested.

4. **Rebuild the compiler bundle** after changing `src/reactivity/`: run `pnpm build` in `workflow-v2/`.

## Engine gaps still open (at 9c91ebf)

Details and earlier builds are in `workflow-v2/docs/ENGINE-GAPS.md`. Mo hasn't been sent this list.

1. **Byte offsets (new).** `codemod/ast-grep` node offsets are UTF-8 byte offsets (`range().start.index`, and `replace()` positions), while `@ast-grep/napi` gives string indexes. Anyone porting napi code will corrupt non-ASCII files without noticing. Either document it or expose a string index. `commitEdits` is not affected.
2. **Every state value becomes a shell env var.** Each key is exported as `CODEMOD_STATE_<KEY>`, so big state breaks `shell` steps with E2BIG.
3. **The workflow's return value is only in `run.json`.** `workflow status` lists steps only.
4. **`workflow resume` rejects `--no-color`.**
5. **`jssg` evaluates a big bundle again for every file.** The old workflow's rewrite step took 761 s. `forEachFile` doesn't have this problem (10 s).
6. **No `structuredClone`** in function steps.
7. **The `shell` working directory differs with and without `cwd`.** Without `cwd` it runs in the CLI's directory; with `cwd` it is relative to the target. This is no longer a problem in practice, because `import.meta.dirname` and the quoting `shell` template remove the need for a path.

Fixed or by design since the first run:

- **Fixed:** function steps can import npm code.
- **Fixed for `forEachFile`:** returning per-file outputs.
- **By design:** `jssg` defaults to `semanticAnalysis: "file"`.
- **By design:** step outputs reject `undefined`, with a clear error.

New at 9c91ebf: steps where only some files failed are now reported as partial (◐). That is how the old workflow's `GuestPage.tsx` failure showed up; earlier builds hid it, with the same output.

## Decisions waiting on Dev (with my recommendation)

1. **Should `workflow-v2/` become the codemod?**
   - Today the root `src/` and `gate/` are older copies without the fixes.
   - **Recommendation:** yes. Make `workflow-v2/` the package, and move it to the root once v2 is out of alpha. Until then, keep the root as the Node reference that the todo-app parity check compares against.
2. **Send the engine gaps to Mo?**
   - The byte-offset gap (1) and the env-var gap (2) are the ones that will bite other workflow authors.
   - **Recommendation:** yes. Send gaps 1 to 4 as short issues or comments on #2485, with the repro from `ENGINE-GAPS.md`.
3. **Run the agent step?**
   - It is wired but has never run. On t3code it would face 6,773 flags.
   - **Recommendation:** first run it on one t3code directory of 20 to 30 files, to measure fix rate and cost before running the whole app.
4. **Check the published `codemod@2.0.0-alpha.3`?**
   - Everything so far ran on a local build of the same commit.
   - **Recommendation:** run `pnpm test` with `CODEMOD_BIN` pointing at the npm binary. If it passes, the run steps above get simpler.

## Next steps

1. **Typecheck and build the converted t3code** (`apps/web`), and sort what's left into codemod bugs and agent work. Zero parse errors is only the floor.
2. **Profile the React Compiler step.** It is 379 s of 653 s. Caching per file or running more threads is the obvious lever.
3. **Replace the React-port table** in "Check React libraries for Solid ports" with the dependency step, once it lands. That step is codemod/codemod#2486, stacked on #2485 and currently behind it.
4. **Make inline context provider values getters.** Today only a named `value` object becomes an object of getters.
5. **Read tsconfig `paths` in `src/reactivity/contracts.mjs`.** It currently hardcodes `~/` to `apps/web/src`.
6. **Run the agent step** once decision 3 is made.
