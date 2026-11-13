// Maps the extractor's facts to one Solid 2 decision per value. Each rule reads one fact the
// React Compiler worked out (reactive or not, own reactive scope or not) or one use-site fact.
const CALL_TIME = new Set(["handler", "effect", "effect-deps", "callback"]);
const EFFECT_HOOKS = /^use(Layout|Insertion)?Effect$/;

export const DECISIONS = {
  memo: "createMemo: reactive, and the compiler gave it its own reactive scope",
  accessor: "derived function `() => expr`: reactive but cheap, the compiler did not memoize it",
  static: "plain const: depends on nothing reactive",
  function: "plain function: it reads reactive values when called, so no memo",
  "call-time": "read at call time: only handlers, effects or callbacks read it",
  inline: "inline the JSX at its one use",
  "jsx-fn": "JSX used in more than one place or passed on: `() => <...>`",
  "getter-object": "object of getters: it is a context value, so consumers keep `ctx.x`",
  unused: "never read: drop it",
  hook: "hook result whose contract is unknown (an external hook, or a tuple to destructure)",
  "getter-read": "destructured from a hook's object of getters: keep the object and read `r.k`",
  flag: "needs a person or an agent",
};

// What a reference to a function value means for the values that function reads.
function functionCallSiteKinds(use) {
  if (use.kind === "effect-deps") return [];
  if (use.called) return [use.kind];
  if (use.attr) return [/^on[A-Z]/.test(use.attr) ? "handler" : "callback"];
  if (use.kind === "hook-arg") return [EFFECT_HOOKS.test(use.argOf ?? "") ? "effect" : "callback"];
  if (CALL_TIME.has(use.kind)) return [use.kind];
  return ["callback"];
}

function resolveUseKinds(value, byName, seen = new Set()) {
  if (seen.has(value.name)) return [];
  seen.add(value.name);
  const kinds = [];
  for (const use of value.uses) {
    if (use.kind === "via-function") {
      const fn = byName.get(use.via);
      if (!fn) kinds.push("callback");
      else for (const u of fn.uses) kinds.push(...functionCallSiteKinds(u).flatMap((k) => (k === "via-function" ? resolveUseKinds(byName.get(u.via) ?? { name: u.via, uses: [] }, byName, seen) : [k])));
    } else kinds.push(use.kind);
  }
  return kinds;
}

// A hook result, once the contract pass knows what the hook hands back in Solid.
function decideHookValue(value, out) {
  const c = value.contract;
  if (!c || c.kind === "opaque") return out("hook", c ? `hook result (${c.why})` : "hook result");
  if (c.kind === "static") return out("static", c.reactiveCall ? `${c.from} hands back a stable function; calling it reads reactive values` : `${c.from} hands back a stable value`);
  if (c.kind === "accessor") {
    return c.destructured
      ? out("getter-read", `destructured from ${c.from}'s getters: keep the object, read \`r.${value.hookCall.path.at(-1)}\``)
      : out("accessor", `${c.from} hands back an accessor: read it as \`${value.name}()\``);
  }
  if (c.kind === "object") return out("getter-object", `${c.from} hands back an object of getters: keep \`${value.name}.k\``);
  return out("hook", `${c.from} hands back a tuple; destructure it`);
}

// Values the compiler calls reactive only because they read hook results that the contract pass
// found stable (a ref, a setter, a stable callback) become static.
function demote(fn) {
  if (!fn.values.some((v) => v.contract || v.nestedContract)) return;
  const stable = new Set([
    ...fn.params.filter((p) => p.reactive === false).map((p) => p.name),
    ...fn.values.filter((v) => (v.contract?.kind === "static" && !v.contract.reactiveCall) || (v.compiler && !v.compiler.reactive && !v.hookCall)).map((v) => v.name),
  ]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const v of fn.values) {
      if (v.hookCall || !v.compiler?.reactive || stable.has(v.name)) continue;
      const inputs = v.compiler.inputs ?? [];
      const staticHook = v.nestedContract?.kind === "static" && !v.nestedContract.reactiveCall;
      if ((inputs.length || staticHook) && inputs.every((n) => stable.has(n))) {
        v.compiler.reactive = false;
        v.compiler.demoted = inputs;
        stable.add(v.name);
        changed = true;
      }
    }
  }
}

function decideValue(value, fn, byName) {
  const out = (decision, why) => ({ decision, why });
  if (value.initKind === "hook") return decideHookValue(value, out);
  if (fn.compiler.status !== "compiled" && !value.compiler?.fallback) return out("flag", `compiler ${fn.compiler.status}: ${fn.compiler.reason ?? "no reason given"}`);
  if (value.reassigned) return out("flag", "reassigned after declaration");
  if (!value.compiler) return out("flag", "not found in the compiler's output");
  if (value.name !== "(return)" && value.uses.length === 0) return out("unused", "no references");
  if (value.uses.some((u) => u.kind === "mutated")) return out("flag", "mutated during render");
  if (value.compiler.filledBy) return out("flag", `filled after creation by ${value.compiler.filledBy}; the AST fallback can't follow that`);
  if (value.nestedHook) return out("flag", `hook call inside the expression (${value.nestedHook}): hoist it first`);
  if (!value.compiler.reactive) {
    if (value.compiler.demoted) return out("static", `only reads stable hook results (${value.compiler.demoted.join(", ")})`);
    return out("static", value.initKind === "function" ? "captures nothing reactive; can hoist" : "no reactive inputs");
  }
  if (value.uses.some((u) => u.jsxTag)) return out("flag", "component chosen at render, used as a JSX tag: <Dynamic>");
  if (value.initKind === "function") return out("function", `reads ${value.compiler.inputs.join(", ") || "reactive values"} when called`);
  const kinds = resolveUseKinds(value, byName);
  if (value.initKind === "jsx") {
    return value.uses.length === 1 && value.uses[0].kind === "jsx" ? out("inline", "one JSX use") : out("jsx-fn", `${value.uses.length} uses`);
  }
  if (kinds.length && kinds.every((k) => CALL_TIME.has(k))) return out("call-time", `only read in ${[...new Set(kinds)].join(", ")}`);
  if (kinds.length && kinds.every((k) => k === "provider-value") && value.initKind === "object") return out("getter-object", "context provider value");
  if (value.compiler.scope === "ast") return out("memo", "allocates");
  if (value.compiler.scope != null) return out("memo", `React scope @${value.compiler.scope}`);
  return out("accessor", "reactive, no own scope");
}

function decideParam(param, fn) {
  if (fn.kind === "component") {
    if (param.rest) return { decision: "flag", why: "rest props: `omit(props, ...)`" };
    if (param.nested) return { decision: "flag", why: "nested destructuring in props" };
    if (param.hasDefault) return { decision: "accessor", why: "default value: `() => props.x ?? d` (or merge)" };
    return { decision: "props", why: "`props.x`" };
  }
  return param.reactive === false ? { decision: "static", why: "not reactive" } : { decision: "accessor-param", why: "callers pass an accessor" };
}

function decideEffect(effect, reactiveNames) {
  const base = (expr) => expr.split(/[.?[(]/)[0];
  const reactiveReads = effect.reads.filter((r) => reactiveNames.has(base(r)));
  if (!effect.deps) return { ...effect, compute: reactiveReads, note: "no deps array: runs every render; compute tracks every reactive read" };
  const depBases = new Set(effect.deps.map(base));
  const missing = reactiveReads.filter((r) => !depBases.has(base(r)) && !effect.deps.includes(r));
  const restartOnly = effect.deps.filter((d) => !reactiveReads.some((r) => r === d || base(r) === d || r.startsWith(`${d}.`)));
  return {
    ...effect,
    compute: effect.deps.length ? effect.deps : [],
    note: [
      effect.deps.length === 0 ? "mount-only: onSettled" : null,
      missing.length ? `reads not in deps (stay untracked in apply): ${missing.join(", ")}` : null,
      restartOnly.length ? `deps only used to restart: ${restartOnly.join(", ")}` : null,
    ].filter(Boolean).join("; ") || null,
  };
}

// When the compiler bails, reactivity comes from the AST instead: a value is reactive if its
// statement reads a param, a hook result or another reactive value. It can only over-mark, since
// module-level reads and refs-only reads are the only things it treats as static.
const MEMO_KINDS = new Set(["call", "object", "array"]);
function astFallback(fn) {
  const params = new Set(fn.params.map((p) => p.name));
  const byName = new Map(fn.values.map((v) => [v.name, v]));
  // Code that runs during render and can write into what it reads: top-level statements, and
  // function values called during render. Everything such code touches moves together.
  const calledInRender = (f) => f.initKind === "function" && f.uses.some((u) => u.called && !CALL_TIME.has(u.kind) && u.kind !== "handler");
  const groups = [
    ...(fn.renderStatements ?? []).map((names) => ({ names, by: "a statement" })),
    ...fn.values.filter(calledInRender).map((f) => ({ names: [f.name, ...f.astReads], by: f.name })),
  ];
  const reactive = new Set();
  const isSource = (n) => params.has(n) || reactive.has(n) || byName.get(n)?.initKind === "hook";
  const readsHook = (v) => v.initKind === "hook" || v.nestedHook;
  for (let changed = true; changed; ) {
    changed = false;
    const mark = (n) => { if (byName.has(n) && !reactive.has(n)) { reactive.add(n); changed = true; } };
    for (const v of fn.values) if (readsHook(v) || (v.astReads ?? []).some(isSource)) mark(v.name);
    for (const g of groups) if (g.names.some(isSource)) g.names.forEach(mark);
  }
  for (const v of fn.values) {
    if (v.compiler) continue;
    const filledBy = MEMO_KINDS.has(v.initKind) && groups.find((g) => g.names.includes(v.name) && g.by !== v.name);
    const inputs = (v.astReads ?? []).filter(isSource);
    v.compiler = { reactive: reactive.has(v.name), scope: MEMO_KINDS.has(v.initKind) ? "ast" : null, inputs, fallback: true, filledBy: filledBy?.by ?? null };
  }
  for (const p of fn.params) p.reactive ??= true;
}

export function decide(extracted) {
  for (const fn of extracted.functions) {
    // Hooks the compiler doesn't pick up (no hook calls inside) still need a contract.
    if (fn.compiler.status === "bailout" || (fn.kind === "hook" && fn.compiler.status === "not-compiled")) astFallback(fn);
    demote(fn);
    const byName = new Map(fn.values.map((v) => [v.name, v]));
    for (const v of fn.values) {
      const d = decideValue(v, fn, byName);
      if (v.compiler?.fallback && d.decision !== "flag" && d.decision !== "hook") d.why += " (AST fallback: no compiler output)";
      // In Solid the catch has to rerun whenever the try does, so the whole statement moves inside.
      if (v.tryAssigned && d.decision !== "flag" && d.decision !== "static") d.why += "; the try/catch moves inside it";
      Object.assign(v, d);
    }
    for (const p of fn.params) Object.assign(p, decideParam(p, fn));
    const reactiveNames = new Set([
      ...fn.params.filter((p) => p.reactive !== false).map((p) => p.name),
      ...fn.values.filter((v) => v.compiler?.reactive).map((v) => v.name),
    ]);
    fn.effects = fn.effects.map((e) => decideEffect(e, reactiveNames));
  }
  return extracted;
}
