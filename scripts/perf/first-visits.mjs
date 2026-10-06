import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

// The first look at each area vs the second: the longest frame after arriving.
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--remote-debugging-port=9339", `--user-data-dir=${mkdtempSync(join(tmpdir(), "cdp-"))}`, "--window-size=1280,800", "--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11", "about:blank"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tabs;
for (let i = 0; i < 40; i++) {
  try {
    tabs = await (await fetch("http://127.0.0.1:9339/json")).json();
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
const ev = async (fn, arg) => {
  const r = await cmd("Runtime.evaluate", { expression: `(${fn})(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description;
};
await cmd("Runtime.enable");
await cmd("Page.navigate", { url: "http://localhost:5199/" });
for (let i = 0; i < 60 && !(await ev(() => !!window.domain)); i++) await sleep(500);
await sleep(2000);
await ev(() => [...document.querySelectorAll("button")].find((b) => /Enter the office/.test(b.textContent ?? ""))?.click());
await sleep(3000);
const spots = [
  ["open office", -6, 0, 0],
  ["your office", 13, 9, Math.PI],
  ["game room", 12, 22, 0],
  ["kitchen", -15, 22, 0],
  ["lobby", 3, 24, 0],
  ["outside", 0, 40, 0],
  ["behind (track)", 0, -30, Math.PI],
  ["floor 2", 60, 0, 0],
];
const { writeFileSync } = await import("node:fs");
await cmd("Profiler.enable");
await cmd("Profiler.setSamplingInterval", { interval: 100 });
for (const round of ["first", "second"]) {
  for (const [name, x, z, f] of spots) {
    const prof = round === "first" && name === process.env.SPOT;
    if (prof) await cmd("Profiler.start");
    const worst = await ev(
      async ([x, z, f]) => {
        const progs = () => (window.domain.world.renderer.info.programs ?? []).map((p) => p.name + "#" + p.cacheKey.length + ":" + p.cacheKey.slice(0, 60));
        const before = new Set(progs());
        window.domain.player.placeAt(x, z, f);
        const frames = [];
        let last = performance.now();
        await new Promise((done) => {
          const tick = (t) => {
            frames.push(t - last);
            last = t;
            if (frames.length < 40) requestAnimationFrame(tick);
            else done();
          };
          requestAnimationFrame(tick);
        });
        const fresh = progs().filter((p) => !before.has(p));
        return Math.round(Math.max(...frames)) + (fresh.length ? " NEW PROGRAMS: " + fresh.join(" | ") : "");
      },
      [x, z, f],
    );
    if (prof) writeFileSync(process.env.OUT, JSON.stringify((await cmd("Profiler.stop")).result.profile));
    console.log(`${round.padEnd(6)} ${String(name).padEnd(16)} worst frame ${worst} ms`);
    await sleep(600);
  }
}
chrome.kill();
process.exit(0);
