// Reactivity pass, part 1: run the React Compiler on each file and decide what every
// component-body value becomes in Solid. Each file's result is its own state key, so parallel
// files never contend for one value.
import type { Codemod } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import { setState } from "codemod:workflow";
import { decide, extract } from "../lib/reactivity.mjs";

const codemod: Codemod<TSX> = (root) => {
  setState(`r2s.analysis:${root.relativeFilename()}`, decide(extract(root.root().text(), root.filename())));
  return null;
};
export default codemod;
