import { expect, it } from "vitest";
import { parse, Lang } from "@ast-grep/napi";
import { transform } from "../src/rules/mechanical.mjs";
import { extract } from "../src/reactivity/extract.mjs";
import { decide } from "../src/reactivity/decide.mjs";
import { rewrite } from "../src/reactivity/rewrite.mjs";
import { applyContracts } from "../src/reactivity/contracts.mjs";
import { PORTS } from "../src/manifests.mjs";

const run = (code) => transform(code, { parse, Lang });
const convert = (code) => run(code).code;
// compare without caring about whitespace
const flat = (code) => convert(code).replace(/\s+/g, " ").trim();

it("R7 keys a <For> by the field React used as its key, reading the item through its accessor", () => {
  const code = `function List({ rows }) { return <ul>{rows.map((row) => <li key={row.id}>{row.name}</li>)}</ul>; }`;
  expect(flat(code)).toContain(`<For each={props.rows} keyed={(row) => row.id}>{(row) => <li>{row().name}</li>}</For>`);
});

it("R7 keys a <For> by index when React keyed by index: the index is a number, the item an accessor", () => {
  const code = `function List({ rows }) { return <ul>{rows.map((row, i) => <li key={i}>{i}: {row}</li>)}</ul>; }`;
  expect(flat(code)).toContain(`<For each={props.rows} keyed={false}>{(row, i) => <li>{i}: {row()}</li>}</For>`);
});

it("R7 reads the index as an accessor when the list is keyed by item", () => {
  const code = `function List({ rows }) { return <ul>{rows.map((row, i) => <li key={row}>{i + 1}</li>)}</ul>; }`;
  expect(flat(code)).toContain(`{(row, i) => <li>{i() + 1}</li>}`);
});

it("R11 turns a guard that returns early into <Show> with the guard's value as fallback", () => {
  const code = `function Dot({ text }) { if (!text) return <span />; return <b>{text}</b>; }`;
  expect(flat(code)).toContain(`<Show when={props.text} fallback={<span />}>`);
});

it("R11 narrows the guarded value through Show's callback", () => {
  const code = `function Dot(props: { text?: string }) { if (!props.text) return null; return <b title={props.text}>{props.text}</b>; }`;
  expect(flat(code)).toContain(`<Show when={props.text}>{(text) => <b title={text()}>{text()}</b>}</Show>`);
});

it("R11 turns several guards into <Switch>/<Match>", () => {
  const code = `function S(props: { a: boolean; b: boolean }) { if (props.a) return <i />; if (props.b) return <u />; return <b />; }`;
  expect(flat(code)).toContain(`<Switch fallback={<b />}> <Match when={props.a}><i /></Match> <Match when={props.b}><u /></Match> </Switch>`);
});

it("R11 flags a guard instead of converting it when work runs between it and the final return", () => {
  const { flags } = run(`function S(props: { a: boolean }) { if (props.a) return null; const x = compute(props); return <b>{x}</b>; }`);
  expect(flags.map((f) => f.kind)).toContain("early return");
});

it.each([
  ["intrinsic elements", `<div tabindex={props.tabindex} />`],
  ["prop types", `interface RowProps { tabindex?: number }`],
  ["owned components", `<Label for="x" />`],
])("R12 renames DOM props on %s", (_where, expected) => {
  const code = `function Row(props: RowProps) { return <div tabIndex={props.tabIndex} />; }\ninterface RowProps { tabIndex?: number }\nconst el = <Label htmlFor="x" />;`;
  expect(flat(code)).toContain(expected);
});

it("R13 switches a text input's onChange to onInput and reads the value from currentTarget", () => {
  expect(flat(`const el = <input value={v} onChange={(e) => set(e.target.value)} />;`)).toContain(`onInput={(e) => set(e.currentTarget.value)}`);
});

it("R13 keeps onChange on a checkbox", () => {
  expect(convert(`const el = <input type="checkbox" onChange={(e) => set(e.target.checked)} />;`)).toContain("onChange=");
});

it("R14 turns a render element into a render function that spreads the part's props and merges class", () => {
  const code = `import { cn } from "~/lib/utils";\nconst el = <TooltipTrigger render={<button className="x" />} />;`;
  expect(flat(code)).toContain(`render={(triggerProps) => <button {...triggerProps} class={cn(triggerProps.class, "x")} />}`);
});

it("R15 keeps literal defaults literal in merge()", () => {
  const code = `function B({ variant = "default", ...rest }: P) { return <b data-v={variant} {...rest} />; }`;
  expect(convert(code)).toContain(`merge({ variant: "default" as const }, props)`);
});

it("R16 writes boolean aria attributes as strings", () => {
  const code = `const el = <div aria-hidden aria-busy={busy || undefined} aria-invalid={Boolean(err)} />;`;
  expect(flat(code)).toContain(`<div aria-hidden="true" aria-busy={busy ? "true" : undefined} aria-invalid={err ? "true" : "false"} />`);
});

it("R17 writes SVG presentation attributes in kebab case", () => {
  expect(convert(`const el = <path strokeWidth="2" strokeLinecap="round" />;`)).toContain(`<path stroke-width="2" stroke-linecap="round" />`);
});

it.each([
  [`type A = React.ComponentPropsWithoutRef<"div"> & React.RefAttributes<HTMLDivElement>;`, `type A = ComponentProps<"div">;`],
  [`type B = React.CSSProperties;`, `type B = JSX.CSSProperties;`],
  [`type C = React.ComponentType<{ a: string }>;`, `type C = Component<{ a: string }>;`],
  [`type D = React.RefObject<HTMLElement | null>;`, `type D = { current: HTMLElement | null };`],
  [`const f = (e: React.KeyboardEvent<HTMLInputElement>) => e.key;`, `(e: KeyboardEvent & { currentTarget: HTMLInputElement }) => e.key`],
  [`import type { Dispatch, SetStateAction } from "react";\ntype P = { set: Dispatch<SetStateAction<number>> };`, `set: Setter<number>`],
])("R18 maps React's type %s to Solid's", (code, expected) => {
  expect(flat(code)).toContain(expected);
});

it("R19 runs a lazy useState initializer once, untracked", () => {
  const code = `function C() { const [v, setV] = useState(() => read()); return <b onClick={() => setV(1)}>{v}</b>; }`;
  expect(convert(code)).toContain(`createSignal(untrack(() => read()))`);
});

it("R19 makes state that is never set a plain const", () => {
  expect(flat(`function C() { const [v] = useState(() => read()); return <b>{v}</b>; }`)).toContain(`const v = untrack(() => read());`);
});

it.each([
  ["use(Context) to useContext", `useContext(ThemeContext)`],
  ["useEffectEvent(fn) to fn", `const go = () => ping();`],
  ["flushSync(fn) to the call and flush()", `setOpen(true); flush();`],
])("R20 maps %s", (_what, expected) => {
  const code = `function C() { const ctx = use(ThemeContext); const go = useEffectEvent(() => ping()); const f = () => { flushSync(() => setOpen(true)); }; return null; }`;
  expect(flat(code)).toContain(expected);
});

it("R21 turns useReducer into a signal and a dispatch that runs the reducer", () => {
  const code = `function C() { const [n, dispatch] = useReducer(reducer, 0); return <b onClick={() => dispatch(1)}>{n}</b>; }`;
  expect(flat(code)).toContain(`const [n, setN] = createSignal<Parameters<typeof reducer>[0]>(0); const dispatch = (action: Parameters<typeof reducer>[1]) => setN((previous) => reducer(previous, action));`);
});

it("R21 calls an inline init function in parentheses", () => {
  const code = `function C() { const [n, dispatch] = useReducer(reducer, null, () => start()); return <b onClick={() => dispatch(1)}>{n}</b>; }`;
  expect(flat(code)).toContain(`createSignal<Parameters<typeof reducer>[0]>(untrack(() => (() => start())(null)))`);
});

it("R22 remounts an element keyed outside a list with a keyed <Show>", () => {
  expect(flat(`function C(props: { id: string }) { return <Form key={props.id} />; }`)).toContain(`<Show when={[props.id]} keyed>{(_key) => <Form />}</Show>`);
});

it("R23 turns values derived in a <For> callback into accessors, reading a narrowed value once", () => {
  const code = `function L(props: { rows: Row[] }) { return <ul>{props.rows.map((row) => { const s = status(row); const label = s ? s.text : "none"; return <li>{label}</li>; })}</ul>; }`;
  expect(flat(code)).toContain(`const s = () => (status(row)); const label = () => { const sValue = s(); return sValue ? sValue.text : "none"; }; return <li>{label()}</li>;`);
});

it("R24 keeps a hook's result as an object instead of destructuring it once", () => {
  const code = `function C() { const { environment, scope } = useSettingsScope(); return <b>{environment.name}{scope}</b>; }`;
  expect(flat(code)).toContain(`const settingsScope = useSettingsScope(); return <b>{settingsScope.environment.name}{settingsScope.scope}</b>;`);
});

it("R25 calls a library hook's accessor where the compiler pass said to", () => {
  const code = `function C() {\n  // solid: canEdit: accessor (useAtomValue hands back an accessor: read it as \`canEdit()\`)\n  const canEdit = useAtomValue(canEditAtom);\n  return <button disabled={!canEdit} />;\n}`;
  expect(convert(code)).toContain(`disabled={!canEdit()}`);
});

it("R25 also calls the accessor when the compiler bailed and the note says it came from the AST", () => {
  const code = `function C() {\n  // solid: threadId: accessor (useChat hands back an accessor: read it as \`threadId()\` (AST fallback: no compiler output))\n  const threadId = useChat((s) => s.threadId);\n  useEffect(() => { open(threadId); }, [threadId]);\n  return <b>{threadId}</b>;\n}`;
  const { code: out, flags } = run(code);
  expect(out).toContain(`createEffect(() => threadId(), (threadId) => { open(threadId); });`);
  expect(out).toContain(`<b>{threadId()}</b>`);
  expect(flags.filter((f) => f.kind === "effect dep")).toEqual([]);
});

it("R43 flags each zustand store once, where it's created, with the bridge its converted callers expect", () => {
  const { flags } = run(`import { create } from "zustand";\nimport { persist } from "zustand/middleware";\n\nexport const useChat = create<ChatState>()(persist((set) => ({ threadId: null, setThreadId: (id) => set({ threadId: id }) }), { name: "chat" }));\nconst useUi = create((set) => ({ tab: "a" }));\nfunction C() { const local = create(() => ({})); return null; }\n`);
  const stores = flags.filter((f) => f.kind === "zustand store");
  expect(stores.map((f) => [f.line, f.detail.split(" ")[0]])).toEqual([[4, "useChat"], [5, "useUi"]]);
  expect(stores[0].detail).toContain("export const useChat = Object.assign((selector) => { const initial = selector(store.getState()); if (typeof initial === \"function\") return initial; const [value, setValue] = createSignal(initial, { ownedWrite: true }); onCleanup(store.subscribe((state) => setValue(() => selector(state)))); return value; }, store)");
});

it("R43 leaves a create that isn't zustand's alone", () => {
  expect(run(`import { create } from "./store";\nexport const useX = create(() => ({}));\n`).flags).toEqual([]);
});

it("R5 leaves a hook's `return state` as the accessor, which its callers call", () => {
  expect(flat(`export function useDebounced(value) { const [d, setD] = useState(value); const [n] = useState(0); const doubled = useMemo(() => d * 2, [d]); return d; }\nexport const useDoubled = (value) => { const [d, setD] = useState(value); const doubled = useMemo(() => d * 2, [d]); return doubled; };`))
    .toContain(`const doubled = createMemo(() => d() * 2); return d; } export const useDoubled = (value) => { const [d, setD] = createSignal(value); const doubled = createMemo(() => d() * 2); return doubled; };`);
  // A component's (or a nested function's) return still reads the value.
  expect(flat(`function C() { const [d, setD] = useState(1); const f = () => { return d; }; return <p>{f()}</p>; }`)).toContain(`const f = () => { return d(); };`);
});

it("R26 reads renamed and function-expression props through props", () => {
  const code = `const Row = function Row({ mixed: mixedOverride, title }: P) { return <b data-m={mixedOverride}>{title}</b>; };`;
  expect(flat(code)).toContain(`function Row(props: P) { return <b data-m={props.mixed}>{props.title}</b>; }`);
});

it("R27 turns a DOM-only useRef into a let and a ref callback", () => {
  const code = `function C() { const box = useRef<HTMLDivElement>(null); const f = () => box.current?.focus(); return <div ref={box} onClick={f} />; }`;
  expect(flat(code)).toContain(`let box: HTMLDivElement | null = null; const f = () => box?.focus(); return <div ref={(element) => (box = element)} onClick={f} />;`);
});

it("R27 makes a ref object passed on a plain { current } object: the body runs once, so that is what useRef was", () => {
  const code = `import { useRef } from "react";\nfunction C() { const r = useRef<HTMLDivElement>(null); useThing(r); return <div ref={r} />; }`;
  const { code: out, flags } = run(code);
  expect(out).toBe(`function C() { const r: { current: HTMLDivElement | null } = { current: null }; useThing(r); return <div ref={(element) => (r.current = element)} />; }`);
  expect(flags.map((f) => f.kind)).toEqual(["custom hook call"]);
});

it("R27 flags a ref written while the component renders: it keeps the first value now", () => {
  const code = `import { useRef } from "react";\nfunction C({ data }) {\n  const latest = useRef(data);\n  latest.current = data;\n  return <button onClick={() => send(latest.current)} />;\n}`;
  const { code: out, flags } = run(code);
  expect(out).toContain(`const latest = { current: props.data };\n  latest.current = props.data;`);
  expect(flags.filter((f) => f.kind === "ref")).toEqual([{ kind: "ref", line: 4, detail: expect.stringMatching(/^latest\.current is written while the component renders/) }]);
});

it("R28 passes TanStack Query options as a function", () => {
  const code = `import { useQuery } from "@tanstack/react-query";\nfunction C() { const q = useQuery(trpc.list.queryOptions({ page: 1 })); return null; }`;
  expect(convert(code)).toContain(`useQuery(() => trpc.list.queryOptions({ page: 1 }))`);
});

it("R29 turns a let chosen by if/else into a <Show>, with branch values as accessors", () => {
  const code = `function C(props: { a: boolean; n: number }) { let el; if (props.a) { const d = props.n * 2; el = <i>{d}</i>; } else { el = <u />; } return <b>{el}</b>; }`;
  expect(flat(code)).toContain(`const d = () => (props.n * 2); const el = ( <Show when={props.a} fallback={<u />}> <i>{d()}</i> </Show> );`);
});

it("R30 hands a guarded accessor to its JSX through <Show>, so TypeScript can narrow it", () => {
  const code = `function C() { const s = createMemo(() => find()); return <div>{s() && <Dot color={s().color} />}</div>; }`;
  expect(flat(code)).toContain(`<Show when={s()}>{(s) => <Dot color={s().color} />}</Show>`);
});

it("R31 moves a value type off a const the compiler turned into an accessor", () => {
  expect(convert(`const t: "a" | "b" = () => (x ? "a" : "b");`)).toContain(`const t = (): "a" | "b" => (x ? "a" : "b");`);
});

it("R32 hands useRender its props and render as getters and returns the element accessor", () => {
  const code = `function Label(props: P) { const others = omit(props, "class"); return useRender({ defaultTagName: "label", props: mergeProps<"label">({ className: "l" }, others), render: props.render }); }`;
  expect(flat(code)).toContain(`const element = useRender({ defaultTagName: "label", get props() { return mergeProps<"label">({ class: "l" }, others); }, get render() { return props.render; } }); return element();`);
});

it("R33 applies a memo the compiler pass decided but did not write", () => {
  const code = `function Input(props: P) {\n  // solid: cls: memo (React scope @1)\n  const cls = cn("a", props.size);\n  return <input class={cls} />;\n}`;
  expect(flat(code)).toContain(`const cls = createMemo(() => cn("a", props.size)); return <input class={cls()} />;`);
});

it("R33 keeps an object literal an expression when it wraps it in a memo", () => {
  const code = `function E(props: P) {\n  // solid: attrs: memo (React scope @1)\n  const attrs = { role: "textbox", title: props.t };\n  return <div {...attrs} />;\n}`;
  expect(flat(code)).toContain(`createMemo(() => ({ role: "textbox", title: props.t }))`);
});

it("R34 passes a DOM event where React code read nativeEvent", () => {
  expect(convert(`const f = (event) => handle(event.nativeEvent);`)).toContain(`handle(event)`);
});

it("leaves a value used as a JSX tag name uncalled, since <x().Icon> is not valid JSX", () => {
  const code = `function A(props: { k: string }) { const alert = MAP[props.k]; if (!alert) return null; return <alert.Icon title={alert.label} />; }`;
  expect(convert(code)).toContain(`<alert.Icon`);
});

it("a loop variable that shadows a signal is not read as the signal", () => {
  const code = `function C() { const [size, setSize] = useState(0); const out = []; for (const size of [1, 2]) out.push(size); return <p onClick={() => setSize(1)}>{size}</p>; }`;
  expect(convert(code)).toContain("for (const size of [1, 2]) out.push(size);");
});

it("a catch parameter that shadows a destructured prop is not read as the prop", () => {
  const code = `function C({ error, onError }) { const go = () => { try { run(); } catch (error) { onError(error); } }; return <p onClick={go}>{error}</p>; }`;
  expect(convert(code)).toContain("catch (error) { props.onError(error); }");
});

it("a const in a nested block that shadows a destructured prop is not read as the prop", () => {
  const code = `function C({ name }) { const pick = () => { const name = "x"; return name; }; return <p onClick={pick}>{name}</p>; }`;
  expect(convert(code)).toContain(`const name = "x"; return name;`);
});

it("adds the Solid imports the rewrites use", () => {
  const code = `import { useState } from "react";\nfunction C(props: { a?: string }) { const [v] = useState(() => 1); if (!props.a) return null; return <b>{v}</b>; }`;
  expect(convert(code)).toContain(`import { Show, untrack } from "solid-js";`);
});

it("R10 replaces React imports written without semicolons", () => {
  const out = convert(`import { useState } from 'react'\nimport './App.css'\n\nfunction App() {\n  const [count, setCount] = useState(0)\n  return <b>{count}</b>\n}\n`);
  expect(out).not.toContain("from 'react'");
  expect(out).toContain("import './App.css'");
});

it("R10 doesn't count a name in another module's semicolon-less import as a use", () => {
  const out = convert(`import { merge } from 'lodash'\nimport { useState } from 'react'\nexport const x = 1\n`);
  expect(out).not.toContain(`from "solid-js"`);
});

it("R35 turns createRoot(el).render(<StrictMode><App /></StrictMode>) into render(() => <App />, el)", () => {
  const out = convert(`import { StrictMode } from 'react'\nimport { createRoot } from 'react-dom/client'\nimport App from './App.tsx'\n\ncreateRoot(document.getElementById('root')!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n)\n`);
  expect(out).toContain(`import { render } from "@solidjs/web";`);
  expect(out).toContain(`render(() => <App />, document.getElementById('root')!)`);
  expect(out).not.toMatch(/react-dom|StrictMode|from 'react'/);
});

it("R35 leaves createRoot alone when it isn't followed by render", () => {
  const out = convert(`import { createRoot } from 'react-dom/client'\nconst root = createRoot(el)\nroot.render(<App />)\n`);
  expect(out).toContain("createRoot(el)");
  expect(out).toContain("from 'react-dom/client'");
});

it("R36 makes a provider's inline value read reactive state through getters", () => {
  const out = flat(`import { createContext, useState } from "react";\nconst ThemeContext = createContext({ dark: false, toggle: () => {} });\nexport function ThemeProvider({ children }) {\n  const [dark, setDark] = useState(false);\n  const toggle = () => setDark(!dark);\n  return <ThemeContext.Provider value={{ dark, toggle, mode: "x" }}>{children}</ThemeContext.Provider>;\n}\n`);
  expect(out).toContain(`<ThemeContext value={{ get dark() { return dark(); }, toggle, mode: "x" }}>`);
});

it("R36 leaves value props on other components alone", () => {
  expect(flat(`const el = <Select value={{ id: pick() }} />;`)).toContain(`value={{ id: pick() }}`);
});

it("R37 turns <Suspense> into Solid 2's <Loading>, imported from solid-js", () => {
  const out = convert(`import { Suspense } from "react";\nexport function A() {\n  return <Suspense fallback={<p>…</p>}><B /></Suspense>;\n}\n`);
  expect(out).toContain(`<Loading fallback={<p>…</p>}><B /></Loading>`);
  expect(out).toMatch(/import \{[^}]*\bLoading\b[^}]*\} from "solid-js";/);
});

it("R37 keeps lazy, from solid-js, and turns useId() into createUniqueId()", () => {
  const out = convert(`import React, { lazy, useId } from "react";\nconst Page = React.lazy(() => import("./Page"));\nconst Other = lazy(() => import("./Other"));\nexport function A() {\n  const id = useId();\n  return <label for={id}><Page /><Other /></label>;\n}\n`);
  expect(out).toContain(`const Page = lazy(() => import("./Page"));`);
  expect(out).toContain(`const id = createUniqueId();`);
  expect(out).toMatch(/import \{[^}]*\blazy\b[^}]*\} from "solid-js";/);
  expect(out).toMatch(/import \{[^}]*\bcreateUniqueId\b[^}]*\} from "solid-js";/);
});

it("R37 turns a <Fragment> into <>, after R22 moves its key to a keyed <Show>", () => {
  const out = convert(`import { Fragment } from "react";\nexport function A(props) {\n  return <div><Fragment><i /><b /></Fragment><Fragment key={props.k}><u /></Fragment></div>;\n}\n`);
  expect(out).toContain(`<div><><i /><b /></><Show when={[props.k]} keyed>{(_key) => <><u /></>}</Show></div>`);
  expect(out).not.toContain("Fragment");
});

it("R37 leaves a Suspense that doesn't come from react alone", () => {
  expect(convert(`import { Suspense } from "./mine";\nexport const a = <Suspense />;\n`)).toContain(`<Suspense />`);
});

it("R10 flags a React import it drops while the code still uses it", () => {
  const { flags } = run(`import { Children, useState } from "react";\nexport function A(props) {\n  const [n] = useState(Children.count(props.children));\n  return <b>{n}</b>;\n}\n`);
  expect(flags).toContainEqual(expect.objectContaining({ kind: "React API", detail: expect.stringContaining("Children") }));
});

it("R10 doesn't import a Solid name the file declares itself", () => {
  const out = convert(`import { useState } from "react";\nfunction Switch(props) { return <i />; }\nexport function A() {\n  const [on] = useState(false);\n  return <Switch on={on} />;\n}\n`);
  expect(out).not.toMatch(/import \{[^}]*\bSwitch\b[^}]*\} from "solid-js";/);
});

it("R10 flags a clash when the conversion uses a Solid name the file declares", () => {
  const { code, flags } = run(`import { flushSync } from "react-dom";\nconst flush = () => {};\nexport function f(set) {\n  flushSync(() => set(1));\n}\n`);
  expect(code).not.toMatch(/import \{[^}]*\bflush\b[^}]*\} from "solid-js";/);
  expect(flags.map((f) => f.kind)).toContain("name clash");
});

it("R38 writes inline style keys as CSS names and gives numbers React's px", () => {
  const { code, flags } = run(`export function A(props) {\n  return <div style={{ backgroundColor: "red", marginTop: 4, opacity: 0.5, zIndex: 2, WebkitLineClamp: 2, "--gap": "1px", width: props.w, color: props.c }} />;\n}\n`);
  expect(code.replace(/\s+/g, " ")).toContain(`style={{ "background-color": "red", "margin-top": "4px", opacity: 0.5, "z-index": 2, "-webkit-line-clamp": 2, "--gap": "1px", width: props.w, color: props.c }}`);
  expect(flags.filter((f) => f.kind === "style number").map((f) => f.detail)).toEqual([expect.stringContaining('"width"'), expect.stringContaining('"color"')]);
});

it("R38 leaves style props on components alone", () => {
  expect(convert(`export const a = <Box style={{ marginTop: 4 }} />;`)).toContain(`style={{ marginTop: 4 }}`);
});

it("R10 doesn't flag a React event type that becomes the DOM's once its import is gone", () => {
  const { flags } = run(`import { type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";\nexport function f(e: KeyboardEvent, m: ReactMouseEvent) { return [e.key, m.button]; }\n`);
  const details = flags.filter((f) => f.kind === "React API").map((f) => f.detail);
  expect(details).toEqual([expect.stringContaining("ReactMouseEvent")]);
});

it("R39 notes and flags an error boundary class as Solid 2's <Errored>", () => {
  const { code, flags } = run(`import { Component, type ErrorInfo, type ReactNode } from "react";\n\nexport class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {\n  state = { error: null };\n  static getDerivedStateFromError(error: Error) { return { error }; }\n  componentDidCatch(error: Error, info: ErrorInfo) { console.error(error, info); }\n  render() { return this.state.error ? <p>Failed</p> : this.props.children; }\n}\n`);
  expect(code).toMatch(/^\/\/ solid: class component: Boundary is an error boundary .*<Errored fallback=\{\(err, reset\) => \.\.\.\}>.*\nexport class Boundary extends Component</m);
  expect(flags).toContainEqual({ kind: "class component", line: 4, detail: expect.stringContaining("<Errored") });
});

it("R39 maps a class component's lifecycle methods in its note, indented with the class", () => {
  const { code, flags } = run(`import * as React from "react";\nexport function make() {\n  class Ticker extends React.PureComponent<{ n: number }> {\n    componentDidMount() { this.setState({ t: 1 }); }\n    componentDidUpdate() {}\n    componentWillUnmount() {}\n    render() { return <span>{this.props.n}</span>; }\n  }\n  return Ticker;\n}\n`);
  expect(code).toContain(`  // solid: class component: Ticker is a class component and Solid has none: rewrite it as a function component (this.state/setState -> createSignal; componentDidMount -> onSettled; componentDidUpdate -> createEffect(compute, apply), split by what it compares; componentWillUnmount -> onCleanup)\n  class Ticker extends React.PureComponent`);
  expect(flags.map((f) => f.kind)).toContain("class component");
});

it("R39 doesn't import Solid's Component type or the APIs its note names", () => {
  const { code, flags } = run(`import { Component } from "react";\nexport class Plain extends Component<{ a: string }> {\n  componentDidMount() {}\n  render() { return <b>{this.props.a}</b>; }\n}\n`);
  expect(code).not.toContain(`from "solid-js"`);
  expect(flags).toContainEqual(expect.objectContaining({ kind: "React API", detail: expect.stringContaining("Component was imported from react") }));
});

it("R42 turns a class with only render() into a function component reading props", () => {
  const { code, flags, applied } = run(`import { Component } from "react";\n\ntype Props = { name: string; className?: string };\n\nexport default class Greeting extends Component<Props> {\n  render() {\n    return <p className={this.props.className}>Hi {this.props.name}</p>;\n  }\n}\n`);
  // R12 renames the className prop, in its type too.
  expect(code).toBe(`\ntype Props = { name: string; class?: string };\n\nexport default function Greeting(props: Props) {\n  return <p class={props.class}>Hi {props.name}</p>;\n}\n`);
  expect(flags).toEqual([]);
  expect(applied["class component -> function component"]).toBe(1);
});

it("R42 turns static defaultProps into merge, and keeps render's return type", () => {
  const code = convert(`import * as React from "react";\nexport class Badge extends React.PureComponent<{ tone?: "info" | "warn"; children?: React.ReactNode }> {\n  static defaultProps = { tone: "info" };\n  render(): React.ReactNode { return <span data-tone={this.props.tone}>{this.props.children}</span>; }\n}\n`);
  expect(code).toBe(`import { merge } from "solid-js";\nimport type { JSX } from "@solidjs/web";\nexport function Badge(props: { tone?: "info" | "warn"; children?: JSX.Element }): JSX.Element {\n  const merged = merge({ tone: "info" as const }, props);\n  return <span data-tone={merged.tone}>{merged.children}</span>;\n}\n`);
});

it("R42 moves `const { ... } = this.props` into the parameter, where R8 converts it like any destructured props", () => {
  const code = convert(`import { Component } from "react";\nclass Row extends Component<{ label: string; size?: number }> {\n  render() {\n    const { label, size = 2 } = this.props;\n    return <td colSpan={size}>{label}</td>;\n  }\n}\n`);
  expect(code).toContain(`function Row(props: { label: string; size?: number }) {\n  const merged = merge({ size: 2 as const }, props);\n  return <td colspan={merged.size}>{merged.label}</td>;\n}`);
});

it("R42 reads this.props in a nested arrow, which keeps render's this", () => {
  expect(flat(`import { Component } from "react";\nclass L extends Component<{ items: string[]; onPick: (s: string) => void }> {\n  render() { return <button onClick={() => this.props.onPick(this.props.items[0])} />; }\n}\n`)).toContain(`function L(props: { items: string[]; onPick: (s: string) => void }) { return <button onClick={() => props.onPick(props.items[0])} />; }`);
});

it.each([
  ["state", `state = { n: 0 };\n  render() { return <b>{this.state.n}</b>; }`],
  ["a lifecycle method", `componentDidMount() { ping(); }\n  render() { return <b>{this.props.a}</b>; }`],
  ["an instance field", `label = "x";\n  render() { return <b>{this.label}</b>; }`],
  ["a method render calls through this", `format() { return "x"; }\n  render() { return <b>{this.format()}</b>; }`],
  ["this in a nested function, which isn't the component's", `render() { return <b onClick={function () { log(this.props.a); }} />; }`],
  ["a value computed above the return, which Solid would read once", `render() { const up = this.props.a.toUpperCase(); return <b>{up}</b>; }`],
  ["destructured props and defaultProps together", `static defaultProps = { a: "x" };\n  render() { const { a } = this.props; return <b>{a}</b>; }`],
  ["a static other than defaultProps", `static contextType = Ctx;\n  render() { return <b>{this.props.a}</b>; }`],
  ["a body that has a name of its own called props", `render() { return <b>{[this.props.a].map((props) => props)}</b>; }`],
])("R42 leaves a class with %s to R39's flag", (_shape, body) => {
  const { code, flags } = run(`import { Component } from "react";\nexport class K extends Component<{ a: string }> {\n  ${body}\n}\n`);
  expect(code).toContain("// solid: class component: K is a class component and Solid has none");
  expect(code).toContain("export class K extends Component");
  expect(flags.map((f) => f.kind)).toContain("class component");
});

it("R42 leaves a class whose defaultProps are assigned after it to R39's flag", () => {
  const { code } = run(`import { Component } from "react";\nclass K extends Component<{ a?: string }> {\n  render() { return <b>{this.props.a}</b>; }\n}\nK.defaultProps = { a: "x" };\n`);
  expect(code).toContain("class K extends Component");
});

it("R39 leaves classes that don't extend React's Component alone", () => {
  const { code, flags } = run(`import { Component } from "./mine";\nclass A extends Component<{}> {}\nclass B extends Error {}\n`);
  expect(code).not.toContain("// solid:");
  expect(flags).toEqual([]);
});

it("an async component is flagged as a server component, and its props and body are left alone", () => {
  const code = `export default async function Page({ searchParams }) {\n  const { q } = await searchParams;\n  if (!q) return null;\n  return <div className="results">{q}</div>;\n}\nconst Side = async ({ id }) => <aside>{id}</aside>;\n`;
  const { code: out, flags } = run(code);
  expect(out).toBe(code.replace(`className="results"`, `class="results"`));
  expect(flags.filter((f) => f.kind === "server component")).toEqual([
    { kind: "server component", line: 1, detail: expect.stringMatching(/^Page is async, a React Server Component, and a Solid component can't be async.*async createMemo/) },
    { kind: "server component", line: 6, detail: expect.stringMatching(/^Side is async/) },
  ]);
});

it("R40 flags each Next.js import once, naming what to use from Solid 2's router and web packages", () => {
  const { code, flags } = run(`import type { Metadata } from "next";\nimport Link from "next/link";\nimport { useRouter, usePathname as path, notFound } from "next/navigation";\nimport Image from "next/image";\nimport dynamic from "next/dynamic";\nimport { cookies } from "next/headers";\nimport { GeistSans } from "geist/font/sans";\nexport const metadata: Metadata = {};\n`);
  expect(code).toContain(`import Link from "next/link";`);
  expect(flags.filter((f) => f.kind === "Next.js").map((f) => [f.line, f.detail])).toEqual([
    [1, "Metadata from next: Metadata and generateMetadata -> useHead from @solidjs/web"],
    [2, "Link from next/link: @solidjs/router has no link component: use <a href>, which the router intercepts"],
    [3, "useRouter, usePathname as path, notFound from next/navigation: useRouter -> useNavigate() (router.push(p) -> navigate(p)); usePathname as path -> useLocation().pathname; notFound -> a catch-all *404 route, with httpStatus(404) from @solidjs/web (from @solidjs/router unless noted)"],
    [4, `Image from next/image: use <img> with width, height and loading="lazy"`],
    [5, "dynamic from next/dynamic: use lazy from solid-js, rendered under <Loading>"],
    [6, `cookies from next/headers: server-only: read it in a server function ("use server") in start mode`],
  ]);
});

it("removing a key that had its own line removes the line", () => {
  const code = `function L(props) {\n  return (\n    <ul>\n      {props.rows.map((row) => (\n        <li\n          key={row.id}\n          class="row"\n        >\n          {row.name}\n        </li>\n      ))}\n    </ul>\n  );\n}\n`;
  expect(convert(code)).toContain(`{(row) => (\n        <li\n          class="row"\n        >`);
  expect(convert(`const el = <li\n  key="a"\n/>;`)).toBe(`const el = <li\n/>;`);
});

it("R24 gives each destructured result of the same hook its own object", () => {
  const out = flat(`function C() { const { data: jobs } = useQuery(a); const { data: counts } = useQuery(b); return <p>{jobs}{counts}</p>; }`);
  expect(out).toContain(`const query = useQuery(a); const query2 = useQuery(b); return <p>{query.data}{query2.data}</p>;`);
});

const effectFlags = (code) => run(code).flags.filter((f) => f.kind === "effect" || f.kind === "effect read");

it("R41 turns useEffect(fn, [dep]) into createEffect(compute, apply), handing apply the dep it reads", () => {
  const code = `import { useEffect } from "react";\nfunction Clock({ tickMs }: { tickMs: number }) {\n  useEffect(() => {\n    const id = setInterval(tick, tickMs);\n    return () => clearInterval(id);\n  }, [tickMs]);\n  return null;\n}\n`;
  const { code: out, flags } = run(code);
  expect(out).toBe(`import { createEffect } from "solid-js";\nfunction Clock(props: { tickMs: number }) {\n  createEffect(() => props.tickMs, (tickMs) => {\n    const id = setInterval(tick, tickMs);\n    return () => clearInterval(id);\n  });\n  return null;\n}\n`);
  expect(flags).toEqual([]);
});

it("R41 hands several deps to apply as one object, and tracks the ones it doesn't read", () => {
  const code = `function C({ user }) { const [open, setOpen] = useState(false); const [n, setN] = useState(0); useEffect(() => { log(open, user.id); }, [open, n, user.id]); return null; }`;
  expect(flat(code)).toContain(`createEffect(() => ({ open: open(), n: n(), id: props.user.id }), ({ open, id }) => { log(open, id); });`);
  expect(effectFlags(code)).toEqual([]);
});

it("R41 keeps the deps array as compute when apply reads none of them", () => {
  const code = `function C() { const [a, setA] = useState(0); const [b, setB] = useState(0); useEffect(() => { ping(); }, [a, b]); return null; }`;
  expect(flat(code)).toContain(`createEffect(() => [a(), b()], () => { ping(); });`);
});

it("R41 turns useEffect(fn, []) into onSettled(fn), cleanup and all", () => {
  const code = `function C() {\n  useEffect(() => {\n    window.addEventListener("resize", onResize);\n    return () => window.removeEventListener("resize", onResize);\n  }, []);\n  return null;\n}\n`;
  expect(convert(code)).toBe(`import { onSettled } from "solid-js";\nfunction C() {\n  onSettled(() => {\n    window.addEventListener("resize", onResize);\n    return () => window.removeEventListener("resize", onResize);\n  });\n  return null;\n}\n`);
});

it("R41 converts useLayoutEffect the same way: Solid's effect runs after the DOM update, before paint", () => {
  const code = `function C() { const [w, setW] = useState(0); useLayoutEffect(() => { measure(w); }, [w]); useLayoutEffect(() => { focus(); }, []); return null; }`;
  expect(flat(code)).toContain(`createEffect(() => w(), (w) => { measure(w); }); onSettled(() => { focus(); });`);
});

it("R41 gives a setter call a block body: a setter returns its value, and Solid only takes a function as a cleanup", () => {
  const code = `function C({ id }) { const [x, setX] = useState(0); useEffect(() => setX(0), [id]); useEffect(() => setX(1), []); return null; }`;
  expect(flat(code)).toContain(`createEffect(() => props.id, () => { setX(0); }); onSettled(() => { setX(1); });`);
});

it("R41 keeps an expression body that may return a cleanup", () => {
  expect(flat(`function C({ id }) { useEffect(() => subscribe(id), [id]); return null; }`)).toContain(`createEffect(() => props.id, (id) => subscribe(id));`);
});

it("R41 converts setState in apply, including a write to the effect's own dep", () => {
  const code = `function C() { const [count, setCount] = useState(0); useEffect(() => { if (count < 3) setCount(count + 1); }, [count]); return null; }`;
  expect(flat(code)).toContain(`createEffect(() => count(), (count) => { if (count < 3) setCount(count + 1); });`);
});

it("R41 reads deps through the parameter in nested functions too, so a cleanup sees its own run's value", () => {
  const code = `function C() { const [room, setRoom] = useState("a"); useEffect(() => { const c = connect(room); c.on("msg", () => show(room)); return () => c.leave(room); }, [room]); return null; }`;
  expect(flat(code)).toContain(`createEffect(() => room(), (room) => { const c = connect(room); c.on("msg", () => show(room)); return () => c.leave(room); });`);
});

it("R41 renames a parameter that would shadow a name the body uses", () => {
  const code = `function C({ id }) { useEffect(() => { const id2 = 1; load(id, id2); }, [id]); return null; }`;
  expect(flat(code)).toContain(`createEffect(() => props.id, (id) => {`);
  const clash = `function C({ user }) { const id = "x"; useEffect(() => { load(user.id, id); }, [user.id]); return null; }`;
  expect(flat(clash)).toContain(`createEffect(() => props.user.id, (idValue) => { load(idValue, id); });`);
});

it("R41 flags a signal or prop read in apply that isn't a dep", () => {
  const code = `function C({ a, b }) { const [n, setN] = useState(0); useEffect(() => { log(a, b, n); props.onChange(a); }, [a]); return null; }`;
  expect(flat(code)).toContain(`createEffect(() => props.a, (a) => {`);
  expect(effectFlags(code)).toEqual([{ kind: "effect read", line: 1, detail: expect.stringMatching(/^props\.b, n\(\) are read in the effect but not in its deps: Solid warns \(STRICT_READ_UNTRACKED\)/) }]);
});

it.each([
  ["no deps array", `useEffect(() => { document.title = String(n); });`, /^no deps array: it ran after every render/],
  ["deps that aren't an array literal", `useEffect(() => { ping(); }, deps);`, /^props\.deps: the deps aren't an array literal/],
  ["a spread in the deps", `useEffect(() => { ping(); }, [...deps]);`, /^\[\.\.\.props\.deps\]: the deps aren't an array literal/],
  ["a ref in the deps", `useEffect(() => { ping(); }, [other.current]);`, /^\[props\.other\.current\]: props\.other\.current is a ref/],
  ["a ref the ref rule made a let", `useEffect(() => { el.current?.focus(); }, [el.current]);`, /^\[el\]: el is a ref/],
  ["an async callback", `useEffect(async () => { await load(); }, [n]);`, /an async callback returns a promise/],
  ["a callback that isn't inline", `useEffect(handler, [n]);`, /the callback isn't an inline function/],
  ["an effect inside a callback", `const f = () => { if (n) { useEffect(() => {}, [n]); } };`, /not at the top of a component or hook body/],
])("R41 flags %s instead of converting it", (_shape, effect, detail) => {
  const code = `function C({ other, deps, handler }) { const [n, setN] = useState(0); const el = useRef(null); ${effect} return <div ref={el} />; }`;
  const { code: out, flags } = run(code);
  expect(out).not.toMatch(/createEffect|onSettled/);
  expect(flags.filter((f) => f.kind === "effect")).toEqual([{ kind: "effect", line: 1, detail: expect.stringMatching(detail) }]);
});

it("R41 converts effects in a custom hook the same way", () => {
  const code = `export function useWidth(el) { const [w, setW] = useState(0); useEffect(() => { const o = new ResizeObserver(() => setW(el.offsetWidth)); o.observe(el); return () => o.disconnect(); }, [el]); return w; }`;
  expect(flat(code)).toContain(`createEffect(() => el, () => { const o = new ResizeObserver(() => setW(el.offsetWidth));`);
});

it("R41 leaves an effect in an async component alone, flagged", () => {
  const code = `async function Page() { useEffect(() => { ping(); }, []); return <div />; }`;
  const { code: out, flags } = run(code);
  expect(out).toContain(`useEffect(() => { ping(); }, []);`);
  expect(flags.map((f) => f.kind)).toEqual(["effect", "server component"]);
});

it("R41 doesn't flag a dep read in the component body: it moves into compute", () => {
  const { flags } = run(`function C() { const [n, setN] = useState(0); useEffect(() => { ping(); }, [n]); return null; }`);
  expect(flags).toEqual([]);
});

it("R41 flags only the deps that changed in React: a library hook result stable in React too is noted static and tracked silently", () => {
  const code = `import { useForm } from "react-hook-form";\nimport { useRouter, usePathname } from "next/navigation";\nimport { useStore } from "./store";\nfunction C({ id }) {\n  const form = useForm();\n  const router = useRouter();\n  const pathname = usePathname();\n  const reset = useStore((s) => s.reset);\n  const count = useStore((s) => s.count);\n  useEffect(() => { form.reset({ id }); router.refresh(); reset(); log(pathname, count); }, [form, router, id, reset, pathname, count]);\n  return <p />;\n}\n`;
  const store = `import { create } from "zustand";\nexport const useStore = create((set) => ({ count: 0, reset: () => set({ count: 0 }) }));\n`;
  const results = [decide(extract(code, "/repo/apps/web/src/C.tsx")), decide(extract(store, "/repo/apps/web/src/store.ts"))];
  applyContracts(results);
  const { code: out, flags } = run(rewrite(code, results[0]).code);
  expect(flags.filter((f) => f.kind === "effect dep")).toEqual([{ kind: "effect dep", line: expect.any(Number), detail: expect.stringMatching(/^pathname is a plain value here/) }]);
  // State selected from the store is tracked as an accessor; its action is called as it is.
  expect(out).toMatch(/createEffect\(\(\) => \(\{ form, router, id: props\.id, reset, pathname, count: count\(\) \}\), \(\{ id, count \}\) => \{ form\.reset\(\{ id: id \}\); router\.refresh\(\); reset\(\); log\(pathname, count\); \}\);/);
});

it("R41 flags a dep that is a plain value or a hook result: tracking it never re-runs the effect", () => {
  const code = `function C() {\n  const pathname = usePathname();\n  const [debounced] = useDebounce(q);\n  const label = format(x);\n  const save = () => post();\n  const [page, setPage] = useQueryState("p");\n  // solid: client: static (useQueryClient hands back a stable value)\n  const client = useQueryClient();\n  useEffect(() => { track(pathname, debounced, label); save(); setPage(1); client.clear(); }, [pathname, debounced, label, save, setPage, client]);\n  return null;\n}`;
  expect(flat(code)).toContain(`createEffect(() => [pathname, debounced, label, save, setPage, client], () => {`);
  expect(run(code).flags.filter((f) => f.kind === "effect dep")).toEqual([{ kind: "effect dep", line: 9, detail: expect.stringMatching(/^pathname, debounced, label are plain values here \(the component body runs once\), so tracking them never re-runs the effect/) }]);
});

it.each([
  ["imported by name", `import { useMemo, useState } from "react";\n`, "useMemo", "useState"],
  ["through the React namespace", `import * as React from "react";\n`, "React.useMemo", "React.useState"],
])("R6 reads a useMemo %s once: the compiler pass and the rule don't both add the call", (_how, imports, useMemo, useState) => {
  const code = `${imports}export function A({ items }: { items: string[] }) {\n  const [n, setN] = ${useState}(0);\n  const label = ${useMemo}(() => (items.length === 0 ? null : \`\${items.length} items\`), [items]);\n  return <p onClick={() => setN(n + 1)}>{label ? <span>{label}</span> : null}{n}</p>;\n}\n`;
  const results = [decide(extract(code, "/repo/apps/web/src/A.tsx"))];
  applyContracts(results);
  const out = run(rewrite(code, results[0]).code).code;
  expect(out).toContain("{label() ? <span>{label()}</span> : null}");
  expect(out).not.toContain("label()()");
});

it("R4 converts a useCallback inside a memo'd component", () => {
  const code = `import { memo, useCallback, useState } from "react";\nexport const Panel = memo(function Panel() {\n  const [open, setOpen] = useState<Record<string, boolean>>({});\n  const toggle = useCallback((k: string) => {\n    setOpen((prev) => ({ ...prev, [k]: !prev[k] }));\n  }, []);\n  return <Row onToggle={toggle} />;\n});\n`;
  const out = convert(code);
  expect(out).toContain(`export const Panel = function Panel() {`);
  expect(out).toContain(`const toggle = (k: string) => {\n    setOpen((prev) => ({ ...prev, [k]: !prev[k] }));\n  };`);
  expect(out).not.toContain("useCallback");
});

it("R6 makes a useMemo that isn't assigned, such as a hook's return, a createMemo", () => {
  const code = `import { useMemo, useState } from "react";\nexport function usePair() {\n  const [a, setA] = useState(0);\n  return useMemo(() => ({ a, setA }), [a]);\n}\n`;
  expect(convert(code)).toContain(`return createMemo(() => ({ a: a(), setA }));`);
});

it("R9 converts FC from a default-and-named react import, and imports Component when it has no type arguments", () => {
  const code = `import React, { type FC, type ComponentType } from "react";\nexport const Note: FC<{ text: string }> = (props) => <p>{props.text}</p>;\nexport type Slot = { render?: ComponentType };\n`;
  const out = convert(code);
  expect(out).toContain(`import type { Component } from "solid-js";`);
  expect(out).toContain(`export const Note: Component<{ text: string }> = (props) => <p>{props.text}</p>;`);
  expect(out).toContain(`export type Slot = { render?: Component };`);
});

it("R9 converts PropsWithChildren to ParentProps and ElementType to ValidComponent, with their imports", () => {
  const code = `import type * as React from "react";\nexport function Box(props: React.PropsWithChildren<{ as?: React.ElementType }>) { return <div>{props.children}</div>; }\n`;
  const out = convert(code);
  expect(out).toContain(`export function Box(props: ParentProps<{ as?: ValidComponent }>)`);
  expect(out).toContain(`import type { ParentProps } from "solid-js";`);
  expect(out).toContain(`import type { ValidComponent } from "@solidjs/web";`);
});

it("R37 reads React.createContext and React.useContext as Solid's", () => {
  const code = `import * as React from "react";\nconst Ctx = React.createContext<string | null>(null);\nexport function useCtx() { return React.useContext(Ctx); }\n`;
  const { code: out, flags } = run(code);
  expect(out).toContain(`import { createContext, useContext } from "solid-js";\nconst Ctx = createContext<string | null>(null);\nexport function useCtx() { return useContext(Ctx); }`);
  expect(flags.map((f) => f.kind)).not.toContain("React namespace");
});

it("R10 flags a React hook left without its import where it's used, with what to use, and not as a custom hook", () => {
  const code = `import { useState, useTransition } from "react";\nexport function Save() {\n  const [n, setN] = useState(0);\n  const [pending, start] = useTransition();\n  return <button onClick={() => start(() => setN(n + 1))}>{String(pending)}</button>;\n}\n`;
  const { flags } = run(code);
  expect(flags.filter((f) => f.kind !== "render-dependent read")).toEqual([{ kind: "React API", line: 4, detail: expect.stringMatching(/^useTransition was imported from react and has no conversion here; its import was removed\. Solid 2 has no transition to start/) }]);
});

it("R10 flags each name still imported from react-dom", () => {
  const code = `import { hydrateRoot } from "react-dom/client";\nhydrateRoot(document.body, <App />);\n`;
  expect(run(code).flags).toEqual([{ kind: "React API", line: 2, detail: "hydrateRoot from react-dom/client: @solidjs/web replaces react-dom. use hydrate(() => <App />, element) from @solidjs/web" }]);
});

it("R10 adds to the file's own solid-js import instead of importing a name twice", () => {
  const code = `import { createEffect } from "solid-js";\nimport { useState } from "react";\nexport function C() {\n  const [n, setN] = useState(0);\n  createEffect(() => n(), () => {});\n  return <p onClick={() => setN(1)}>{n()}</p>;\n}\n`;
  const out = convert(code);
  expect(out).toContain(`import { createEffect, createSignal } from "solid-js";`);
  expect(out.match(/from "solid-js"/g)).toHaveLength(1);
});

it("R10 leaves a file already converted to Solid as it is", () => {
  const code = `import { createSignal, Show } from "solid-js";\nexport function C() {\n  const [n, setN] = createSignal(0);\n  return <Show when={n()}><p onClick={() => setN(1)}>{n()}</p></Show>;\n}\n`;
  expect(convert(code)).toBe(code);
});

const ported = (code, names) => transform(code, { parse, Lang, ports: Object.fromEntries(names.map((name) => [name, PORTS[name]])) });

it("R44 imports lucide icons and their types from @lucide/solid", () => {
  const code = `import { Check, ChevronDownIcon as Chevron } from "lucide-react";\nimport type { LucideIcon, LucideProps } from "lucide-react";\nexport const icons: LucideIcon[] = [Check, Chevron];\n`;
  const { code: out, flags } = ported(code, ["lucide-react"]);
  expect(out).toBe(`import { Check, ChevronDownIcon as Chevron } from "@lucide/solid";\nimport type { LucideIcon, LucideProps } from "@lucide/solid";\nexport const icons: LucideIcon[] = [Check, Chevron];\n`);
  expect(flags).toEqual([]);
});

it("R44 imports TanStack Query from @tanstack/solid-query and flags what it doesn't export, with what to use", () => {
  const code = `import { QueryClientProvider, useQuery, useSuspenseQuery } from "@tanstack/react-query";\nexport { useMutation } from "@tanstack/react-query";\n`;
  const { code: out, flags } = ported(code, ["@tanstack/react-query"]);
  expect(out).toBe(`import { QueryClientProvider, useQuery, useSuspenseQuery } from "@tanstack/solid-query";\nexport { useMutation } from "@tanstack/solid-query";\n`);
  expect(flags).toEqual([{ kind: "ported library", line: 1, detail: "useSuspenseQuery from @tanstack/solid-query: use useQuery: reading its data suspends under <Loading>, which is what useSuspenseQuery did" }]);
});

it("R44 leaves a library alone when the project doesn't move it to its port, and flags a subpath when it does", () => {
  const code = `import { Check } from "lucide-react";\nimport { DynamicIcon } from "lucide-react/dynamic";\n`;
  expect(run(code).code).toBe(code);
  expect(ported(code, ["lucide-react"]).flags).toEqual([{ kind: "ported library", line: 2, detail: "lucide-react/dynamic is a subpath of lucide-react, whose imports now come from @lucide/solid: find its counterpart there" }]);
});

it("R45 turns createPortal into <Portal mount>", () => {
  const code = `import { createPortal } from "react-dom";\nexport function Modal(props: { open: boolean }) {\n  return <div>{props.open && createPortal(<dialog open />, document.body)}{createPortal(<p />, document.body)}</div>;\n}\n`;
  const out = convert(code);
  expect(out).toBe(`import { Portal } from "@solidjs/web";\nexport function Modal(props: { open: boolean }) {\n  return <div>{props.open && <Portal mount={document.body}><dialog open /></Portal>}<Portal mount={document.body}><p /></Portal></div>;\n}\n`);
});

it("R8 makes a prop used as a JSX tag a component with dynamic()", () => {
  const code = `export function Item({ icon: Icon, label }: { icon: Comp; label: string }) {\n  return <li><Icon class="size-4" />{label}</li>;\n}\n`;
  const out = convert(code);
  expect(out).toContain(`import { dynamic } from "@solidjs/web";`);
  expect(out).toContain(`export function Item(props: { icon: Comp; label: string }) {\n  const Icon = dynamic(() => props.icon);\n  return <li><Icon class="size-4" />{props.label}</li>;`);
});

it("R8 flags a prop used as a JSX tag in a file with a dynamic of its own", () => {
  const code = `import dynamic from "next/dynamic";\nconst Chart = dynamic(() => import("./chart"));\nexport function Item({ icon: Icon }: { icon: Comp }) {\n  return <Icon />;\n}\n`;
  const { code: out, flags } = run(code);
  expect(out).not.toContain("const Icon =");
  expect(flags.filter((f) => f.kind === "prop as tag")).toEqual([{ kind: "prop as tag", line: 3, detail: "<Icon> renders the icon prop: write const Icon = dynamic(() => props.icon) with dynamic from @solidjs/web (this file has a dynamic of its own)" }]);
});

it("R8 makes a default that reads another prop a getter over props", () => {
  const code = `export function Toolbar({ isMarkdown, limit = 10, showRefresh = !isMarkdown, rows = limit }: P) {\n  return <p>{showRefresh}{rows}</p>;\n}\n`;
  expect(convert(code)).toContain(`const merged = merge({ limit: 10 as const, get showRefresh() { return !props.isMarkdown; }, get rows() { return (props.limit ?? 10); } }, props);`);
});

it("R8 reads a default that reads another default through that one, in parentheses", () => {
  const code = "export function Chip({ label, labelPrefix, ariaLabel = labelPrefix ? `${labelPrefix}${label}` : label, title = ariaLabel }: P) {\n  return <b aria-label={ariaLabel} title={title} />;\n}\n";
  expect(convert(code)).toContain("const merged = merge({ get ariaLabel() { return props.labelPrefix ? `${props.labelPrefix}${props.label}` : props.label; }, get title() { return (props.ariaLabel ?? (props.labelPrefix ? `${props.labelPrefix}${props.label}` : props.label)); } }, props);");
});

it("R8 applies an empty [] or {} default where the prop is read, so merge doesn't type it never[]", () => {
  const code = `export function Tags({ tags = [], meta = {}, size = "sm" }: P) {\n  return <ul data-size={size}>{tags.length}{meta.x}</ul>;\n}\n`;
  const out = convert(code);
  expect(out).toContain(`const merged = merge({ size: "sm" as const }, props);`);
  expect(out).toContain(`<ul data-size={merged.size}>{(merged.tags ?? []).length}{(merged.meta ?? {}).x}</ul>`);
});

it("R31 makes a hook's return type Accessor<T> when it now returns an accessor", () => {
  const code = `export function useLabel(n: number): string | undefined {\n  // solid: return: memo (React scope @1)\n  return createMemo(() => (n ? String(n) : undefined));\n}\nexport function useCount(): number {\n  const [count, setCount] = createSignal(0);\n  return count;\n}\nexport function useName(): string {\n  return "x";\n}\n`;
  const out = convert(code);
  expect(out).toContain(`import type { Accessor } from "solid-js";`);
  expect(out).toContain(`export function useLabel(n: number): Accessor<string | undefined> {`);
  expect(out).toContain(`export function useCount(): Accessor<number> {`);
  expect(out).toContain(`export function useName(): string {`);
});

it("R1 renames React's other camelCase HTML attributes the way Solid's JSX types spell them, on intrinsic elements only", () => {
  const code = `const el = <><iframe frameBorder="0" allowFullScreen /><img crossOrigin="anonymous" srcSet={s} /><meta httpEquiv="refresh" /><Frame frameBorder="0" /></>;`;
  expect(convert(code)).toBe(`const el = <><iframe frameborder="0" allowfullscreen /><img crossorigin="anonymous" srcset={s} /><meta http-equiv="refresh" /><Frame frameBorder="0" /></>;`);
});

it("R1 drops suppressHydrationWarning, which only React reads", () => {
  expect(convert(`const el = <html lang="en" suppressHydrationWarning><body /></html>;`)).toBe(`const el = <html lang="en"><body /></html>;`);
});

it("R30 hands a guarded field of an accessor to <Show>'s callback, and a ternary's other branch becomes the fallback", () => {
  const code = `const el = <div>{node().icon ? <AgentIcon name={node().icon} /> : <Dot />}{user() ? <b>{user().name}</b> : <i>guest</i>}</div>;`;
  expect(convert(code)).toBe(`import { Show } from "solid-js";\nconst el = <div><Show when={node().icon} fallback={<Dot />}>{(icon) => <AgentIcon name={icon()} />}</Show><Show when={user()} fallback={<i>guest</i>}>{(user) => <b>{user().name}</b>}</Show></div>;`);
});

it("R30 names the callback's parameter apart from a name the branch already uses", () => {
  const code = `const el = <div>{item().label && <Tag label={item().label} other={label} />}</div>;`;
  expect(convert(code)).toBe(`import { Show } from "solid-js";\nconst el = <div><Show when={item().label}>{(labelValue) => <Tag label={labelValue()} other={label} />}</Show></div>;`);
});

it("R10 drops the React Compiler's directives, and doesn't take them for uses of memo", () => {
  const code = `import { memo, useState } from "react";\nexport function C() {\n  "use no memo";\n  const [n, setN] = useState(0);\n  return <p onClick={() => setN(1)}>{n}</p>;\n}\nexport const D = memo(C);\n`;
  const { code: out, flags } = run(code);
  expect(out).not.toContain("use no memo");
  expect(flags.filter((f) => f.kind === "React API")).toEqual([]);
});

it("R10 doesn't take JSX.CSSProperties for a use of React's CSSProperties", () => {
  const code = `import type { CSSProperties } from "react";\nexport function C(props: { style: CSSProperties }) { return <p style={props.style} />; }\n`;
  const { code: out, flags } = run(code);
  expect(out).toContain(`props: { style: JSX.CSSProperties }`);
  expect(flags).toEqual([]);
});

it("R8 rewrites a prop read as what a for...of iterates, and as a nested function's parameter default", () => {
  const code = `function C({ items = [], value }: P) {\n  const seen = new Set();\n  for (const item of items) seen.add(item);\n  function snapshot(query = value, value2 = 1) { return query + value2; }\n  return <p onClick={() => snapshot()}>{seen.size}</p>;\n}\n`;
  const out = convert(code);
  expect(out).toContain(`for (const item of (props.items ?? [])) seen.add(item);`);
  expect(out).toContain(`function snapshot(query = props.value, value2 = 1) {`);
});

it("R8 leaves a nested function's parameter of the same name alone", () => {
  const code = `function C({ value }: P) {\n  const f = (value = 2) => value;\n  return <p>{f()}{value}</p>;\n}\n`;
  expect(convert(code)).toContain(`const f = (value = 2) => value;\n  return <p>{f()}{props.value}</p>;`);
});

const tested = (code) => ported(code, ["@testing-library/react"]);

it("R46 renders a function of the element, and leaves a function as it is", () => {
  const code = `import { render } from "@testing-library/react";\nrender(<App />);\nrender(() => <App />);\nrender(makeApp(), { wrapper: Providers });\n`;
  const { code: out, flags } = tested(code);
  expect(out).toBe(`import { render } from "@solidjs/testing-library";\nrender(() => <App />);\nrender(() => <App />);\nrender(() => makeApp(), { wrapper: Providers });\n`);
  expect(flags).toEqual([]);
});

it("R46 flags an element made before render runs, React-only render options and asFragment", () => {
  const code = `import { render } from "@testing-library/react";\nexport const renderWith = (ui: JSX.Element) => render(ui, { reactStrictMode: true });\nconst { asFragment } = render(<App />);\n`;
  const { code: out, flags } = tested(code);
  expect(out).toContain(`render(() => ui, { reactStrictMode: true })`);
  expect(flags.map((f) => [f.kind, f.line, f.detail.slice(0, 40)])).toEqual([
    ["render", 2, "reactStrictMode: React-only render optio"],
    ["render", 2, "ui is an element made before render() ru"],
    ["render", 3, "asFragment() returns the container's inn"],
  ]);
});

it("R46 runs act's callback body, one level less indented, then flush(), and drops act from the import", () => {
  const code = `import { act, render } from "@testing-library/react";\nit("x", () => {\n  act(() => {\n    button.click();\n    if (open) {\n      close();\n    }\n  });\n  act(() => vi.advanceTimersByTime(100));\n});\n`;
  const { code: out, flags } = tested(code);
  expect(out).toBe(`import { flush } from "solid-js";\nimport { render } from "@solidjs/testing-library";\nit("x", () => {\n  button.click();\n  if (open) {\n    close();\n  }\n  flush();\n  vi.advanceTimersByTime(100);\n  flush();\n});\n`);
  expect(flags).toEqual([]);
});

it("R46 keeps an awaited act's awaits, and awaits what an awaited act's callback returns", () => {
  const code = `import { act } from "@testing-library/react";\nit("x", async () => {\n  await act(async () => {\n    await user.click(button);\n  });\n  await act(() => promise);\n});\n`;
  expect(tested(code).code).toBe(`import { flush } from "solid-js";\nit("x", async () => {\n  await user.click(button);\n  flush();\n  await promise;\n  flush();\n});\n`);
});

it("R46 keeps act's callback a block when it declares a name", () => {
  const code = `import { act } from "@testing-library/react";\nit("x", () => {\n  act(() => {\n    const next = 2;\n    set(next);\n  });\n});\n`;
  expect(tested(code).code).toContain(`  {\n    const next = 2;\n    set(next);\n  }\n  flush();\n`);
});

it("R46 flags an act it can't inline, and keeps its import", () => {
  const code = `import { act } from "@testing-library/react";\nit("x", () => {\n  const p = act(async () => load());\n});\n`;
  const { code: out, flags } = tested(code);
  expect(out).toContain(`import { act } from "@solidjs/testing-library";`);
  expect(flags.map((f) => [f.kind, f.line])).toEqual([["act", 3], ["ported library", 1]]);
});

it("R46 converts React 19's act from react, and doesn't flag it as a React API", () => {
  const code = `import { act } from "react";\nit("x", () => {\n  act(() => {\n    store.set(1);\n  });\n});\n`;
  const { code: out, flags } = run(code);
  expect(out).toBe(`import { flush } from "solid-js";\nit("x", () => {\n  store.set(1);\n  flush();\n});\n`);
  expect(flags).toEqual([]);
});

it("R46 flushes after each fireEvent statement, once", () => {
  const code = `import { fireEvent } from "@testing-library/react";\nit("x", () => {\n  fireEvent.click(button);\n  fireEvent(input, new Event("input"));\n  fireEvent.keyDown(input, { key: "Enter" });\n  flush();\n});\n`;
  expect(tested(code).code).toBe(`import { flush } from "solid-js";\nimport { fireEvent } from "@solidjs/testing-library";\nit("x", () => {\n  fireEvent.click(button);\n  flush();\n  fireEvent(input, new Event("input"));\n  flush();\n  fireEvent.keyDown(input, { key: "Enter" });\n  flush();\n});\n`);
});

it("R46 turns a rerender with new literal props into a signal per prop that changes, set before a flush()", () => {
  const code = `import { render, screen } from "@testing-library/react";\nit("x", () => {\n  const { rerender, container } = render(<Badge label="new" count={1} tone="info" />);\n  rerender(<Badge label="new" count={2} tone="info" />);\n  rerender(<Badge label="old" count={2} tone="info" />);\n});\n`;
  const { code: out, flags } = tested(code);
  expect(out).toBe(`import { createSignal, flush } from "solid-js";\nimport type { ComponentProps } from "@solidjs/web";\nimport { render, screen } from "@solidjs/testing-library";\nit("x", () => {\n  const [label, setLabel] = createSignal<ComponentProps<typeof Badge>["label"]>("new");\n  const [count, setCount] = createSignal<ComponentProps<typeof Badge>["count"]>(1);\n  const { container } = render(() => <Badge label={label()} count={count()} tone="info" />);\n  setCount(2);\n  flush();\n  setLabel("old");\n  flush();\n});\n`);
  expect(flags).toEqual([]);
});

it("R46 drops the destructuring when rerender was all it took, names the signal apart from the file's names, and adds a prop the first render didn't pass", () => {
  const code = `import { render } from "@testing-library/react";\nconst open = true;\nit("x", () => {\n  const { rerender } = render(<details />);\n  rerender(<details open />);\n});\n`;
  expect(tested(code).code).toContain(`  const [open2, setOpen2] = createSignal<ComponentProps<"details">["open"]>(undefined);\n  render(() => <details open={open2()} />);\n  setOpen2(true);\n  flush();\n`);
});

it("R46 flags a rerender that passes a value that isn't a literal, or that isn't destructured", () => {
  const code = `import { render } from "@testing-library/react";\nit("x", () => {\n  const { rerender } = render(<Field onSave={first} />);\n  rerender(<Field onSave={second} />);\n  const view = render(<Field />);\n  view.rerender(<Field disabled />);\n});\n`;
  const { code: out, flags } = tested(code);
  expect(out).toContain(`const { rerender } = render(() => <Field onSave={first} />);\n  rerender(<Field onSave={second} />);`);
  expect(flags.map((f) => [f.kind, f.line])).toEqual([["rerender", 3], ["rerender", 5]]);
});

it("R46 passes renderHook's initialProps as the hook's arguments and reads the hook's value as result", () => {
  const code = `import { renderHook } from "@testing-library/react";\nit("x", () => {\n  const { result, unmount } = renderHook((start: number) => useCounter(start), { initialProps: 10 });\n  result.current.increment();\n  expect(result.current.count).toBe(11);\n  unmount();\n  const hook = renderHook(useToggle, { initialProps });\n  expect(hook.result.current.on).toBe(false);\n  hook.unmount();\n});\n`;
  const { code: out, flags } = tested(code);
  expect(out).toBe(`import { renderHook } from "@solidjs/testing-library";\nit("x", () => {\n  const { result, cleanup: unmount } = renderHook((start: number) => useCounter(start), { initialProps: [10] });\n  result.increment();\n  expect(result.count).toBe(11);\n  unmount();\n  const hook = renderHook(useToggle, { initialProps: [initialProps] });\n  expect(hook.result.on).toBe(false);\n  hook.cleanup();\n});\n`);
  expect(flags).toEqual([]);
});

it("R46 flags a hook's whole value read off result, renderHook's rerender, and options it can't read", () => {
  const code = `import { renderHook } from "@testing-library/react";\nit("x", () => {\n  const { result, rerender } = renderHook(() => useValue());\n  expect(result.current).toBe(1);\n  renderHook(() => useValue(), options);\n});\n`;
  const { code: out, flags } = tested(code);
  expect(out).toContain(`expect(result).toBe(1);`);
  expect(flags.map((f) => [f.kind, f.line])).toEqual([["renderHook", 4], ["rerender", 3], ["renderHook", 5]]);
});

it("R46 converts a component defined in a test like any other, and leaves the tests alone when the project keeps @testing-library/react", () => {
  const code = `import { useState } from "react";\nimport { render } from "@testing-library/react";\nfunction Toggle() {\n  const [on, setOn] = useState(false);\n  return <button className="t" onClick={() => setOn(!on)}>{String(on)}</button>;\n}\nrender(<Toggle />);\n`;
  expect(tested(code).code).toContain(`  const [on, setOn] = createSignal(false);\n  return <button class="t" onClick={() => setOn(!on())}>{String(on())}</button>;\n}\nrender(() => <Toggle />);`);
  expect(run(code).code).toContain(`import { render } from "@testing-library/react";`);
  expect(run(code).code).toContain(`render(<Toggle />);`);
});
