import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { transform } = createRequire(import.meta.url)("../gate/mechanical.js");
const run = (src) => transform(src).code;
// compare without caring about whitespace
const flat = (s) => s.replace(/\s+/g, " ").trim();

describe("React -> Solid 2 codemod", () => {
  it("R7 keys a <For> by the field React used as its key, reading the item through its accessor", () => {
    const out = run(`function List({ rows }) { return <ul>{rows.map((row) => <li key={row.id}>{row.name}</li>)}</ul>; }`);
    expect(flat(out)).toContain(`<For each={props.rows} keyed={(row) => row.id}>{(row) => <li>{row().name}</li>}</For>`);
  });

  it("R7 keys a <For> by index when React keyed by index: the index is a number, the item an accessor", () => {
    const out = run(`function List({ rows }) { return <ul>{rows.map((row, i) => <li key={i}>{i}: {row}</li>)}</ul>; }`);
    expect(flat(out)).toContain(`<For each={props.rows} keyed={false}>{(row, i) => <li>{i}: {row()}</li>}</For>`);
  });

  it("R7 reads the index as an accessor when the list is keyed by item", () => {
    const out = run(`function List({ rows }) { return <ul>{rows.map((row, i) => <li key={row}>{i + 1}</li>)}</ul>; }`);
    expect(flat(out)).toContain(`{(row, i) => <li>{i() + 1}</li>}`);
  });

  it("R11 turns a guard that returns early into <Show> with the guard's value as fallback", () => {
    const out = run(`function Dot({ text }) { if (!text) return <span />; return <b>{text}</b>; }`);
    expect(flat(out)).toContain(`<Show when={props.text} fallback={<span />}>`);
  });

  it("R11 narrows the guarded value through Show's callback", () => {
    const out = run(`function Dot(props: { text?: string }) { if (!props.text) return null; return <b title={props.text}>{props.text}</b>; }`);
    expect(flat(out)).toContain(`<Show when={props.text}>{(text) => <b title={text()}>{text()}</b>}</Show>`);
  });

  it("R11 turns several guards into <Switch>/<Match>", () => {
    const out = run(`function S(props: { a: boolean; b: boolean }) { if (props.a) return <i />; if (props.b) return <u />; return <b />; }`);
    expect(flat(out)).toContain(`<Switch fallback={<b />}> <Match when={props.a}><i /></Match> <Match when={props.b}><u /></Match> </Switch>`);
  });

  it("R11 leaves a guard alone when work runs between it and the final return", () => {
    const { code, flags } = transform(`function S(props: { a: boolean }) { if (props.a) return null; const x = compute(props); return <b>{x}</b>; }`);
    expect(code).not.toContain("<Show");
    expect(flags.map((f) => f.kind)).toContain("early return");
  });

  it("R12 renames DOM props on owned components, their prop types and their props reads", () => {
    const out = run(`function Row(props: RowProps) { return <div tabIndex={props.tabIndex} />; }\ninterface RowProps { tabIndex?: number }\nconst el = <Label htmlFor="x" />;`);
    expect(flat(out)).toContain(`<div tabindex={props.tabindex} />`);
    expect(flat(out)).toContain(`interface RowProps { tabindex?: number }`);
    expect(flat(out)).toContain(`<Label for="x" />`);
  });

  it("R13 switches a text input's onChange to onInput and reads the value from currentTarget", () => {
    const out = run(`const el = <input value={v} onChange={(e) => set(e.target.value)} />;`);
    expect(flat(out)).toContain(`onInput={(e) => set(e.currentTarget.value)}`);
  });

  it("R13 keeps onChange on a checkbox", () => {
    const out = run(`const el = <input type="checkbox" onChange={(e) => set(e.target.checked)} />;`);
    expect(out).toContain("onChange=");
  });

  it("R14 turns a render element into a render function that spreads the part's props and merges class", () => {
    const out = run(`import { cn } from "~/lib/utils";\nconst el = <TooltipTrigger render={<button className="x" />} />;`);
    expect(flat(out)).toContain(`render={(triggerProps) => <button {...triggerProps} class={cn(triggerProps.class, "x")} />}`);
  });

  it("R15 keeps literal defaults literal in merge()", () => {
    const out = run(`function B({ variant = "default", ...rest }: P) { return <b data-v={variant} {...rest} />; }`);
    expect(out).toContain(`merge({ variant: "default" } as const, props)`);
  });

  it("R16 writes boolean aria attributes as strings", () => {
    const out = run(`const el = <div aria-hidden aria-busy={busy || undefined} aria-invalid={Boolean(err)} />;`);
    expect(flat(out)).toContain(`<div aria-hidden="true" aria-busy={busy ? "true" : undefined} aria-invalid={err ? "true" : "false"} />`);
  });

  it("R17 writes SVG presentation attributes in kebab case", () => {
    expect(run(`const el = <path strokeWidth="2" strokeLinecap="round" />;`)).toContain(`<path stroke-width="2" stroke-linecap="round" />`);
  });

  it("R18 maps React's prop and ref types to Solid's", () => {
    const out = run(`type A = React.ComponentPropsWithoutRef<"div"> & React.RefAttributes<HTMLDivElement>;\ntype B = React.CSSProperties;\ntype C = React.ComponentType<{ a: string }>;\ntype D = React.RefObject<HTMLElement | null>;`);
    expect(flat(out)).toContain(`type A = ComponentProps<"div">;`);
    expect(out).toContain(`type B = JSX.CSSProperties;`);
    expect(out).toContain(`type C = Component<{ a: string }>;`);
    expect(out).toContain(`type D = { current: HTMLElement | null };`);
  });

  it("R18 maps React event types to DOM events with a typed currentTarget", () => {
    expect(run(`const f = (e: React.KeyboardEvent<HTMLInputElement>) => e.key;`)).toContain(`(e: KeyboardEvent & { currentTarget: HTMLInputElement }) => e.key`);
  });

  it("R18 maps a state setter type to Setter", () => {
    expect(run(`import type { Dispatch, SetStateAction } from "react";\ntype P = { set: Dispatch<SetStateAction<number>> };`)).toContain(`set: Setter<number>`);
  });

  it("R19 runs a lazy useState initializer once, untracked", () => {
    expect(run(`function C() { const [v, setV] = useState(() => read()); return <b onClick={() => setV(1)}>{v}</b>; }`)).toContain(`createSignal(untrack(() => read()))`);
  });

  it("R19 makes state that is never set a plain const", () => {
    expect(flat(run(`function C() { const [v] = useState(() => read()); return <b>{v}</b>; }`))).toContain(`const v = untrack(() => read());`);
  });

  it("R20 maps use(Context), useEffectEvent and flushSync", () => {
    const out = run(`function C() { const ctx = use(ThemeContext); const go = useEffectEvent(() => ping()); const f = () => { flushSync(() => setOpen(true)); }; return null; }`);
    expect(out).toContain(`useContext(ThemeContext)`);
    expect(out).toContain(`const go = () => ping();`);
    expect(flat(out)).toContain(`setOpen(true); flush();`);
  });

  it("R21 turns useReducer into a signal and a dispatch that runs the reducer", () => {
    const out = flat(run(`function C() { const [n, dispatch] = useReducer(reducer, 0); return <b onClick={() => dispatch(1)}>{n}</b>; }`));
    expect(out).toContain(`const [n, setN] = createSignal<Parameters<typeof reducer>[0]>(0); const dispatch = (action: Parameters<typeof reducer>[1]) => setN((previous) => reducer(previous, action));`);
  });

  it("R22 remounts an element keyed outside a list with a keyed <Show>", () => {
    expect(flat(run(`function C(props: { id: string }) { return <Form key={props.id} />; }`))).toContain(`<Show when={[props.id]} keyed>{(_key) => <Form />}</Show>`);
  });

  it("R23 turns values derived in a <For> callback into accessors, reading a narrowed value once", () => {
    const out = flat(run(`function L(props: { rows: Row[] }) { return <ul>{props.rows.map((row) => { const s = status(row); const label = s ? s.text : "none"; return <li>{label}</li>; })}</ul>; }`));
    expect(out).toContain(`const s = () => (status(row)); const label = () => { const sValue = s(); return sValue ? sValue.text : "none"; }; return <li>{label()}</li>;`);
  });

  it("R24 keeps a hook's result as an object instead of destructuring it once", () => {
    const out = flat(run(`function C() { const { environment, scope } = useSettingsScope(); return <b>{environment.name}{scope}</b>; }`));
    expect(out).toContain(`const settingsScope = useSettingsScope(); return <b>{settingsScope.environment.name}{settingsScope.scope}</b>;`);
  });

  it("R25 calls a library hook's accessor where the compiler pass said to", () => {
    const out = run(`function C() {\n  // solid: canEdit: accessor (useAtomValue hands back an accessor: read it as \`canEdit()\`)\n  const canEdit = useAtomValue(canEditAtom);\n  return <button disabled={!canEdit} />;\n}`);
    expect(out).toContain(`disabled={!canEdit()}`);
  });

  it("R26 reads renamed and function-expression props through props", () => {
    const out = flat(run(`const Row = function Row({ mixed: mixedOverride, title }: P) { return <b data-m={mixedOverride}>{title}</b>; };`));
    expect(out).toContain(`function Row(props: P) { return <b data-m={props.mixed}>{props.title}</b>; }`);
  });

  it("R27 turns a DOM-only useRef into a let and a ref callback", () => {
    const out = flat(run(`function C() { const box = useRef<HTMLDivElement>(null); const f = () => box.current?.focus(); return <div ref={box} onClick={f} />; }`));
    expect(out).toContain(`let box: HTMLDivElement | null = null; const f = () => box?.focus(); return <div ref={(element) => (box = element)} onClick={f} />;`);
  });

  it("R27 keeps useRef when the ref object is passed on", () => {
    expect(run(`function C() { const r = useRef(null); useThing(r); return <div ref={r} />; }`)).toContain(`useRef(null)`);
  });

  it("R28 passes TanStack Query options as a function", () => {
    const out = run(`import { useQuery } from "@tanstack/react-query";\nfunction C() { const q = useQuery(trpc.list.queryOptions({ page: 1 })); return null; }`);
    expect(out).toContain(`useQuery(() => trpc.list.queryOptions({ page: 1 }))`);
  });

  it("R29 turns a let chosen by if/else into a <Show>, with branch values as accessors", () => {
    const out = flat(run(`function C(props: { a: boolean; n: number }) { let el; if (props.a) { const d = props.n * 2; el = <i>{d}</i>; } else { el = <u />; } return <b>{el}</b>; }`));
    expect(out).toContain(`const d = () => (props.n * 2); const el = ( <Show when={props.a} fallback={<u />}> <i>{d()}</i> </Show> );`);
  });

  it("R30 hands a guarded accessor to its JSX through <Show>, so TypeScript can narrow it", () => {
    const out = flat(run(`function C() { const s = createMemo(() => find()); return <div>{s() && <Dot color={s().color} />}</div>; }`));
    expect(out).toContain(`<Show when={s()}>{(s) => <Dot color={s().color} />}</Show>`);
  });

  it("R31 moves a value type off a const the compiler turned into an accessor", () => {
    expect(run(`const t: "a" | "b" = () => (x ? "a" : "b");`)).toContain(`const t = (): "a" | "b" => (x ? "a" : "b");`);
  });

  it("R32 hands useRender its props and render as getters and returns the element accessor", () => {
    const out = flat(run(`function Label(props: P) { const others = omit(props, "class"); return useRender({ defaultTagName: "label", props: mergeProps<"label">({ className: "l" }, others), render: props.render }); }`));
    expect(out).toContain(`const element = useRender({ defaultTagName: "label", get props() { return mergeProps<"label">({ class: "l" }, others); }, get render() { return props.render; } }); return element();`);
  });

  it("R33 applies a memo the compiler pass decided but did not write", () => {
    const out = flat(run(`function Input(props: P) {\n  // solid: cls: memo (React scope @1)\n  const cls = cn("a", props.size);\n  return <input class={cls} />;\n}`));
    expect(out).toContain(`const cls = createMemo(() => cn("a", props.size)); return <input class={cls()} />;`);
  });

  it("R34 passes a DOM event where React code read nativeEvent", () => {
    expect(run(`const f = (event) => handle(event.nativeEvent);`)).toContain(`handle(event)`);
  });

  it("leaves a value used as a JSX tag name uncalled, since <x().Icon> is not valid JSX", () => {
    const out = run(`function A(props: { k: string }) { const alert = MAP[props.k]; if (!alert) return null; return <alert.Icon title={alert.label} />; }`);
    expect(out).toContain(`<alert.Icon`);
  });

  it("does not rewrite a prop's name where a nested const, loop variable or catch shadows it", () => {
    const out = flat(run(`function P({ size }: { size: number }) { const f = () => { const size = 2; return size; }; for (const size of list) use(size); try {} catch (size) { log(size); } return <b>{size}</b>; }`));
    expect(out).toContain(`const size = 2; return size;`);
    expect(out).toContain(`for (const size of list) use(size);`);
    expect(out).toContain(`catch (size) { log(size); }`);
  });

  it("keeps an object literal an expression when the compiler memo wraps it", () => {
    const out = run(`function E(props: P) {\n  // solid: attrs: memo (React scope @1)\n  const attrs = { role: "textbox", title: props.t };\n  return <div {...attrs} />;\n}`);
    expect(flat(out)).toContain(`createMemo(() => ({ role: "textbox", title: props.t }))`);
  });

  it("adds the Solid imports the rewrites use", () => {
    const out = run(`import { useState } from "react";\nfunction C(props: { a?: string }) { const [v] = useState(() => 1); if (!props.a) return null; return <b>{v}</b>; }`);
    expect(out).toContain(`import { Show, untrack } from "solid-js";`);
  });
});
