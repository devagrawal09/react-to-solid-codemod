> Copied from the research notes for this branch. Paths under `research/` are in this repo.

# React Compiler in Rust: what exists, how close it is, and how #2485 could use it

Nov 13, 2026. Sources read: React `main` at df6aa4ec (Nov 12) under `compiler/`, oxc at e375dff3 (Nov 13, oxc 0.158.0), codemod PR #2485 at 4caf9ed, react-to-solid-codemod `src/extract.mjs`.

## Short answer

- **WASM in the codemod's package (section 7, Nov 13 evening):** Dev doesn't want the React Compiler in codemod core, so the facts build now ships as a 3.5 MB `.wasm` (1.1 MB gzipped) inside react-to-solid-codemod, and #2485 gets only a generic loader: a transform can `import x from "./x.wasm"`. Facts are byte-identical to the native build on all 810 files, extract runs at 68 ms median per t3code file (native 63, Babel 348), and #2485 needs no oxc bump or Rust 1.98. The costs are about 1.2 s of one-time compile per run, wasmtime adding 13.8 MB to the CLI (3.6 MB gzipped), and memory that only grows, which the binding handles by replacing an instance past 256 MB.
- **Built (section 6):** a local #2485 branch has `codemod:react-compiler` on a patched oxc compiler. The react-to-solid extract gives the same answers as with Babel on the todo app (7/7 functions) and 91% of t3code functions (the rest are compiler-version differences), with no pre-steps, at about 9x less time per file inside the engine. The oxc bump costs Rust 1.98 and 2 files of fixes, one of which only shows up at run time.
- There are two real ports, both complete enough to compile production React. **Neither gives you the intermediate analysis as data.** The React team's port gives it as **text** (the same debug printout the TS compiler prints per pass). oxc's fork **stripped** debug output and the logger entirely: you get compiled code plus diagnostics.
- **Getting the facts out is a small Rust patch in either port**: both have a `ReactiveFunctionVisitor` and operand iterators, and the reactive function after `PruneHoistedContexts` holds exactly what `extract.mjs` reads today (scopes, deps, declarations, identifier ids, reactive flags).
- **For #2485 the natural fit is oxc's crate**, because it runs on oxc's AST and `oxc_semantic`, which #2485 already uses. Two costs: #2485 pins oxc 0.99.0 and the compiler needs ~0.158 (bump), and the crate is `publish = false` since 0.143.0 (git dependency or vendor).
- **Parity**: oxc matches TS `main` scope-for-scope on 96.5% of React's own fixtures (Babel 1.0.0 is at 95.4% against the same `main`). On a real app (t3code) it agrees with a May 2026 Babel build on 94.8% of memoized functions' scope dependencies. Its misses are deliberate divergences in exactly the area `extract.mjs` reads (dependency paths, scope merging).
- **Speed**: oxc (via its npm binding, so including the JS↔native hop) is 6x to 10x faster than Babel 1.0.0 in Node. The codemod's Babel bundle in QuickJS averaged 621 ms per file on a 20-file sample against 3.2 ms for oxc, and 3 more files didn't finish in 90 s.

## 1. Public API, input, scope info, versions, publishing

| | React team's port | oxc's fork |
|---|---|---|
| Where | `compiler/crates/*` in react/react; landed in #36173 (merged Jun 9, 2026, 03e775554) | `crates/oxc_react_compiler` in oxc-project/oxc; core vendored from oxc-project/forked-react-compiler |
| Entry point | `compile_program(file: File, scope: ScopeInfo, options: PluginOptions) -> CompileResult` (`crates/react_compiler/src/entrypoint/program.rs:3756`) | `compile(&Program, &Semantic, &Allocator, PluginOptions) -> CompileResult` and a read-only `lint(...)` (`src/lib.rs:80`, `:121`) |
| AST in | Babel-shaped serde AST (`react_compiler_ast`), i.e. Babel JSON | oxc AST directly; lowering reads `oxc_ast` (`react_compiler_lowering/build_hir.rs`) |
| Scope info | Host supplies a `ScopeInfo` table (scopes, bindings, node→scope, reference→binding) (`react_compiler_ast/src/scope.rs:105`). The napi Babel shim builds it from Babel's scope | `oxc_semantic` via `ScopeResolver` (`src/scope.rs:110`); semantic must be built `with_build_nodes(true)` |
| Out | `Success { ast, events, ordered_log, renames, timing }` / `Error` (`compile_result.rs:87`). Events match Babel's logger: `CompileSuccess` (with memoSlots/Blocks/Values), `CompileError`, `CompileSkip`, `PipelineError` (`:250`) | `Success { output, diagnostics }` / `Fatal` (`react_compiler/entrypoint/compile_result.rs`). No events, no `fnLoc` stream |
| Tracks | TS `main` in lockstep: commits change TS and Rust together; parity script diffs TS vs Rust per pass (`scripts/test-rust-port.ts:293-314`). `crates/TODO.md`: Babel e2e 1792/1802 fixtures | Pinned fork with 11 commented "Unlike the TS implementation" divergences (list in section 3) |
| Published | crates.io `react_compiler`, `react_compiler_hir`, `react_compiler_ast` 0.1.0 (Aug 31, 2026). The Babel shim `babel-plugin-react-compiler-rust` is **not on npm**. OXC and SWC frontends were removed Jun 11 (#36743, d3da20082) | Crate `publish = false` now; last crates.io release 0.143.0 (Aug 3). Shipped to users through oxlint and npm `oxc-transform-react` 0.158.0 (Nov 9) |
| Versus Babel 1.0.0 | Newer than 1.0.0 (it is TS `main`) | Newer than 1.0.0 (forked from a 2026 `main`), plus its own changes |

Others, briefly:
- **eve0415/oxc-plugin-react-compiler**: archived; claimed 100% conformance; points users to oxlint and React's own port.
- **sethwebster/rust-react-compiler**: active hobby port; its own README puts it at 84.2% "compiles", 24.1% "correct", later phases 5-35% done. Not usable.

## 2. Getting the intermediate analysis out

What `extract.mjs` uses today: `logger.debugLogIRs` with `kind === "reactive"`, keeping the last one per function (after `PruneHoistedContexts`), and walking its statements for scopes `{id, dependencies[{identifier, path, reactive}], declarations, merged}`, places `{identifier{id, declarationId, name, scope}, reactive}`, stores and `loweredFunc.func.context`. Plus `CompileSuccess`/`CompileError`/`CompileSkip` events and Babel bindings.

**React's port.** `debugLogIRs` exists but only as text: `DebugLogEntry { kind: "debug", name, value: String }` with the comment "Currently only supports the 'debug' variant (string values)" (`compile_result.rs:201-208`). Enabled by `PluginOptions.__debug` (`plugin_options.rs:78-81`). About 70 passes log; the reactive function after `PruneHoistedContexts` is logged around `pipeline.rs:1030-1033` via `print_reactive_function.rs`, whose doc says it "produces output identical to the TS printDebugReactiveFunction". That printer includes scope ids, ranges, `dependencies: [i] { identifier: N, reactive: bool, path: ".x" }`, declarations and merged (`react_compiler_hir/src/print.rs:492`). So you could parse it, and the format is a tested contract against TS, but it is a printout, not an API. The IR types have no `Serialize` (arena ids: `Place{identifier: IdentifierId, effect, reactive, loc}` at `react_compiler_hir/src/lib.rs:996`, `ReactiveScope` at `:1340`, `ReactiveFunction` in `reactive.rs:28`).

**oxc's fork.** Nothing. `compile_fn` runs the same pass order (`react_compiler/entrypoint/pipeline.rs:97`, `prune_hoisted_contexts` at `:356`, codegen at `:378`) and never prints. The data structures are all there (`Place` at `react_compiler_hir/mod.rs:1052` with `span`, `ReactiveScope<'a>`, `ReactiveFunctionVisitor<'a>` at `react_compiler_reactive_scopes/visitors.rs:32`), and the `lint` path already compiles without codegen (`EMIT = false`), which is the shape a "facts" mode wants.

**Built-in Babel/oxc support in the engine (Dev's question).** Built-in *oxc* support helps; built-in *Babel* doesn't fix anything, because Babel would still run in QuickJS. The useful built-in is narrower than "oxc in jssg": one native function that returns the compiler's facts per function, keyed by source span, so a jssg/ast-grep step can join them to nodes by byte range.

## 3. Parity, measured

Harness: `research/parity-harness/` (`run.mjs`, `compare.mjs`, `fixtures.mjs`). Three compilers: Babel + `babel-plugin-react-compiler` **1.0.0** (what the codemod pins), Babel + `0.0.0-experimental-a1856f3-20260507` (a May 2026 TS `main` build), and **oxc** through npm `oxc-transform-react` 0.158.0. `panicThreshold: "none"`, default options. Output-level comparison per function: memo slots `_c(N)`, the dependency list of each `if ($[i] !== …)` scope check, sentinel scope count, and normalized text.

**React's fixture corpus vs TS `main` expected output** (1848 fixtures; 1020 compared after skipping 376 error/todo and 452 with non-default pragmas; 863 memoized functions):

| | same scopes + deps | same slots | missing fn | extra fn |
|---|---|---|---|---|
| oxc | 833 (96.5%) | 845 | 12 | 7 |
| Babel 1.0.0 | 823 (95.4%) | 823 | 23 | 10 |

**Real code** (every .ts/.tsx/.js/.jsx outside tests/stories):

| corpus | files | memoized fns (1.0.0 / May / oxc) | oxc = May on scope deps | oxc = 1.0.0 on scope deps | 1.0.0 = May on scope deps |
|---|---|---|---|---|---|
| codemod-react-to-solid spec snippets | 20 | 13 / 19 / 19 | 19/19, byte-identical | 13/13 | 13/13 |
| t3code `apps/web/src` | 1383 | 2032 / 2062 / 2066 | 1953/2061 (94.8%) | 1877/2031 (92.4%) | 1964/2031 (96.7%) |

On t3code oxc differs from the May build more than 1.0.0 does from the May build. So its divergences outweigh a year of upstream drift there.

**What the differences are** (oxc vs May build, 136 functions): 59 have a different number of scopes (merging), 46 have a coarser dependency (`editor` instead of `editor.isEditable`, `comments` instead of `comments.length`), 18 add a method-property dependency (`environment?.label.trim`, `items.map`), 7 are temp naming only, the rest mixed. Reproduced by hand: `const text = environment?.label.trim() || label` compiles to `_c(5)` with deps `environment?.label, label` in both Babel builds, and to `_c(6)` with an extra `environment?.label.trim` in oxc; React's fixture `optional-member-expression-as-memo-dep` shows the same (`_c(7)` in TS, `_c(8)` in oxc, and oxc's own snapshot records `_c(8)`, so it's intended).

oxc's own documented divergences (all "Unlike the TS implementation" comments): `infer_types.rs:492`, `validate_no_ref_access_in_render.rs:118`, `build_hir.rs:579`, `:756`, `:3711`, `:4787` (compiles logical assignment instead of Todo), `propagate_scope_dependencies_hir.rs:1051` and `:1084` (doesn't assume callbacks run), `infer_reactive_places.rs:384`, `merge_reactive_scopes_that_invalidate_together.rs:532`, `prune_maybe_throws.rs:46`. Several touch reactivity and dependencies, which is what `extract.mjs` turns into Solid primitives.

**One finding for the codemod regardless of port**: 6 of the 20 spec snippets memoize only on the newer compilers (the try/catch value-block bailout was fixed after 1.0.0). The codemod's try pre-step and second compile may be unnecessary on a newer compiler.

## 4. Spike: compiler facts in #2485 (original design; built version in section 6)

Shape:
1. **Rust, in an oxc_react_compiler fork**: `pub fn facts(&Program, &Semantic, &Allocator, PluginOptions) -> Vec<FunctionFacts>`, a third `const EMIT` mode next to `lint` that stops after `prune_hoisted_contexts` (`pipeline.rs:356`) and walks the reactive function with `ReactiveFunctionVisitor`. Per function: `span`, `name`, status (`compiled` / `error {category, reason, span}` / `skipped {reason}`), `memo_slots`, `scopes[{id, span, deps[{name, symbol, path, reactive}], declarations[{name, symbol}], merged}]`, `stores[{name, symbol, span, reactive, scope}]`, `params`, `context` captures. Keying names by oxc `SymbolId` and spans by byte offsets is what lets a jssg step join facts to ast-grep nodes. Estimate: a few hundred lines, mostly the visitor; React's port would take the same visitor against its own IR.
2. **#2485**: register `codemod:react-compiler` next to `codemod:ast-grep` in `crates/codemod-sandbox/src/sandbox/engine/execution_engine.rs:423-443` (rquickjs `ModuleDef`), exposing `facts(source, filename, options)` returning JSON. Needs the oxc bump from 0.99.0 (codemod-sandbox, language-javascript, workflow `Cargo.toml`) and a git/vendored dependency on the compiler.
3. **Codemod**: `extract.mjs` swaps `debugLogIRs` walking for this JSON; `decide`/`rewrite` stay.

Alternative with no fork (idea, untested): parse the compiled output, since scopes and dependency lists are visible in `if ($[i] !== …)`. That loses per-place reactive flags and declaration ids, which `decide` uses, so I'd only use it as a check.

Recommendation: oxc fork for #2485, because it shares the AST and semantic model with the engine and is the fastest. React's port is the one that tracks TS `main`, so if exact Babel parity matters more than integration, the alternative is React's crates.io release with a `ScopeInfo` built from oxc semantic (React's own `react_compiler_oxc` crate did exactly this, oxc AST to Babel AST in `convert_ast.rs`, 2896 lines, and oxc semantic to `ScopeInfo` in `convert_scope.rs`, 535 lines, until #36743 deleted it on Jun 11; it could be restored from git history, on a newer oxc).

## 5. Time per file

Node, average ms per file (warm, includes parse and printing):

| corpus | Babel 1.0.0 | Babel May 2026 | oxc (napi) |
|---|---|---|---|
| specs | 8.5 | 9.7 | 0.6 |
| t3code | 91.2 | 91.2 | 15.6 |
| ChatView.tsx (4041 lines) | 33 s | 34.7 s | 8.8 s |

Babel-in-QuickJS, measured by running the v2 react-to-solid workflow's bundle (`v2-react-to-solid/workflow/lib/reactivity.mjs`, Babel + compiler 1.0.0 + the codemod's `extract`) in quickjs-emscripten 0.31 (a release wasm build of QuickJS, not #2485's rquickjs), one fresh context per file (`research/parity-harness/qjs-loop.sh`). 23 app files sampled from t3code and a second app:

| | avg ms per file (20 files that finished) |
|---|---|
| Babel-in-QuickJS, full `extract` | 621 (median 228; slowest 5.3 s) |
| Babel 1.0.0 in Node, compile only | 42 |
| oxc via napi, compile and print | 3.2 |

- 3 of the 23 files did not finish within 90 s in QuickJS (95 to 398 ms in Node). I didn't find out why.
- A long-lived QuickJS context hung for over 25 minutes on a 1-line spec snippet with try/catch (the try pre-step path) after 12 earlier files; the same snippet takes 76 ms in a fresh context, and 66 ms with the pre-step off. QuickJS's interrupt handler did not stop it. Worth checking whether jssg reuses a context across files.
- The sibling's own t3code run on a QuickJS -O3 debug CLI took 18.6 min for 1383 files (~0.8 s per file including rewrite and lint), which is in line with this.
- So a native facts call would be roughly two orders of magnitude faster per file than Babel in QuickJS, before counting the hangs.

## 6. Built: `codemod:react-compiler` on a local #2485 branch (Nov 13, afternoon)

Everything here is local: nothing pushed, no PR. The engine patches are in `research/engine-patches/` (reference only), scripts in `research/spike/`, raw results in `research/results/`.

**The Rust patch (oxc fork, 2 commits, ~500 lines with tests).** `oxc_react_compiler::facts(&Program, &Semantic, &Allocator, PluginOptions) -> (Vec<FunctionFacts>, Diagnostics)`. It runs the normal pipeline and, right after `prune_hoisted_contexts`, walks the reactive function (`src/facts.rs`, a port of `analyzeReactiveFunction` from `extract.mjs`). Per function: span, status (compiled / bailout / skipped), memo slots, categorized diagnostics, and for compiled functions the identifiers by declaration id, the operand edges, the named stores with reactive flags and scopes, the surviving scopes with dependencies (with property paths), declarations and merged ids, the returns, and the reactive ids. Hooks: `ProgramContext.facts`, one line in `pipeline.rs`, `record_facts` in `program.rs`. Promoted temporaries are noted before `rename_variables`, because otherwise `t0` from a destructuring default shares its variable's position (the one extractor bug the comparison found; fixed, with a spec).

**The module (#2485 + 2 local commits on top of 5a33930).** `import { analyze } from "codemod:react-compiler"`; `analyze(source, filename)` returns JSON with Babel-style `"line:column"` keys (UTF-16 columns), so results join with `extract.mjs`'s AST pass by position. Registered at the three loader sites in `execution_engine.rs`. `extract(code, file, { analyze })` in react-to-solid (one local commit) then runs Babel only for the AST and builds `joinFunction`'s input from the facts, with no try pre-step and no second compile.

**oxc 0.99 -> 0.158, the concrete cost:**
- Rust toolchain: oxc 0.158 needs rustc 1.98; the repo pins 1.97.1. I built with 1.100.0.
- Code: 2 files, +100/-41 lines (`language-javascript/src/oxc_adapter.rs`, `workflow/src/build.rs`). Four API changes: `errors` became `diagnostics` on parser, semantic and transformer results; string literal values are `JSStr` (no `Display`; I added a 3-line `js_string` helper); `ExportNamedDeclaration` split into `ExportNamedDeclaration` (local specifiers), `ExportFromDeclaration` (re-exports with a source) and `ExportDeclaration` (`export const …`); and `SemanticBuilder` no longer builds the node table by default.
- That last one compiles cleanly and breaks at run time: 11 `language-javascript` tests panicked and every `codemod-workflow` engine test failed ("write the function inline") until I added `.with_build_nodes(true)` at 4 call sites. After that all tests in the three crates pass (sandbox 131 + 20 + 1, language-javascript 39 + 1, workflow 84 across its suites).
- The CLI's rolldown dependency (rev 3d1985ab) pins oxc 0.96, so the binary keeps carrying two oxc versions, as it already does today (0.96 and 0.99).
- `oxc_react_compiler` is `publish = false`, so #2485 needs a git dependency on a fork (or vendoring); I used a local path.
- Cargo.lock: ~790 changed lines. Release build of the CLI: 6 to 7 minutes here.

**Same answers as the Babel extract** (`research/spike/oxc-compare.mjs`: the real `extract.mjs` on both paths, compared per function and per value; temp names normalized):

| | todo app (6 files) | t3code web (804 files) |
|---|---|---|
| functions, same status | 7/7 | 2042/2045 |
| compiled by both, identical facts | 7/7 | 1791/1965 (91%) |
| values: reactive flag | 25/25 | 14288/14294 |
| values: inputs | 25/25 | 14294/14294 |
| values: scope | 25/25 | 14011/14294 (98%) |
| values: read by scopes | 25/25 | 13407/14294 (94%) |

The t3code differences are the compiler-version kinds from section 3, not the extractor: the codemod's Babel side is `babel-plugin-react-compiler` 1.0.0 and oxc tracks a newer compiler. Of 131 scope-dependency diffs, 26 are oxc adding a method-property dependency (`refs.find`), 6 are newer compilers treating `useState` setters as stable, the rest are coarser or merged scopes. Status: 2 functions compile only on oxc, 1 only on Babel.

**In the engine** (the #2485 CLI built in release, `codemod jssg run research/spike/native.mjs`, a jssg codemod that calls `extract` with `analyze` and prints a JSON line per file; `babel.mjs` is the same with today's path):

| | todo app, 6 files | 28 t3code files |
|---|---|---|
| per-file summaries identical (status, scope count, reactive names) | 6/6 | 23/28 files, 93/98 functions |
| extract time, today's Babel path | 37 to 251 ms per file | 24.7 s total, median 375 ms, max 4.4 s |
| extract time, native facts | 17 to 32 ms per file | 2.8 s total, median 51 ms, max 452 ms |

What's left in the native path's time is Babel parsing and walking the AST in QuickJS for the AST side of `extract.mjs`. Moving that to ast-grep or to Rust is the next 5 to 10x. The three files that never finished in quickjs-emscripten (section 5) ran in 4.2 to 4.4 s on #2485's rquickjs with Babel and in about 300 ms with the native facts. Native `analyze` alone averaged 8.4 ms per t3code file in a release build, except ChatView.tsx (4042 lines) at 11.7 s.

## 7. WASM in the codemod's package, with a generic loader in #2485 (Nov 13, evening)

**What's where.**
- react-to-solid-codemod, local branch `wasm-facts` (7e4d364 on `oxc-facts`):
  - `compiler-facts/` is a Rust crate: oxc's compiler plus the facts patch, built for `wasm32-unknown-unknown`. It has no imports.
  - Its ABI is `alloc`/`dealloc`, `analyze_utf8(src, len, name, len) -> resultLen` and `result_ptr`.
  - The build output is `lib/compiler-facts.wasm`.
  - `src/compiler-facts.mjs` is a host-agnostic binding with `analyze(source, filename)`, returning the same JSON as the native module.
  - `src/compiler-facts.jssg.mjs` is the jssg entry and `src/compiler-facts-node.mjs` is the Node entry.
  - `extract` takes `analyze` as before.
- #2485, local branch `wasm-host-2485` (215043d on 5a33930, **no oxc bump**). This drops `codemod:react-compiler` entirely.
  - The module loader routes `*.wasm` imports to `crates/codemod-sandbox/src/wasm_host`.
  - The default export has `instantiate()`, which returns `{ exports, memory }`. Each export is a function taking i32/i64/f32/f64. `memory` offers `read` (a Uint8Array copy), `readString` (UTF-8), `write` (a string or Uint8Array) and `size`.
  - A module that imports anything is refused at load.
  - Compiled code is cached per file for the process, and compiled once even when worker threads import it at the same moment.
  - `codemod:wasm`'s `instantiate(path)` only accepts files the module system already loaded.
  - Nothing in core names React.

**Runtime: wasmtime 42 (Cranelift).** wasmtime 43 and later need bumpalo ≥ 3.20.2, but rolldown's oxc 0.96 in the CLI pins `bumpalo = 3.19.0`, so 42 is the newest that resolves. Its MSRV is 1.91, so it builds on #2485's 1.97.1. It adds 42 crates to the lock and bumps a few shared ones (anyhow, thiserror, windows-sys).

**Numbers** (Linux, 4 cores, release builds):

| | native module | WASM in package | Babel (today) |
|---|---|---|---|
| facts identical to native | | 810/810 files (Node), 34/34 summaries (engine) | |
| extract per file, 28 t3code files | median 63 ms, total 2.9 s | median 68 ms, total 3.1 s | median 348 ms, total 24.2 s |
| analyze alone, same files | median 4 ms, total 295 ms | median 6 ms, total 400 ms | |
| todo app, extract per file | median 21 ms | median 23 ms | median 72 ms |
| one-time cost per run | none | compile 1.2 to 1.4 s, instantiate 0.12 ms | loading the 7 MB bundle |
| wall time, `jssg run` todo / 28 t3code | 1.3 s / 4.7 s | 2.4 s / 6.3 s | 1.4 s / 10.8 s |
| peak RSS, todo / 28 t3code | 221 / 280 MB | 366 / 399 MB | 229 / 369 MB |
| CLI binary vs 5a33930 (159.4 MB) | +3.5 MB (built on 1.100) | +13.8 MB, gzipped +3.6 MB | |

- **Memory per isolate.**
  - An instance starts at 1.2 MB of linear memory and stays under 10 MB on the 28 files.
  - WASM memory never shrinks, though. One instance kept across all 803 t3code files (without ChatView.tsx) ends at 459 MB, and ChatView.tsx alone takes it to 2.2 GB (the wasm32 ceiling is 4 GB).
  - So the binding drops an instance that grew past 256 MB and starts a fresh one for the next file.
  - The native module frees through the system allocator; I didn't measure its peak on ChatView.tsx.
- **Speed outside the engine** (wasmtime harness, all 803 t3code files without ChatView.tsx): median 3.8 ms per file against 2.7 ms native, and about the same total.
  - ChatView.tsx takes 8.7 s under wasmtime against 11.7 s native.
  - Under Node's V8 it takes 147 s, probably from growing memory to 2.2 GB. Node isn't on the engine path.

**What the loader means for Mo's engine.**
1. It's a new capability: arbitrary compiled code from a codemod package runs in the CLI process. With no imports it can't touch files, network or the host, only CPU and memory. Two limits aren't enforced yet:
   - A memory cap per instance (wasmtime `StoreLimits`).
   - Interruption: `codemod:runtime.isCanceled()` can't stop a running WASM call. Epoch interruption would fix that.
2. Binary size and the dependency set. wasmtime adds 13.8 MB, and its version is held back by rolldown's bumpalo pin. wasmi (an interpreter) would be smaller but slower, and I didn't measure it.
3. The browser and playground build (`wasm` feature) has no host. There it would map to the browser's `WebAssembly`; the loader is `cfg(feature = "native")` only.
4. Cold start is about 1.2 s per run on this module. wasmtime's on-disk cache (the `cache` feature, not enabled) would remove it on later runs.
5. It's a copy-in/copy-out ABI convention (`alloc`, pointer and length, a UTF-8 result). The engine doesn't enforce it, but every package would follow it. The component model or WIT would type it, at more engine weight.

## What I tested and what I didn't

Tested: read both ports' entry points, result types, pipelines, IR types and debug printers; ran Babel 1.0.0, a May 2026 Babel build and oxc 0.158.0 (npm binding) on 20 spec snippets, the app files above and 1020 React fixtures; reproduced one divergence by hand; timed the codemod's Babel bundle in a release QuickJS (quickjs-emscripten wasm), not in #2485's rquickjs.

Not tested (research phase): React's Rust port on any input (its Babel shim isn't on npm).

Tested in the build phase: the oxc fork's crate tests plus 5 new specs; the three bumped #2485 crates' full test suites on Rust 1.100 (all pass); 3 module specs and 1 engine spec (a jssg codemod importing `codemod:react-compiler`); the real `extract.mjs` on both paths for the todo app and 804 t3code files in Node, and inside the #2485 CLI for the todo app and 28 t3code files.

Not tested in the build phase: the bump on Rust 1.98 exactly or 1.97 (it can't build there); the rest of the #2485 workspace's tests (only codemod-sandbox, language-javascript and codemod-workflow ran; the CLI was built, not tested); `decide`, `rewrite` and the rest of the react-to-solid workflow on native facts (only `extract`); other apps' files; macOS or any platform but this Linux container; binary size against a 0.99 baseline.

Tested in the WASM phase:
- WASM facts against the native build's saved JSON on all 6 todo and 804 t3code files under Node (byte-identical).
- The wasmtime harness on the same files.
- 5 loader specs and the full codemod-sandbox suite (132 + 20 + 1 pass), plus clippy and fmt on codemod-sandbox (clean).
- react-to-solid's 31 vitest specs, 3 of them new.
- The release #2485 CLI with the loader, running extract on the todo app and the 28 t3code files on all three paths.

Not tested in the WASM phase:
- wasmi or any runtime but wasmtime 42.
- The `wasm` (browser) build of the sandbox.
- The rest of the #2485 workspace's tests; the CLI was built and run, not tested.
- `decide` and `rewrite` on WASM facts beyond one spec.
- The memory-cap reset inside the engine on ChatView.tsx; it's only tested in Node with a cap of 0.
- macOS or Windows.
- Cancelling a long WASM call.
