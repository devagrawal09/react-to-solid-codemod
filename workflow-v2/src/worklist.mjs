// The work list: every flag, and every type error after an apply, as one Markdown file for a coding
// agent or a person. Files in dependency order (the hook-contract pass's import graph: a hook or
// module before the files that import it), project files first; within a file, tasks in line
// order, each with its severity, the converted line, the codemod's `// solid:` note above it, what
// to do, the type errors on that line, and the section of Solid 2's migration guide it needs.

// The migration guide at the Solid commit solid-js 2.0.3 was released from.
export const GUIDE = "https://github.com/solidjs/solid/blob/68406c2077eff22c67f71db4a16bf7026ddceee1/documentation/solid-2.0/MIGRATION.md";

const BUILD = "Will not build";
const BEHAVES = "Behaves differently";
const CLEANUP = "Cleanup";

// Each flag kind's severity, what to do about it (the flag's own detail says where and why), and
// its section of the guide.
export const KINDS = {
  dependency: { severity: BUILD, guide: "imports-where-things-live-now", do: "Change this dependency in package.json as the flag says, then the imports of it in the files below, which still import the React library, and install again." },
  "build config": { severity: BUILD, guide: "typescript-jsx-solid-js--renderer-package", do: "Change this config as the flag says: the build, the type-check or the tests read it." },
  workspace: { severity: BUILD, guide: "imports-where-things-live-now", do: "A workspace package and the packages that use it have to agree on React or Solid. Convert the package the flag names (--param workspace=true converts the ones this app depends on), or keep a React copy of it for the packages still on React." },
  "shared config": { severity: BUILD, guide: "typescript-jsx-solid-js--renderer-package", do: "The workspace shares this file, so the codemod left it alone. Change it once every package that uses it is on Solid 2; until then, set the option in the converted package's own config." },
  "React API": { severity: BUILD, guide: "quick-rename--removal-map", do: "Its import from React was removed, so the name no longer resolves. Rewrite the code that uses it with what the flag names, or remove it." },
  "React namespace": { severity: BUILD, guide: "quick-rename--removal-map", do: "React is no longer a dependency. Replace each React.* name: React.ReactNode and React.ReactElement are JSX.Element from @solidjs/web, React.FC is Component from solid-js, React.CSSProperties is JSX.CSSProperties, and an event type is the DOM's (MouseEvent, KeyboardEvent)." },
  "ported library": { severity: BUILD, guide: "imports-where-things-live-now", do: "The Solid port doesn't export this name: rewrite the code that uses it with what the flag names." },
  "class component": { severity: BUILD, guide: "effects-lifecycle-and-cleanup", do: "Write the class as a function component: state is createSignal, componentDidMount is onSettled, componentDidUpdate an effect on what it compared, componentWillUnmount the cleanup onSettled returns, and an error boundary is <Errored fallback={(err, reset) => ...}>. Then remove its import of React's Component." },
  "server component": { severity: BUILD, guide: "createresource--async-computations--loading", do: "Make the component synchronous: load its data in an async createMemo (reads suspend under the nearest <Loading>) or a server function, and render what it returns." },
  "Next.js": { severity: BUILD, guide: "quick-checklist-start-here", do: "Next.js isn't a dependency after the migration: replace this Next.js API as the flag says." },
  "Next.js route": { severity: BUILD, guide: "quick-checklist-start-here", do: "Finish the route as the flag says; the codemod's README (Next.js App Router to file routes) has the file conventions." },
  "zustand store": { severity: BUILD, guide: "write-inside-reactive-scope-owned-scope", do: "Write the bridge the flag spells out where the store is defined: its callers already read selected state as x() and call selected actions directly." },
  "useReducer shape": { severity: BUILD, guide: "draft-first-setters", do: "This useReducer is now useReducer_TODO, which doesn't exist. Write it as const [state, setState] = createSignal(initial) with dispatch = (action) => setState((s) => reducer(s, action)), or as a store whose draft setter applies the reducer." },
  "useState shape": { severity: BUILD, guide: "quick-checklist-start-here", do: "This useState wasn't destructured as [value, setter], so it was renamed as it was. Destructure it, const [x, setX] = createSignal(...), and read x() where it's used." },
  "expression-bodied component": { severity: BUILD, guide: "top-level-reactive-read-in-a-component", do: "Give the component a block body ({ return ...; }) and convert it like the others: props read as props.x, state as signals, values read in JSX or memos." },
  "complex props pattern": { severity: BUILD, guide: "mergeprops--splitprops--merge--omit", do: "Take props as one object and read props.x where each is used: defaults go in merge({ ... }, props), and a rest is omit(props, ...keys)." },
  "name clash": { severity: BUILD, guide: "imports-where-things-live-now", do: "The file declares a name the conversion also imports from Solid. Rename the file's own, then check each use means the one it should." },
  act: { severity: BUILD, guide: "batching--reads-values-update-after-flush", do: "Rewrite the test as the flag says: @solidjs/testing-library has no act, and writes apply on flush() from solid-js." },
  render: { severity: BUILD, guide: "batching--reads-values-update-after-flush", do: "Rewrite the render as the flag says: @solidjs/testing-library renders a function, once." },
  renderHook: { severity: BUILD, guide: "batching--reads-values-update-after-flush", do: "Rewrite the hook test as the flag says: Solid's renderHook runs the hook once, with initialProps as its arguments, and result is what it returned." },
  rerender: { severity: BUILD, guide: "batching--reads-values-update-after-flush", do: "There is no rerender: render once with signals for the props that change, set them, then flush()." },
  effect: { severity: BUILD, guide: "effects-lifecycle-and-cleanup", do: "This is still React's useEffect, which isn't imported any more. Write it as createEffect(() => deps, (values) => { ...; return cleanup; }), reading what it depends on in the first function, or as onSettled(() => ...) for one that ran once on mount; async work goes in a function the second one calls." },
  "accessor in tag name": { severity: BUILD, guide: "dynamic-components-createdynamic--dynamic--dynamic-factory", do: "Make the component with dynamic as the flag says, const Tag = dynamic(() => source) from @solidjs/web, and render <Tag />." },
  "prop as tag": { severity: BUILD, guide: "dynamic-components-createdynamic--dynamic--dynamic-factory", do: "Make the component with dynamic as the flag says, const Tag = dynamic(() => props.x) from @solidjs/web, and render <Tag />." },
  "Fragment with props": { severity: BUILD, guide: "list-rendering-index-is-gone-and-for-handles-each-keying-mode", do: "Solid has no Fragment component: keep the children and drop the wrapper; a list's key goes in <For keyed={(item) => item.id}>." },
  "render-dependent read": { severity: BEHAVES, guide: "top-level-reactive-read-in-a-component", do: "A Solid component body runs once, so this reads the value once. Read it where it's used: in JSX, in createMemo(() => ...), in an effect's first function, or in the event handler; untrack() only for a deliberate one-time read." },
  "custom hook call": { severity: BEHAVES, guide: "top-level-reactive-read-in-a-component", do: "Decide what this hook returns in Solid. A value that changes: have the hook return an accessor and read x() here, or an object of getters and read x.field. A stable one (a function, a client, a ref): leave the reads as they are. A `// solid:` note above it says what the codemod assumed." },
  "destructured hook result": { severity: BEHAVES, guide: "top-level-reactive-read-in-a-component", do: "Destructuring reads each field once: keep the object and read obj.field where each is used." },
  "destructured memo": { severity: BEHAVES, guide: "top-level-reactive-read-in-a-component", do: "Destructuring a memo reads it once: keep the memo and read memo().field where each is used." },
  "early return": { severity: BEHAVES, guide: "top-level-reactive-read-in-a-component", do: "The statements between the early return and the last one now run once, before the condition is known. Move the condition into the JSX, <Show when={...} fallback={...}>, and what those statements compute into what it renders." },
  "reassigned let": { severity: BEHAVES, guide: "top-level-reactive-read-in-a-component", do: "Choose in the JSX (<Show>, <Switch>) or in a createMemo instead of an if/else at the top of the component." },
  "list key": { severity: BEHAVES, guide: "list-rendering-index-is-gone-and-for-handles-each-keying-mode", do: "<For> keys rows by the item itself unless told otherwise: pass keyed={(item) => key} for this key, or keyed={false} for a list by index." },
  "controlled input": { severity: BEHAVES, guide: "attributes--events-closer-to-html-and-fewer-namespaces", do: "Use onInput for an update on every keystroke (the DOM's change event fires on commit); keep onChange for checkboxes and radios." },
  "style number": { severity: BEHAVES, guide: "attributes--events-closer-to-html-and-fewer-namespaces", do: "Write the value with its unit as a string (`${n}px`): Solid sets a number as it is, without React's px." },
  "context default": { severity: BEHAVES, guide: "usecontext-on-a-default-less-context-returns-t-not-t--undefined", do: "Give the context a default (null for an optional one), or always render its provider: without one, useContext on a default-less context throws in Solid 2." },
  "effect dep": { severity: BEHAVES, guide: "effects-lifecycle-and-cleanup", do: "A plain value never changes, so tracking it never re-runs the effect. Make it an accessor (a signal, a memo, or a hook that returns one) and track it as x() in the effect's first function." },
  ref: { severity: BEHAVES, guide: "top-level-reactive-read-in-a-component", do: "The body runs once, so this write keeps the first value. Read what it copies (an accessor or props) where ref.current is read." },
  "render handler": { severity: BEHAVES, guide: "attributes--events-closer-to-html-and-fewer-namespaces", do: "Your handler replaces the part's own: call the part's handler from yours." },
  "effect read": { severity: CLEANUP, guide: "effects-lifecycle-and-cleanup", do: "Add the value to the effect's first function if the effect should re-run when it changes, or read it with untrack() for a deliberate snapshot; until then Solid warns STRICT_READ_UNTRACKED in dev." },
};
const OTHER = { severity: BEHAVES, guide: "quick-checklist-start-here", do: "Finish this spot as the flag says." };

// What a type error no flag covers usually means after this codemod, by its code.
const NOT_FOUND = "A name that no longer resolves: usually a React API whose import was removed. Use its Solid 2 counterpart.";
const WRONG_TYPE = "A value of a type Solid doesn't take there: a React type (ReactNode, ReactElement) where Solid wants JSX.Element from @solidjs/web, an accessor passed where its value is wanted (call it), or a component still written as a React class.";
const ADVICE = {
  TS2307: "A module that isn't installed any more: React, or a React library with no Solid 2 port, imported by code left as React's. See this file's flags and package.json's.",
  TS2304: NOT_FOUND,
  TS2552: NOT_FOUND,
  TS2339: "A property the value doesn't have in Solid: an accessor read without calling it (x().field), or a React class member (this.props, this.setState).",
  TS2322: WRONG_TYPE,
  TS2345: WRONG_TYPE,
};
const UNKNOWN = "Read the error with the converted code: the usual causes are a value that is now an accessor (read it as x()), a React type left in a signature (ReactNode is JSX.Element from @solidjs/web), or a library that is still React's.";

/**
 * renderWorklist({ mode, root, flags, errors, order, typecheck, commands }) -> Markdown.
 * - mode: "apply" or "preview"; root: the converted directory ("" for the target's root);
 * - flags: { file, line, end?, kind, detail, excerpt?, note? } (line 0 for a whole file; end, when
 *   the flagged code spans lines, its last line);
 * - errors: { file, line, column, code, message, excerpt? } from the type-check ("" for no file);
 * - order: the source files, leaf modules first; files not in it (package.json, configs) go first;
 * - typecheck: { status: "checked" | "skipped", detail } or null (a preview);
 * - commands: the commands that re-verify, in order.
 */
export function renderWorklist({ mode, root, flags, errors, order, typecheck, commands }) {
  const rank = new Map(order.map((file, i) => [file, i]));
  const files = [...new Set([...flags.map((f) => f.file), ...errors.filter((e) => e.file).map((e) => e.file)])].sort((a, b) => (rank.get(a) ?? -1) - (rank.get(b) ?? -1) || (a < b ? -1 : a > b ? 1 : 0));
  // Each type error goes with the first flag on its line, else with the innermost flagged code
  // around it (a class, an async component, an effect left as React's).
  const flagOf = new Map();
  for (const e of errors.filter((x) => x.file)) {
    const inFile = flags.filter((f) => f.file === e.file && f.line > 0);
    const at = inFile.find((f) => f.line === e.line) ?? inFile.filter((f) => f.end && f.line <= e.line && e.line <= f.end).sort((a, b) => a.end - a.line - (b.end - b.line))[0];
    if (at) flagOf.set(e, at);
  }
  const global = errors.filter((e) => !e.file);
  const unflagged = errors.filter((e) => e.file && !flagOf.has(e));
  const severities = { [BUILD]: 0, [BEHAVES]: 0, [CLEANUP]: 0 };
  for (const f of flags) severities[(KINDS[f.kind] ?? OTHER).severity]++;
  const flaggedFiles = new Set(flags.map((f) => f.file)).size;
  const errorFiles = new Set(errors.map((e) => e.file)).size;

  const out = [
    "# React to Solid 2: work list",
    "",
    mode === "apply"
      ? `The codemod converted \`${root || "."}\` to Solid 2. These are the spots it left for you or your agent to finish.`
      : `A preview: nothing was converted. These are the spots that would be left after \`--param apply=true\`, at the lines the converted files would have.`,
    "",
    `${flags.length} flagged ${flags.length === 1 ? "spot" : "spots"} in ${flaggedFiles} ${flaggedFiles === 1 ? "file" : "files"}: ${severities[BUILD]} will not build, ${severities[BEHAVES]} behave differently, ${severities[CLEANUP]} cleanup.`,
    typecheck === null ? "Type-check: only after an apply." : typecheck.status === "checked" ? `Type-check (${typecheck.detail}): ${errors.length} ${errors.length === 1 ? "error" : "errors"} in ${errorFiles} ${errorFiles === 1 ? "file" : "files"}, ${flagOf.size} in flagged code, ${unflagged.length} unflagged${global.length ? `, ${global.length} outside any file` : ""}.` : `Type-check: skipped, ${typecheck.detail}.`,
    "",
    "How to work through this list:",
    "",
    "1. Fix the \"Will not build\" tasks first: until they're gone the app doesn't type-check or run, so what behaves differently can't be seen.",
    "2. Files are in dependency order: a hook or module comes before the files that import it. Fix it first; what its callers need follows from what it returns.",
    "3. Each task quotes the converted line, with the codemod's `// solid:` note above it when there is one: what the codemod decided there. Keep a note accurate, or delete it once its spot is done.",
    "4. Keep each edit to its spot. Type errors under a task are in the code it flags (its line, or the class, component or effect it spans); an \"unflagged\" task is a type error outside any flagged code.",
    "5. Re-verify with the commands at the end. The type-checker, the linter and the tests, not this list, decide what is done.",
  ];
  if (global.length) out.push("", "Type-check errors outside any file:", "", ...global.map((e) => `- ${e.code}: ${e.message}`));

  for (const file of files) {
    out.push("", `## \`${file}\``, "");
    const tasks = [
      ...flags.filter((f) => f.file === file).map((f) => ({ line: f.line, flag: f })),
      ...[...new Set(unflagged.filter((e) => e.file === file).map((e) => e.line))].map((line) => ({ line, flag: null })),
    ].sort((a, b) => a.line - b.line);
    // Several flags on a line: the line is quoted with the first.
    const quoted = new Set();
    for (const { line, flag } of tasks) {
      const first = !quoted.has(line);
      quoted.add(line);
      const here = flag ? errors.filter((e) => flagOf.get(e) === flag) : unflagged.filter((e) => e.file === file && e.line === line);
      const kind = flag ? KINDS[flag.kind] ?? OTHER : null;
      const where = line > 0 ? `${file}:${line}` : file;
      out.push(flag ? `- [ ] \`${where}\` **${flag.kind}**: ${kind.severity}` : `- [ ] \`${where}\` **type error** (unflagged): ${BUILD}`);
      const code = first ? [flag?.note, flag ? flag.excerpt : here[0]?.excerpt].filter(Boolean) : [];
      if (code.length) out.push("  ```tsx", ...code.map((text) => `  ${text}`), "  ```");
      const located = here.map((e) => `  - \`${e.line}:${e.column}\` ${e.code}: ${e.message}`);
      if (flag) {
        out.push(`  Flag: ${flag.detail}`, `  Do: ${kind.do}`);
        if (located.length) out.push("  Type errors in this code:", ...located);
        out.push(`  Guide: ${GUIDE}#${kind.guide}`);
      } else {
        out.push(...located, `  Do: No flag covers this line. ${[...new Set(here.map((e) => ADVICE[e.code] ?? UNKNOWN))].join(" ")}`, `  Guide: ${GUIDE}#quick-checklist-start-here`);
      }
    }
  }

  out.push("", "## Re-verify", "", "```sh", ...commands, "```", "");
  return out.join("\n");
}
