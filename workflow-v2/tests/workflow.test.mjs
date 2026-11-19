import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Needs a codemod CLI with the code-first engine: codemod@2.0.0-alpha.4 or newer.
const bin = process.env.CODEMOD_BIN;
const workflow = path.resolve(import.meta.dirname, "../src/workflow.ts");
const fixture = path.resolve(import.meta.dirname, "fixtures/todo-app");

function givenApp(edit = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r2s-"));
  fs.cpSync(fixture, dir, { recursive: true });
  edit(dir);
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=spec@example.com", "-c", "user.name=spec", "commit", "-qm", "fixture");
  return dir;
}

function migrate(dir, params = ["apply=true"]) {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "r2s-runs-"));
  const cli = spawnSync(bin, ["workflow", "run", "-w", workflow, "-t", dir, ...params.flatMap((p) => ["--param", p]), "--no-interactive", "--approve", "--disable-analytics", "--no-color"], {
    env: { ...process.env, CODEMOD_RUN_STORE_DIR: store },
    encoding: "utf8",
  });
  const id = `${cli.stdout}${cli.stderr}`.match(/^Run (\S+)/m)[1];
  return JSON.parse(fs.readFileSync(path.join(store, id, "run.json"), "utf8"));
}

const read = (dir, file) => fs.readFileSync(path.join(dir, file), "utf8");

describe.skipIf(!bin)("react-to-solid workflow on a small todo app", { tags: ["slow"] }, () => {
  let app;
  let run;
  beforeAll(() => {
    app = givenApp();
    run = migrate(app);
  }, 120_000);

  it("turns useState into createSignal, reading props through props", () => {
    expect(read(app, "src/components/TodoList.tsx")).toContain("const [todos, setTodos] = createSignal(props.initial);");
  });

  it("makes a value the React Compiler memoized a createMemo", () => {
    expect(read(app, "src/components/TodoList.tsx")).toContain("const visible = createMemo(() =>");
  });

  it("rewrites code after a non-ASCII character in the same file", () => {
    expect(read(app, "src/components/TodoItem.tsx")).toContain('<li title="To do · item" class={className()}>\n      <label for={merged.todo.id}>');
  });

  it("leaves a component with nothing to convert unchanged", () => {
    expect(read(app, "src/App.tsx")).toBe(read(fixture, "src/App.tsx"));
  });

  it("reports what the rules could not convert, with file and line", () => {
    expect(run.output.flags).toContainEqual(expect.objectContaining({ file: "src/components/Clock.tsx", line: 8, kind: "effect" }));
  });

  it("reports eslint-plugin-solid's Solid 2 warnings by rule", () => {
    expect(run.output.lint.byRule).toEqual({ "solid/reactivity": 1 });
  });
});

describe.skipIf(!bin)("react-to-solid workflow without apply=true", { tags: ["slow"] }, () => {
  it("previews the conversion and writes nothing", () => {
    const app = givenApp();
    const run = migrate(app, []);
    expect(run.output.preview).toBe(true);
    expect(run.output.wouldChange).toContain("src/components/TodoList.tsx");
    expect(run.output.flags).toContainEqual(expect.objectContaining({ file: "src/components/Clock.tsx", line: 8, kind: "effect" }));
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: app, encoding: "utf8" })).toBe("");
  });
});

describe.skipIf(!bin)("react-to-solid workflow on a project without React", { tags: ["slow"] }, () => {
  it("fails before changing any file", () => {
    const app = givenApp((dir) => fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "not-react" })));
    expect(migrate(app).error).toContain("No package.json here depends on react");
  });
});
