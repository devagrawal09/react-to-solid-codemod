import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GUIDE, KINDS, renderWorklist } from "../src/worklist.mjs";

const checked = { status: "checked", detail: "TypeScript 6.0.3 on tsconfig.json, 1 chunk" };
const render = (input) => renderWorklist({ mode: "apply", root: "src", flags: [], errors: [], order: [], typecheck: checked, commands: ["npm install"], ...input });
// The task lines (`- [ ] ...`) and the type errors under them, without the guidance.
const outline = (md) => md.split("\n").filter((line) => /^(## |- \[ \] |  - `)/.test(line));

describe("the work list", () => {
  it("puts project files first, by path, then the source files in dependency order", () => {
    const flags = [
      { file: "src/App.tsx", line: 3, kind: "custom hook call", detail: "d" },
      { file: "src/hooks/useA.ts", line: 2, kind: "effect", detail: "d" },
      { file: "package.json", line: 0, kind: "dependency", detail: "d" },
      { file: "src/z.tsx", line: 1, kind: "list key", detail: "d" },
      { file: "src/a.tsx", line: 1, kind: "list key", detail: "d" },
      { file: ".", line: 0, kind: "build config", detail: "d" },
    ];
    // The hook-contract pass's order: every source file, each after the files it imports.
    const md = render({ flags, order: ["src/z.tsx", "src/hooks/useA.ts", "src/App.tsx", "src/a.tsx"] });
    expect(md.split("\n").filter((line) => line.startsWith("## "))).toEqual(["## `.`", "## `package.json`", "## `src/z.tsx`", "## `src/hooks/useA.ts`", "## `src/App.tsx`", "## `src/a.tsx`", "## Re-verify"]);
  });

  it("lists a file's tasks in line order, each with its severity, the converted line and the note above it", () => {
    const flags = [
      { file: "src/C.tsx", line: 9, kind: "effect read", detail: "x is read", excerpt: "createEffect(() => a(), (a) => {" },
      { file: "src/C.tsx", line: 4, kind: "custom hook call", detail: "useX() returns values in React", excerpt: "const x = useX();", note: "// solid: x: hook (`useX` is unknown)" },
    ];
    const md = render({ flags });
    expect(md).toContain([
      "- [ ] `src/C.tsx:4` **custom hook call**: Behaves differently",
      "  ```tsx",
      "  // solid: x: hook (`useX` is unknown)",
      "  const x = useX();",
      "  ```",
      "  Flag: useX() returns values in React",
      `  Do: ${KINDS["custom hook call"].do}`,
      `  Guide: ${GUIDE}#top-level-reactive-read-in-a-component`,
      "- [ ] `src/C.tsx:9` **effect read**: Cleanup",
    ].join("\n"));
    expect(md).toContain("2 flagged spots in 1 file: 0 will not build, 1 behave differently, 1 cleanup.");
  });

  it("quotes a line once when it has several flags", () => {
    const flags = [
      { file: "src/C.tsx", line: 4, kind: "render-dependent read", detail: "a", excerpt: "const x = useX(props.a);" },
      { file: "src/C.tsx", line: 4, kind: "custom hook call", detail: "b", excerpt: "const x = useX(props.a);" },
    ];
    expect(render({ flags }).split("const x = useX(props.a);")).toHaveLength(2);
  });

  it("puts each type error with the flag on its line, else the innermost flagged code around it, else lists it as unflagged", () => {
    const flags = [
      { file: "src/C.tsx", line: 2, end: 30, kind: "class component", detail: "class" },
      { file: "src/C.tsx", line: 10, end: 12, kind: "effect", detail: "effect" },
      { file: "src/C.tsx", line: 11, kind: "React API", detail: "api" },
      { file: "src/C.tsx", line: 11, kind: "render-dependent read", detail: "read" },
    ];
    const errors = [
      { file: "src/C.tsx", line: 11, column: 3, code: "TS2304", message: "Cannot find name 'useLayoutEffect'." },
      { file: "src/C.tsx", line: 12, column: 5, code: "TS2339", message: "in the effect" },
      { file: "src/C.tsx", line: 20, column: 7, code: "TS2339", message: "in the class" },
      { file: "src/C.tsx", line: 40, column: 1, code: "TS2307", message: "Cannot find module 'react'." },
      { file: "src/C.tsx", line: 40, column: 9, code: "TS2322", message: "second on the line" },
      { file: "src/D.tsx", line: 1, column: 1, code: "TS9999", message: "a file with no flags" },
    ];
    const md = render({ flags, errors });
    expect(outline(md)).toEqual([
      "## `src/C.tsx`",
      "- [ ] `src/C.tsx:2` **class component**: Will not build",
      "  - `20:7` TS2339: in the class",
      "- [ ] `src/C.tsx:10` **effect**: Will not build",
      "  - `12:5` TS2339: in the effect",
      "- [ ] `src/C.tsx:11` **React API**: Will not build",
      "  - `11:3` TS2304: Cannot find name 'useLayoutEffect'.",
      "- [ ] `src/C.tsx:11` **render-dependent read**: Behaves differently",
      "- [ ] `src/C.tsx:40` **type error** (unflagged): Will not build",
      "  - `40:1` TS2307: Cannot find module 'react'.",
      "  - `40:9` TS2322: second on the line",
      "## `src/D.tsx`",
      "- [ ] `src/D.tsx:1` **type error** (unflagged): Will not build",
      "  - `1:1` TS9999: a file with no flags",
      "## Re-verify",
    ]);
    // An unflagged error's advice is its code's, one line for each code on the line.
    expect(md).toContain("  Do: No flag covers this line. A module that isn't installed any more: React, or a React library with no Solid 2 port");
    expect(md).toMatch(/imported by code left as React's\. See this file's flags and package\.json's\. A value of a type Solid doesn't take there/);
    expect(md).toContain("  Do: No flag covers this line. Read the error with the converted code");
    expect(md).toContain("Type-check (TypeScript 6.0.3 on tsconfig.json, 1 chunk): 6 errors in 2 files, 3 in flagged code, 3 unflagged.");
  });

  it("lists an error with no file at the top", () => {
    const md = render({ errors: [{ file: "", line: 0, column: 0, code: "TS5083", message: "Cannot read file 'tsconfig.base.json'." }] });
    expect(md).toContain("1 error in 1 file, 0 in flagged code, 0 unflagged, 1 outside any file.");
    expect(md).toContain("Type-check errors outside any file:\n\n- TS5083: Cannot read file 'tsconfig.base.json'.");
  });

  it("says what a preview's list is, and why a type-check was skipped", () => {
    expect(render({ mode: "preview", typecheck: null })).toMatch(/A preview: nothing was converted\. These are the spots that would be left after `--param apply=true`[\s\S]*Type-check: only after an apply\./);
    expect(render({ typecheck: { status: "skipped", detail: "solid-js isn't installed where . resolves it" } })).toContain("Type-check: skipped, solid-js isn't installed where . resolves it.");
  });

  it("ends with the commands that re-verify", () => {
    expect(render({ commands: ["npm install", "npm run typecheck", "npm run build"] })).toMatch(/## Re-verify\n\n```sh\nnpm install\nnpm run typecheck\nnpm run build\n```\n$/);
  });

  it("has guidance for every kind of flag the run raises", () => {
    // The kinds in flag("...") calls and kind: "..." flag objects (not ast-grep's node kinds).
    const src = path.resolve(import.meta.dirname, "../src");
    const raised = new Set();
    for (const file of ["rules/mechanical.mjs", "manifests.mjs", "nextjs.mjs", "workflow.ts"]) {
      const text = fs.readFileSync(path.join(src, file), "utf8");
      for (const m of text.matchAll(/\bflag\("([^"]+)"/g)) raised.add(m[1]);
      for (const m of text.matchAll(/kind: "([^"]+)", (?:line: [^,]+, )?detail/g)) raised.add(m[1]);
    }
    expect(raised.size).toBeGreaterThan(30);
    expect([...raised].filter((kind) => !KINDS[kind])).toEqual([]);
  });
});
