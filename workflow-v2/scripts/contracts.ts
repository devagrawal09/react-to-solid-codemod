// Reactivity pass, part 2: the whole-program hook-contract pass. It needs every file's analysis
// at once, so the workflow runs this transform on a single file and it works from state.
import type { Codemod } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import { getState, setState } from "codemod:workflow";
import { applyContracts } from "../lib/reactivity.mjs";

const codemod: Codemod<TSX> = () => {
  const analysis: Record<string, any> = getState("r2s.analysis") ?? {};
  applyContracts(Object.values(analysis));
  setState("r2s.decided", analysis);
  return null;
};
export default codemod;
