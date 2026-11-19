// React -> Solid 2 migration on the code-first engine.
//
//   codemod workflow run -w src/workflow.ts -t <app> [--param include=src] [--param apply=true] [--param agent=true]
//
// Without apply=true the run is a preview: it converts every file in memory and reports
// what it would change, flags included, and writes nothing.
//
// 1. Guard: the target is a React app, and which of its libraries have a Solid port.
// 2. Reactivity pass: the React Compiler (run inside jssg, no Node) decides what each
//    component-body value becomes; a whole-program pass works out what each hook returns.
// 3. Rule pass: mechanical rewrites (props, hooks, JSX, imports), with flags for the rest.
// 4. Verify: eslint-plugin-solid's Solid 2 config on the migrated files.
// 5. Optionally hand the flagged spots to an agent, after an approval.
import { step, forEachFile, shell, agent, approval, branch, commit } from "codemod/workflow";
import { parse } from "codemod/ast-grep";
import { applyContracts, decide, extract, rewrite } from "./lib/reactivity.mjs";
import { transform } from "./rules/mechanical.mjs";

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

export default async function main({ params }: { params: { include?: string; apply?: boolean | string; agent?: boolean | string } }) {
  // --param values arrive as JSON when they parse as JSON, so true is a boolean.
  const apply = params.apply === true || params.apply === "true";
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

  if (apply) await step(branch("react-to-solid-2"));
  // Each step returns its per-file results; nothing goes through state.
  const analyzed = await step("Run the React Compiler on each file", forEachFile(sources, (file) =>
    // contracts.mjs finds `~/` imports by an absolute-looking path. The round trip drops the
    // `undefined` fields the pass leaves, which step outputs reject.
    ({ file: file.path, result: JSON.parse(JSON.stringify(decide(extract(file.text, `/${file.path}`)))) })));
  const files = analyzed.outputs.map((o) => o.file);
  if (files.length === 0) return { plan, files: 0, note: `no .ts/.tsx files under ${root}` };
  const decided = await step("Resolve hook contracts across files", () => {
    // Step results are frozen; applyContracts edits its input. (No structuredClone in function steps.)
    const results = analyzed.outputs.map((o) => JSON.parse(JSON.stringify(o.result)));
    applyContracts(results);
    return Object.fromEntries(files.map((file, i) => [file, results[i]]));
  });
  // One pass per file: the compiler's decisions, then the rules on that text. A preview
  // stops before writing.
  const converted = await step(apply ? "Convert each file to Solid 2" : "Preview the conversion of each file", forEachFile(sources, (file) => {
    const result = decided[file.path];
    let code = file.text;
    if (result && !result.parseError) {
      // The rewrite adds its own createMemo import; the rule pass writes the full solid-js import.
      code = rewrite(code, result).code.replace(/^import \{ createMemo \} from "solid-js";\n/m, "");
    }
    const { code: out, applied, flags } = transform(code, { parse: (language: string, text: string) => parse(text, { language }), Lang: { Tsx: "tsx" } });
    const changed = out !== file.text;
    if (apply && changed) file.write(out);
    return { file: file.path, changed, applied, flags };
  }));
  const changed = converted.outputs.filter((o) => o.changed).map((o) => o.file);
  const report = await step("Summarize the conversion", () =>
    summarize(files, decided, converted.outputs));
  const result = { plan, analyzed: files.length, failures: [...analyzed.failures, ...converted.failures], ...report };

  if (!apply) {
    console.log(`Preview: ${changed.length} of ${files.length} files would change, with ${report.flags.length} flagged spots to finish by hand. Nothing was written; run again with --param apply=true to convert them.`);
    return { ...result, preview: true, wouldChange: changed };
  }
  await step(commit("Convert React components to Solid 2", { add: files }));

  const lintDir = `${import.meta.dirname}/lint`;
  await step("Install the Solid 2 lint", shell`cd ${lintDir} && { [ -x node_modules/.bin/eslint ] || npm ci --silent --no-audit --no-fund >&2; }`);
  // Paths are relative to the target, so the command runs there (cwd "."), not in the CLI's
  // directory. summarize.mjs prints its summary as the last line of stdout.
  const linted = await step("Lint with eslint-plugin-solid (Solid 2 config)", shell({ cwd: "." })`${lintDir}/node_modules/.bin/eslint -c ${lintDir}/eslint.config.mjs -f json ${files} | node ${lintDir}/summarize.mjs`);
  let lint = {};
  try {
    lint = JSON.parse(linted.stdout?.trimEnd().split("\n").pop() ?? "");
  } catch {
    // A dry run skips shell steps; only the last 1 MiB of output comes back.
  }

  if ((params.agent === true || params.agent === "true") && report.flags.length) {
    await step(approval(`Hand ${report.flags.length} flagged spots to an agent?`));
    await step("Finish flagged spots", agent(agentPrompt(report.flags), { maxSteps: 40 }));
  }
  return { ...result, changed, lint };
}


function summarize(files: string[], decided: Record<string, any>, ruleResults: { file: string; applied: Record<string, number>; flags: any[] }[]) {
  const decisions: Record<string, number> = {};
  const compiler: Record<string, number> = {};
  for (const file of files) {
    for (const fn of decided[file]?.functions ?? []) {
      compiler[fn.compiler?.status ?? "none"] = (compiler[fn.compiler?.status ?? "none"] ?? 0) + 1;
      for (const v of fn.values ?? []) decisions[v.decision] = (decisions[v.decision] ?? 0) + 1;
    }
  }
  const applied: Record<string, number> = {};
  const flags: { file: string; line: number; kind: string; detail: string }[] = [];
  for (const r of ruleResults) {
    for (const [rule, n] of Object.entries(r.applied)) applied[rule] = (applied[rule] ?? 0) + n;
    for (const f of r.flags) flags.push({ file: r.file, ...f });
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
