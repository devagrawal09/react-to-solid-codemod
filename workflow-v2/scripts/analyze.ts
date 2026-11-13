// Reactivity pass, part 1: run the React Compiler on each file and decide what every
// component-body value becomes in Solid. Results go to workflow state for the contracts step.
import type { Codemod } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import { acquireLock, getState, setState } from "codemod:workflow";
import { decide, extract } from "../lib/reactivity.mjs";

const codemod: Codemod<TSX> = (root) => {
  const result = decide(extract(root.root().text(), root.filename()));
  const release = acquireLock("r2s.analysis");
  try {
    setState("r2s.analysis", { ...(getState("r2s.analysis") ?? {}), [root.relativeFilename()]: result });
  } finally {
    release();
  }
  return null;
};
export default codemod;
