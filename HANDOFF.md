# Handoff: rule pass R11–R34 (Solid 2 hand fixes turned into rules)

Branch `handoff/solid2-codemod-rules`. It is not merged and has no PR.

## Goal

Three whole screens were converted from React to Solid 2 with both passes of this codemod and
then fixed by hand until they compiled, passed their tests and worked in the browser:

- t3code Settings > OpenTelemetry export
- t3code Settings > Keybindings
- codemod-app Settings > Repositories > Indexing

Many hand fixes came back on every screen. Examples: early returns, destructured props,
`onChange` vs `onInput`, `htmlFor`, leftover React types, values frozen inside `<For>`, Base UI
`useRender`.

This branch turns the mechanical ones into rules in the rule pass (`gate/mechanical.js`). It
reruns the three screens from the original React source and measures how much hand work is left.
The fixes that need judgment stay manual, and are listed below with the reason.

## What's on this branch

| Path | What |
|---|---|
| `gate/mechanical.js` | The rule pass. R1–R10 were on `main`. R11–R34 are new, and R7 changed. It still runs as a CLI and works with `gate/pipeline.cjs` unchanged. It also exports `transform(src) -> { code, applied, flags }`. |
| `test/rules.test.mjs` | 39 specs, one rule per test, plain Vitest, no model calls. Every rule from R11 to R34 has at least one. |
| `gate/measure/` | The scripts that produced the numbers below. They are kept as a record: they hard-code paths to local worktrees from the screen runs, which are not in this repo. |
| `README.md` | The rule pass section and the run steps now mention the new rules. |

## The rules

Each rule is conservative. When it can't rewrite safely, it adds a flag to the JSON output for an
agent or a person to handle, and does not guess.

| Rule | What it does |
|---|---|
| R7 (changed) | `.map` → `<For>` now keys the way React keyed. By an item field: `keyed={(row) => row.id}`, with the item an accessor. By index: `keyed={false}`, with the index a number. Otherwise: by reference. An index read as an accessor becomes `i()`. |
| R11 | Early returns in a component become `<Show>` (one guard) or `<Switch>`/`<Match>` (several), with the guard's value as the fallback. A guarded value is narrowed through Show's callback, so TypeScript narrows too. If work runs between a guard and the final return, the rule flags it instead, because that work would run eagerly in Solid. |
| R12 | DOM prop renames (`htmlFor` → `for`, `tabIndex` → `tabindex` …) also apply to owned components, their `*Props` types, `props.x` reads and `omit`/`merge` keys, so callers and components agree. |
| R13 | `onChange` on a text input or textarea becomes `onInput`, and `.target` becomes `.currentTarget`. Checkboxes, radios and other non-text inputs keep `onChange`. |
| R14 | `render={<El className="x" />}` becomes `render={(p) => <El {...p} class={cn(p.class, "x")} />}`. Base UI parts need a function there to pass their props in. `cn` is used only when the file imports it. |
| R15 | Literal defaults stay literal: `merge({ variant: "default" } as const, props)`. |
| R16 | Boolean `aria-*` values become `"true"`/`"false"` strings. |
| R17 | SVG presentation attributes become kebab case (`strokeWidth` → `stroke-width`). |
| R18 | React types: `ComponentPropsWithoutRef`/`WithRef` → `ComponentProps`. `RefAttributes` is dropped. `CSSProperties` → `JSX.CSSProperties`. `ComponentType`/`FC` → `Component`. `RefObject<T>` → `{ current: T }`. `React.KeyboardEvent<HTMLInputElement>` → `KeyboardEvent & { currentTarget: HTMLInputElement }`. `Dispatch<SetStateAction<T>>` → `Setter<T>`. |
| R19 | A lazy `useState(() => init())` runs once: `createSignal(untrack(() => init()))`. State that is never set becomes a plain `const`. |
| R20 | `use(Context)` → `useContext(Context)`. `useEffectEvent(fn)` → `fn`. `flushSync(() => x())` → `x(); flush();`. |
| R21 | `useReducer(reducer, init)` → a typed `createSignal` plus a `dispatch` that runs the reducer. |
| R22 | A `key` on an element outside a list remounts it in React. It becomes `<Show when={[key]} keyed>{(_key) => …}</Show>`. |
| R23 | Values derived inside a `<For>` callback become accessors, so they track the item. A value read twice inside another derived value is read once into a local, so TypeScript narrowing holds. |
| R24 | A destructured hook result (`const { a, b } = useThing()`) stays an object, with fields read where they are used (`thing.a`), so they stay live. |
| R25 | Library hook values that the reactivity pass marked "hands back an accessor" are called (`x()`). |
| R26 | Renamed props (`{ mixed: mixedOverride }`) and props of function expressions read through `props`. |
| R27 | A `useRef` used only as `.current` and `ref={x}` becomes a `let` and a ref callback. A ref object that is passed on keeps `useRef`. |
| R28 | TanStack Query options are passed as a function: `useQuery(() => opts)`. |
| R29 | `let el; if (c) el = A; else el = B;` becomes `const el = <Show when={c} fallback={B}>A</Show>`, and consts inside the branches become accessors. |
| R30 | `{x() && <El a={x().b} />}` becomes `<Show when={x()}>{(x) => <El a={x().b} />}</Show>`, so TypeScript can narrow. |
| R31 | When the reactivity pass turned a typed const into an accessor or memo, the type moves to the return type or to `createMemo<T>`. |
| R32 | Base UI `useRender` reads its params once in Solid. `props` and `render` become getters, and the element accessor is returned (`return element()`). `className` becomes `class` in the default props object. |
| R33 | Memo and accessor decisions the reactivity pass made but left unwritten in a component are applied. |
| R34 | `event.nativeEvent` → `event`, since a Solid handler gets the DOM event. |

Guards that apply to every rule (each found by the corpus check below, and fixed):

- A name used as a JSX tag (`<item.Icon>`) is never turned into a call, because `<item().Icon>` is not valid JSX. It is flagged for `<Dynamic>`.
- Reads are not rewritten where a nested `const`, a loop variable, a `catch` parameter or a function parameter shadows the name.
- An object memo keeps its parentheses, and a comment inside `return ( … )` is not taken as the value.

## Results on the three screens

Each screen was rerun from its original React source: the reactivity pass, then the rule pass,
old (`main`) and new (this branch). Both outputs were compared with the version fixed by hand.

| Screen | Rewrites | Lines still to fix by hand | tsc errors | Solid lint |
|---|---|---|---|---|
| OpenTelemetry export | 103 → 152 | 315 → 223 (−29%) | 29 → 16 | 20 warnings, 1 error → 3 warnings |
| Keybindings | 308 → 387 | 743 → 680 (−8%) | 122 → 48 | 43 warnings, 7 errors → 33 warnings, 3 errors |
| Repositories > Indexing | 123 → 143 | 238 → 103 (−57%) | 31 → 12 | 11 warnings, 5 errors → 2 warnings |

The hand-fixed versions have 0, 2 and 0 tsc errors, and no lint findings.

How "lines still to fix by hand" is counted:

- Format both versions with prettier, ignoring imports and `// solid:` notes.
- Take the line diff (LCS) against the hand-fixed file.
- The old tool output already had a few hand fixes in place. So the new codemod's output was
  merged in per top-level declaration (`gate/measure/merge.js`), and only declarations the hand
  fix hadn't touched took the new output.

Keybindings gained the least, because most of what's left there is judgment work:

- the when-expression editor was split into two components by hand (about 166 lines)
- custom hooks are still in React shape (about 160 lines)
- state is set during render

## What was tested

- **Specs.** `npm test` passes on this branch: 67 tests. That is 28 existing specs for the
  reactivity pass and 39 new specs for the rule pass. The new specs cover every rule from R11 to
  R34, the R7 key modes, and the corpus guards above. R1–R10 are covered only where a new rule
  builds on them (imports, props, types).
- **Three screens, before and after.** For each screen: tsc, Solid lint and the line count
  against the hand-fixed version, all in the table above. No rule broke output that the old pass
  already had right. Every line the new output lacks is a hand choice, not a mistake:
  - the hand fix left out `as const`
  - it used a plain `class` instead of `cn()`
  - it read through a destructure instead of the object
  - it dropped an unused prop in `select.tsx`

  The tsc errors that appear only in the new output were hidden before behind earlier errors in
  the same expressions.
- **Corpus check.** The rule pass ran over all 626 decided files in t3code's `apps/web`
  (`gate/measure/gate.js`):
  - 0 crashes
  - one file parses worse in ast-grep than with the old pass: `TelemetryExportSettings.tsx`,
    because tree-sitter misreads a call to `override()` (a TypeScript keyword)
  - TypeScript parses that file without errors

## What was not tested

- **The rerun screens were not opened in a browser.** Only the hand-fixed versions from the
  earlier screen runs were browser-checked. The new output was checked with tsc, lint and the line
  diff.
- **`gate/pipeline.cjs` was not run end to end with the new rules.** The screens went through the
  measure scripts instead. The pipeline calls the rule pass the same way, and its CLI was
  smoke-tested on this branch.
- **No other codebases.** Nothing outside t3code `apps/web` and the one codemod-app screen.
  Nothing on mobile (React Native).
- **Formatting.** Output is not formatted. Run prettier after the pass, as the measurements did.
- **The measure scripts don't run from a fresh clone.** They need the local worktrees and the old
  and new tool outputs from the screen runs. The shared project folder has the screen-run
  material (`react-to-solid2-scope/one-screen`, `bigger-screen`, `codemod-app-screen`, `rules`).

## How to run

```sh
npm ci && (cd gate && npm ci)
npm test                                                  # all specs

node gate/mechanical.js in.tsx out.tsx                    # one file; prints applied rules and flags as JSON
node gate/pipeline.cjs <checkout> out/decided out/gate    # whole app after src/scan.mjs, then Solid lint
```

From code: `require("./gate/mechanical.js").transform(source)` returns `{ code, applied, flags }`.

## Still by hand, and why

These need judgment, or an answer that the code doesn't hold. The pass flags them where it can
see them.

- **Set state during render.** The right Solid shape depends on intent: a memo, a derived signal
  or an effect.
- **Custom hooks in React shape.** Each hook needs a contract for what it returns as accessors and
  what it takes as getters. That includes decisions left unapplied inside hooks.
- **`useEffect` → `createEffect`.** Solid 2 splits an effect into a tracked half and an untracked
  half, and where to split takes understanding.
- **Loading and error UI → `<Loading>`/`<Errored>` boundaries.** Where a boundary goes is a UI
  decision.
- **Narrowing across accessor calls in compound conditions,** like `a() && b() && a().x`.
- **Contracts for context and library hooks:** a context that hands out an id as an accessor,
  nuqs, `next/navigation`, atoms, dnd-kit, Clerk.
- **A component chosen at render and used as a tag.** It needs `<Dynamic>`. This is flagged.
- **`React.isValidElement`.** There is no Solid equivalent.
- **Capture props like `onScrollCapture`.** Solid has none. They need `addEventListener` with
  `capture`.
- **`useRef` written during render,** and a rest destructure inside if/else branches. R29 flags
  the second.
- **A component split so a `<Match>` callback doesn't read a stale accessor.** Keybindings has one.

## Open decisions for Dev

1. **Where the rules finally live.**
   - Options:
     - merge this branch into `main` here
     - move the rule pass into the Codemod registry as a jssg step
     - fold it into solid-migration-assistant
   - Recommendation: merge into `main` here now. Port the pass to a jssg step when the codemod is
     published to the registry. The rules are plain ast-grep, so the port is mostly mechanical. The
     reactivity pass stays outside Codemod core either way.
2. **License.**
   - The repo is public with no license. That means nobody else may legally reuse it.
   - Recommendation: MIT, to match Solid and most of its ecosystem.
   - This branch adds no license file. That waits for Dev.

## Next steps

1. Rerun the three screens in a real browser from the new output, plus the remaining hand fixes,
   to confirm nothing regressed at runtime.
2. Decide contracts for the library hooks that are still open (dnd-kit, Clerk, nuqs,
   `next/navigation`), and add them to `src/contracts.mjs`.
3. Pick the next rule candidates from the flags list. Likely candidates:
   - `<Dynamic>` for tag-name values
   - capture props → `addEventListener`
   - `useEffect` with an obvious tracked half
4. Run the pipeline on a second codebase, to see which rules are t3code-shaped.
5. Format the output (prettier) as a final pipeline step.
