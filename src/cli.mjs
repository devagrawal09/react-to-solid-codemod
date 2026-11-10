// node src/cli.mjs <out-dir> <file...>
// Writes <name>.json (extractor + decisions), <name>.report.md and <name>.solid.tsx per file.
// Hook contracts are resolved across the files given together.
import fs from "node:fs";
import path from "node:path";
import { extract } from "./extract.mjs";
import { decide } from "./decide.mjs";
import { applyContracts } from "./contracts.mjs";
import { rewrite } from "./rewrite.mjs";
import { report } from "./report.mjs";

export function convertFiles(files) {
  const codes = files.map((file) => fs.readFileSync(file, "utf8"));
  const results = files.map((file, i) => decide(extract(codes[i], path.resolve(file))));
  applyContracts(results);
  return results.map((result, i) => {
    const rewritten = rewrite(codes[i], result);
    return { file: files[i], result, rewritten, markdown: report(result, rewritten) };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [outDir, ...files] = process.argv.slice(2);
  fs.mkdirSync(outDir, { recursive: true });
  for (const { file, result, rewritten, markdown } of convertFiles(files)) {
    const base = path.join(outDir, path.basename(file).replace(/\.[jt]sx?$/, ""));
    fs.writeFileSync(`${base}.json`, JSON.stringify(result, null, 2));
    fs.writeFileSync(`${base}.report.md`, markdown);
    fs.writeFileSync(`${base}.solid${path.extname(file)}`, rewritten.code);
    console.log(`${file}: ${result.ms} ms`);
  }
}
