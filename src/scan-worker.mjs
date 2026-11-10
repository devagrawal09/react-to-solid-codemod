// One scan worker: extracts and decides the files the main thread sends, one message per file.
import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { extract } from "./extract.mjs";
import { decide } from "./decide.mjs";

parentPort.on("message", (file) => {
  const code = fs.readFileSync(file, "utf8");
  const r = decide(extract(code, file));
  // With --compare, files a pre-step touched also run without the pre-steps, to measure them.
  if (workerData.compare && r.functions.some((f) => f.tryPrestep)) {
    const before = extract(code, file, { prestep: false });
    r.before = before.functions.map((f) => ({ loc: f.loc, status: f.compiler.status, reason: f.compiler.reason ?? null }));
  }
  parentPort.postMessage(r);
});
