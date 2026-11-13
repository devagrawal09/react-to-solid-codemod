// Rule pass: the mechanical React -> Solid 2 rewrites (props, hooks, JSX, imports). What a rule
// can't do safely is recorded as a flag for the report.
import type { Codemod } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import { parse } from "codemod:ast-grep";
import { setState } from "codemod:workflow";
import { transform } from "../rules/mechanical.mjs";

const codemod: Codemod<TSX> = (root) => {
  // The rewrite step adds its own createMemo import; the rule pass writes the full solid-js import.
  const code = root.root().text().replace(/^import \{ createMemo \} from "solid-js";\n/m, "");
  const { code: out, applied, flags } = transform(code, { parse, Lang: { Tsx: "tsx" } });
  setState(`r2s.rules:${root.relativeFilename()}`, { applied, flags });
  return out === root.root().text() ? null : out;
};
export default codemod;
