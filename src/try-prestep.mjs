// React Compiler 1.0.0 bails on a whole component when a try/catch contains a value block
// (`? :`, `&&`, `||`, `??`, `?.`). Its output is never shipped here, only its analysis, so before
// the compiler runs we rewrite each such statement into a shape it accepts and that keeps the same
// reads and the same reactive dependencies:
//
//   try { A } catch (e) { B } finally { C }
//   →  const __try0 = [reads of A]; if (__try0.length) { A } else { let e = __try0; B } { C }
//
// Both branches stay reachable, `return`/`await`/`break` inside A keep working (they stay in the same
// function), and anything the catch computes depends on what the try block read, which is what
// decides whether it can throw. The array only captures the reads, so it doesn't extend any value's
// mutable range the way passing them to an unknown function would.
import { types as t } from "@babel/core";

const VALUE_BLOCK = /^(ConditionalExpression|LogicalExpression|OptionalMemberExpression|OptionalCallExpression)$/;

export function hasValueBlock(tryPath) {
  let found = false;
  tryPath.traverse({
    enter(p) {
      if (VALUE_BLOCK.test(p.node.type)) {
        found = true;
        p.stop();
      }
    },
  });
  return found;
}

function outerReads(tryPath) {
  const names = new Map();
  tryPath.get("block").traverse({
    ReferencedIdentifier(p) {
      if (p.node.type === "JSXIdentifier" || p.findParent((a) => a.isTSType?.() || a.isTSTypeQuery())) return;
      const binding = p.scope.getBinding(p.node.name);
      if (!binding || tryPath.isAncestor(binding.path)) return;
      if (binding.kind === "module" && !binding.constantViolations.length && binding.path.isImportSpecifier?.()) return;
      names.set(p.node.name, true);
    },
  });
  return [...names.keys()];
}

// `onRewrite(tryPath)` / `onSkip(tryPath, why)` let the caller record which functions were changed.
export function tryPrestep({ onRewrite = () => {}, onSkip = () => {} } = {}) {
  let counter = 0;
  const desugar = (path) => {
    if (!path.getFunctionParent() || !hasValueBlock(path)) return;
    // Generators can't be compiled anyway, and a desugared yield would change what the analysis sees.
    if (path.getFunctionParent().node.generator) return onSkip(path, "try inside a generator");
    onRewrite(path);
    const { block, handler, finalizer } = path.node;
    const id = t.identifier(`__try${counter++}`);
    const reads = t.arrayExpression(outerReads(path).map((n) => t.identifier(n)));
    const catchBody = handler
      ? t.blockStatement([
          ...(handler.param ? [t.variableDeclaration("let", [t.variableDeclarator(handler.param, id)])] : []),
          ...handler.body.body,
        ])
      : null;
    path.replaceWithMultiple([
      t.variableDeclaration("const", [t.variableDeclarator(id, reads)]),
      t.ifStatement(t.memberExpression(id, t.identifier("length")), block, catchBody),
      ...(finalizer ? [finalizer] : []),
    ]);
  };
  // The compiler does its work in Program enter, so this has to finish before that, not on a later visit.
  return {
    visitor: {
      Program(program) {
        program.traverse({ TryStatement: { exit: desugar } });
        program.scope.crawl();
      },
    },
  };
}
