import { expect, it } from "vitest";
import { parse, Lang } from "@ast-grep/napi";
import { transform } from "../src/rules/mechanical.mjs";

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
  expect(convert(code)).toContain(`merge({ variant: "default" } as const, props)`);
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

it("R26 reads renamed and function-expression props through props", () => {
  const code = `const Row = function Row({ mixed: mixedOverride, title }: P) { return <b data-m={mixedOverride}>{title}</b>; };`;
  expect(flat(code)).toContain(`function Row(props: P) { return <b data-m={props.mixed}>{props.title}</b>; }`);
});

it("R27 turns a DOM-only useRef into a let and a ref callback", () => {
  const code = `function C() { const box = useRef<HTMLDivElement>(null); const f = () => box.current?.focus(); return <div ref={box} onClick={f} />; }`;
  expect(flat(code)).toContain(`let box: HTMLDivElement | null = null; const f = () => box?.focus(); return <div ref={(element) => (box = element)} onClick={f} />;`);
});

it("R27 keeps useRef when the ref object is passed on", () => {
  expect(convert(`function C() { const r = useRef(null); useThing(r); return <div ref={r} />; }`)).toContain(`useRef(null)`);
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

it("R41 flags a dep that is a plain value or a hook result: tracking it never re-runs the effect", () => {
  const code = `function C() {\n  const pathname = usePathname();\n  const [debounced] = useDebounce(q);\n  const label = format(x);\n  const save = () => post();\n  const [page, setPage] = useQueryState("p");\n  // solid: client: static (useQueryClient hands back a stable value)\n  const client = useQueryClient();\n  useEffect(() => { track(pathname, debounced, label); save(); setPage(1); client.clear(); }, [pathname, debounced, label, save, setPage, client]);\n  return null;\n}`;
  expect(flat(code)).toContain(`createEffect(() => [pathname, debounced, label, save, setPage, client], () => {`);
  expect(run(code).flags.filter((f) => f.kind === "effect dep")).toEqual([{ kind: "effect dep", line: 9, detail: expect.stringMatching(/^pathname, debounced, label are plain values here \(the component body runs once\), so tracking them never re-runs the effect/) }]);
});
