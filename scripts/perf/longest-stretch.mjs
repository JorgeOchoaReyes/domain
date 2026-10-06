import { readFileSync } from "node:fs";

// The longest stretch of uninterrupted main-thread work in a .cpuprofile, and what it was doing.
const prof = JSON.parse(readFileSync(process.argv[2], "utf8"));
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const name = (n) => n.callFrame.functionName || "(anon)";
const label = (n) => `${name(n)} ${n.callFrame.url.split("/").pop()?.split("?")[0]}:${n.callFrame.lineNumber + 1}`;
let t = prof.startTime;
const samples = prof.samples.map((sid, i) => {
  t += prof.timeDeltas[i] ?? 0;
  return { sid, t, dt: prof.timeDeltas[i] ?? 0, idle: name(byId.get(sid)) === "(idle)" };
});
// Contiguous busy spans.
let best = { start: 0, end: 0, from: 0, to: 0 };
let from = -1;
for (let i = 0; i < samples.length; i++) {
  if (!samples[i].idle && from < 0) from = i;
  if ((samples[i].idle || i === samples.length - 1) && from >= 0) {
    const span = samples[i].t - samples[from].t;
    if (span > best.end - best.start) best = { start: samples[from].t, end: samples[i].t, from, to: i };
    from = -1;
  }
}
console.log(`longest busy stretch: ${((best.end - best.start) / 1000).toFixed(0)} ms at +${((best.start - prof.startTime) / 1e6).toFixed(2)} s`);
const incl = new Map();
let total = 0;
for (let i = best.from; i < best.to; i++) {
  const s = samples[i];
  total += s.dt;
  const seen = new Set();
  for (let id = s.sid; id !== undefined; id = parent.get(id)) {
    const n = byId.get(id);
    if (!n) break;
    const k = label(n);
    if (seen.has(k)) continue;
    seen.add(k);
    incl.set(k, (incl.get(k) ?? 0) + s.dt);
  }
}
for (const [k, us] of [...incl].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`${(us / 1000).toFixed(0).padStart(5)} ms  ${k}`);
