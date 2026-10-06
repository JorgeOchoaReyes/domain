import { readFileSync } from "node:fs";

// Inclusive time per function of OUR code (src/client), from a .cpuprofile: where in our code the frame goes.
const prof = JSON.parse(readFileSync(process.argv[2], "utf8"));
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const ours = (n) => /\/src\/client\//.test(n.callFrame.url) || /\/(main|world|props|extras|cars|player|ambience|rooms|hud|fx|characters|minigames|parkland|upstairs|gameroom|office|boards|laptop)\.ts/.test(n.callFrame.url);
const label = (n) => `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()?.split("?")[0]}:${n.callFrame.lineNumber + 1}`;
const incl = new Map();
const leafOwner = new Map();
let total = 0;
prof.samples.forEach((sid, i) => {
  const us = prof.timeDeltas[i] ?? 0;
  total += us;
  const seen = new Set();
  let first = null;
  for (let id = sid; id !== undefined; id = parent.get(id)) {
    const n = byId.get(id);
    if (!n) break;
    if (ours(n)) {
      const k = label(n);
      if (!first) first = k;
      if (!seen.has(k)) {
        seen.add(k);
        incl.set(k, (incl.get(k) ?? 0) + us);
      }
    }
  }
  if (first) leafOwner.set(first, (leafOwner.get(first) ?? 0) + us);
});
const pct = (us) => `${((us / total) * 100).toFixed(1).padStart(5)}%`;
console.log("Inclusive (our functions, top 30):");
for (const [k, us] of [...incl].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`${pct(us)}  ${k}`);
console.log("\nNearest of our functions to where time is spent (top 25):");
for (const [k, us] of [...leafOwner].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${pct(us)}  ${k}`);
