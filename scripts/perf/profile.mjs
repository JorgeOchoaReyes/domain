import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

// Profile the office with workers busy: frame times (long frames), and where the main thread's time goes.
const out = process.argv[2];
const where = process.argv[3] ?? "office"; // office | outside
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--remote-debugging-port=9338", `--user-data-dir=${mkdtempSync(join(tmpdir(), "cdp-"))}`, "--window-size=1280,800", "--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11", "about:blank"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tabs;
for (let i = 0; i < 40; i++) {
  try {
    tabs = await (await fetch("http://127.0.0.1:9338/json")).json();
    break;
  } catch {
    await sleep(250);
  }
}
const ws = new WebSocket(tabs.find((t) => t.type === "page").webSocketDebuggerUrl, { maxPayload: 1 << 30 });
await new Promise((r) => ws.once("open", r));
let id = 0;
const wait = new Map();
ws.on("message", (d) => {
  const m = JSON.parse(d);
  if (m.id && wait.has(m.id)) {
    wait.get(m.id)(m);
    wait.delete(m.id);
  }
});
const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (fn) => {
  const r = await cmd("Runtime.evaluate", { expression: `(${fn})()`, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description;
};
await cmd("Runtime.enable");
await cmd("Page.navigate", { url: "http://localhost:5199/" });
for (let i = 0; i < 60 && !(await ev(() => !!window.domain)); i++) await sleep(500);
await sleep(2000);
await ev(() => [...document.querySelectorAll("button")].find((b) => /Enter the office/.test(b.textContent ?? ""))?.click());
await sleep(2000);
console.log("renderer:", await ev(() => { const gl = document.createElement("canvas").getContext("webgl2"); const d = gl?.getExtension("WEBGL_debug_renderer_info"); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "?"; }));
// Fill desks with (simulated) workers and give them work, so the office is busy.
await ev(async () => {
  const d = window.domain;
  const free = d.office().desks.filter((x) => !x.worker).slice(0, 8);
  for (const desk of free) d.net.send({ t: "hire", deskId: desk.id, agent: ["claude", "codex", "opencode", "gemini"][Math.floor(Math.random() * 4)] });
  await new Promise((r) => setTimeout(r, 4000));
  for (const desk of d.office().desks.filter((x) => x.worker)) d.net.send({ t: "quickTask", deskId: desk.id, text: `Busy work for ${desk.id}` });
});
await sleep(3000);
if (where === "outside") await ev(() => window.domain.player.placeAt(0, 40, 0));
else await ev(() => window.domain.player.placeAt(-6, 0, 0));
await sleep(2000);

// Frame times for 10 s, and messages from the server meanwhile.
await ev(() => {
  window.__frames = [];
  window.__t0 = Math.round(performance.now());
  let last = performance.now();
  const tick = (t) => { window.__frames.push(t - last); if (t - last > 40) (window.__slow ??= []).push([Math.round(last - window.__t0), Math.round(t - last)]); last = t; if (window.__frames.length < 100000) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  window.__msgs = {};
  const net = window.domain.net;
  const ws = net.ws ?? net.socket;
  window.__msgLog = [];
  if (ws) ws.addEventListener("message", (e) => { try { const t = JSON.parse(e.data).t; window.__msgs[t] = (window.__msgs[t] ?? 0) + 1; window.__msgLog.push([Math.round(performance.now()), t]); } catch {} });
  window.__long = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: "longtask", buffered: true }); } catch {}
});
const PROF = !process.env.NOPROF;
if (PROF) {
  await cmd("Profiler.enable");
  await cmd("Profiler.setSamplingInterval", { interval: 200 });
  await cmd("Profiler.start");
}
// Walk around a bit while it records.
await cmd("Input.dispatchKeyEvent", { type: "keyDown", code: "KeyW", key: "w", windowsVirtualKeyCode: 87 });
await sleep(5000);
await cmd("Input.dispatchKeyEvent", { type: "keyUp", code: "KeyW", key: "w", windowsVirtualKeyCode: 87 });
await sleep(5000);
const prof = PROF ? (await cmd("Profiler.stop")).result.profile : { nodes: [], samples: [], timeDeltas: [] };
const stats = await ev(() => {
  const f = window.__frames.slice(5).sort((a, b) => a - b);
  const q = (p) => f[Math.floor(f.length * p)]?.toFixed(1);
  const over = (ms) => f.filter((x) => x > ms).length;
  return JSON.stringify({ frames: f.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: f.at(-1)?.toFixed(1), over33: over(33), over50: over(50), over100: over(100), slowFrames: window.__slow, longTasks: window.__long, near: window.__long.map(([t]) => window.__msgLog.filter(([m]) => Math.abs(m - t) < 400)), startedAt: window.__t0, msgs: window.__msgs, renderInfo: window.domain.world.renderer?.info?.render, mem: window.domain.world.renderer?.info?.memory });
});
console.log("frames:", stats);

// Self time per function (top 30), and per file.
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const self = new Map();
const dt = prof.timeDeltas;
const counts = new Map();
prof.samples.forEach((sid, i) => counts.set(sid, (counts.get(sid) ?? 0) + (dt[i] ?? 0)));
for (const [nid, us] of counts) {
  const n = byId.get(nid);
  const cf = n.callFrame;
  const key = `${cf.functionName || "(anon)"} ${cf.url.split("/").pop()?.split("?")[0]}:${cf.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + us);
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
const idle = [...self.entries()].filter(([k]) => k.startsWith("(idle)")).reduce((a, [, v]) => a + v, 0);
const nFrames = JSON.parse(stats).frames;
console.log(`BUSY: ${((total - idle) / 1000 / nFrames).toFixed(2)} ms of main thread per frame over ${nFrames} frames (idle ${((idle / total) * 100).toFixed(0)}%)`);
const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 35);
console.log(`\ntotal sampled ${(total / 1000).toFixed(0)} ms; top self time:`);
for (const [k, us] of top) console.log(`${((us / total) * 100).toFixed(1).padStart(5)}%  ${(us / 1000).toFixed(0).padStart(6)} ms  ${k}`);
writeFileSync(join(out, `cpu-${where}.cpuprofile`), JSON.stringify(prof));
chrome.kill();
process.exit(0);
