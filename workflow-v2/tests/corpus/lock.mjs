import fs from "node:fs";

/**
 * One corpus run per cache: two runs on the same cache reset each other's `work/` copies and
 * overwrite each other's `results/`. `lockCorpus(file)` creates the lock file (exclusively), with
 * the run's pid, its start time and its command line, and returns a function that removes it (also
 * called on exit). A lock whose process is gone, or whose pid now belongs to a process that started
 * at another time (a reused pid), is stale and taken over. A live one makes it wait, up to
 * `waitSeconds`, checking every `pollSeconds`, then throw, naming the run that holds it.
 */
export function lockCorpus(file, { waitSeconds = 0, pollSeconds = 30, log = console.error } = {}) {
  const own = { pid: process.pid, start: startTime(process.pid), command: process.argv.join(" "), at: new Date().toISOString() };
  const deadline = Date.now() + waitSeconds * 1000;
  for (let waited = false; ; waited = true) {
    try {
      fs.writeFileSync(file, `${JSON.stringify(own)}\n`, { flag: "wx" });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const text = readText(file);
    if (text === null) continue; // released between the two calls
    let holder = null;
    try {
      holder = JSON.parse(text);
    } catch {
      // Unreadable: a run killed while writing it. Stale.
    }
    if (!holder || !alive(holder)) {
      // Removed only if it's still the lock just read: another run may have taken it over already.
      if (readText(file) === text) fs.rmSync(file, { force: true });
      log(`corpus: taking over a stale lock ${file}${holder ? ` (pid ${holder.pid} ${holder.pid === process.pid ? "is this run" : "has exited"}, since ${holder.at})` : ""}`);
      continue;
    }
    const who = `pid ${holder.pid} (${holder.command}), running since ${holder.at}`;
    if (Date.now() >= deadline) {
      throw new Error(`another corpus run holds ${file}: ${who}. Its clones, work copies and results are in the same cache, so this run would overwrite them. Wait for it to finish, set REACT_TO_SOLID_CORPUS_WAIT=<minutes> to wait for it, or give this run its own REACT_TO_SOLID_CORPUS_CACHE.`);
    }
    if (!waited) log(`corpus: waiting for the run that holds ${file}: ${who}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, Math.min(pollSeconds * 1000, deadline - Date.now())));
  }
  const release = () => {
    if (readText(file) === `${JSON.stringify(own)}\n`) fs.rmSync(file, { force: true });
    process.removeListener("exit", release);
  };
  process.on("exit", release);
  return release;
}

const readText = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

// Fields 3 on of /proc/<pid>/stat (after the command's name): [0] is the state, [19] the start
// time in clock ticks since boot, which tells a reused pid from the run that wrote the lock. null
// where there's no /proc.
function stat(pid) {
  const text = readText(`/proc/${pid}/stat`);
  return text === null ? null : text.slice(text.lastIndexOf(")") + 2).split(" ");
}
const startTime = (pid) => stat(pid)?.[19] ?? null;

// This run's own pid in the lock (a previous run in this process, or the same pid after a reboot)
// is stale: this run is the one asking. So is an exited run its parent hasn't reaped (a zombie).
function alive({ pid, start }) {
  if (!Number.isInteger(pid) || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
  }
  const fields = stat(pid);
  return start === null || fields === null || (fields[0] !== "Z" && fields[19] === start);
}
