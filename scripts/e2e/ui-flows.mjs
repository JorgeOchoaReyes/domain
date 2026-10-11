// The office in the browser, end to end: a simulated office (quick and free) driven
// through Chrome like a person would — hire ready-made agents from the hire card, the
// spoken stand-up with who does what, work done (the phone pings, Arnold offers a
// review), office hours with real slides, the monitor (N, approve), reviews from the
// phone, a task to everyone (someone offers), messaging, the CCTV wall and its chair,
// sitting in your office, your own terminal (💻 Mine), the end-of-day recap and Resume yesterday — plus the dock
// (More), quieter toasts, and 🔔 Needs you (the inbox, and the phone's same list).
//
//   npm run e2e:ui           (needs Chrome; set CHROME to its path if it's elsewhere)
//   E2E_VOICE=1 npm run e2e:ui   also: the stand-up's 🎤 hears a recording (Chrome's fake microphone
//                            plays a WAV) and Whisper on this computer writes it in the box. On Windows
//                            the WAV is spoken by the system voice; elsewhere give one: E2E_VOICE=say.wav
//                            (16-bit, saying "Add a dark mode toggle and fix the login bug"). The first
//                            run downloads the voice model (≈80 MB) into ~/.domain/models.
//
// It starts its own office and page on free ports and cleans up after itself.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const freePort = () =>
  new Promise((r) => {
    const s = createNetServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
const ROOT = mkdtempSync(join(tmpdir(), "domain-ui-e2e-"));
const OUT = join(ROOT, "shots");
mkdirSync(OUT);
const PROJECT = join(ROOT, "project");
mkdirSync(PROJECT);
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: PROJECT });
writeFileSync(join(PROJECT, "README.md"), "hi");
execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qam", "init", "--allow-empty"], { cwd: PROJECT });
// The opt-in voice check: a WAV for Chrome's fake microphone.
const VOICE_SAID = "Add a dark mode toggle and fix the login bug.";
let VOICE_WAV = "";
if (process.env.E2E_VOICE) {
  VOICE_WAV = process.env.E2E_VOICE !== "1" ? process.env.E2E_VOICE : join(ROOT, "say.wav");
  if (process.env.E2E_VOICE === "1") {
    if (process.platform !== "win32") throw new Error("E2E_VOICE=1 speaks the WAV with Windows' voice; elsewhere set E2E_VOICE to a WAV file");
    // A second of quiet first (the microphone opening), then the sentence, then quiet.
    const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); $s.SetOutputToWaveFile('${VOICE_WAV.replace(/'/g, "''")}', $f); $p = New-Object System.Speech.Synthesis.PromptBuilder; $p.AppendBreak([TimeSpan]::FromMilliseconds(1000)); $p.AppendText('${VOICE_SAID}'); $p.AppendBreak([TimeSpan]::FromMilliseconds(2500)); $s.Speak($p); $s.Dispose()`;
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: "ignore" });
  }
}
// A repo elsewhere on "this computer" for ＋ Add a repo → On this computer to find (the scan looks only here).
const CODE = join(ROOT, "code");
const SIDE = join(CODE, "side-app");
mkdirSync(SIDE, { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: SIDE });
execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/side-app.git"], { cwd: SIDE });
writeFileSync(join(SIDE, "README.md"), "side");
execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qam", "init", "--allow-empty"], { cwd: SIDE });
const SERVER_PORT = await freePort();
const PAGE_PORT = await freePort();
const CDP_PORT = await freePort();
const shell = process.platform === "win32";
const server = spawn("npx", ["tsx", "src/server/index.ts"], { shell, stdio: "ignore", env: { ...process.env, DOMAIN_SIMULATE: "1", PORT: String(SERVER_PORT), DOMAIN_CWD: PROJECT, DOMAIN_REPO_ROOTS: CODE, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.com", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.com", DOMAIN_PREFS: join(ROOT, "prefs.json"), DOMAIN_ADDRESS: join(ROOT, "office.json") } });
const page = spawn("npx", ["vite", "--port", String(PAGE_PORT), "--strictPort"], { shell, stdio: "ignore", env: { ...process.env, VITE_SERVER_PORT: String(SERVER_PORT) } });
const killTree = (p) => {
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" });
    else p.kill();
  } catch {}
};
let chrome = null;
// Everything it started goes when it ends — passing, failing or interrupted (the server takes its shells with it).
process.on("exit", () => [server, page, chrome].filter(Boolean).forEach(killTree));
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(sig, () => process.exit(130));
process.on("uncaughtException", (e) => { console.error(e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error(e); process.exit(1); });
// A run that hangs ends itself (and its processes) rather than playing on.
setTimeout(() => {
  console.error("e2e: gave up after 20 minutes");
  process.exit(1);
}, 20 * 60_000).unref();
for (let i = 0; i < 60; i++) {
  try {
    await fetch(`http://localhost:${PAGE_PORT}/`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
await new Promise((r) => setTimeout(r, 3000));
const CHROME = process.env.CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
chrome = spawn(CHROME, ["--headless=new", "--mute-audio", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "cdp-"))}`, "--window-size=1500,900", "--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11", ...(VOICE_WAV ? ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${VOICE_WAV}%noloop`, "--autoplay-policy=no-user-gesture-required"] : []), "about:blank"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tabs;
for (let i = 0; i < 40; i++) {
  try { tabs = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json(); break; } catch { await sleep(250); }
}
const ws = new WebSocket(tabs.find((t) => t.type === "page").webSocketDebuggerUrl, { maxPayload: 1 << 30 });
await new Promise((r) => ws.once("open", r));
let id = 0;
const wait = new Map();
const errors = [];
ws.on("message", (d) => {
  const m = JSON.parse(d);
  if (m.method === "Runtime.exceptionThrown") errors.push("EXC " + JSON.stringify(m.params.exceptionDetails).slice(0, 500));
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push("ERR " + m.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 300));
  if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); }
});
const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (fn, arg) => {
  const r = await cmd("Runtime.evaluate", { expression: `(${fn})(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description;
};
const shot = async (name) => {
  const r = await cmd("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, name), Buffer.from(r.result.data, "base64"));
};
const key = async (k, code = `Key${k.toUpperCase()}`, vk = k.toUpperCase().charCodeAt(0)) => {
  await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk });
  await sleep(120);
  await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
};
const results = [];
const check = (name, ok, detail = "") => {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const until = async (fn, ms = 30000, step = 1000) => {
  for (let t = 0; t < ms; t += step) {
    const v = await ev(fn);
    if (v) return v;
    await sleep(step);
  }
  return null;
};
const closeAll = async () => { for (let k = 0; k < 4; k++) await ev(() => window.domain.escapeModal()); };
const tasksOf = () => ev(() => window.domain.progress().goals.flatMap((g) => g.tasks.map((t) => ({ title: t.title, deskId: t.deskId, status: t.status, for: t.for ?? null, offered: t.offered ?? null }))));

await cmd("Runtime.enable");
await cmd("Page.enable");
await cmd("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const W = window.WebSocket; window.WebSocket = class extends W { constructor(...a) { super(...a); this.addEventListener("message", (e) => { try { const m = JSON.parse(e.data); if (m.t === "chat") window.__threads = m.threads; } catch {} }); } }; })();` });
await cmd("Emulation.setDeviceMetricsOverride", { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false });
await cmd("Page.navigate", { url: `http://localhost:${PAGE_PORT}/` });
await until(() => !!window.domain, 30000, 500);
await sleep(2000);
await ev(() => [...document.querySelectorAll("button")].find((b) => /Enter the office/.test(b.textContent ?? ""))?.click());
await sleep(2500);
await closeAll();

// --- 0a. The dock: a few clear buttons, the rest under More ---------------------------
const dock = await ev(() => [...document.querySelectorAll(".dock > .btn, .dock-more-wrap > .btn")].map((b) => b.dataset.act));
check("dock: a few clear buttons (Needs you … More)", dock?.length <= 6 && dock[0] === "inbox" && dock.at(-1) === "more" && ["goals", "monitor", "laptop", "phone"].every((a) => dock.includes(a)), JSON.stringify(dock));
await ev(() => document.querySelector('.dock [data-act="more"]').click());
await sleep(300);
const more = await ev(() => !document.querySelector(".more-menu").classList.contains("hidden") && [...document.querySelectorAll(".more-menu .more-item")].map((b) => b.dataset.act));
check("More: stand-up, focus, round up, office hours, travel, chat, Office, settings, controls", Array.isArray(more) && ["standup", "focus", "roundup", "hours", "travel", "chat", "office", "settings", "help"].every((a) => more.includes(a)), JSON.stringify(more));
await shot("0a-more-menu.png");
await key("Escape", "Escape", 27);
await sleep(300);
check("More: Esc puts it away (and doesn't open settings)", !!(await ev(() => document.querySelector(".more-menu").classList.contains("hidden") && !document.querySelector(".settings-modal"))));
check("More: 📦 Repos & GitHub and 🔌 MCP tools, one click away", Array.isArray(more) && more.includes("repos") && more.includes("mcp"), JSON.stringify(more));

// --- 0r. Repos and GitHub, in plain sight --------------------------------------------------
const card = await until(() => document.querySelector(".pj-hud") && [...document.querySelectorAll(".pj-hud button")].map((b) => b.textContent.trim().replace(/\s+/g, " ")), 10000, 500);
check("HUD project card: the repo count, GitHub, and ＋ Add repo", Array.isArray(card) && card.some((t) => /^📦 1 repo$/.test(t)) && card.some((t) => /Sign in to GitHub|@/.test(t)) && card.some((t) => /＋ Add repo/.test(t)), JSON.stringify(card));
await ev(() => document.querySelector(".pj-hud-main").click());
await until(() => document.querySelector(".projects-modal .pa-add-btn"), 8000, 250);
await shot("0r1-projects-before.png");
check("Projects: one big ＋ Add a repo button", !!(await ev(() => /＋ Add a repo/.test(document.querySelector(".projects-modal .pa-add-btn")?.textContent ?? ""))));
await ev(() => document.querySelector(".projects-modal .pa-add-btn").click());
const addTabs = await until(() => { const t = [...document.querySelectorAll(".pa-tab")].map((b) => b.dataset.tab); return t.length ? t : null; }, 5000, 250);
check("＋ Add a repo: on this computer, from GitHub, a folder path, a new repo", JSON.stringify(addTabs) === JSON.stringify(["local", "github", "folder", "new"]), JSON.stringify(addTabs));
const foundSide = await until(() => [...document.querySelectorAll(".pa-found li")].some((li) => /side-app/.test(li.textContent)) && [...document.querySelectorAll(".pa-found li")].map((li) => li.querySelector("b")?.textContent), 10000, 250);
check("＋ Add a repo → On this computer finds the repo (and not the project)", Array.isArray(foundSide) && foundSide.length === 1, JSON.stringify(foundSide));
await shot("0r2-add-chooser.png");
await ev(() => [...document.querySelectorAll(".pa-found li")].find((li) => /side-app/.test(li.textContent)).querySelector(".pj-add").click());
const opened = await until(() => { const l = [...document.querySelectorAll(".pj-open-repos li b")].map((b) => b.textContent); return l.length === 2 ? l : null; }, 10000, 250);
check("one click Add: it's open alongside the project", !!opened && opened.some((t) => /side-app/.test(t)), JSON.stringify(opened));
await ev(() => document.querySelector('.pa-tab[data-tab="new"]').click());
await sleep(200);
const ghOff = await ev(() => document.querySelector(".pa-new-gh") && !document.querySelector(".pa-new-gh").checked);
check("a new repo: \"also on GitHub\" is off unless you tick it", !!ghOff);
await ev(() => { const i = document.querySelector(".pa-new-name"); i.value = "e2e-fresh"; document.querySelector(".pa-create").click(); });
const made = await until(() => { const l = [...document.querySelectorAll(".pj-open-repos li b")].map((b) => b.textContent); return l.length === 3 ? l : null; }, 15000, 250);
check("a new, empty repo: git init next to the project, opened alongside", !!made && made.some((t) => /e2e-fresh/.test(t)), JSON.stringify(made));
await ev(() => document.querySelector('.pa-tab[data-tab="local"]').click());
await sleep(300);
await shot("0r3-projects-after.png");
const chips = await ev(() => [...document.querySelectorAll(".pj-hud-chip")].map((b) => b.textContent.trim()));
check("HUD project card counts them", Array.isArray(chips) && chips.includes("📦 3 repos"), JSON.stringify(chips));
await closeAll();
await ev(() => window.domain.laptop.open("repo"));
const lt = await until(() => document.querySelector(".rp-top .rp-add") && { add: document.querySelector(".rp-add").textContent.trim(), mcp: !!document.querySelector(".rp-mcp"), open: document.querySelectorAll(".rp-open li").length, gh: !!document.querySelector(".rp-gh") }, 8000, 250);
check("laptop Repo app: ＋ Add a repo, 🔌 MCP tools, the open repos, GitHub", lt?.add === "＋ Add a repo" && lt.mcp && lt.open === 3 && lt.gh, JSON.stringify(lt));
await sleep(1200);
await shot("0r4-laptop-repo.png");
await closeAll();
await ev(() => document.querySelector('.dock [data-act="more"]').click());
await sleep(300);
await ev(() => document.querySelector('.more-menu [data-act="mcp"]').click());
const mcpHead = await until(() => document.querySelector(".mcp-sec.theirs h4")?.textContent, 8000, 250);
check("More → 🔌 MCP tools: Found in your CLIs", /Found in your CLIs/.test(mcpHead ?? ""), mcpHead ?? "");
await sleep(800);
await shot("0r5-mcp.png");
await closeAll();
await ev(() => window.domain.openHire(window.domain.office().desks.find((d) => !d.worker).id));
const hireRepo = await until(() => { const s = document.querySelector(".tm-repo-in"); return s && [...s.options].map((o) => o.textContent); }, 6000, 250);
check("hire card: a 📦 Repo choice, ending with ＋ Add a repo…", Array.isArray(hireRepo) && hireRepo.length === 5 && /Where new hires work/.test(hireRepo[0]) && hireRepo.at(-1) === "＋ Add a repo…", JSON.stringify(hireRepo));
await shot("0r6-hire-repo.png");
await closeAll();
// Back to just the project for the rest of the run.
await ev(() => window.domain.net.send({ t: "repoClose", path: "side-app" }));
await ev(() => window.domain.net.send({ t: "repoClose", path: "e2e-fresh" }));
await sleep(800);

// --- 0a'. Settings → Voice: how the 🎤 hears you, and the voice model ---------------------
await ev(() => document.querySelector('.dock [data-act="more"]').click());
await sleep(300);
await ev(() => document.querySelector('.more-menu .more-item[data-act="settings"]').click());
await sleep(300);
const voiceSet = await until(() => {
  const cards = [...document.querySelectorAll(".st-voice .st-view-card")];
  const state = document.querySelector(".st-whisper-state")?.textContent ?? "";
  return cards.length && !/asking/.test(state) ? { cards: cards.map((c) => `${c.dataset.ve}${c.classList.contains("on") ? "*" : ""}`), state } : null;
}, 8000, 250);
check("Settings → Voice: on this computer (Whisper) by default, browser, system dictation — and the model", voiceSet?.cards.join() === "whisper*,browser,system" && /whisper-base\.en/.test(voiceSet.state), JSON.stringify(voiceSet));
await ev(() => document.querySelector(".st-voice")?.scrollIntoView());
await shot("0a-settings-voice.png");
await closeAll();

// --- 0b. Quieter toasts ------------------------------------------------------------------
await ev(() => { for (let k = 0; k < 3; k++) window.domain.hud.toast("🧪 Same thing, said three times", "warn"); window.domain.hud.note("🧪 Routine news, quietly"); });
await sleep(200);
const toasts = await ev(() => ({ same: [...document.querySelectorAll("#toasts .toast")].filter((t) => /Same thing/.test(t.textContent)).map((t) => t.textContent), routine: [...document.querySelectorAll("#toasts .toast")].some((t) => /Routine news/.test(t.textContent)), recent: window.domain.hud.recent.some((r) => /Routine news/.test(r.text)) }));
check("toasts: the same one three times is one toast ×3", toasts?.same.length === 1 && /×3/.test(toasts.same[0]), JSON.stringify(toasts?.same));
check("toasts: routine news doesn't pop up — it's in Recent", toasts && !toasts.routine && toasts.recent);

// --- 0c. Your desk: sit (E), then E again is your computer, on 💻 Mine (nobody's presenting yet) ---
await ev(() => window.domain.player.placeAt(13.6, 7.7, 0));
await sleep(600);
await key("e");
await sleep(600);
await key("e");
await sleep(800);
check("your desk: E, E opens your computer on 💻 Mine", !!(await ev(() => !!document.querySelector('.lt-tabs [data-app="mine"].on'))));
await closeAll();
await key("w");
await sleep(400);

// --- 0. A team of three ---------------------------------------------------------------
for (const [i, role] of [[0, "builder"], [1, "reviewer"]]) {
  await ev((a) => window.domain.openHire(window.domain.office().desks[a[0]].id), [i, role]);
  await sleep(1200);
  const has = await ev(() => document.querySelectorAll(".tm-role").length);
  if (i === 0) check("hire card: ready-made agents listed", has >= 10, `${has} roles`);
  if (i === 0) await shot("0-hire-roles.png");
  await ev((r) => document.querySelector(`.tm-role[data-role="${r}"] .tm-role-go`).click(), role);
  await sleep(1500);
}
await ev(() => window.domain.net.send({ t: "hire", deskId: window.domain.office().desks[2].id, agent: "gemini" }));
const hired = await until(() => window.domain.office().desks.filter((d) => d.worker?.status === "idle").length >= 3, 30000);
check("hire 3 workers (2 ready-made)", !!hired);
const roles = await ev(() => window.domain.office().desks.slice(0, 2).map((d) => d.worker?.identity?.name ?? null));
const team = await ev(() => window.domain.progress().team.map((c) => [c.name, c.persona.length]));
check("ready-made agents hired as characters with their full method", roles?.[0] === "Bolt" && roles?.[1] === "Grace" && team.every(([, n]) => n > 400), `${JSON.stringify(roles)} ${JSON.stringify(team)}`);
await closeAll();

// --- 1. Spoken stand-up: who does what, then start the day -------------------------------
await key("u");
await sleep(1500);
if (VOICE_WAV) {
  // 🎤 → listening (the fake microphone plays the WAV) → it stops by itself after the pause →
  // transcribing on this computer → the words in the box.
  await ev(() => {
    window.__chips = [];
    new MutationObserver(() => {
      const c = document.querySelector(".mic-chip");
      const t = c?.textContent?.replace(/\d+s/, "Ns").replace(/\d+%/, "N%");
      if (t && window.__chips.at(-1) !== t) window.__chips.push(t);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    document.querySelector(".su-said").value = "";
    document.querySelector(".su-mic").click();
  });
  const t0 = Date.now();
  if (await until(() => /Listening/.test(document.querySelector(".mic-chip")?.textContent ?? ""), 15000, 200)) await shot("1-standup-listening.png");
  const heard = await until(() => document.querySelector(".su-said").value.trim() || null, 240000, 250);
  const ms = Date.now() - t0;
  const chips = await ev(() => window.__chips);
  const norm = (x) => (x ?? "").toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).filter(Boolean);
  const missing = norm(VOICE_SAID).filter((w) => !norm(heard).includes(w));
  check("voice: the stand-up 🎤 hears you and Whisper writes it in the box", !!heard && missing.length === 0, `"${heard}" in ${(ms / 1000).toFixed(1)} s${missing.length ? ` · missing: ${missing.join(" ")}` : ""}`);
  check("voice: it says what it's doing (listening, then transcribing)", chips?.some((c) => /Listening/.test(c)) && chips?.some((c) => /Transcribing|Downloading/.test(c)), JSON.stringify(chips));
  await shot("1-standup-voice.png");
}
await ev(() => {
  document.querySelector(".su-said").value = "Today I want to add a dark mode toggle, fix the login bug, and write tests for checkout. By end of day the PR is open.";
  document.querySelector(".su-make").click();
});
await sleep(2000);
const rows = await ev(() => [...document.querySelectorAll(".su-row")].map((r) => [r.querySelector(".su-row-task").value, r.querySelector(".su-row-who").value]));
check("stand-up: plan with who does what", rows?.length === 3 && rows.every((r) => r[1]), JSON.stringify(rows));
check("stand-up: end-of-day option", !!(await ev(() => document.querySelector('.su-len [data-m="eod"]'))));
await shot("1-standup.png");
await ev(() => document.querySelector(".standup-modal .go").click());
const started = await until(async () => {
  const ts = window.domain.progress().goals.flatMap((g) => g.tasks);
  return ts.filter((t) => t.deskId).length >= 3 ? ts.map((t) => `${t.title}→${t.deskId}`) : null;
}, 15000);
check("start the day: each task goes to its pick", !!started && rows.every(([t, d]) => started.includes(`${t}→${d}`)), JSON.stringify(started));
await closeAll();

// --- 2. Work done: lines up, phone pings, Arnold offers a review ---------------------------
const ready = await until(() => window.domain.office().presentations.some((p) => p.report) && document.querySelector(".ph-banner")?.textContent, 90000);
check("work done: phone notification", !!ready && !/Need a decision: Need|“Finished:/.test(ready), ready ?? "");
check("work done: Arnold offers Review now", !!(await ev(() => [...document.querySelectorAll("button")].some((b) => /Review now/.test(b.textContent)))));
check("work done: lined up outside your office", !!(await ev(() => window.domain.office().presentations.filter((p) => p.report).length >= 1)));
await shot("2-ready-ping.png");

// --- 2a. One place for what needs you: the inbox --------------------------------------------
const badge = await until(() => Number(document.querySelector('.dock [data-act="inbox"] .dock-badge:not(.hidden)')?.textContent ?? 0), 8000, 500);
check("Needs you: the dock counts it", badge >= 1, `${badge}`);
await key("i");
await sleep(500);
const inboxRows = await ev(() => !document.querySelector(".inbox-pop").classList.contains("hidden") && [...document.querySelectorAll(".inbox-pop .ib-item")].map((li) => li.textContent.replace(/\s+/g, " ").trim()));
check("Needs you (I): finished work, with Review now", Array.isArray(inboxRows) && inboxRows.some((r) => /finished|plan for|decision/.test(r) && /Review now/.test(r)), JSON.stringify(inboxRows).slice(0, 200));
await shot("2a-inbox.png");
const phoneSame = await ev(() => { window.domain.phone.open("alerts"); const n = document.querySelectorAll(".ph-inbox .ib-item").length; window.domain.phone.close(); return n; });
check("phone Alerts: the same list", phoneSame >= 1 && Math.abs(phoneSame - inboxRows.length) <= 1, `${phoneSame} on the phone, ${inboxRows.length} in the inbox`);
await key("i");
await sleep(300);
check("Needs you: I again puts it away", !!(await ev(() => document.querySelector(".inbox-pop").classList.contains("hidden"))));

// --- 2b. Office hours: the deck is real slides --------------------------------------------
await closeAll();
await key("o");
const reviewOpen = await until(() => !!document.querySelector(".review-modal"), 20000, 500);
await key("ArrowRight", "ArrowRight", 39);
await sleep(700);
const rich = await ev(() => { const s = document.querySelector(".rich-slide"); return s ? { h2: s.querySelector("h2")?.textContent, li: s.querySelectorAll("li").length } : null; });
check("office hours: slides have a heading and points", reviewOpen && !!rich?.h2 && rich.li >= 2, JSON.stringify(rich));
await shot("2b-rich-slide.png");
await key("ArrowRight", "ArrowRight", 39);
await sleep(700);
// Code and the check's slide only where this report has them.
const shown = await ev(() => { const t = document.querySelector(".review-modal h2")?.textContent ?? ""; const p = window.domain.office().presentations.find((x) => x.report && document.querySelector(".review-modal")?.textContent.includes(x.report.title)); return { hasCode: !!p?.report.slides.some((s) => s.includes("```")), hasCheck: !!p?.report.check && p.report.check.status !== "running", title: p?.report.title }; });
let sawCode = false;
for (let k = 0; k < 8 && shown.hasCode && !sawCode; k++) { sawCode = !!(await ev(() => document.querySelector(".rich-slide pre code")?.textContent)); if (!sawCode) { await key("ArrowRight", "ArrowRight", 39); await sleep(500); } }
check("office hours: a slide with code (when the deck has some)", !shown.hasCode || sawCode, JSON.stringify(shown));
await shot("2c-code-slide.png");
let n = 0;
for (; n < 8 && !(await ev(() => /Checks (pass|fail)/.test(document.querySelector(".rich-slide h2")?.textContent ?? ""))); n++) { await key("ArrowRight", "ArrowRight", 39); await sleep(500); }
check("office hours: the check's result is a slide (when there's a check)", !shown.hasCheck || n < 8);
await shot("2d-check-slide.png");
// Leave office hours the way you would: Esc.
for (let k = 0; k < 3; k++) { await key("Escape", "Escape", 27); await sleep(400); }
await closeAll();
check("office hours: Esc leaves them", !(await ev(() => !!document.querySelector(".review-modal"))));

// --- 3. Review from the monitor: N, Approve ----------------------------------------------
await closeAll();
await key("n");
await sleep(2000);
const focused = await ev(() => document.querySelectorAll(".mon-tile").length === 1 && !!document.querySelector('.mon-review:not(.hidden) [data-review="approve"]'));
check("N: opens the next to review, big, with Approve", !!focused);
await shot("3-monitor-review.png");
const reviewsBefore = await ev(() => window.domain.progress().session?.reviews ?? 0);
await ev(() => document.querySelector('.mon-review:not(.hidden) [data-review="approve"]').click());
const reviewed = await until((b) => (window.domain.progress().session?.reviews ?? 0) > 0, 10000);
check("monitor: Approve goes through", !!reviewed, `reviews ${reviewsBefore} → ${await ev(() => window.domain.progress().session?.reviews)}`);
await closeAll();

// --- 4. Review from the phone: send back with a note --------------------------------------
const another = await until(() => window.domain.office().presentations.some((p) => p.report), 90000);
await ev(() => window.domain.phone.open("reviews"));
await sleep(1200);
const phoneCard = await ev(() => !!document.querySelector("[data-back]"));
check("phone: review card with Approve / Send back", !!another && phoneCard);
const backDesk = await ev(() => document.querySelector("[data-back]").dataset.back);
await ev(() => {
  const n = document.querySelector(".ph-rv-note");
  n.value = "Please add a test for it";
  document.querySelector("[data-back]").click();
});
const backOk = await until(new Function(`return window.domain.office().desks.find((x) => x.id === ${JSON.stringify(backDesk)})?.worker?.status === "working"`), 8000);
check("phone: Send back with a note (it goes back to work)", !!backOk, backDesk);
await shot("4-phone-review.png");
await ev(() => window.domain.phone.close());

// --- 5. Laptop: a task to everyone -> someone offers -> let them take it ---------------------
await ev(() => window.domain.laptop.open("team"));
await sleep(1200);
await ev(() => { document.querySelector(".tm-compose textarea").value = "Update the README with setup steps"; document.querySelector(".tm-task").click(); });
const offered = await until(() => document.querySelector('.tm-log [data-answer="take"]') && [...document.querySelectorAll(".tm-log .tm-m")].at(-1)?.textContent, 10000);
check("laptop: someone offers to take it", !!offered, (offered ?? "").replace(/\s+/g, " ").slice(0, 100));
await shot("5-offer.png");
const inboxOffer = await ev(() => window.domain.inboxItems().find((x) => x.kind === "offer")?.actions.map((a) => a.id).join(","));
check("Needs you: the offer is there too, with its buttons", inboxOffer === "take,next", inboxOffer ?? "");
await ev(() => document.querySelector('.tm-log [data-answer="take"]').click());
const took = await until(async () => {
  const t = window.domain.progress().goals.flatMap((g) => g.tasks).find((t) => /README/.test(t.title));
  return t && (t.deskId || t.for) ? `${t.deskId ?? "saved for " + t.for} ${t.status}` : null;
}, 10000);
check("laptop: Let them take it assigns (or saves) it", !!took, took ?? "");
await closeAll();

// --- 6. Monitor: message an agent, quick key -------------------------------------------------
await key("k");
await sleep(1500);
const tiles = await ev(() => document.querySelectorAll(".mon-tile").length);
check("monitor: a tile per agent", tiles === 3, `${tiles} tiles`);
const msgDesk = await ev(() => document.querySelector(".mon-tile").dataset.desk);
await ev(() => { const i = document.querySelector(".mon-say input"); i.value = "How is it going?"; i.closest("form").requestSubmit(); });
await sleep(1500);
await closeAll();
await ev(() => window.domain.laptop.open("team"));
await sleep(1000);
await ev((d) => document.querySelector(`.tm-p[data-to="${d}"]`)?.click(), msgDesk);
await sleep(1200);
const heard = await ev(() => [...document.querySelectorAll(".tm-log .tm-m")].map((m) => m.textContent.replace(/\s+/g, " ")).filter((t) => /How is it going\?/.test(t)).length);
check("monitor: message reaches the agent's thread", heard > 0, `${msgDesk}: ${heard} in its thread`);
await closeAll();

// --- 7. CCTV: sit, switch cameras, all/one ---------------------------------------------------
await ev(() => window.domain.player.placeAt(10.0, 9.4, -Math.PI / 2));
await sleep(800);
await key("e");
await sleep(1500);
const seated = await ev(() => window.domain.world.cctv.seated && window.domain.player.sitting);
check("CCTV: E at the wall sits you in its chair", !!seated);
await shot("6-cctv-grid.png");
await key("ArrowRight", "ArrowRight", 39);
await sleep(1500);
const cam1 = await ev(() => JSON.stringify(window.domain.world.cctv));
await key("ArrowRight", "ArrowRight", 39);
await sleep(300);
const cam2 = await ev(() => window.domain.world.cctv.cam);
check("CCTV: → switches camera (one big)", /"mode":"single"/.test(cam1) && !cam1.includes(`"cam":"${cam2}"`), `${cam1} then ${cam2}`);
check("CCTV: arrows don't stand you up", !!(await ev(() => window.domain.player.sitting)));
await shot("7-cctv-single.png");
await key("ArrowUp", "ArrowUp", 38);
await sleep(300);
check("CCTV: ↑ back to all", (await ev(() => window.domain.world.cctv.mode)) === "grid");
await key("w");
await sleep(500);
check("CCTV: W gets up", !(await ev(() => window.domain.player.sitting)) && !(await ev(() => window.domain.world.cctv.seated)));

// --- 7b. Sitting in your office -----------------------------------------------------------------
await ev(() => window.domain.player.placeAt(11.2, 11.0, 0));
await sleep(600);
await key("e");
await sleep(800);
check("armchair: E sits you down", !!(await ev(() => window.domain.player.sitting)));
await key("w");
await sleep(500);
check("armchair: W gets you up", !(await ev(() => window.domain.player.sitting)));

// --- 7c. 💻 Mine: your own terminal, a real shell on this computer -----------------------------
await closeAll();
await ev(() => window.domain.laptop.open("mine"));
await sleep(800);
check("laptop: 💻 Mine is an app", !!(await ev(() => !!document.querySelector('.lt-tabs [data-app="mine"].on') && !!document.querySelector(".mn"))));
await ev(() => document.querySelector(".mn-new").click());
const mineTabs = await until(() => document.querySelectorAll(".mn-tab").length, 10000, 250);
check("Mine: ＋ New tab opens a shell", mineTabs === 1, `${mineTabs} tab(s)`);
const mineLines = () => ev(() => [...document.querySelectorAll(".mn-term .xterm-rows > div")].map((d) => d.textContent.trim()));
// The shell's prompt first, then type into it like a person would.
await until(() => [...document.querySelectorAll(".mn-term .xterm-rows > div")].some((d) => d.textContent.trim()), 15000, 500);
await sleep(1500);
await ev(() => document.querySelector(".mn-term .xterm-helper-textarea").focus());
await cmd("Input.insertText", { text: "echo hello-from-mine" });
await sleep(200);
await key("Enter", "Enter", 13);
let said = null;
for (let i = 0; i < 30 && !said; i++) {
  await sleep(500);
  said = (await mineLines())?.find((l) => l === "hello-from-mine") ?? null;
}
check("Mine: echo hello-from-mine prints it", !!said, JSON.stringify((await mineLines())?.filter(Boolean).slice(-4)));
await shot("7c-mine.png");
await closeAll();
await sleep(400);
await ev(() => window.domain.laptop.open("mine"));
const kept = await until(() => [...document.querySelectorAll(".mn-term .xterm-rows > div")].some((d) => d.textContent.trim() === "hello-from-mine") && document.querySelectorAll(".mn-tab").length, 8000, 250);
check("Mine: the tab (and its output) is still there after closing the laptop", kept === 1, String(kept));
await ev(() => { const net = window.domain.net; const send = net.send.bind(net); net.send = (m) => { (window.__sent ??= []).push(m); send(m); }; });
await ev(() => document.querySelector(".mn-hand").click());
await ev(() => { const t = document.querySelector(".mn-handoff textarea"); t.value = "Look at the output from my shell"; t.closest("form").requestSubmit(); });
const handed = await until(() => window.domain.progress().goals.flatMap((g) => g.tasks).find((t) => /^In project: Look at the output/.test(t.title))?.title, 8000, 500);
const handedNote = await ev(() => (window.__sent ?? []).filter((m) => m.t === "quickTask").map((m) => m.files?.[0]?.text ?? "").join("\n"));
check("Mine: … with the tab's last lines attached", /hello-from-mine/.test(handedNote ?? ""), (handedNote ?? "").split("\n").slice(-2).join(" | "));
check("Mine: 🎯 Hand this to the team makes a task for the folder", !!handed, handed ?? "");
await ev(() => document.querySelector(".mn-tab [data-close]").click());
const gone = await until(() => document.querySelector(".mn-none") ? "closed" : null, 8000, 250);
check("Mine: ✕ closes the tab (and ends its shell)", gone === "closed");
await closeAll();

// --- 8. End of day: stop -> recap ---------------------------------------------------------------
await closeAll();
await ev(() => window.domain.net.send({ t: "sessionStop" }));
const recap = await until(() => document.querySelector(".summary .recap")?.textContent, 10000);
check("end of session: recap of done / still open / EOD goals", !!recap && /end-of-day/i.test(recap), (recap ?? "").replace(/\s+/g, " ").slice(0, 120));
await shot("8-recap.png");
await closeAll();

// --- 9. Resume yesterday --------------------------------------------------------------------------
await key("u");
await sleep(1500);
const resumeBtn = await ev(() => document.querySelector(".su-resume")?.textContent);
check("stand-up: Resume yesterday is offered", !!resumeBtn, resumeBtn ?? "");
await ev(() => document.querySelector(".su-resume")?.click());
const resumed = await until(() => window.domain.progress().session && JSON.stringify({ eod: window.domain.progress().session.eod, minutes: window.domain.progress().session.minutes }), 8000);
check("Resume yesterday: same plan, session on", !!resumed, resumed ?? "");

// --- 10. Agent CLIs: versions and updates; restarting a worker -------------------------------------
await closeAll();
await ev(() => document.querySelector('.dock [data-act="more"]').click());
await sleep(300);
await ev(() => document.querySelector('.more-menu [data-act="office"]').click());
await sleep(600);
await ev(() => [...document.querySelectorAll(".om-tile")].find((b) => /Agent CLIs/.test(b.textContent ?? ""))?.click());
const cliRows = await until(() => document.querySelectorAll(".ac-list li").length, 5000, 250);
check("More → Office → Agent CLIs lists every agent", cliRows === 4, `${cliRows} rows`);
const looked = await until(() => window.domain.agents()?.checkedAt > 0 && [...document.querySelectorAll(".ac-status")].map((e) => e.textContent).join(" | "), 60000);
check("Agent CLIs: versions looked up", !!looked, looked ?? "");
await shot("10-agent-clis.png");
await closeAll();
await ev(() => (window.__before = window.domain.office().desks[0].worker?.id ?? null));
await ev(() => window.domain.openTerminal(window.domain.office().desks[0].id));
await sleep(800);
await ev(() => document.querySelector(".modal.term .term-restart")?.click());
const after = await until(() => { const w = window.domain.office().desks[0].worker; return w && w.status !== "asleep" && w.id !== window.__before ? w.status : null; }, 10000, 500);
check("restart a worker: a new session at the same desk", !!after, after ?? "");

// --- 11. Local models first (when Ollama or LM Studio runs on this computer) -------------------------
await closeAll();
const localOnes = await until(() => window.domain.localModels?.().length ? window.domain.localModels() : null, 8000, 500);
if (localOnes) {
  await ev(() => window.domain.openHire(window.domain.office().desks.find((d) => !d.worker).id));
  await sleep(1000);
  const firstOpt = await ev(() => document.querySelector('.tm-agents li[data-agent="codex"] .tm-model option')?.textContent);
  check("hire card: a local model is listed first, free and private", /^🖥 .*free, private/.test(firstOpt ?? ""), firstOpt ?? "");
  await ev(() => document.querySelector(".tm-policy").click());
  await sleep(800);
  const rows = await ev(() => [...document.querySelectorAll(".po-local-list li")].map((li) => li.textContent.replace(/\s+/g, " ").trim()));
  check("Team defaults: local models with their context window", rows?.length > 0 && rows.some((r) => /context/.test(r)), JSON.stringify(rows).slice(0, 200));
  await ev(() => document.querySelector(".po-local-list")?.scrollIntoView());
  await shot("11-local-models.png");
  await closeAll();
} else results.push("SKIP  local models: none running on this computer");

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failed}/${results.length} passed · screenshots in ${OUT}`);
console.log(errors.length ? `\nPage errors:\n${errors.join("\n")}` : "\nNo page errors.");
ws.close();
chrome.kill();
process.exit(failed || errors.length ? 1 : 0);
