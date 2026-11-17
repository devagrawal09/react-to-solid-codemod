# Runs one jssg spike over a target and records wall time and the child's peak RSS.
import json, resource, subprocess, sys, time
binary, script, target, out = sys.argv[1:5]
threads = sys.argv[5] if len(sys.argv) > 5 else None
cmd = [binary, "jssg", "run", script, "--language", "tsx", "--target", target, "--dry-run", "--no-interactive", "--allow-dirty", "--disable-analytics", "--no-color"]
if threads: cmd += ["--max-threads", threads]
t = time.time()
p = subprocess.run(cmd, cwd="/home/user/src/rc-spike", capture_output=True, text=True)
wall = time.time() - t
rss = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 1024
open(out, "w").write(p.stdout + p.stderr)
print(json.dumps({"script": script, "target": target, "threads": threads, "exit": p.returncode, "wallS": round(wall, 2), "peakRssMB": round(rss)}))
