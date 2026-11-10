import { describe, expect, it } from "vitest";
import { extract } from "../src/extract.mjs";
import { decide } from "../src/decide.mjs";
import { rewrite } from "../src/rewrite.mjs";
import { applyContracts } from "../src/contracts.mjs";

const run = (code, options) => decide(extract(code, "Fixture.tsx", options));
const valueIn = (code, name) => run(code).functions[0].values.find((v) => v.name === name);

describe("value decisions", () => {
  it.each([
    ["a reactive value with its own React scope becomes createMemo", "memo",
      `function C({ items }) { const sorted = items.toSorted(); return <ul>{sorted.map((i) => <li>{i}</li>)}</ul>; }`],
    ["a reactive primitive the compiler leaves unmemoized becomes an accessor", "accessor",
      `function C({ a, b }) { const sorted = a === b; return <p>{String(sorted)}</p>; }`],
    ["a value with no reactive inputs stays a plain const", "static",
      `function C() { const sorted = [1, 2].join(","); return <p>{sorted}</p>; }`],
    ["JSX used once is inlined", "inline",
      `function C({ a }) { const sorted = <b>{a}</b>; return <p>{sorted}</p>; }`],
    ["JSX used twice becomes a function", "jsx-fn",
      `function C({ a }) { const sorted = <b>{a}</b>; return <p>{sorted}{sorted}</p>; }`],
    ["a value read only in an event handler is read at call time", "call-time",
      `function C({ a }) { const sorted = a.toSorted(); return <button onClick={() => send(sorted)} />; }`],
    ["a context provider value becomes a getter object", "getter-object",
      `function C({ a }) { const sorted = { a }; return <ThemeContext value={sorted} />; }`],
    ["a hook call inside a derivation is flagged", "flag",
      `function C({ a }) { const sorted = f(a, useThing()); return <p>{sorted}</p>; }`],
  ])("%s", (_name, decision, code) => {
    expect(valueIn(code, "sorted").decision).toBe(decision);
  });

  it("when the compiler bails, a value reading a prop is decided from the AST and says so", () => {
    const code = `function C({ a }) { const x = a.b(); try { f(a ? 1 : 2); } catch {} return <p>{x}</p>; }`;
    expect(run(code, { prestep: false }).functions[0].values[0]).toMatchObject({ decision: "memo", why: expect.stringMatching(/AST fallback/) });
  });

  it("when the compiler bails, a value reading only module scope stays static", () => {
    const code = `function C({ a }) { const x = LIMIT * 2; try { f(a ? 1 : 2); } catch {} return <p>{x}</p>; }`;
    expect(run(code, { prestep: false }).functions[0].values[0].decision).toBe("static");
  });
});

it("an effect's compute half is its deps array", () => {
  const code = `function C({ a, b }) { useEffect(() => { log(a); }, [a, b]); return null; }`;
  expect(run(code).functions[0].effects[0].compute).toEqual(["a", "b"]);
});

it("the rewrite wraps a memo and turns its reads into calls", () => {
  const code = `function C({ items }) { const sorted = items.toSorted(); return <ul>{sorted.map((i) => <li>{i}</li>)}</ul>; }`;
  expect(rewrite(code, run(code)).code).toContain("const sorted = createMemo(() => items.toSorted()); return <ul>{sorted().map(");
});

describe("try/catch pre-step", () => {
  const parse = `function C({ q }) { let x; try { x = q ? JSON.parse(q) : null; } catch { x = null; } return <p>{x}</p>; }`;

  it("a component that bails only on value blocks in a try/catch compiles after the pre-step", () => {
    const code = `function C({ a }) { const x = a.b(); try { f(a ? 1 : 2); } catch {} return <p>{x}</p>; }`;
    expect(run(code).functions[0].compiler.status).toBe("compiled");
  });

  it("a let assigned only by the try/catch after it becomes a memo", () => {
    expect(valueIn(parse, "x").decision).toBe("memo");
  });

  it("the rewrite moves the try/catch inside the memo", () => {
    expect(rewrite(parse, run(parse)).code).toMatch(/const x = createMemo\(\(\) => \{\s+let x;\s+try \{/);
  });

  it("a let also assigned outside its try/catch stays flagged", () => {
    const code = `function C({ q }) { let x; try { x = q ? JSON.parse(q) : null; } catch { x = null; } x ??= 1; return <p>{x}</p>; }`;
    expect(valueIn(code, "x").decision).toBe("flag");
  });
});

describe("condition pre-step", () => {
  const code = `function C({ a, b }) { const same = a?.id === b?.id ? "same" : "different"; return <p>{same}</p>; }`;

  it("a component with two optional chains in a ternary test compiles after the pre-step", () => {
    expect(run(code).functions[0].compiler.status).toBe("compiled");
  });

  it("a value whose test was lifted keeps the test's reads as its inputs", () => {
    expect(valueIn(code, "same").compiler.inputs.sort()).toEqual(["a", "b"]);
  });
});

it("when the compiler bails, an array filled by a function called during render is flagged", () => {
  const code = `function C({ tree }) { const out = []; const visit = (n) => { out.push(n); n.kids.forEach(visit); }; visit(tree); try { f(tree ? 1 : 2); } catch {} return <p>{out.length}</p>; }`;
  expect(run(code, { prestep: false }).functions[0].values[0].why).toMatch(/filled after creation by visit/);
});

it("a map filled by a loop during render is flagged, since a memo of the declaration alone would come back empty", () => {
  const code = `function C({ items }) { const byId = new Map(); for (const i of items) { byId.set(i.id, i); } return <p>{byId.size}</p>; }`;
  expect(run(code).functions[0].values[0].why).toBe("mutated during render");
});

describe("hook contracts across files", () => {
  const hookFile = "/repo/apps/web/src/useThing.ts";
  const hook = `export function useThing(items) { const sorted = items.toSorted(); const reset = useStableCallback(() => {}); const count = sorted.length; return { sorted, reset, count }; }
    export function useSorted(items) { const sorted = items.toSorted(); return sorted; }
    export function useReset() { const reset = useRef(null); return reset; }
    export const useCtx = () => useContext(Ctx);
    export function useResolver(items) { const [first, setFirst] = useState(items); return () => first.id; }
    export const useStore = create()((set) => ({ open: false }));`;
  const caller = (body) => `import { useThing, useSorted, useReset, useCtx, useStore, useResolver } from "./useThing";\nfunction C({ items }) { ${body} }`;
  const settle = (body) => {
    const results = [decide(extract(hook, hookFile)), decide(extract(caller(body), "/repo/apps/web/src/C.tsx"))];
    applyContracts(results);
    return results[1].functions[0].values;
  };

  it("a value from a local hook that returns a memo is read as an accessor", () => {
    expect(settle(`const sorted = useSorted(items); return <p>{sorted.length}</p>;`)[0].decision).toBe("accessor");
  });

  it("a value that only reads a local hook's stable result becomes static", () => {
    const values = settle(`const ref = useReset(); const target = ref.current; return <p onClick={() => target} />;`);
    expect(values.find((v) => v.name === "target").decision).toBe("static");
  });

  it("destructuring a local hook's object of getters keeps the object", () => {
    expect(settle(`const { count } = useThing(items); return <p>{count}</p>;`)[0].decision).toBe("getter-read");
  });

  it("an arrow hook that returns its body expression takes that expression's contract", () => {
    expect(settle(`const ctx = useCtx(); return <p>{ctx.open}</p>;`)[0].decision).toBe("getter-object");
  });

  it("calling a hook's returned function during render stays reactive", () => {
    const values = settle(`const resolve = useResolver(items); const id = resolve(); return <p>{id}</p>;`);
    expect(values.find((v) => v.name === "id").decision).not.toBe("static");
  });

  it("state with no setter is static", () => {
    expect(settle(`const [first] = useState(items); return <p>{first}</p>;`)[0].decision).toBe("static");
  });

  it("a router hook called with select hands back an accessor", () => {
    expect(settle(`const hash = useLocation({ select: (l) => l.hash }); return <p>{hash}</p>;`)[0].decision).toBe("accessor");
  });

  it("a store read through a wrapped selector is an accessor, not a stable value", () => {
    expect(settle(`const open = useStore(useShallow((s) => s.open)); return <p>{open}</p>;`)[0].decision).toBe("accessor");
  });
});
