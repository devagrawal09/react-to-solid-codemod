// Reactivity pass, part 2: the whole-program hook-contract pass. It needs every file's analysis
// at once, so the workflow runs this transform on a single file and passes the file list.
import type { Codemod } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import { getState, setState } from "codemod:workflow";
import { applyContracts } from "../lib/reactivity.mjs";

const codemod: Codemod<TSX> = (_root, options) => {
  const files: string[] = options.params.files;
  const results = files.map((file) => getState(`r2s.analysis:${file}`));
  applyContracts(results);
  files.forEach((file, i) => setState(`r2s.decided:${file}`, results[i]));
  return null;
};
export default codemod;
