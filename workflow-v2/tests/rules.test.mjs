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
