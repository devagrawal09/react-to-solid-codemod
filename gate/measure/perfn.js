// perfn.js <file-old> <file-new> <file-fin> : diff lines per top-level function (old vs new vs fin)
const fs = require("fs");
const prettier = require("/home/user/rules/measure/node_modules/prettier");
const split = (t) => {
  const out = new Map(); let cur = "(top)";
  for (const l of t.split("\n")) {
    const m = l.match(/^(?:export )?(?:default )?(?:function|const|let) (\w+)/);
    if (m) cur = m[1];
    const s = l.trim().replace(/\} as const,/, "},");
    if (!s || s.startsWith("// solid:") || /^import\b/.test(s)) continue;
    (out.get(cur) || out.set(cur, []).get(cur)).push(s);
  }
  return out;
};
const lcs = (a, b) => { const n=a.length,m=b.length,dp=Array.from({length:n+1},()=>new Int32Array(m+1)); for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--)dp[i][j]=a[i]===b[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]); return n+m-2*dp[0][0]; };
(async () => {
  const [O, N, F] = await Promise.all(process.argv.slice(2, 5).map(async (f) => split(await prettier.format(fs.readFileSync(f, "utf8"), { parser: "typescript", printWidth: 100 }).catch(() => fs.readFileSync(f, "utf8")))));
  const names = new Set([...O.keys(), ...N.keys(), ...F.keys()]);
  for (const n of names) { const o = lcs(O.get(n) || [], F.get(n) || []), nn = lcs(N.get(n) || [], F.get(n) || []); if (o || nn) console.log(`${n.padEnd(40)} old ${String(o).padStart(4)} new ${String(nn).padStart(4)}${/^use[A-Z]/.test(n) ? "  (hook)" : ""}`); }
})();
