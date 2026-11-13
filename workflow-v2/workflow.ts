// React -> Solid 2 migration on the code-first engine.
//
//   codemod workflow run -w workflow.ts -t <app> [--param include=src] [--param agent=true]
//
// 1. Guard: the target is a React app, and which of its libraries have a Solid port.
// 2. Reactivity pass: the React Compiler (run inside jssg, no Node) decides what each
//    component-body value becomes; a whole-program pass works out what each hook returns.
// 3. Rule pass: mechanical rewrites (props, hooks, JSX, imports), with flags for the rest.
// 4. Verify: eslint-plugin-solid's Solid 2 config on the migrated files.
// 5. Optionally hand the flagged spots to an agent, after an approval.
import { step, forEachFile, jssg, shell, agent, approval, branch, commit, getState, setState } from "codemod:workflow";

// React libraries and their Solid 2 ports. A dependency step will replace this table.
const PORTS: Record<string, string> = {
  react: "solid-js",
  "react-dom": "@solidjs/web",
  "@tanstack/react-query": "@tanstack/solid-query",
  "@tanstack/react-router": "@tanstack/solid-router",
  "react-router": "@solidjs/router",
  "react-router-dom": "@solidjs/router",
  "lucide-react": "lucide-solid",
  "@base-ui-components/react": "@solidports/base-ui",
};
const NOT_SHIPPED = /^(@types\/|babel-plugin-react-compiler$|eslint-plugin-react|@vitejs\/plugin-react|typescript$)/;

export default async function main({ params }: { params: { include?: string; agent?: string } }) {
  const root = (params.include ?? "src").replace(/\/$/, "");
  const sources = { include: [`${root}/**/*.tsx`, `${root}/**/*.ts`], exclude: ["**/*.test.*", "**/*.spec.*", "**/*.d.ts"] };

  const manifests = await step("Read package.json files", forEachFile("**/package.json", (file) => {
    const pkg = JSON.parse(file.text);
    return { path: file.path, deps: { ...pkg.peerDependencies, ...pkg.devDependencies, ...pkg.dependencies } };
  }));
  const plan = await step("Check React libraries for Solid ports", () => {
    const deps: Record<string, string> = {};
    for (const m of manifests.outputs as { deps: Record<string, string> }[]) Object.assign(deps, m.deps);
    if (!deps.react) throw new Error("No package.json here depends on react; nothing to migrate.");
    const reactish = Object.keys(deps).filter((name) => /react/i.test(name) && !NOT_SHIPPED.test(name)).sort();
    return {
      react: deps.react,
      usesReactCompiler: "babel-plugin-react-compiler" in deps,
      ported: reactish.filter((name) => PORTS[name]).map((name) => `${name} -> ${PORTS[name]}`),
      noPort: reactish.filter((name) => !PORTS[name]),
    };
  });

  await step(branch("react-to-solid-2"));
  const analyzed = await step("Run the React Compiler on each file", jssg("./scripts/analyze.ts", { language: "tsx", ...sources }));
  const files = Object.keys(getState()).filter((key) => key.startsWith("r2s.analysis:")).map((key) => key.slice("r2s.analysis:".length)).sort();
  if (files.length === 0) return { plan, files: 0, note: `no .ts/.tsx files under ${root}` };
  await step("Resolve hook contracts across files", jssg("./scripts/contracts.ts", { language: "tsx", files: [files[0]], params: { files } }));
  const reactive = await step("Rewrite values as signals, memos and accessors", jssg("./scripts/rewrite.ts", { language: "tsx", files }));
  const rules = await step("Apply the React to Solid rules", jssg("./scripts/rules.ts", { language: "tsx", files }));
  await step(commit("Convert React components to Solid 2", { add: files }));

  const report = await step("Summarize the conversion", () =>
    summarize(files, (file) => getState(`r2s.decided:${file}`), (file) => getState(`r2s.rules:${file}`)));
  // Shell steps get every state value as an environment variable, and per-file analysis is too
  // big for that on a real app, so drop it once the summary has it.
  for (const file of files) for (const kind of ["analysis", "decided", "rules"]) setState(`r2s.${kind}:${file}`, null);

  await step("Install the Solid 2 lint", shell(`cd "$CODEMOD_PATH/lint" && { [ -x node_modules/.bin/eslint ] || npm ci --silent --no-audit --no-fund; }`));
  await step("Lint with eslint-plugin-solid (Solid 2 config)", shell(
    `"$CODEMOD_PATH/lint/node_modules/.bin/eslint" -c "$CODEMOD_PATH/lint/eslint.config.mjs" -f json ${files.map((f) => `'${f}'`).join(" ")} | node "$CODEMOD_PATH/lint/summarize.mjs"`,
    { cwd: "." },
  ));
  const lint = getState("r2s.lint") ?? {};

  if (params.agent === "true" && report.flags.length) {
    await step(approval(`Hand ${report.flags.length} flagged spots to an agent?`));
    await step("Finish flagged spots", agent(agentPrompt(report.flags), { maxSteps: 40 }));
  }
  return { plan, analyzed: analyzed.unmodified + analyzed.failures.length, rewritten: reactive.changes, rules: rules.changes, ...report, lint };
}

function summarize(files: string[], decided: (file: string) => any, ruleResults: (file: string) => any) {
  const decisions: Record<string, number> = {};
  const compiler: Record<string, number> = {};
  for (const file of files) {
    for (const fn of decided(file)?.functions ?? []) {
      compiler[fn.compiler?.status ?? "none"] = (compiler[fn.compiler?.status ?? "none"] ?? 0) + 1;
      for (const v of fn.values ?? []) decisions[v.decision] = (decisions[v.decision] ?? 0) + 1;
    }
  }
  const applied: Record<string, number> = {};
  const flags: { file: string; line: number; kind: string; detail: string }[] = [];
  for (const file of files) {
    for (const [rule, n] of Object.entries(ruleResults(file)?.applied ?? {})) applied[rule] = (applied[rule] ?? 0) + (n as number);
    for (const f of ruleResults(file)?.flags ?? []) flags.push({ file, ...f });
  }
  return { compiler, decisions, applied, flags };
}

function agentPrompt(flags: { file: string; line: number; kind: string; detail: string }[]) {
  return [
    "These files were converted from React to Solid 2 by a codemod. Finish the spots it flagged.",
    "Keep each `// solid:` note accurate. Do not touch code that was not flagged.",
    ...flags.map((f) => `- ${f.file}:${f.line} ${f.kind}: ${f.detail}`),
  ].join("\n");
}
