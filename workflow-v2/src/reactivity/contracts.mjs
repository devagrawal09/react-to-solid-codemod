// Whole-program pass: what each hook hands back in Solid, and what that means for its callers.
// A contract is one of
//   { kind: "static" }                         stable value or function: read it plainly
//   { kind: "accessor" }                       reactive value: the hook returns `() => v`, callers call it
//   { kind: "object", props: { k: contract } } object of getters/plain props: callers keep `r.k`
//   { kind: "tuple", items: [contract] }       array: per element
//   { kind: "opaque", why }                    unknown: the caller's value stays a `hook` decision
// Local hooks are resolved leaf first (a hook returning another hook's result takes its contract).
import path from "node:path";
import { decide } from "./decide.mjs";

const S = { kind: "static" };
// A stable function that reads reactive values when called: callers keep the reference, but a value
// computed by calling it during render stays reactive.
const F = { kind: "static", reactiveCall: true };
const A = { kind: "accessor" };
const tuple = (...items) => ({ kind: "tuple", items });

// React and the libraries t3code uses. Contexts are objects of getters in Solid.
export const BUILTIN = {
  useState: tuple(A, S),
  useReducer: tuple(A, S),
  useTransition: tuple(A, S),
  useActionState: tuple(A, S, A),
  useOptimistic: tuple(A, S),
  useRef: S,
  useId: S,
  useEffectEvent: S,
  // R4 turns useCallback(fn, deps) into fn: callers keep the reference and call it, as with a
  // function declared in the body (decided `function`). It isn't an accessor: reading it as
  // `cb()` would call it.
  useCallback: { ...F, decision: "function", note: "useCallback(fn) becomes fn, a plain function that reads reactive values when called" },
  // R6 turns it into createMemo and rewrites its reads itself. Unlisted, its callback argument
  // made it look like a store selector, and both passes added the call (`x()()`).
  useMemo: A,
  useDeferredValue: A,
  useSyncExternalStore: A,
  useContext: { kind: "object", props: {} },
  use: { kind: "object", props: {} },
  useNavigate: S,
  useAtomValue: A,
  useAtomSet: S,
  useAtomRefresh: S,
  useSyncExternalStoreWithSelector: A,
  useRouter: S,
  useRouterState: A,
  useLocation: { kind: "object", props: {} },
  useParams: { kind: "object", props: {} },
  useSearch: { kind: "object", props: {} },
  useQueryClient: S,
};

// Library hooks whose result keeps its identity across renders in React too, by import source
// (a name alone is ambiguous: Next.js's useRouter isn't TanStack's). Such a value was in effect
// deps only to satisfy exhaustive-deps, so tracking it as a plain value loses nothing. Checked
// against each library's source on Nov 19. react-hook-form's useFormContext is left out: its
// value is rebuilt when formState changes.
export const LIBRARY = {
  "react-hook-form": { useForm: { ...F, note: "useForm hands back the same form object every render; its methods read form state" } },
  "next/navigation": { useRouter: { ...S, note: "Next.js's useRouter hands back the same router every render" } },
  "posthog-js/react": { usePostHog: { ...S, note: "usePostHog hands back the PostHog client, the same every render" } },
  "@lexical/react/LexicalComposerContext": { useLexicalComposerContext: tuple(S, S) },
  "@tanstack/react-virtual": {
    useVirtualizer: { ...F, note: "useVirtualizer hands back the same virtualizer every render; its methods read its state" },
    useWindowVirtualizer: { ...F, note: "useWindowVirtualizer hands back the same virtualizer every render; its methods read its state" },
  },
  "react-redux": { useDispatch: S, useStore: S },
};

// call-time values are reactive reads done later, so a caller gets an accessor, not a plain value.
const STATIC_DECISIONS = new Set(["static", "function", "unused"]);

function resolveImport(fromFile, source, files) {
  let base;
  // `~/` and `@/` are the usual tsconfig paths for the app's src directory (t3code, create-t3-app,
  // create-next-app).
  if ((source.startsWith("~/") || source.startsWith("@/")) && fromFile.includes("/src/")) base = path.join(fromFile.slice(0, fromFile.indexOf("/src/") + "/src/".length), source.slice(2));
  else if (source.startsWith(".")) base = path.join(path.dirname(fromFile), source);
  else return null;
  for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) if (files.has(base + ext)) return base + ext;
  return null;
}

export function buildContracts(results) {
  const files = new Map(results.map((r) => [r.file, r]));
  const hooks = new Map(); // `${file}#${name}` -> fn
  for (const r of results) for (const fn of r.functions) if (fn.kind === "hook" && fn.name) hooks.set(`${r.file}#${fn.name}`, fn);
  const memo = new Map();
  const settled = new Set();

  // Give each hook-result value in `fn` its contract, then redecide fn so values that only read
  // stable hook results drop to static. Callees settle first, through contractOfCall.
  const settle = (file, fn, stack) => {
    if (settled.has(fn)) return;
    settled.add(fn);
    for (const v of fn.values) {
      // `useId().replaceAll(":", "")`: the value is flagged (hoist the hook), but what reads it can still be static.
      if (v.nestedHook) v.nestedContract = contractOfCall(file, v.nestedHook, stack);
      if (!v.hookCall) continue;
      const c = hookValueContract(file, v.hookCall, stack);
      v.contract = { ...c, from: v.hookCall.callee, builtin: Boolean(target(file, v.hookCall.callee)?.builtin), destructured: (v.hookCall.path ?? []).some((k) => typeof k === "string") };
    }
    decide({ functions: [fn] });
  };

  // `const [x] = useState(init)` with no setter never changes.
  const hookValueContract = (file, hookCall, stack) => {
    const t = target(file, hookCall.callee);
    if (hookCall.onlyFirst && ["useState", "useReducer"].includes(t?.builtin) && hookCall.path?.[0] === 0) return { ...S, why: "state without a setter" };
    return at(contractOfCall(file, hookCall.callee, stack, hookCall.selector, hookCall.selects), hookCall.path);
  };

  // The hook a call in `file` refers to: imported from a local file, defined in the same file, or built in.
  const target = (file, callee) => {
    if (!callee) return null;
    const imp = files.get(file)?.imports?.[callee];
    if (imp) {
      const resolved = resolveImport(file, imp.source, files);
      if (resolved && imp.imported !== "default" && imp.imported !== "*") return files.get(resolved).stores?.[imp.imported] ? { store: files.get(resolved).stores[imp.imported] } : { key: `${resolved}#${imp.imported}` };
      const library = Object.entries(LIBRARY).find(([source]) => source === imp.source)?.[1];
      if (library?.[imp.imported]) return { library: library[imp.imported] };
      // Next.js's useRouter and useParams aren't the router hooks the table describes.
      if (BUILTIN[imp.imported] && !/^next(\/|$)/.test(imp.source)) return { builtin: imp.imported };
      return { external: `${imp.source}:${imp.imported}` };
    }
    if (hooks.has(`${file}#${callee}`)) return { key: `${file}#${callee}` };
    if (files.get(file)?.stores?.[callee]) return { store: files.get(file).stores[callee] };
    if (BUILTIN[callee]) return { builtin: callee };
    return { external: callee };
  };

  const contractOfCall = (file, callee, stack, selector = false, selects = null) => {
    const t = target(file, callee);
    if (!t) return { kind: "opaque", why: "no callee" };
    if (t.library) return t.library;
    // A zustand store hook (zustand has no Solid 2 binding; the store gets a bridge, see R43). An
    // action it selects (`useStore((s) => s.reset)`) is a function made once with the store: the
    // same every render, so callers call it directly. Selected state is a reactive slice; the
    // whole store (no selector) changes on every write.
    if (t.store) {
      if (selector && selects && t.store.actions?.includes(selects)) return { ...S, note: `${callee} selects ${selects}, a store action: the same function every render` };
      return selector ? { ...A, why: "store selector" } : { kind: "opaque", why: `${callee} without a selector is the whole store` };
    }
    // A router hook with `select` hands back the selected slice, not its usual object.
    if (t.builtin) return selector && BUILTIN[t.builtin].kind === "object" && t.builtin !== "useContext" && t.builtin !== "use" ? { ...A, why: "router selector" } : BUILTIN[t.builtin];
    // A store hook called with a selector (`useStore((s) => s.x)`) reads one reactive slice.
    if (selector && (t.external || !hooks.has(t.key))) return { ...A, why: "store selector" };
    if (t.external) return { kind: "opaque", why: `external ${t.external}` };
    return contractOfHook(t.key, stack);
  };

  // A value inside a hook: its own decision, or the contract of the hook it came from.
  const contractOfValue = (file, fn, name, stack) => {
    const v = fn.values.find((x) => x.name === name);
    if (!v) return fn.params.some((p) => p.name === name) ? A : { kind: "opaque", why: `unknown ${name}` };
    if (v.hookCall) return hookValueContract(file, v.hookCall, stack);
    if (v.decision === "function") return F;
    if (STATIC_DECISIONS.has(v.decision)) return S;
    if (["memo", "accessor", "call-time", "jsx-fn", "inline"].includes(v.decision)) return A;
    if (v.decision === "getter-object") return { kind: "object", props: {} };
    return { kind: "opaque", why: `${name} is ${v.decision}` };
  };

  const contractOfHook = (key, stack = new Set()) => {
    if (memo.has(key)) return memo.get(key);
    if (stack.has(key)) return { kind: "opaque", why: "recursive hook" };
    const fn = hooks.get(key);
    if (!fn) return { kind: "opaque", why: `not found ${key}` };
    const file = key.slice(0, key.lastIndexOf("#"));
    const next = new Set(stack).add(key);
    settle(file, fn, next);
    const shape = fn.returnShape ?? { type: "none" };
    let c;
    if (shape.type === "none") c = S;
    else if (shape.type === "identifier") c = contractOfValue(file, fn, shape.name, next);
    else if (shape.type === "object") {
      // Spread or computed keys aren't followed; `at()` reads an unknown key as an accessor.
      c = { kind: "object", props: Object.fromEntries(shape.props.filter((p) => p.key).map((p) => [p.key, p.fn ? F : p.name ? contractOfValue(file, fn, p.name, next) : A])) };
    } else if (shape.type === "array") {
      c = tuple(...shape.items.map((i) => (i.fn ? F : i.name ? contractOfValue(file, fn, i.name, next) : A)));
    } else {
      const ret = fn.values.find((v) => v.name === "(return)");
      c = ret?.hookCall ? contractOfCall(file, ret.hookCall.callee, next, ret.hookCall.selector, ret.hookCall.selects) : ret?.decision === "function" ? F : ret && STATIC_DECISIONS.has(ret.decision) ? S : ret?.decision === "flag" ? { kind: "opaque", why: "return flagged" } : A;
    }
    memo.set(key, c);
    return c;
  };

  return { target, contractOfCall, contractOfHook, hooks, settle };
}

// Follow a destructuring path into a contract.
export function at(contract, keys) {
  let c = contract;
  for (const k of keys ?? []) {
    if (c.kind === "tuple" && typeof k === "number") c = c.items[k] ?? { kind: "opaque", why: "past the tuple" };
    else if (c.kind === "object" && typeof k === "string") c = c.props[k] ?? A;
    else if (c.kind === "accessor" || c.kind === "static" || c.kind === "opaque") return c;
    else return { kind: "opaque", why: `can't follow ${k}` };
  }
  return c;
}

// TanStack Query's Solid port takes its options as a function (R28), so what goes into them stays reactive.
const QUERY_HOOK = /^@tanstack\/(react|solid)-query:(useQuery|useSuspenseQuery|useInfiniteQuery|useQueries|useMutation)$/;
// Where a param read keeps reading after the body ran once: JSX, effects, closures, the hook's return.
const TRACKED_USES = new Set(["jsx", "effect", "effect-deps", "callback", "handler", "return", "provider-value"]);

// Sets `contract` on every hook-result value and redecides every function, leaf hooks first.
// Then decides which params of each local hook callers pass as accessors (`id: Accessor<T>`, read
// `id()`, called as `useThing(() => props.id)`), and leaves the rule pass, per file, `hooks`:
//   defs:  { [hook]: { accessors: [param index], blocked: [{ index, why }], callers } }
//          hooks defined here with a reactive param: the ones that become accessors, the ones whose
//          pattern can't, and whether any converted file calls the hook
//   calls: { [local name]: [param index] }  every local hook called here, with its accessor indexes
export function applyContracts(results) {
  const { settle, target, hooks } = buildContracts(results);
  for (const r of results) for (const fn of r.functions) settle(r.file, fn, new Set());

  // A param is reactive when the hook reads it where reading keeps happening after the body ran
  // once (JSX, an effect, a closure, a memo or accessor it feeds, its return), or forwards it to a
  // hook param that is. A param the hook calls is a function: callers keep passing it as it is.
  const indexes = new Map(); // hook key -> Set of reactive param indexes
  const blocked = new Map(); // hook key -> [{ index, why }]
  const reactiveIndexes = (key, stack) => {
    if (indexes.has(key)) return indexes.get(key);
    if (stack.has(key)) return new Set();
    const fn = hooks.get(key);
    const file = key.slice(0, key.lastIndexOf("#"));
    const next = new Set(stack).add(key);
    const byName = new Map(fn.values.map((v) => [v.name, v]));
    const reactive = (p) => !p.uses.some((u) => u.called) && p.uses.some((u) => {
      if (TRACKED_USES.has(u.kind)) return true;
      if (u.kind === "value" || u.kind === "via-function") return !STATIC_DECISIONS.has(byName.get(u.via)?.decision ?? "static");
      if (u.kind !== "hook-arg" || !u.hook) return false;
      const t = target(file, u.hook);
      if (t?.key && hooks.has(t.key)) return reactiveIndexes(t.key, next).has(u.arg);
      return QUERY_HOOK.test(t?.external ?? "");
    });
    const found = new Set();
    const why = [];
    for (const index of new Set(fn.params.map((p) => p.index))) {
      const at = fn.params.filter((p) => p.index === index);
      if (!at.some(reactive)) continue;
      // `{ id, ...rest }`, `{ a: { b } }` and `[a, b]` can't become one accessor read field by field.
      const shape = at.find((p) => p.rest || p.nested) ?? (at.length > 1 && at.some((p) => p.plain) ? at[0] : null);
      if (shape) why.push({ index, why: shape.rest ? "a rest element" : "nested destructuring" });
      else found.add(index);
    }
    indexes.set(key, found);
    blocked.set(key, why);
    return found;
  };

  for (const r of results) {
    const defs = {};
    for (const fn of r.functions) {
      if (fn.kind !== "hook" || !fn.name || hooks.get(`${r.file}#${fn.name}`) !== fn) continue;
      const key = `${r.file}#${fn.name}`;
      const accessors = reactiveIndexes(key, new Set());
      for (const p of fn.params) Object.assign(p, accessors.has(p.index) ? { decision: "accessor-param", why: "read where it keeps being read: callers pass an accessor" } : { decision: "static", why: "read once, or called: callers pass it as it is" });
      if (!accessors.size && !blocked.get(key).length) continue;
      // Callers this pass can't see (another package, files outside the converted directory) still pass plain values.
      const callers = results.some((o) => Object.keys(o.imports ?? {}).some((local) => target(o.file, local)?.key === key))
        || r.functions.some((g) => g !== fn && (g.values.some((v) => v.hookCall?.callee === fn.name) || [...g.values, ...g.params].some((x) => x.uses?.some((u) => u.hook === fn.name))));
      defs[fn.name] = { accessors: [...accessors].sort((a, b) => a - b), blocked: blocked.get(key), callers };
    }
    // Every local hook called here, so the rule pass knows which arguments to pass as accessors.
    const calls = {};
    for (const local of new Set([...Object.keys(r.imports ?? {}), ...r.functions.filter((f) => f.kind === "hook" && f.name).map((f) => f.name)])) {
      const t = target(r.file, local);
      if (t?.key && hooks.has(t.key)) calls[local] = [...reactiveIndexes(t.key, new Set())].sort((a, b) => a - b);
    }
    // A memo or accessor passed straight to a local hook is read here (`x()`); the rule pass passes
    // the accessor itself where the param is one.
    for (const fn of r.functions) for (const v of fn.values) for (const u of v.uses) if (u.argOf && u.argOf in calls) u.localHook = true;
    r.hooks = { defs, calls };
  }
}
