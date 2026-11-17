# Handoff: React Compiler analysis, as WASM, for react-to-solid

Last updated Nov 17, 2026. Written for someone picking this up cold.

This work spans two branches:

| What | Repo and branch | Based on |
|---|---|---|
| The codemod side: the WASM build of the compiler, its JS binding, `extract` using it, research notes and scripts | `devagrawal09/react-to-solid-codemod`, branch `handoff/react-compiler-wasm` | `main` at 772c59d |
| The engine side: a generic `.wasm` loader for jssg transforms, nothing React-specific | `codemod/codemod`, branch `handoff/wasm-loader` | Mo's `engine/code-first` at 6536221 |

Both branches carry this file as `HANDOFF.md`. No PRs are open for either.

## TL;DR

- react-to-solid needs the React Compiler's *analysis* (which values are reactive, which memo scopes exist, what each scope depends on). Today it gets that by running Babel and `babel-plugin-react-compiler` inside QuickJS: about 350 ms per file, and some files take seconds or hang.
- oxc (a Rust JS toolchain) has a Rust port of the React Compiler. A ~500-line patch makes it hand back that analysis as JSON (`facts`).
- That patched compiler is built to a 3.5 MB `.wasm` file that ships **inside the react-to-solid package**. The codemod engine only needs a generic "import a `.wasm` file" feature, so **no React code goes into codemod core**. Dev ruled out building the compiler into the engine on Nov 13.
- The results:
  - The WASM facts are byte-identical to a native build on all 810 test files.
  - `extract` runs at 68 ms median per real-app file, against 348 ms with Babel today.
  - The costs are about 1.2 s of one-time WASM compile per run, +13.8 MB on the CLI binary, and more memory per worker.
- What's open: whether to take the loader to Mo, whether to upstream the patch to oxc, and moving the rest of `extract` off Babel. See [Decisions waiting on Dev](#decisions-waiting-on-dev).

## Goal

The react-to-solid codemod (`src/extract.mjs`) decides how each React value becomes a Solid primitive (signal, memo, plain value). It does that from the React Compiler's view of the component. The goal of this work:

1. Get that analysis out of a compiler as data, not compiled code.
2. Make it fast enough to run inside the codemod engine (jssg, which runs JS in QuickJS) on real apps.
3. Keep the React Compiler out of codemod core.

## How it fits together

```
your-component.tsx
   │  source text
   ▼
react-to-solid jssg transform  (QuickJS, inside the codemod CLI)
   │  import compilerFacts from "../lib/compiler-facts.wasm"   ← engine's generic loader
   │  analyze(source, filename)                                 ← src/compiler-facts.mjs
   ▼
lib/compiler-facts.wasm  (oxc's React Compiler + facts patch, run by wasmtime)
   │  JSON facts per function
   ▼
extract(code, file, { analyze })  → decide → rewrite   (unchanged from today)
```

What goes in and what comes out, for a small component:

```tsx
// Counter.tsx (input)
export function Counter({ step }) {
  const [count, setCount] = useState(0);
  const next = count + step;
  return <button onClick={() => setCount(next)}>{next}</button>;
}
```

```jsonc
// analyze(source, "Counter.tsx").functions[0] (abridged)
{
  "loc": "1:7",                 // "line:column" (1-based line, 0-based UTF-16 column), same as Babel
  "status": "compiled",         // or "bailout" / "skipped" with diagnostics
  "memoSlots": 5,
  "reactive": {
    "named": [                  // every named binding the compiler saw, with its reactive flag
      { "loc": "1:26", "id": 1,  "name": "step",     "reactive": true },
      { "loc": "2:9",  "id": 6,  "name": "count",    "reactive": true },
      { "loc": "2:16", "id": 7,  "name": "setCount", "reactive": false },
      { "loc": "3:8",  "id": 12, "name": "next",     "reactive": true }
    ],
    "scopes": [                 // memo scopes that survived, with dependencies (and property paths)
      { "id": 1, "line": 4, "dependencies": [{ "id": 12, "name": "next", "reactive": true, "path": [] }], "declarations": [19] },
      { "id": 2, "line": 4, "dependencies": [{ "id": 19, "name": "t1" }, { "id": 12, "name": "next" }], "declarations": [21] }
    ],
    "returns": [{ "loc": "4:2", "id": 21, "reactive": true }],
    "identifiers": [ /* every identifier by id, with name, loc and scope */ ],
    "edges": [ /* [id, [ids it was computed from]] */ ],
    "reactiveIds": [1, 5, 6, 9, 10, 11, 12, 19, 20, 21]
  }
}
```

`extract` joins these to its own AST pass by `"line:column"`, which is why the keys are Babel-style.

What the engine gives a transform that imports a `.wasm` file (branch `handoff/wasm-loader`):

```js
import compilerFacts from "../lib/compiler-facts.wasm";

const { exports, memory } = compilerFacts.instantiate();   // a fresh instance, own memory
exports.alloc(len); exports.analyze_utf8(ptr, len, namePtr, nameLen);  // numbers in, numbers out
memory.write(ptr, "text");        // UTF-8 into linear memory, returns bytes written
memory.readString(ptr, len);      // UTF-8 out
memory.read(ptr, len);            // Uint8Array copy
memory.size();                    // bytes of linear memory
```

The binding (`src/compiler-facts.mjs`, about 35 lines) hides all of this behind `analyze(source, filename)`.

## Rust in two minutes (for this repo)

- **Crate**: a Rust package, roughly an npm package. `compiler-facts/` is one, with `Cargo.toml` as its `package.json`.
- **Path dependency**: `oxc_react_compiler = { path = ".oxc/crates/oxc_react_compiler" }` means "use the source at this folder", like a `file:` dependency. `build.sh` clones oxc into `compiler-facts/.oxc` at a fixed commit and applies `oxc-facts.patch`, so the patched compiler is what gets built.
- **`wasm32-unknown-unknown`**: the build target for "plain WebAssembly with no operating system". The module can only compute: it has no imports, so no files, network or clock.
- **`cdylib`**: "build a library other languages can load", which for this target produces the `.wasm`.
- **The ABI**: the `.wasm` exports `alloc(len)`, `dealloc(ptr, len)`, `analyze_utf8(srcPtr, srcLen, namePtr, nameLen) -> resultLen` and `result_ptr()`. The JS side writes the source into WASM memory, calls `analyze_utf8`, then reads the JSON back. It's a convention, not something the engine checks.
- **wasmtime**: the Rust library the engine uses to run `.wasm` files. It compiles WASM to machine code (Cranelift) at load time, which is the 1.2 s one-time cost.

## Findings on the two Rust ports

Full detail is in `research/REPORT.md`, sections 1 to 3.

| | React team's own port | oxc's fork |
|---|---|---|
| Where | `compiler/crates/*` in react/react (merged Jun 2026) | `crates/oxc_react_compiler` in oxc-project/oxc |
| Input | A Babel-shaped JSON AST plus a scope table the host builds | oxc's own AST and `oxc_semantic`, which the codemod engine already uses |
| Intermediate analysis | Only as a **text printout** (the same debug print as the TS compiler) | **None**: debug output and logger stripped. Compiled code plus diagnostics only |
| Tracks upstream | Lockstep with TS `main` | A pinned fork with 11 documented divergences |
| Published | crates.io 0.1.0; its Babel shim isn't on npm | `publish = false` on crates.io since 0.143.0; ships via oxlint and npm `oxc-transform-react` |

Neither port gives the analysis as data. In both, exposing it is a small patch: walk the reactive function right after the `PruneHoistedContexts` pass, which is exactly the point `extract.mjs` reads from Babel's debug log today. I patched **oxc's port**, because it runs on the same AST and semantic model as the engine and it's the faster one.

## Parity numbers

Output-level comparison per memoized function: memo slots, each scope's dependency list and scope count.

| | Agreement |
|---|---|
| React's own fixtures, oxc vs TS `main` expected output (863 functions) | 96.5%. Babel 1.0.0 scores 95.4% on the same check |
| t3code (`apps/web/src`, 1383 files), oxc vs a May 2026 Babel build | 94.8% of functions with the same scope dependencies |
| The codemod's own 20 spec snippets | 19/19 byte-identical to the May build |

The differences are deliberate oxc choices in exactly the area `extract` reads. It sometimes uses a coarser dependency (`editor` for `editor.isEditable`), merges scopes differently, or adds a method-property dependency (`items.map`).

**`extract` on facts vs on Babel 1.0.0** (the real `extract.mjs` both ways, compared per function and per value):

| | todo app (6 files) | t3code web (804 files) |
|---|---|---|
| functions with the same status | 7/7 | 2042/2045 |
| compiled by both, identical facts | 7/7 | 1791/1965 (91%) |
| values with the same reactive flag | 25/25 | 14288/14294 |
| values in the same scope | 25/25 | 14011/14294 (98%) |

The 9% of t3code functions that differ come from the compiler version, not the extractor. The codemod pins `babel-plugin-react-compiler` 1.0.0, and oxc tracks a newer compiler. For example, newer compilers treat `useState` setters as stable.

**WASM vs native build of the same patch**: 810/810 files byte-identical in Node, and 34/34 per-file summaries identical inside the engine.

## Speed and memory numbers

These are Linux, 4 cores, release builds, measured Nov 13 against the old #2485 base (5a33930).

| | native module (rejected design) | WASM in package (this branch) | Babel (today) |
|---|---|---|---|
| `extract` per file, 28 t3code files | median 63 ms, total 2.9 s | median 68 ms, total 3.1 s | median 348 ms, total 24.2 s |
| `analyze` alone, same files | median 4 ms | median 6 ms | |
| todo app, `extract` per file | median 21 ms | median 23 ms | median 72 ms |
| one-time cost per run | none | compile 1.2 to 1.4 s | loading the 7 MB Babel bundle |
| `jssg run` wall time, todo / 28 t3code | 1.3 s / 4.7 s | 2.4 s / 6.3 s | 1.4 s / 10.8 s |
| peak RSS, todo / 28 t3code | 221 / 280 MB | 366 / 399 MB | 229 / 369 MB |
| CLI binary size vs base (159.4 MB) | +3.5 MB | +13.8 MB (gzipped +3.6 MB) | |

- What remains of the 68 ms is mostly Babel *parsing and walking the AST* in QuickJS for `extract`'s AST side. Moving that to ast-grep or Rust is the next 5 to 10x.
- **Memory**:
  - An instance starts at 1.2 MB and stays under 10 MB on normal files.
  - WASM memory never shrinks, though. One instance kept across 803 t3code files ends at 459 MB, and the 4,042-line `ChatView.tsx` alone grows it to 2.2 GB.
  - So the binding throws away an instance that grew past 256 MB and starts a fresh one; instantiating takes 0.12 ms.
- **Huge files**: `ChatView.tsx` takes 8.7 s under wasmtime and 11.7 s native. Under Node's V8 it takes 147 s, but Node isn't on the engine path.

## What was tested and what wasn't

Tested:
- The WASM facts against the native build's JSON on all 6 todo-app and 804 t3code files in Node (byte-identical).
- react-to-solid's 31 vitest specs. Three are new:
  - values derived from props are reactive;
  - `extract` gives the same decisions as Babel;
  - after a file grows memory past the cap, the next file gets a fresh instance.
- The loader's 5 specs and the full `codemod-sandbox` suite (119 + 20 + 1). Clippy and fmt are clean, and the `codemod` CLI builds. This was rerun on Mo's `engine/code-first` base on Nov 17.
- On the old base: the release CLI with the loader running `extract` on the todo app and 28 t3code files, all three ways (native, WASM, Babel).
- On Nov 17:
  - `compiler-facts/build.sh` from a clean oxc checkout. The rebuilt `.wasm` gives byte-identical facts to the native build on all 810 files.
  - Its bytes differ slightly from the Nov 13 file only because it no longer embeds the build machine's paths.
  - The release CLI built from `handoff/wasm-loader` (Mo's base) ran `extract` on the todo app and the 28 t3code files. Its per-file summaries matched the Nov 13 run on 34/34 files, at a median of 59 ms per t3code file.

Not tested:
- `decide` and `rewrite` (the rest of the workflow) on WASM facts, beyond one spec.
- The memory-cap reset inside the engine on `ChatView.tsx`. It's tested only in Node, with a cap of 0.
- Cancelling a long WASM call. The engine can't interrupt one yet.
- The browser/playground build of the engine, which has no `.wasm` host.
- wasmi or any runtime other than wasmtime 42.
- macOS or Windows.
- The rest of the codemod workspace's test suites beyond `codemod-sandbox`.
- React's own Rust port on any input. Its Babel shim isn't on npm.

## How to build and run

**Run the codemod's specs (Node):**
```bash
npm install
npx vitest run            # 31 specs; uses lib/compiler-facts.wasm through Node's WebAssembly
```

**Rebuild the WASM file** (needs Rust ≥ 1.98 via rustup; oxc 0.158 requires it):
```bash
compiler-facts/build.sh                      # clones oxc at e375dff3 into compiler-facts/.oxc, applies the patch
RUST_TOOLCHAIN=1.98.0 compiler-facts/build.sh
OXC_REPO=~/src/oxc compiler-facts/build.sh    # use a local oxc clone instead of GitHub
```
This writes `lib/compiler-facts.wasm`. The release build uses LTO and takes a few minutes.

**Run it inside the codemod engine:**
```bash
# 1. the CLI with the loader
git clone https://github.com/codemod/codemod && cd codemod && git checkout handoff/wasm-loader
cargo build --release -p codemod           # target/release/codemod

# 2. a transform that imports the .wasm (the package's own entry)
#    src/compiler-facts.jssg.mjs:
#      import compilerFacts from "../lib/compiler-facts.wasm";
#      export const analyze = bindAnalyze(compilerFacts);
codemod jssg run <transform.mjs> --language tsx --target <app> --dry-run
```
The measurement scripts are in `research/spike/`:
- `wasm-t.mjs`, `native-t.mjs` and `babel.mjs` are jssg transforms that print one JSON line per file.
- `engine-run.py` records wall time and peak RSS.
- `engine-stats.mjs` sums the results.
- `build/build.mjs` bundles `extract` with esbuild.
- `wasm-vs-native.mjs` compares facts in Node.
- `wasmtime-bench/` is a standalone Rust harness.

These scripts still have the absolute paths of the machine they ran on (`/home/user/src/...`), so edit those first.

## What's on this branch

| Path | What |
|---|---|
| `compiler-facts/` | The Rust crate: `src/lib.rs` (the ABI and JSON output), `oxc-facts.patch` (the change to oxc), `build.sh` |
| `lib/compiler-facts.wasm` | The built module, 3.5 MB (1.1 MB gzipped) |
| `src/compiler-facts.mjs` | Host-agnostic binding: `bindAnalyze(compiled, { maxMemoryBytes })` returns `analyze(source, filename)` |
| `src/compiler-facts.jssg.mjs` / `src/compiler-facts-node.mjs` | The entry for jssg, and the entry for Node |
| `src/extract.mjs` | `extract(code, file, { analyze })`: with `analyze` it uses the facts and skips the try pre-step and second compile; without it, today's Babel path |
| `test/compiler-facts.test.mjs` | The 3 new specs |
| `research/REPORT.md` | Full research write-up: both ports, parity, timing, the native design and the WASM design |
| `research/engine-patches/` | The **rejected** native-module design for the engine (bump oxc 0.99 to 0.158, add `codemod:react-compiler`), kept as reference only |
| `research/spike/`, `research/results/`, `research/parity-harness/` | The scripts and raw outputs behind the numbers |

## Decisions waiting on Dev

1. **Take the generic `.wasm` loader to Mo?**
   - Recommendation: yes, as a proposal with these numbers, not as a merge-ready PR.
   - It's the only way found to keep React out of core while getting near-native speed.
   - Mo should know it's a new capability: arbitrary compiled code from a package runs in the CLI. It's sandboxed (no imports allowed), but it costs 13.8 MB of binary, and the wasmtime version is held at 42 by rolldown's `bumpalo` pin.
2. **Add a memory cap and cancellation to the loader before it ships?**
   - Recommendation: yes.
   - wasmtime has both: `StoreLimits` for memory and epoch interruption so `isCanceled()` can stop a running call. Without them, one bad file can take gigabytes or run forever.
3. **Upstream the facts patch to oxc, or carry it?**
   - Recommendation: open an oxc discussion with the patch, and keep carrying it pinned until they answer.
   - The patch is 656 diff lines on one commit, so rebasing it is real work every oxc bump.
4. **Re-baseline on oxc's compiler instead of Babel 1.0.0?**
   - Recommendation: yes.
   - The 9% of t3code functions that differ are newer-compiler behavior. Matching 1.0.0 exactly isn't worth fighting, and the newer compiler also fixes the try/catch bailout that the codemod's pre-step works around.
5. **Move `extract`'s AST side off Babel?**
   - Recommendation: yes, after 1 and 2. It's where the remaining time goes, and the next 5 to 10x.

## Next steps

1. Decide 1 and 2 above.
2. If yes, add `StoreLimits` and epoch interruption to `crates/codemod-sandbox/src/wasm_host/mod.rs`, with a spec each, and enable wasmtime's `cache` feature to remove the 1.2 s cold start on later runs.
3. Run the full react-to-solid workflow (`decide` and `rewrite`, not just `extract`) on WASM facts against the todo app and t3code, and diff the Solid output against today's.
4. Replace Babel parsing in `extract` with the engine's ast-grep tree, then re-measure.
5. Map the loader to the browser's `WebAssembly` for the playground build, or document that `.wasm` imports are CLI-only.
6. Product docs: if the loader ships, `.wasm` imports in jssg transforms need a page in the `codemod` repo's `docs/`.

## Base commits

- oxc: `e375dff31cc44c1fe8f17e2997d46ba85dc38c2a` (oxc 0.158.0) plus `compiler-facts/oxc-facts.patch`.
- codemod engine: Mo's `engine/code-first` at 6536221. Measurements above were on #2485 at 5a33930.
- react-to-solid: `main` at 772c59d.
