import { describe, expect, it } from "vitest";
import { extract } from "../src/reactivity/extract.mjs";
import { decide } from "../src/reactivity/decide.mjs";
import { rewrite } from "../src/reactivity/rewrite.mjs";
import { applyContracts } from "../src/reactivity/contracts.mjs";

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

it("a memo that only aliases another memo wraps a call to it, once", () => {
  const code = `function C({ items }) {\n  const sorted = items.toSorted();\n  const shown = sorted;\n  return <ul>{shown.map((i) => <li>{i}</li>)}</ul>;\n}`;
  expect(rewrite(code, run(code)).code).toContain("const shown = createMemo(() => sorted());\n");
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

  it("hands back the files in dependency order: each after the local files it imports, then by path", () => {
    const at = (file, code) => decide(extract(code, `/repo/apps/web/src/${file}`));
    const results = [
      at("App.tsx", `import { Page } from "./pages/Page";\nimport { cn } from "~/lib/cn";\nexport function App() { return <Page class={cn("a")} />; }`),
      at("pages/Page.tsx", `import { useThing } from "../useThing";\nimport { Missing } from "./nowhere";\nimport { clsx } from "clsx";\nexport function Page() { const t = useThing([]); return <p class={clsx("p")}>{t.count}</p>; }`),
      at("useThing.ts", `import { cn } from "./lib/cn";\nexport function useThing(items) { const sorted = items.toSorted(); return { count: sorted.length, cls: cn("x") }; }`),
      at("lib/cn.ts", `export const cn = (...names) => names.join(" ");`),
      at("lib/z-cycle-a.ts", `import { b } from "./z-cycle-b";\nexport const a = () => b;`),
      at("lib/z-cycle-b.ts", `import { a } from "./z-cycle-a";\nexport const b = () => a;`),
    ];
    expect(applyContracts(results).map((file) => file.slice("/repo/apps/web/src/".length))).toEqual(["lib/cn.ts", "useThing.ts", "pages/Page.tsx", "App.tsx", "lib/z-cycle-b.ts", "lib/z-cycle-a.ts"]);
  });

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

  it("a hook that returns an object literal hands back the getters its callers read", () => {
    const source = `export function useFilter(initial) {\n  const [filter, setFilter] = useState(initial);\n  const label = filter === "all" ? "Everything" : "Some";\n  return { filter, setFilter, label };\n}\n`;
    const results = [decide(extract(source, "/repo/apps/web/src/useFilter.ts"))];
    applyContracts(results);
    expect(results[0].functions[0].values.find((v) => v.name === "(return)").decision).toBe("getter-object");
    expect(rewrite(source, results[0]).code).toContain("return { get filter() { return filter; }, get setFilter() { return setFilter; }, get label() { return label(); } };");
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

describe("async components", () => {
  // Trimmed from a Next.js login page.
  const page = `import { env } from "~/env";\n\nexport default async function LoginPage({ searchParams }) {\n  const resolvedParams = await searchParams;\n  const origins = [env.BENCHMARKS_URL, env.PHOENIX_URL].filter(Boolean);\n  return <LoginContent redirect={resolvedParams.redirect} origins={origins} />;\n}\n`;

  it("an async component, a React Server Component, isn't analyzed, so the rewrite leaves it as it is", () => {
    const result = run(page);
    expect(result.functions).toEqual([]);
    expect(rewrite(page, result).code).toBe(page);
  });

  it("an async arrow component and an async hook aren't analyzed either", () => {
    expect(run(`const Page = async ({ id }) => { const data = await load(id); return <p>{data}</p>; };\nasync function useData() { return await load(); }`).functions).toEqual([]);
  });

  it("an await inside a callback doesn't count as awaiting during render", () => {
    expect(valueIn(`function C({ id }) { const save = async () => { await send(id); }; return <button onClick={save} />; }`, "save")).toMatchObject({ awaits: false, decision: "function" });
  });

  it("a value that awaits during render is flagged instead of wrapped in a memo, which can't await", () => {
    const extracted = extract(`function C({ p }) { const v = p.value; return <b>{v}</b>; }`, "Fixture.tsx");
    extracted.functions[0].values[0].awaits = true;
    expect(decide(extracted).functions[0].values[0]).toMatchObject({ decision: "flag", why: expect.stringContaining("awaits during render") });
  });
});

it("Next.js's useRouter isn't TanStack's router hook: the library table, by import source, says its router is stable", () => {
  const contract = (source) => {
    const results = [decide(extract(`import { useRouter } from "${source}";\nfunction C({ id }) { const router = useRouter(); return <p onClick={() => router.push(id)} />; }`, "/repo/apps/web/src/C.tsx"))];
    applyContracts(results);
    return results[0].functions[0].values.find((v) => v.name === "router").contract;
  };
  expect(contract("@tanstack/react-router")).toMatchObject({ kind: "static", builtin: true });
  expect(contract("next/navigation")).toMatchObject({ kind: "static", builtin: false, note: "Next.js's useRouter hands back the same router every render" });
});

describe("library hooks whose result is stable in React too", () => {
  const values = (code) => {
    const results = [decide(extract(code, "/repo/apps/web/src/C.tsx"))];
    applyContracts(results);
    return results[0].functions[0].values;
  };

  it.each([
    ["react-hook-form's useForm", `import { useForm } from "react-hook-form";`, `const form = useForm();`, "form", "useForm hands back the same form object every render; its methods read form state"],
    ["Next.js's useRouter", `import { useRouter } from "next/navigation";`, `const form = useRouter();`, "form", "Next.js's useRouter hands back the same router every render"],
    ["PostHog's usePostHog", `import { usePostHog } from "posthog-js/react";`, `const form = usePostHog();`, "form", "usePostHog hands back the PostHog client, the same every render"],
    ["Lexical's composer context", `import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";`, `const [form] = useLexicalComposerContext();`, "form", "useLexicalComposerContext hands back a stable value"],
    ["TanStack Virtual's useVirtualizer", `import { useVirtualizer } from "@tanstack/react-virtual";`, `const form = useVirtualizer({ count: 1 });`, "form", "useVirtualizer hands back the same virtualizer every render; its methods read its state"],
    ["react-redux's useDispatch", `import { useDispatch } from "react-redux";`, `const form = useDispatch();`, "form", "useDispatch hands back a stable value"],
  ])("%s is static, with a note that says why", (_name, imp, decl, name, why) => {
    const code = `${imp}\nfunction C({ id }) { ${decl} useEffect(() => { form.reset(id); }, [form, id]); return <p />; }`;
    expect(values(code).find((v) => v.name === name)).toMatchObject({ decision: "static", why: expect.stringContaining(why) });
  });

  it("a value computed by calling a stable form's methods during render stays reactive", () => {
    const vs = values(`import { useForm } from "react-hook-form";\nfunction C() { const form = useForm(); const name = form.watch("name"); return <p>{name}</p>; }`);
    expect(vs.find((v) => v.name === "name").decision).not.toBe("static");
  });

  it("the same hook name from another package, or a hook the table leaves out, stays an unknown hook result", () => {
    expect(values(`import { useForm } from "my-forms";\nfunction C() { const form = useForm(); return <p onClick={() => form.reset()} />; }`)[0].decision).toBe("hook");
    // Its value is rebuilt when formState changes.
    expect(values(`import { useFormContext } from "react-hook-form";\nfunction C() { const form = useFormContext(); return <p onClick={() => form.reset()} />; }`)[0].decision).toBe("hook");
  });

  it("rewrite notes a stable library hook result as static, which R41 reads", () => {
    const code = `import { useForm } from "react-hook-form";\nfunction C() {\n  const form = useForm();\n  return <p onClick={() => form.reset()} />;\n}\n`;
    const results = [decide(extract(code, "/repo/apps/web/src/C.tsx"))];
    applyContracts(results);
    expect(rewrite(code, results[0]).code).toContain(`  // solid: form: static (useForm hands back the same form object every render; its methods read form state)\n  const form = useForm();`);
  });
});

it("a useCallback value is a plain function, not a store selector's accessor: its reads aren't turned into calls", () => {
  const code = `import { useCallback } from "react";\nexport function useShare(id) {\n  const share = useCallback(async (opts) => { await post(id, opts); }, [id]);\n  return { share };\n}\n`;
  const results = [decide(extract(code, "/repo/apps/web/src/useShare.ts"))];
  applyContracts(results);
  expect(results[0].functions[0].values.find((v) => v.name === "share")).toMatchObject({ decision: "function", why: "useCallback(fn) becomes fn, a plain function that reads reactive values when called" });
  expect(rewrite(code, results[0]).code).toContain("return { get share() { return share; } };");
});

describe("zustand store hooks", () => {
  const storeFile = "/repo/apps/web/src/store.ts";
  const store = `import { create } from "zustand";
    import { persist } from "zustand/middleware";
    export const useChat = create<ChatState>()(persist((set, get) => ({ threadId: null, open: false, setThreadId: (id) => set({ threadId: id }), toggle() { set({ open: !get().open }); } }), { name: "chat" }));
    export const useCount = create((set) => { const inc = () => set((s) => ({ n: s.n + 1 })); return { n: 0, inc }; });
    export const useLoose = create(makeState);`;
  const settle = (body, imports = "useChat, useCount, useLoose") => {
    const results = [decide(extract(store, storeFile)), decide(extract(`import { ${imports} } from "./store";\nfunction C() { ${body} }`, "/repo/apps/web/src/C.tsx"))];
    applyContracts(results);
    return results[1].functions[0].values;
  };

  it("extract finds each store and the actions in its initial state, through middleware", () => {
    expect(extract(store, storeFile).stores).toEqual({ useChat: { actions: ["setThreadId", "toggle"] }, useCount: { actions: [] }, useLoose: { actions: null } });
  });

  it("an action a selector picks is static: callers call it directly", () => {
    expect(settle(`const setThreadId = useChat((s) => s.setThreadId); return <p onClick={() => setThreadId(1)} />;`)[0]).toMatchObject({ decision: "static", why: "useChat selects setThreadId, a store action: the same function every render" });
    expect(settle(`const toggle = useChat((s) => s.toggle); return <p onClick={toggle} />;`)[0].decision).toBe("static");
  });

  it("selected state stays an accessor, and so does a key the store's initial state doesn't write as a function", () => {
    expect(settle(`const threadId = useChat((s) => s.threadId); return <p>{threadId}</p>;`)[0].decision).toBe("accessor");
    expect(settle(`const inc = useCount((s) => s.inc); return <p onClick={inc} />;`)[0].decision).toBe("accessor");
    expect(settle(`const reset = useLoose((s) => s.reset); return <p onClick={reset} />;`)[0].decision).toBe("accessor");
    expect(settle(`const open = useChat((s) => s.open && s.threadId); return <p>{open}</p>;`)[0].decision).toBe("accessor");
  });

  it("the whole store, with no selector, is an unknown hook result that says why", () => {
    expect(settle(`const chat = useChat(); return <p>{chat.threadId}</p>;`)[0]).toMatchObject({ decision: "hook", why: "hook result (useChat without a selector is the whole store)" });
  });

  it("a store used in the file that creates it gets the same contracts", () => {
    const code = `import { create } from "zustand";\nconst useUi = create((set) => ({ tab: "a", setTab: (tab) => set({ tab }) }));\nfunction C() { const tab = useUi((s) => s.tab); const setTab = useUi((s) => s.setTab); return <p onClick={() => setTab("b")}>{tab}</p>; }`;
    const results = [decide(extract(code, "/repo/apps/web/src/C.tsx"))];
    applyContracts(results);
    expect(results[0].functions[0].values.map((v) => [v.name, v.decision])).toEqual([["tab", "accessor"], ["setTab", "static"]]);
  });

  it.each([["~/"], ["@/"]])("a store imported through the app's %s path alias gets the same contracts, in any app's src", (alias) => {
    const results = [decide(extract(store, "/apps/nextjs/src/store.ts")), decide(extract(`import { useChat } from "${alias}store";\nfunction C() { const setThreadId = useChat((s) => s.setThreadId); return <p onClick={() => setThreadId(1)} />; }`, "/apps/nextjs/src/app/page/C.tsx"))];
    applyContracts(results);
    expect(results[1].functions[0].values[0].decision).toBe("static");
  });

  it("a create that isn't zustand's isn't a store", () => {
    expect(extract(`import { create } from "./mine";\nexport const useX = create(() => ({ a: () => 1 }));`, storeFile).stores).toEqual({});
  });
});

it("inlining JSX used once leaves no line of indentation behind", () => {
  const code = `function C({ a }) {\n  const badge = <b>{a}</b>;\n\n  return <p>{badge}</p>;\n}\n`;
  expect(rewrite(code, run(code)).code).toBe(`function C({ a }) {\n  // solid: badge: inline (one JSX use)\n\n  return <p>{(<b>{a}</b>)}</p>;\n}\n`);
});
