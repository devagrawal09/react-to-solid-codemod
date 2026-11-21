# React to Solid 2: work list

The codemod converted `src` to Solid 2. These are the spots it left for you or your agent to finish.

7 flagged spots in 2 files: 3 will not build, 3 behave differently, 1 cleanup.
Type-check (TypeScript 6.0.3 on tsconfig.app.json, 1 chunk): 4 errors in 3 files, 3 in flagged code, 1 unflagged.

How to work through this list:

1. Fix the "Will not build" tasks first: until they're gone the app doesn't type-check or run, so what behaves differently can't be seen.
2. Files are in dependency order: a hook or module comes before the files that import it. Fix it first; what its callers need follows from what it returns.
3. Each task quotes the converted line, with the codemod's `// solid:` note above it when there is one: what the codemod decided there. Keep a note accurate, or delete it once its spot is done.
4. Keep each edit to its spot. Type errors under a task are in the code it flags (its line, or the class, component or effect it spans); an "unflagged" task is a type error outside any flagged code.
5. Re-verify with the commands at the end. The type-checker, the linter and the tests, not this list, decide what is done.

## `src/hooks/useCounter.ts`

- [ ] `src/hooks/useCounter.ts:6` **effect**: Will not build
  ```tsx
  useEffect(() => {
  ```
  Flag: no deps array: it ran after every render, and a Solid component doesn't re-render. Track what it reads in compute: createEffect(() => [...], (values) => ...)
  Do: This is still React's useEffect, which isn't imported any more. Write it as createEffect(() => deps, (values) => { ...; return cleanup; }), reading what it depends on in the first function, or as onSettled(() => ...) for one that ran once on mount; async work goes in a function the second one calls.
  Type errors in this code:
  - `6:3` TS2304: Cannot find name 'useEffect'.
  - `7:5` TS2322: Type 'number' is not assignable to type 'string'.
  Guide: https://github.com/solidjs/solid/blob/68406c2077eff22c67f71db4a16bf7026ddceee1/documentation/solid-2.0/MIGRATION.md#effects-lifecycle-and-cleanup
- [ ] `src/hooks/useCounter.ts:6` **React API**: Will not build
  Flag: useEffect was imported from react and has no conversion here; its import was removed
  Do: Its import from React was removed, so the name no longer resolves. Rewrite the code that uses it with what the flag names, or remove it.
  Guide: https://github.com/solidjs/solid/blob/68406c2077eff22c67f71db4a16bf7026ddceee1/documentation/solid-2.0/MIGRATION.md#quick-rename--removal-map

## `src/lib/format.ts`

- [ ] `src/lib/format.ts:2` **type error** (unflagged): Will not build
  ```tsx
  export const pad = (n: number): string => n;
  ```
  - `2:43` TS2322: Type 'number' is not assignable to type 'string'.
  Do: No flag covers this line. A value of a type Solid doesn't take there: a React type (ReactNode, ReactElement) where Solid wants JSX.Element from @solidjs/web, an accessor passed where its value is wanted (call it), or a component still written as a React class.
  Guide: https://github.com/solidjs/solid/blob/68406c2077eff22c67f71db4a16bf7026ddceee1/documentation/solid-2.0/MIGRATION.md#quick-checklist-start-here

## `src/components/Counter.tsx`

- [ ] `src/components/Counter.tsx:8` **render-dependent read**: Behaves differently
  ```tsx
  // solid: counter: getter-object (useCounter hands back an object of getters: keep `counter.k`)
  const counter = useCounter(props.start);
  ```
  Flag: prop 'start' is read in the component body; it runs once in Solid (needs createMemo/<Show>)
  Do: A Solid component body runs once, so this reads the value once. Read it where it's used: in JSX, in createMemo(() => ...), in an effect's first function, or in the event handler; untrack() only for a deliberate one-time read.
  Guide: https://github.com/solidjs/solid/blob/68406c2077eff22c67f71db4a16bf7026ddceee1/documentation/solid-2.0/MIGRATION.md#top-level-reactive-read-in-a-component
- [ ] `src/components/Counter.tsx:8` **custom hook call**: Behaves differently
  Flag: useCounter() returns values in React; decide value vs accessor
  Do: Decide what this hook returns in Solid. A value that changes: have the hook return an accessor and read x() here, or an object of getters and read x.field. A stable one (a function, a client, a ref): leave the reads as they are. A `// solid:` note above it says what the codemod assumed.
  Guide: https://github.com/solidjs/solid/blob/68406c2077eff22c67f71db4a16bf7026ddceee1/documentation/solid-2.0/MIGRATION.md#top-level-reactive-read-in-a-component
- [ ] `src/components/Counter.tsx:9` **custom hook call**: Behaves differently
  ```tsx
  const theme = useTheme();
  ```
  Flag: useTheme() returns values in React; decide value vs accessor
  Do: Decide what this hook returns in Solid. A value that changes: have the hook return an accessor and read x() here, or an object of getters and read x.field. A stable one (a function, a client, a ref): leave the reads as they are. A `// solid:` note above it says what the codemod assumed.
  Guide: https://github.com/solidjs/solid/blob/68406c2077eff22c67f71db4a16bf7026ddceee1/documentation/solid-2.0/MIGRATION.md#top-level-reactive-read-in-a-component
- [ ] `src/components/Counter.tsx:11` **React API**: Will not build
  ```tsx
  // solid: pending: accessor (useTransition hands back an accessor: read it as `pending()`); startTransition: static (useTransition hands back a stable value)
  const [pending, startTransition] = useTransition();
  ```
  Flag: useTransition was imported from react and has no conversion here; its import was removed. Solid 2 has no transition to start: call the callback directly; async work in a createMemo or an action shows as pending through isPending(() => value) and <Loading>
  Do: Its import from React was removed, so the name no longer resolves. Rewrite the code that uses it with what the flag names, or remove it.
  Type errors in this code:
  - `11:38` TS2552: Cannot find name 'useTransition'. Did you mean 'CSSTransition'?
  Guide: https://github.com/solidjs/solid/blob/68406c2077eff22c67f71db4a16bf7026ddceee1/documentation/solid-2.0/MIGRATION.md#quick-rename--removal-map
- [ ] `src/components/Counter.tsx:17` **effect read**: Cleanup
  ```tsx
  createEffect(() => props.start, (start) => {
  ```
  Flag: props.label is read in the effect but not in its deps: Solid warns (STRICT_READ_UNTRACKED) in dev. Add it to compute if the effect should re-run on it, or read it with untrack() for a deliberate snapshot
  Do: Add the value to the effect's first function if the effect should re-run when it changes, or read it with untrack() for a deliberate snapshot; until then Solid warns STRICT_READ_UNTRACKED in dev.
  Guide: https://github.com/solidjs/solid/blob/68406c2077eff22c67f71db4a16bf7026ddceee1/documentation/solid-2.0/MIGRATION.md#effects-lifecycle-and-cleanup

## Re-verify

```sh
npm install
npm run typecheck
npm run build
```
