// Reactivity pass, part 3: write each value as the Solid code its decision calls for, with a
// `// solid:` note above it.
import type { Codemod } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import { getState } from "codemod:workflow";
import { rewrite } from "../lib/reactivity.mjs";

const codemod: Codemod<TSX> = (root) => {
  const result = getState(`r2s.decided:${root.relativeFilename()}`);
  if (!result || result.parseError) return null;
  const code = root.root().text();
  const out = rewrite(code, result).code;
  return out === code ? null : out;
};
export default codemod;
