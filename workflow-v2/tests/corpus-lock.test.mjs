import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lockCorpus } from "./corpus/lock.mjs";

// The corpus harness's lock: one run per cache (tests/corpus/lock.mjs).
const dirs = [];
const children = [];
const lockIn = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r2s-lock-"));
  dirs.push(dir);
  return path.join(dir, "corpus.lock");
};
// Another live process, as the run that holds the lock.
const otherRun = (seconds) => {
  const child = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${seconds * 1000})`], { stdio: "ignore" });
  children.push(child);
  return child;
};
const startOf = (pid) => {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
};
const held = (file, pid, start = startOf(pid)) => fs.writeFileSync(file, `${JSON.stringify({ pid, start, command: "node tests/corpus.test.mjs", at: "2026-11-20T18:28:00.000Z" })}\n`);

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!fs.existsSync("/proc/self/stat"))("the corpus lock", () => {
  it("is a file with this run's pid while it holds it, removed on release", () => {
    const file = lockIn();
    const release = lockCorpus(file, { log: () => {} });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ pid: process.pid, start: startOf(process.pid) });
    release();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("fails at once while another live run holds it, naming that run", () => {
    const file = lockIn();
    const other = otherRun(30);
    held(file, other.pid);
    expect(() => lockCorpus(file, { log: () => {} })).toThrow(`another corpus run holds ${file}: pid ${other.pid} (node tests/corpus.test.mjs), running since 2026-11-20T18:28:00.000Z`);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).pid).toBe(other.pid);
  });

  it("waits for a live run to finish, then takes the lock", () => {
    const file = lockIn();
    const other = otherRun(1);
    held(file, other.pid);
    const logged = [];
    const release = lockCorpus(file, { waitSeconds: 20, pollSeconds: 0.2, log: (line) => logged.push(line) });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).pid).toBe(process.pid);
    expect(logged[0]).toMatch(/^corpus: waiting for the run that holds .*: pid \d+/);
    release();
  });

  it("takes over a stale lock: an exited run, a reused pid, an unreadable file", () => {
    const exited = spawnSync(process.execPath, ["-e", ""]).pid;
    const reused = otherRun(30).pid;
    for (const stale of [(file) => held(file, exited, "1"), (file) => held(file, reused, "1"), (file) => fs.writeFileSync(file, "{\"pid\": 12")]) {
      const file = lockIn();
      stale(file);
      const logged = [];
      const release = lockCorpus(file, { log: (line) => logged.push(line) });
      expect(JSON.parse(fs.readFileSync(file, "utf8")).pid).toBe(process.pid);
      expect(logged[0]).toMatch(/^corpus: taking over a stale lock/);
      release();
    }
  });

  it("leaves a lock another run holds when releasing", () => {
    const file = lockIn();
    const release = lockCorpus(file, { log: () => {} });
    const other = otherRun(30);
    held(file, other.pid);
    release();
    expect(JSON.parse(fs.readFileSync(file, "utf8")).pid).toBe(other.pid);
  });

  it("stops the harness before it touches the cache while another run holds it", () => {
    const file = lockIn();
    const other = otherRun(30);
    held(file, other.pid);
    const harness = spawnSync(process.execPath, [path.join(import.meta.dirname, "corpus.test.mjs")], { encoding: "utf8", env: { ...process.env, REACT_TO_SOLID_CORPUS_CACHE: path.dirname(file), REACT_TO_SOLID_CORPUS_ONLY: "none" } });
    expect(harness.status).not.toBe(0);
    expect(harness.stderr).toContain(`another corpus run holds ${file}: pid ${other.pid}`);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["corpus.lock"]);
  });
});
