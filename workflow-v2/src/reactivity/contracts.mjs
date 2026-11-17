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

// call-time values are reactive reads done later, so a caller gets an accessor, not a plain value.
const STATIC_DECISIONS = new Set(["static", "function", "unused"]);

function resolveImport(fromFile, source, files) {
  let base;
  if (source.startsWith("~/")) base = path.join(fromFile.slice(0, fromFile.indexOf("/apps/web/src/") + "/apps/web/src/".length), source.slice(2));
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
    return at(contractOfCall(file, hookCall.callee, stack, hookCall.selector), hookCall.path);
  };

  // The hook a call in `file` refers to: imported from a local file, defined in the same file, or built in.
  const target = (file, callee) => {
    if (!callee) return null;
    const imp = files.get(file)?.imports?.[callee];
    if (imp) {
      const resolved = resolveImport(file, imp.source, files);
      if (resolved && imp.imported !== "default" && imp.imported !== "*") return { key: `${resolved}#${imp.imported}` };
      if (BUILTIN[imp.imported]) return { builtin: imp.imported };
      return { external: `${imp.source}:${imp.imported}` };
    }
    if (hooks.has(`${file}#${callee}`)) return { key: `${file}#${callee}` };
    if (BUILTIN[callee]) return { builtin: callee };
    return { external: callee };
  };

  const contractOfCall = (file, callee, stack, selector = false) => {
    const t = target(file, callee);
    if (!t) return { kind: "opaque", why: "no callee" };
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
      c = ret?.hookCall ? contractOfCall(file, ret.hookCall.callee, next, ret.hookCall.selector) : ret?.decision === "function" ? F : ret && STATIC_DECISIONS.has(ret.decision) ? S : ret?.decision === "flag" ? { kind: "opaque", why: "return flagged" } : A;
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

// Sets `contract` on every hook-result value and redecides every function, leaf hooks first.
export function applyContracts(results) {
  const { settle } = buildContracts(results);
  for (const r of results) for (const fn of r.functions) settle(r.file, fn, new Set());
}
