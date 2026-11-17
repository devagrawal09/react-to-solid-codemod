// Builds the three corpora as {name, file, code} lists.
import fs from "node:fs";
import path from "node:path";
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx|ts|jsx|js)$/.test(e.name) && !/\.(test|spec|d)\.|\.stories\./.test(e.name)) out.push(p);
  }
  return out;
};
export function specs() {
  const src = fs.readFileSync("/home/user/src/react-to-solid-codemod/test/decide.test.mjs", "utf8");
  const out = [];
  for (const m of src.matchAll(/`([^`]*function [^`]*)`/g)) if (!m[1].includes("${")) out.push({ corpus: "specs", file: `spec-${out.length}.tsx`, code: m[1] });
  return out;
}
export function dir(corpus, root) {
  return walk(root).map((p) => ({ corpus, file: path.relative(root, p), code: fs.readFileSync(p, "utf8") }));
}
export const all = () => [
  ...specs(),
  ...dir("t3code-web", "/home/user/src/t3code/apps/web/src"),
  ...dir("codemod-app-nextjs", "/home/user/codemod-app/apps/nextjs/src"),
];
