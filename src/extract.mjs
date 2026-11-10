// Runs babel-plugin-react-compiler (pinned 1.0.0, the version t3code ships) on one file and
// returns, per component and hook, the compiler's reactive scopes joined with source-level facts
// (declaration kind, use sites). The compiler data comes from its `debugLogIRs` hook: we keep the
// last ReactiveFunction it logs (after PruneHoistedContexts), so no compiled output is parsed.
import { transformSync } from "@babel/core";
import { tryPrestep } from "./try-prestep.mjs";
import { conditionPrestep } from "./condition-prestep.mjs";
import ReactCompiler from "babel-plugin-react-compiler";

const EFFECT_HOOKS = /^use(Layout|Insertion)?Effect$/;
const HOOK_NAME = /^use[A-Z0-9]/;
const DEFERRED_CALLEES = new Set([
  "setTimeout", "setInterval", "requestAnimationFrame", "queueMicrotask", "addEventListener",
  "then", "catch", "finally", "subscribe", "observeResize",
]);
const STATEMENT_KINDS = new Set(["instruction", "scope", "pruned-scope", "terminal"]);

const posKey = (loc) => (loc && loc.start ? `${loc.start.line}:${loc.start.column}` : null);

function calleeName(callee) {
  if (!callee) return null;
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier")
    return callee.property.name;
  return null;
}

function functionName(path) {
  const { node, parentPath } = path;
  if (node.id?.name) return node.id.name;
  let p = parentPath;
  let wrapped = false;
  while (p && p.isCallExpression()) { p = p.parentPath; wrapped = true; } // memo(forwardRef(() => ...))
  // `const useStore = create()((set) => ...)` is a store, not a hook: only components get unwrapped.
  if (p?.isVariableDeclarator() && p.node.id.type === "Identifier" && !(wrapped && HOOK_NAME.test(p.node.id.name))) return p.node.id.name;
  if (p?.isExportDefaultDeclaration()) return "default";
  return null;
}

function containsJsx(node) {
  let found = false;
  const visit = (n) => {
    if (found || !n || typeof n !== "object") return;
    if (n.type === "JSXElement" || n.type === "JSXFragment") return void (found = true);
    for (const k of Object.keys(n)) {
      if (k === "loc" || k === "leadingComments" || k === "trailingComments") continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v.type === "string") visit(v);
    }
  };
  visit(node);
  return found;
}

function initKind(init) {
  if (!init) return "none";
  const t = init.type;
  if (t === "ArrowFunctionExpression" || t === "FunctionExpression") return "function";
  if (t === "CallExpression" && (HOOK_NAME.test(calleeName(init.callee) ?? "") || calleeName(init.callee) === "use"))
    return "hook";
  if (t === "JSXElement" || t === "JSXFragment") return "jsx";
  if ((t === "ConditionalExpression" || t === "LogicalExpression") && containsJsx(init)) return "jsx";
  if (/Literal$/.test(t) && t !== "TemplateLiteral") return "literal";
  if (t === "TemplateLiteral" && init.expressions.length === 0) return "literal";
  if (t === "ObjectExpression") return "object";
  if (t === "ArrayExpression") return "array";
  if (t === "CallExpression" || t === "NewExpression") return "call";
  return "expression";
}

// A hook called inside a derivation, e.g. `f(x, useY(z))`, outside any nested function.
function nestedHookCall(init) {
  let found = null;
  const visit = (n, top) => {
    if (found || !n || typeof n !== "object") return;
    if (/Function/.test(n.type ?? "")) return;
    if (!top && n.type === "CallExpression" && (HOOK_NAME.test(calleeName(n.callee) ?? "") || calleeName(n.callee) === "use")) return void (found = calleeName(n.callee));
    for (const k of Object.keys(n)) {
      if (k === "loc") continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((x) => visit(x, false));
      else if (v && typeof v.type === "string") visit(v, false);
    }
  };
  visit(init, true);
  return found;
}

function boundIdentifiers(pattern, out = []) {
  if (!pattern) return out;
  switch (pattern.type) {
    case "Identifier": out.push(pattern); break;
    case "ObjectPattern": for (const p of pattern.properties) boundIdentifiers(p.type === "RestElement" ? p.argument : p.value, out); break;
    case "ArrayPattern": for (const e of pattern.elements) boundIdentifiers(e, out); break;
    case "AssignmentPattern": boundIdentifiers(pattern.left, out); break;
    case "RestElement": boundIdentifiers(pattern.argument, out); break;
  }
  return out;
}

// Where `id` sits in a destructuring pattern: [] for a plain name, ["a"] for `{ a }`, [0] for `[x]`.
function patternPath(pattern, id, at = []) {
  if (!pattern) return null;
  if (pattern === id) return at;
  switch (pattern.type) {
    case "ObjectPattern":
      for (const p of pattern.properties) {
        const key = p.type === "RestElement" ? "..." : p.computed ? "[computed]" : (p.key.name ?? String(p.key.value));
        const r = patternPath(p.type === "RestElement" ? p.argument : p.value, id, [...at, key]);
        if (r) return r;
      }
      return null;
    case "ArrayPattern":
      for (const [i, e] of pattern.elements.entries()) { const r = patternPath(e, id, [...at, i]); if (r) return r; }
      return null;
    case "AssignmentPattern": return patternPath(pattern.left, id, at);
    case "RestElement": return patternPath(pattern.argument, id, [...at, "..."]);
  }
  return null;
}

// `useStore((s) => s.x)`, `useStore(useShallow((s) => ...))` or a router's `useLocation({ select: (l) => l.hash })`.
const isSelector = (arg) => /Function/.test(arg?.type ?? "") || (arg?.type === "CallExpression" && /Function/.test(arg.arguments?.[0]?.type ?? ""))
  || (arg?.type === "ObjectExpression" && arg.properties.some((p) => p.key?.name === "select" && /Function/.test(p.value?.type ?? "")));

// What a hook hands back, for the cross-file contract pass.
function returnShape(arg) {
  while (/^(TSAsExpression|TSSatisfiesExpression|TSNonNullExpression|ParenthesizedExpression)$/.test(arg?.type ?? "")) arg = arg.expression;
  if (!arg) return { type: "none" };
  if (arg.type === "Identifier") return { type: "identifier", name: arg.name };
  if (arg.type === "ObjectExpression") {
    return { type: "object", props: arg.properties.map((p) => p.type === "ObjectProperty" && !p.computed ? { key: p.key.name ?? String(p.key.value), name: p.value.type === "Identifier" ? p.value.name : null, fn: /Function/.test(p.value.type) } : { key: null }) };
  }
  if (arg.type === "ArrayExpression") return { type: "array", items: arg.elements.map((e) => ({ name: e?.type === "Identifier" ? e.name : null, fn: /Function/.test(e?.type ?? "") })) };
  return { type: "expression" };
}

// Where a reference sits relative to the component body: JSX, effect, handler, another value...
function classifyReference(ref, fnPath, valueByDeclarator) {
  let p = ref;
  let outerFn = null;
  while (p.parentPath && p.node !== fnPath.node) {
    if (p.isFunction()) outerFn = p;
    p = p.parentPath;
  }
  if (outerFn) return classifyFunctionPosition(outerFn, fnPath, valueByDeclarator);
  return classifyRenderPosition(ref, fnPath, valueByDeclarator);
}

function classifyFunctionPosition(fn, fnPath, valueByDeclarator) {
  const parent = fn.parentPath;
  if (parent.isCallExpression() && parent.node.arguments.includes(fn.node)) {
    const name = calleeName(parent.node.callee) ?? "";
    if (EFFECT_HOOKS.test(name)) return { kind: "effect" };
    if (HOOK_NAME.test(name)) return { kind: "callback", via: name };
    if (DEFERRED_CALLEES.has(name)) return { kind: "callback", via: name };
    // A synchronous callback such as items.map(cb) runs where the call runs.
    return classifyRenderPosition(parent, fnPath, valueByDeclarator);
  }
  if (parent.isJSXExpressionContainer() && parent.parentPath.isJSXAttribute()) {
    const attr = parent.parentPath.node.name.name;
    return /^on[A-Z]/.test(attr) ? { kind: "handler", via: attr } : { kind: "callback", via: attr };
  }
  if (parent.isVariableDeclarator()) {
    const owner = valueByDeclarator.get(parent.node);
    if (owner) return { kind: "via-function", via: owner };
  }
  return { kind: "callback" };
}

function isEffectDepsArray(path) {
  return (
    path.isArrayExpression() &&
    path.parentPath.isCallExpression() &&
    EFFECT_HOOKS.test(calleeName(path.parentPath.node.callee) ?? "") &&
    path.parentPath.node.arguments[1] === path.node
  );
}

const MUTATING = /^(set|add|delete|clear|push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin)$/;

function classifyRenderPosition(ref, fnPath, valueByDeclarator) {
  // `x.set(k, v)` as a statement, at the top level or inside a loop or `if` of the body.
  const member = ref.parentPath;
  const mutating = member?.isMemberExpression() && member.node.object === ref.node && !member.node.computed && MUTATING.test(member.node.property.name ?? "")
    && member.parentPath.isCallExpression() && member.parentPath.node.callee === member.node && member.parentPath.parentPath.isExpressionStatement();
  let p = ref;
  let inJsx = false;
  let providerValue = false;
  while (p.parentPath && p.node !== fnPath.node) {
    if (isEffectDepsArray(p)) return { kind: "effect-deps" };
    if (p.isJSXAttribute() && !inJsx) {
      const el = p.parentPath.node.name;
      const elName = el.type === "JSXMemberExpression" ? `${el.object.name}.${el.property.name}` : el.name;
      if (p.node.name.name === "value" && /(Context|Provider)$|\.Provider$/.test(elName ?? "")) {
        const expr = p.node.value?.expression;
        providerValue = expr === ref.node;
      }
    }
    if (p.isJSXElement() || p.isJSXFragment()) inJsx = true;
    if (p.isFunction()) return { kind: "callback" };
    const parent = p.parentPath;
    if (!inJsx && parent.isCallExpression() && parent.node.arguments.includes(p.node) && HOOK_NAME.test(calleeName(parent.node.callee) ?? ""))
      return { kind: "hook-arg" };
    if (parent.node === fnPath.node.body || parent.node === fnPath.node) {
      if (p.isVariableDeclaration()) {
        const decl = p.node.declarations.find((d) => d.start <= ref.node.start && d.end >= ref.node.end);
        if (decl && initKind(decl.init) === "hook") return { kind: "hook-arg" };
        const owner = decl && valueByDeclarator.get(decl);
        if (inJsx) return { kind: "jsx" };
        return owner ? { kind: "value", via: owner } : { kind: "render" };
      }
      if (p.isReturnStatement()) {
        if (providerValue) return { kind: "provider-value" };
        return { kind: inJsx ? "jsx" : "return" };
      }
      if (p.isExpressionStatement() && p.node.expression.type === "CallExpression" && HOOK_NAME.test(calleeName(p.node.expression.callee) ?? "")) return { kind: "hook-arg" };
      if (mutating) return { kind: "mutated" };
      return { kind: inJsx ? "jsx" : "render" };
    }
    p = parent;
  }
  return { kind: inJsx ? "jsx" : "render" };
}

function analyzeFunction(fnPath, code) {
  const name = functionName(fnPath);
  const node = fnPath.node;
  const isComponent = /^[A-Z]/.test(name ?? "");
  const values = [];
  const valueByDeclarator = new Map();
  const params = [];

  node.params.forEach((param, index) => {
    const pattern = param.type === "AssignmentPattern" ? param.left : param;
    if (pattern.type === "ObjectPattern") {
      for (const prop of pattern.properties) {
        if (prop.type === "RestElement") {
          params.push({ name: prop.argument.name, index, rest: true, loc: posKey(prop.argument.loc) });
          continue;
        }
        const target = prop.value.type === "AssignmentPattern" ? prop.value.left : prop.value;
        for (const id of boundIdentifiers(target)) {
          params.push({ name: id.name, key: prop.key.name ?? prop.key.value, index, hasDefault: prop.value.type === "AssignmentPattern", nested: target.type !== "Identifier", loc: posKey(id.loc) });
        }
      }
    } else {
      for (const id of boundIdentifiers(pattern)) params.push({ name: id.name, index, plain: true, hasDefault: param.type === "AssignmentPattern", loc: posKey(id.loc) });
    }
  });

  const bodyStatements = node.body.type === "BlockStatement" ? node.body.body : [];
  for (const st of bodyStatements) {
    if (st.type !== "VariableDeclaration") continue;
    for (const decl of st.declarations) {
      for (const id of boundIdentifiers(decl.id)) {
        const v = {
          name: id.name,
          loc: posKey(id.loc),
          line: id.loc.start.line,
          declarationKind: st.kind,
          initKind: initKind(decl.init),
          nestedHook: initKind(decl.init) === "hook" ? null : nestedHookCall(decl.init),
          destructured: decl.id.type !== "Identifier",
          text: code.slice(decl.start, decl.end).split("\n")[0].slice(0, 120),
          range: { statement: [st.start, st.end], declarator: [decl.start, decl.end], init: decl.init ? [decl.init.start, decl.init.end] : null, id: [decl.id.start, decl.id.end] },
          singleDeclarator: st.declarations.length === 1,
          uses: [],
        };
        if (v.initKind === "hook") {
          const call = decl.init.type === "AwaitExpression" ? decl.init.argument : decl.init;
          v.hookCall = { callee: calleeName(call.callee), path: patternPath(decl.id, id), selector: isSelector(call.arguments?.[0]), onlyFirst: decl.id.type === "ArrayPattern" && decl.id.elements.length === 1 };
        }
        values.push(v);
        valueByDeclarator.set(decl, v.name);
      }
    }
  }
  const returns = bodyStatements.filter((s) => s.type === "ReturnStatement" && s.argument);
  // An expression-bodied arrow (`() => useContext(Ctx)`) returns its body.
  const lastReturn = returns.at(-1) ?? (node.body.type === "BlockStatement" ? undefined : { argument: node.body, loc: node.body.loc, start: node.body.start, end: node.body.end });
  if (!isComponent && lastReturn && !["Identifier", "NullLiteral", "BooleanLiteral", "StringLiteral", "NumericLiteral"].includes(lastReturn.argument.type)) {
    values.push({
      name: "(return)", loc: posKey(lastReturn.loc), line: lastReturn.loc.start.line, declarationKind: "return",
      initKind: initKind(lastReturn.argument), destructured: false, text: code.slice(lastReturn.start, lastReturn.end).split("\n")[0].slice(0, 120),
      range: { statement: [lastReturn.start, lastReturn.end], init: [lastReturn.argument.start, lastReturn.argument.end] }, uses: [{ kind: "return" }],
      ...(initKind(lastReturn.argument) === "hook" && lastReturn.argument.type === "CallExpression" ? { hookCall: { callee: calleeName(lastReturn.argument.callee), path: [], selector: isSelector(lastReturn.argument.arguments[0]) } } : {}),
    });
  }

  const bindingInfo = (bname) => {
    const binding = fnPath.scope.getBinding(bname);
    return binding && binding.scope === fnPath.scope ? binding : null;
  };
  for (const v of values) {
    if (v.name === "(return)") continue;
    const binding = bindingInfo(v.name);
    if (!binding) continue;
    v.reassigned = binding.constantViolations.length > 0;
    // `let x; try { x = a } catch { x = b }`: one value computed by the try statement right after it.
    const tryStmt = v.reassigned ? tryAssignment(v, binding, fnPath, bodyStatements) : null;
    if (tryStmt) {
      v.reassigned = false;
      v.tryAssigned = { line: tryStmt.loc.start.line };
      v.range.statement = [v.range.statement[0], tryStmt.end];
    }
    const inside = (ref) => tryStmt && ref.node.start >= tryStmt.start && ref.node.end <= tryStmt.end;
    // Type positions (`typeof x`) are not reads, and reads inside its own try are part of computing it.
    v.uses = binding.referencePaths.filter((ref) => !ref.findParent((a) => a.isTSTypeQuery()) && !inside(ref)).map((ref) => {
      const container = ref.parentPath.isJSXExpressionContainer() ? ref.parentPath : null;
      const attr = container?.parentPath.isJSXAttribute() ? container.parentPath.node.name.name : null;
      const hookCall = ref.parentPath.isCallExpression() && ref.parentPath.node.arguments.includes(ref.node) ? calleeName(ref.parentPath.node.callee) : null;
      return {
        ...classifyReference(ref, fnPath, valueByDeclarator),
        line: ref.node.loc?.start.line, start: ref.node.start, end: ref.node.end,
        attr, called: ref.parentPath.isCallExpression({ callee: ref.node }), argOf: hookCall,
        shorthand: ref.parentPath.isObjectProperty({ shorthand: true }) && ref.parentPath.node.value === ref.node,
        jsxChild: Boolean(container) && !attr,
        jsxTag: ref.node.type === "JSXIdentifier",
      };
    });
  }
  for (const prm of params) {
    const binding = bindingInfo(prm.name);
    prm.uses = binding ? binding.referencePaths.map((ref) => classifyReference(ref, fnPath, valueByDeclarator).kind) : [];
  }

  // Which params and values each value's own statement reads, for the AST fallback when the
  // compiler bails. Reads inside closures count: they decide what the closure captures.
  const valuesByStatement = new Map();
  for (const v of values) if (v.range?.statement) valuesByStatement.set(v.range.statement[0], [...(valuesByStatement.get(v.range.statement[0]) ?? []), v]);
  const statementOf = (ref) => ref.findParent((a) => a.parentPath?.node === node.body);
  for (const v of values) v.astReads = [];
  // Top-level statements that aren't declarations or returns (`visit("")`, loops filling a map): the names each reads.
  const renderStatements = new Map();
  for (const name of new Set([...params.map((p) => p.name), ...values.map((v) => v.name)])) {
    const binding = bindingInfo(name);
    if (!binding) continue;
    for (const ref of binding.referencePaths) {
      const st = statementOf(ref)?.node;
      const owners = valuesByStatement.get(st?.start) ?? [];
      for (const owner of owners) if (owner.name !== name && !owner.astReads.includes(name)) owner.astReads.push(name);
      const owner = owners[0];
      const hookStatement = st?.type === "ExpressionStatement" && st.expression.type === "CallExpression" && HOOK_NAME.test(calleeName(st.expression.callee) ?? "");
      if (!owner && st && !hookStatement && !["ReturnStatement", "VariableDeclaration", "FunctionDeclaration"].includes(st.type)) {
        if (!renderStatements.has(st)) renderStatements.set(st, new Set());
        renderStatements.get(st).add(name);
      }
    }
  }

  const effects = [];
  for (const st of bodyStatements) {
    const call = st.type === "ExpressionStatement" && st.expression.type === "CallExpression" ? st.expression : null;
    const hook = call && calleeName(call.callee);
    if (!hook || !EFFECT_HOOKS.test(hook)) continue;
    const [cb, deps] = call.arguments;
    const reads = new Set();
    if (cb) {
      fnPath.traverse({
        Identifier(idPath) {
          if (idPath.node.start < cb.start || idPath.node.end > cb.end || !idPath.isReferencedIdentifier()) return;
          const b = idPath.scope.getBinding(idPath.node.name);
          if (b && b.scope === fnPath.scope) {
            const member = idPath.parentPath.isMemberExpression({ object: idPath.node }) && !idPath.parentPath.node.computed ? code.slice(idPath.parentPath.node.start, idPath.parentPath.node.end) : idPath.node.name;
            reads.add(member);
          }
        },
      });
    }
    effects.push({
      hook, line: call.loc.start.line,
      deps: deps?.type === "ArrayExpression" ? deps.elements.map((e) => code.slice(e.start, e.end)) : null,
      reads: [...reads],
    });
  }

  return { name, kind: isComponent ? "component" : HOOK_NAME.test(name ?? "") ? "hook" : "function", loc: posKey(node.loc), line: node.loc.start.line, hasJsx: containsJsx(node.body), params, values, effects, earlyReturns: returns.length > 1 ? returns.length - 1 : 0, returnShape: returnShape(lastReturn?.argument), renderStatements: [...renderStatements.values()].map((n) => [...n]) };
}

// ---- compiler IR ----------------------------------------------------------------------------

function isPlace(o) {
  return o && o.kind === "Identifier" && o.identifier && typeof o.identifier.id === "number" && "reactive" in o;
}

function collectOperands(value, out, onInstr) {
  const visit = (o, depth) => {
    if (!o || typeof o !== "object" || depth > 40) return;
    if (isPlace(o)) return void out.push(o);
    if (Array.isArray(o)) return o.forEach((x) => visit(x, depth + 1));
    if (o instanceof Map || o instanceof Set) return;
    if (typeof o.id === "number" && "lvalue" in o && "value" in o) {
      if (o.lvalue) {
        onInstr(o);
        out.push(o.lvalue);
      } else visit(o.value, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(o)) {
      if (k === "loc" || k === "env" || k === "type" || k === "identifier") continue;
      if (k === "loweredFunc") { visit(v?.func?.context, depth + 1); continue; }
      visit(v, depth + 1);
    }
  };
  visit(value, 0);
}

function storeTargets(value) {
  switch (value.kind) {
    case "StoreLocal": case "StoreContext": case "DeclareLocal": case "DeclareContext":
      return [value.lvalue.place];
    case "Destructure": {
      const out = [];
      const walk = (pat) => {
        if (pat.kind === "ObjectPattern") for (const p of pat.properties) out.push(p.place);
        else if (pat.kind === "ArrayPattern") for (const it of pat.items) if (it.kind === "Identifier" || it.kind === "Spread") out.push(it.kind === "Spread" ? it.place : it);
      };
      walk(value.lvalue.pattern);
      return out.filter(isPlace);
    }
    default: return [];
  }
}

// SSA versions of one variable joined by a phi share a declarationId, so the graph keys on it.
const did = (identifier) => identifier.declarationId;

function analyzeReactiveFunction(fn) {
  const edges = new Map(); // identifier id -> Set of operand identifier ids
  const named = new Map(); // locKey -> { reactive, scopeId, operandIds }
  const identifiers = new Map(); // id -> identifier
  const surviving = new Map(); // scope id -> scope
  const scopeOfDecl = new Map(); // identifier id -> surviving scope id
  const returns = [];
  const reactiveIds = new Set(); // ids written by at least one reactive store (a `let` assigned in branches)

  const addEdge = (from, to) => {
    if (from === to) return;
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from).add(to);
  };
  const visitInstr = (instr, scopeId) => {
    const ops = [];
    collectOperands(instr.value, ops, (inner) => visitInstr(inner, scopeId));
    const targets = storeTargets(instr.value);
    const lvals = [...targets, ...(instr.lvalue ? [instr.lvalue] : [])];
    const targetIds = new Set(targets.map((t) => did(t.identifier)));
    const operands = ops.filter((o) => !targetIds.has(did(o.identifier)));
    for (const o of [...lvals, ...operands]) identifiers.set(did(o.identifier), o.identifier);
    for (const l of lvals) for (const o of operands) addEdge(did(l.identifier), did(o.identifier));
    for (const l of lvals) if (l.reactive) reactiveIds.add(did(l.identifier));
    for (const t of targets) {
      const key = posKey(t.identifier.loc);
      if (!key || named.has(key)) continue;
      named.set(key, { id: did(t.identifier), name: t.identifier.name?.value, reactive: t.reactive, ownScope: t.identifier.scope?.id ?? null, enclosingScope: scopeId, operandIds: operands.map((o) => did(o.identifier)) });
    }
  };
  const visitBlock = (block, scopeId) => {
    for (const stmt of block) {
      if (stmt.kind === "instruction") visitInstr(stmt.instruction, scopeId);
      else if (stmt.kind === "scope") {
        surviving.set(stmt.scope.id, stmt.scope);
        for (const d of stmt.scope.declarations.values()) scopeOfDecl.set(did(d.identifier), stmt.scope.id);
        visitBlock(stmt.instructions, stmt.scope.id);
      } else if (stmt.kind === "pruned-scope") visitBlock(stmt.instructions, scopeId);
      else if (stmt.kind === "terminal") visitTerminal(stmt.terminal, scopeId);
    }
  };
  const visitTerminal = (term, scopeId) => {
    if (term.kind === "return" && isPlace(term.value)) {
      identifiers.set(did(term.value.identifier), term.value.identifier);
      returns.push({ loc: posKey(term.loc), reactive: term.value.reactive, id: did(term.value.identifier) });
    }
    const seen = new Set();
    const visit = (o, depth) => {
      if (!o || typeof o !== "object" || seen.has(o) || depth > 6) return;
      seen.add(o);
      if (Array.isArray(o)) {
        if (o.length && o.every((s) => s && STATEMENT_KINDS.has(s.kind))) return visitBlock(o, scopeId);
        return o.forEach((x) => visit(x, depth + 1));
      }
      if (typeof o.id === "number" && "lvalue" in o && "value" in o) return visitInstr(o, scopeId);
      for (const [k, v] of Object.entries(o)) if (k !== "loc" && k !== "value") visit(v, depth + 1);
      if (o.kind && o.kind !== "return" && o.value && typeof o.value === "object") visit(o.value, depth + 1);
    };
    visit(term, 0);
  };
  visitBlock(fn.body, null);
  for (const p of fn.params) {
    const place = p.kind === "Identifier" ? p : p.place;
    if (isPlace(place)) {
      identifiers.set(did(place.identifier), place.identifier);
      const key = posKey(place.identifier.loc);
      if (key && !named.has(key)) named.set(key, { name: place.identifier.name?.value, reactive: place.reactive, ownScope: null, enclosingScope: null, operandIds: [] });
    }
  }
  return { edges, named, identifiers, surviving, scopeOfDecl, returns, reactiveIds };
}

// ---- join ---------------------------------------------------------------------------------

function joinFunction(ast, ir, event) {
  const fn = { ...ast, compiler: event };
  if (!ir) return fn;
  const { edges, named, identifiers, surviving, scopeOfDecl, returns, reactiveIds } = ir;
  const sourceIdByKey = new Map();
  for (const [id, ident] of identifiers) {
    const key = posKey(ident.loc);
    if (key && ident.name && named.has(key)) sourceIdByKey.set(key, id);
  }
  const sourceKeys = new Set([...ast.values.map((v) => v.loc), ...ast.params.map((p) => p.loc)]);
  const nameOfSourceId = new Map();
  for (const [id, ident] of identifiers) {
    const key = posKey(ident.loc);
    if (key && sourceKeys.has(key) && ident.name) {
      const src = ast.values.find((v) => v.loc === key) ?? ast.params.find((p) => p.loc === key);
      if (src) nameOfSourceId.set(id, src.name);
    }
  }
  const inputsOf = (startIds) => {
    const found = new Set();
    const seen = new Set();
    const stack = [...startIds];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      if (nameOfSourceId.has(id)) { found.add(nameOfSourceId.get(id)); continue; }
      for (const n of edges.get(id) ?? []) stack.push(n);
    }
    return [...found];
  };
  const survivingScopeFor = (ids) => {
    for (const id of ids) {
      if (scopeOfDecl.has(id)) return scopeOfDecl.get(id);
      const ident = identifiers.get(id);
      if (ident?.scope && surviving.has(ident.scope.id)) return ident.scope.id;
    }
    return null;
  };
  const scopeRefName = (ident) => nameOfSourceId.get(did(ident)) ?? (scopeOfDecl.has(did(ident)) ? `@${scopeOfDecl.get(did(ident))}` : ident.name?.value ?? `$${ident.id}`);

  fn.scopes = [...surviving.values()].map((s) => ({
    id: s.id,
    line: s.loc?.start?.line ?? null,
    dependencies: [...s.dependencies].map((d) => ({ name: scopeRefName(d.identifier) + d.path.map((p) => `${p.optional ? "?." : "."}${p.property}`).join(""), reactive: d.reactive })),
    declares: [...s.declarations.values()].map((d) => nameOfSourceId.get(did(d.identifier)) ?? d.identifier.name?.value ?? `$${d.identifier.id}`),
    merged: [...s.merged],
  }));
  const declaredBy = new Map();
  for (const s of fn.scopes) for (const d of s.declares) declaredBy.set(d, s.id);
  const readers = new Map();
  for (const s of fn.scopes) for (const d of s.dependencies) {
    const base = d.name.split(/\??\./)[0];
    if (!readers.has(base)) readers.set(base, new Set());
    readers.get(base).add(s.id);
  }

  for (const v of fn.values) {
    if (v.name === "(return)") {
      const r = returns.find((x) => x.loc === v.loc) ?? returns.at(-1);
      if (r) v.compiler = { reactive: r.reactive, scope: survivingScopeFor([r.id]), inputs: inputsOf([r.id]) };
      continue;
    }
    const info = named.get(v.loc);
    if (!info) continue;
    if (v.tryAssigned) {
      // The declaration itself stores nothing; the assignments in the try and catch decide it.
      const writes = [...(edges.get(info.id) ?? [])];
      v.compiler = { reactive: info.reactive || reactiveIds.has(info.id), scope: scopeOfDecl.get(info.id) ?? survivingScopeFor(writes), inputs: inputsOf(writes), readByScopes: [] };
      continue;
    }
    const scope = (info.ownScope != null && surviving.has(info.ownScope) ? info.ownScope : null) ?? survivingScopeFor(info.operandIds) ?? (info.enclosingScope != null && declaredBy.get(v.name) === info.enclosingScope ? info.enclosingScope : null);
    v.compiler = { reactive: info.reactive, scope, inputs: inputsOf(info.operandIds), readByScopes: [...(readers.get(v.name) ?? [])].filter((id) => id !== scope) };
  }
  for (const p of fn.params) {
    const info = named.get(p.loc);
    if (info) p.reactive = info.reactive;
  }
  return fn;
}

function describeError(event) {
  const d = event.detail ?? event.data;
  if (!d) return { reason: event.kind };
  const o = d.options ?? d;
  return { reason: o.reason ?? String(d), category: o.category ?? null, description: o.description ?? null, line: o.loc?.start?.line ?? o.details?.find?.((x) => x.loc)?.loc?.start?.line ?? null };
}

// The try statement that alone assigns a bare `let x;`: it must come right after the declaration,
// assign only in its try or catch block (not finally, not a nested function), and x must be the
// declaration's only declarator.
function tryAssignment(v, binding, fnPath, bodyStatements) {
  if (v.declarationKind !== "let" || v.initKind !== "none" || !v.singleDeclarator || v.destructured) return null;
  const at = bodyStatements.findIndex((st) => st.start === v.range.statement[0]);
  const next = bodyStatements[at + 1];
  if (next?.type !== "TryStatement") return null;
  const within = (n, node) => node && n.start >= node.start && n.end <= node.end;
  const ok = binding.constantViolations.every((c) =>
    (within(c.node, next.block) || within(c.node, next.handler)) && c.getFunctionParent()?.node === fnPath.node);
  return ok ? next : null;
}

const CONDITION_BAIL = /^Unexpected terminal kind `(optional|logical)` for (ternary|logical) test block/;

function compile(code, filename, { prestep, liftIn }) {
  const imports = {};
  const astFunctions = new Map();
  const irByLoc = new Map();
  const events = [];
  const collect = () => ({
    visitor: {
      Program(program) {
        for (const st of program.node.body) {
          if (st.type !== "ImportDeclaration" || st.importKind === "type") continue;
          for (const sp of st.specifiers) imports[sp.local.name] = { source: st.source.value, imported: sp.type === "ImportSpecifier" ? (sp.imported.name ?? sp.imported.value) : sp.type === "ImportDefaultSpecifier" ? "default" : "*" };
        }
        program.traverse({
          Function(path) {
            const name = functionName(path);
            if (!name || !(/^[A-Z]/.test(name) || HOOK_NAME.test(name))) return;
            astFunctions.set(posKey(path.node.loc), analyzeFunction(path, code));
          },
        });
      },
    },
  });
  // What each pre-step changed or skipped, keyed by every enclosing function.
  const notes = new Map();
  const note = (path, entry) => {
    for (let f = path.getFunctionParent(); f; f = f.parentPath?.getFunctionParent()) {
      const key = posKey(f.node.loc);
      if (!notes.has(key)) notes.set(key, []);
      notes.get(key).push({ line: path.node?.loc?.start.line, ...entry });
    }
  };
  const pre = [];
  if (prestep) pre.push(tryPrestep({ onRewrite: (p) => note(p, { step: "try", rewritten: true }), onSkip: (p, why) => note(p, { step: "try", rewritten: false, why }) }));
  if (liftIn) pre.push(conditionPrestep({ inFunction: (f) => liftIn.has(posKey(f.node.loc)), onLift: (p) => note(p, { step: "condition", rewritten: true }), onSkip: (p, why) => note(p, { step: "condition", rewritten: false, why }) }));
  let parseError = null;
  try {
    transformSync(code, {
      filename, babelrc: false, configFile: false, code: false, ast: false,
      parserOpts: { plugins: ["typescript", "jsx"] },
      plugins: [collect, ...pre, [ReactCompiler, {
        panicThreshold: "none",
        logger: {
          logEvent: (_file, e) => events.push(e),
          debugLogIRs: (v) => { if (v.kind === "reactive") irByLoc.set(posKey(v.value.loc), v.value); },
        },
      }]],
    });
  } catch (e) {
    parseError = String(e.message ?? e).split("\n")[0];
  }
  return { astFunctions, irByLoc, events, notes, parseError, imports };
}

export function extract(code, filename, { prestep = true } = {}) {
  const started = performance.now();
  let run = compile(code, filename, { prestep });
  // Second compile, only for files where a function hit the condition bug, lifting tests only there.
  const liftIn = new Set(run.events.filter((e) => e.kind === "CompileError" && CONDITION_BAIL.test(describeError(e).reason)).map((e) => posKey(e.fnLoc)));
  if (prestep && liftIn.size) run = compile(code, filename, { prestep, liftIn });
  const { astFunctions, irByLoc, events, notes, parseError, imports } = run;

  const eventByLoc = new Map();
  for (const e of events) {
    const key = posKey(e.fnLoc);
    if (!key) continue;
    if (e.kind === "CompileSuccess") eventByLoc.set(key, { status: "compiled", memoSlots: e.memoSlots });
    else if (e.kind === "CompileError" || e.kind === "PipelineError") eventByLoc.set(key, { status: "bailout", ...describeError(e) });
    else if (e.kind === "CompileSkip" && !eventByLoc.has(key)) eventByLoc.set(key, { status: "skipped", reason: e.reason });
  }
  const functions = [];
  for (const [key, ast] of astFunctions) {
    const event = eventByLoc.get(key) ?? { status: "not-compiled" };
    const ir = event.status === "compiled" ? irByLoc.get(key) : null;
    const fn = joinFunction(ast, ir && analyzeReactiveFunction(ir), event);
    if (notes.has(key)) fn.tryPrestep = notes.get(key);
    functions.push(fn);
  }
  return { file: filename, parseError, imports, functions, ms: Math.round(performance.now() - started) };
}
