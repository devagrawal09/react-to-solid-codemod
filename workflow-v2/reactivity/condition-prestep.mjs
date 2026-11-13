// React Compiler 1.0.0 also bails ("Unexpected terminal kind `optional` for ternary test block")
// when the test of a `? :` or the left side of `&&`/`||`/`??` holds two value blocks, as in
// `a?.id === b?.id ? x : y`. Lifting the test into a const just before the statement compiles fine.
// Like the try pre-step this only feeds the analysis: evaluating the test unconditionally reads the
// same values, so every value keeps the same reactive inputs, and the source is never rewritten.
import { types as t } from "@babel/core";

const VALUE_BLOCK = /^(ConditionalExpression|LogicalExpression|OptionalMemberExpression|OptionalCallExpression)$/;
const LOOP = /^(For|ForIn|ForOf|While|DoWhile)Statement$/;

function valueBlocks(path) {
  let n = 0;
  path.traverse({
    Function(p) { p.skip(); },
    enter(p) { if (VALUE_BLOCK.test(p.node.type)) n++; },
  });
  return n + (VALUE_BLOCK.test(path.node.type) ? 1 : 0);
}

function assignedNames(statement) {
  const names = new Set();
  statement.traverse({
    Function(p) { p.skip(); },
    AssignmentExpression(p) { for (const n of Object.keys(p.getBindingIdentifiers())) names.add(n); },
    UpdateExpression(p) { if (p.node.argument.type === "Identifier") names.add(p.node.argument.name); },
  });
  return names;
}

// `inFunction(fnPath)` says whether to touch a test inside that top-level component or hook.
export function conditionPrestep({ inFunction = () => true, onLift = () => {}, onSkip = () => {} } = {}) {
  let counter = 0;
  const lift = (testPath) => {
    if (!testPath.node || valueBlocks(testPath) < 2) return;
    let fn = testPath.getFunctionParent();
    if (!fn) return;
    let outer = fn;
    while (outer.parentPath?.getFunctionParent()) outer = outer.parentPath.getFunctionParent();
    if (!inFunction(outer)) return;
    if (fn.isArrowFunctionExpression() && !t.isBlockStatement(fn.node.body)) {
      fn.get("body").replaceWith(t.blockStatement([t.returnStatement(fn.node.body)]));
      fn.scope.crawl();
      return onSkip(testPath, "retry");
    }
    const statement = testPath.getStatementParent();
    if (!statement || statement.getFunctionParent()?.node !== fn.node) return onSkip(testPath, "not inside a statement");
    if (LOOP.test(statement.node.type) || (LOOP.test(statement.parentPath.node.type) && statement.key !== "body")) return onSkip(testPath, "loop condition");
    const reads = new Set();
    testPath.traverse({ Identifier(p) { if (p.isReferencedIdentifier()) reads.add(p.node.name); } });
    if (testPath.isIdentifier()) reads.add(testPath.node.name);
    if ([...assignedNames(statement)].some((n) => reads.has(n))) return onSkip(testPath, "the statement assigns what the test reads");
    const id = t.identifier(`__test${counter++}`);
    const test = testPath.node;
    testPath.replaceWith(id);
    statement.insertBefore(t.variableDeclaration("const", [t.variableDeclarator(id, test)]));
    onLift(testPath);
  };
  const visit = (p) => { lift(p.isConditionalExpression() ? p.get("test") : p.get("left")); };
  return {
    visitor: {
      Program(program) {
        // Converting an arrow body to a block requeues its contents, so loop until nothing changes.
        for (let round = 0; round < 4; round++) {
          let retry = false;
          const skip = onSkip;
          onSkip = (p, why) => (why === "retry" ? (retry = true) : skip(p, why));
          program.traverse({ ConditionalExpression: { exit: visit }, LogicalExpression: { exit: visit } });
          onSkip = skip;
          if (!retry) break;
        }
        program.scope.crawl();
      },
    },
  };
}
