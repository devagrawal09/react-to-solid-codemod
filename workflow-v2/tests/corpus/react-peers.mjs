// The corpus harness's own reading of a lockfile's React peers, independent of the workflow's
// (dependencyGraph), so the set of React-only libraries it counts is the same for every version.
import { reactPeerClosure } from "../../src/manifests.mjs";

// The packages in a lockfile that peer on react or react-dom, directly or through a peer that does
// (nuqs peers on next, which peers on react), by name; null when the lockfile doesn't record peers
// (yarn 1). npm's package-lock.json is JSON; pnpm-lock.yaml lists packages two spaces in under
// `packages:`, and yarn berry's yarn.lock at the top level, each with a `peerDependencies:` block,
// read line by line.
export function reactPeers(path, text) {
  const peersOf = new Map();
  if (path.endsWith("package-lock.json")) {
    for (const [key, entry] of Object.entries(JSON.parse(text).packages ?? {})) {
      const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
      if (name) peersOf.set(name, new Set([...(peersOf.get(name) ?? []), ...Object.keys(entry.peerDependencies ?? {})]));
    }
  } else {
    const pnpm = path.endsWith("pnpm-lock.yaml");
    if (!pnpm && !/^__metadata:/m.test(text)) return null;
    const entry = pnpm ? 2 : 0;
    let section = pnpm ? "" : "packages";
    let name = null;
    let peers = false;
    for (const line of text.split("\n")) {
      const indent = line.search(/\S/);
      if (indent < 0 || line.trimStart().startsWith("#")) continue;
      if (pnpm && indent === 0) section = line.trim();
      else if (section !== "packages:" && section !== "packages") continue;
      else if (indent === entry) {
        // 'name@1.0.0':, /name@1.0.0(peer@1):, "name@npm:^1, name@npm:^2":
        const key = line.trim().replace(/:$/, "").replace(/^["']|["']$/g, "").split(",")[0].trim().replace(/^\//, "");
        name = key.match(/^(@?[^@]+)@/)?.[1] ?? null;
        peers = false;
        if (name && !peersOf.has(name)) peersOf.set(name, new Set());
      } else if (indent === entry + 2) peers = line.trim() === "peerDependencies:";
      else if (peers && name && indent === entry + 4) {
        const peer = line.trim().match(/^["']?(@?[^"':]+)["']?:/)?.[1];
        if (peer) peersOf.get(name).add(peer);
      }
    }
  }
  return reactPeerClosure(peersOf);
}
