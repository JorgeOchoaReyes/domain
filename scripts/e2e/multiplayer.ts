// A shared office, end to end: you (the host) and a teammate who joins over the local network with
// the passcode. Shared: the stand-up and goals, #team and #people, the review line, watching every
// agent. Yours: the agents you hire — someone else can message them, but only their owner (or the
// host) gives them work, types into them, reviews them or sends them home. Simulated agents, so it's
// quick and free:
//
//   npm run e2e:team
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { connect, type Conn } from "../../src/cli/nou.ts";
import { TEAM_THREAD, PEOPLE_THREAD } from "../../src/shared/chat.ts";
import type { ServerMessage } from "../../src/shared/protocol.ts";

const D = mkdtempSync(join(tmpdir(), "domain-team-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: D });
const results: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise<number>((r) => {
    const s = createNetServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });
const PORT = await freePort();
const server = spawn("npx", ["tsx", "src/server/index.ts"], {
  cwd: process.cwd(),
  shell: true,
  env: { ...process.env, PORT: String(PORT), DOMAIN_SIMULATE: "1", DOMAIN_CWD: D, DOMAIN_PREFS: join(D, "prefs.json"), DOMAIN_ADDRESS: join(D, "office.json") },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
server.stdout.on("data", (d) => (out += d));
server.stderr.on("data", (d) => (out += d));
for (let i = 0; i < 60 && !/listening/.test(out); i++) await sleep(500);

/** A teammate over the local network: the LAN address and passcode the host shares. */
function joinOverLan(url: string, code: string, name: string): Promise<Conn> {
  const ws = new WebSocket(`${url.replace(/^http/, "ws")}/?code=${code}`);
  return new Promise((resolve, reject) => {
    const listeners = new Set<(m: ServerMessage) => void>();
    const c: Conn = {
      me: name,
      office: { desks: [], peers: [], presentations: [] },
      progress: null as never,
      threads: [],
      send: (m) => ws.send(JSON.stringify(m)),
      on: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
      next: (test, ms = 15000) =>
        new Promise((done) => {
          const t = setTimeout(() => (off(), done(null)), ms);
          const off = c.on((m) => test(m) && (clearTimeout(t), off(), done(m)));
        }),
      close: () => ws.close(),
    };
    let ready = false;
    ws.on("error", (e) => !ready && reject(e));
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as ServerMessage;
      if (m.t === "welcome" || m.t === "office") c.office = m.office;
      else if (m.t === "progress") c.progress = m.progress;
      else if (m.t === "chat") c.threads = m.threads;
      for (const fn of [...listeners]) fn(m);
      if (!ready && c.progress && c.office.desks.length) {
        ready = true;
        resolve(c);
      }
    });
    ws.on("open", () => {
      c.send({ t: "join", name });
      c.send({ t: "chatGet" });
    });
  });
}

let host: Conn | null = null;
let ana: Conn | null = null;
try {
  host = await connect("Jorge", `ws://127.0.0.1:${PORT}`);
  const h = host;
  // Open the office to the network for teammates.
  h.send({ t: "lanStart", role: "teammate" });
  const lan = await h.next((m): m is Extract<ServerMessage, { t: "lan" }> => m.t === "lan" && m.on && !!m.code, 15000);
  check("host shares the office (address + passcode)", !!lan?.code && lan.urls.length > 0, `${lan?.urls[0]} · code ${lan?.code ? "••••••" : "none"}`);
  ana = await joinOverLan(lan!.urls[0], lan!.code!, "Ana");
  const a = ana;
  check("a teammate joins with the passcode", true, "Ana");
  // A wrong passcode is turned away.
  const wrong = await new Promise<boolean>((r) => {
    const ws = new WebSocket(`${lan!.urls[0].replace(/^http/, "ws")}/?code=000000`);
    ws.on("open", () => (ws.close(), r(false)));
    ws.on("error", () => r(true));
    ws.on("unexpected-response", () => r(true));
  });
  check("a wrong passcode is turned away", wrong);

  // Each hires an agent.
  h.send({ t: "hire", deskId: "desk-1", agent: "claude" });
  a.send({ t: "hire", deskId: "desk-2", agent: "codex" });
  const both = await h.next((m): m is Extract<ServerMessage, { t: "office" }> => m.t === "office" && ["desk-1", "desk-2"].every((d) => m.office.desks.find((x) => x.id === d)?.worker?.status === "idle"), 20000);
  const owners = both?.office.desks.filter((d) => d.worker).map((d) => `${d.id}:${d.worker!.hiredBy}`);
  check("each hires their own agent", JSON.stringify(owners) === JSON.stringify(["desk-1:Jorge", "desk-2:Ana"]), owners?.join(" "));
  check("everyone sees every agent", a.office.desks.filter((d) => d.worker).length === 2);

  // Ana can't direct Jorge's agent…
  const warned = a.next((m): m is Extract<ServerMessage, { t: "loop" }> => m.t === "loop" && /🔒/.test(m.text ?? ""), 5000);
  a.send({ t: "quickTask", deskId: "desk-1", text: "Ana tries to give Jorge's agent a task" });
  const w = await warned;
  await sleep(800);
  const taskOnJorgesAgent = h.progress.goals.flatMap((g) => g.tasks).some((t) => /Ana tries/.test(t.title));
  check("a teammate can't give your agent a task", !!w && !taskOnJorgesAgent, w?.text);
  for (const [t, extra] of [
    ["input", { data: "rm -rf /\r" }],
    ["fire", {}],
    ["review", { approve: true }],
  ] as const) {
    const refused = a.next((m): m is Extract<ServerMessage, { t: "loop" }> => m.t === "loop" && /🔒/.test(m.text ?? ""), 4000);
    a.send({ t, deskId: "desk-1", ...extra } as never);
    check(`…nor ${t === "input" ? "type into it" : t === "fire" ? "send it home" : "review its work"}`, !!(await refused));
  }
  check("your agent is still there", !!h.office.desks.find((d) => d.id === "desk-1")?.worker);
  // …but can message it.
  a.send({ t: "chatSend", to: "desk-1", text: "Hi from Ana — how's it going?" });
  const heard = await h.next((m): m is Extract<ServerMessage, { t: "chat" }> => m.t === "chat" && !!m.threads.find((x) => x.id === "desk-1")?.messages.some((x) => /Hi from Ana/.test(x.text)), 8000);
  check("a teammate can message your agent", !!heard);
  // Her own agent: hers to direct.
  a.send({ t: "quickTask", deskId: "desk-2", text: "Ana's own task for her agent" });
  const own = await a.next((m): m is Extract<ServerMessage, { t: "progress" }> => m.t === "progress" && m.progress.goals.some((g) => g.tasks.some((t) => /Ana's own task/.test(t.title) && t.deskId === "desk-2")), 8000);
  check("a teammate directs her own agent", !!own);
  // The host may direct anyone's (it's their computer).
  await sleep(4000);
  h.send({ t: "quickTask", deskId: "desk-2", text: "Jorge hands Ana's agent a task too" });
  const hostOk = await h.next((m): m is Extract<ServerMessage, { t: "progress" }> => m.t === "progress" && m.progress.goals.some((g) => g.tasks.some((t) => /Jorge hands/.test(t.title))), 8000);
  check("the host may direct anyone's agent", !!hostOk);

  // A task to everyone from Ana: only agents she may direct offer.
  h.send({ t: "hire", deskId: "desk-3", agent: "gemini" });
  await h.next((m): m is Extract<ServerMessage, { t: "office" }> => m.t === "office" && m.office.desks.find((x) => x.id === "desk-3")?.worker?.status === "idle", 15000);
  a.send({ t: "quickTask", deskId: "any", text: "Anyone free: tidy the README" });
  const offer = await a.next((m): m is Extract<ServerMessage, { t: "chat" }> => m.t === "chat" && !!m.threads.find((x) => x.id === TEAM_THREAD)?.messages.some((x) => /tidy the README/.test(x.text)), 8000);
  const offerMsg = offer?.threads.find((x) => x.id === TEAM_THREAD)?.messages.filter((x) => /tidy the README/.test(x.text)).at(-1);
  check("a task to everyone: only agents she may direct offer", !offerMsg?.offer || !["desk-1", "desk-3"].includes(offerMsg.offer.deskId), offerMsg ? `${offerMsg.who}: ${offerMsg.text}` : "none");

  // Shared: the stand-up and goals, #team and #people.
  h.send({ t: "standup", goalId: null, newGoal: { title: "Ship the beta", why: "", tasks: ["Write the launch post"], kind: "build" }, tone: "ship", intention: "Beta out", minutes: 60 });
  const shared = await a.next((m): m is Extract<ServerMessage, { t: "progress" }> => m.t === "progress" && !!m.progress.session && m.progress.goals.some((g) => g.title === "Ship the beta"), 8000);
  check("the stand-up and its goal are shared", !!shared, shared?.progress.session?.intention);
  a.send({ t: "peopleSend", text: "Morning Jorge!" });
  const people = await h.next((m): m is Extract<ServerMessage, { t: "chat" }> => m.t === "chat" && !!m.threads.find((x) => x.id === PEOPLE_THREAD)?.messages.some((x) => x.who === "Ana" && /Morning/.test(x.text)), 8000);
  check("#people: the humans talk among themselves", !!people);
  h.send({ t: "chatSend", to: TEAM_THREAD, text: "Team: beta today!" });
  const team = await a.next((m): m is Extract<ServerMessage, { t: "chat" }> => m.t === "chat" && !!m.threads.find((x) => x.id === TEAM_THREAD)?.messages.some((x) => /beta today/.test(x.text)), 8000);
  check("#team is shared too", !!team);
  // (The host is here on nou, which doesn't walk in as a person; Ana does.)
  check("the teammate walks about in the office", h.office.peers.some((p) => p.name === "Ana") && !a.office.peers.some((p) => p.name === "Jorge"), `${h.office.peers.map((p) => p.name).join(", ")}`);

  // When Ana leaves, her agent isn't stuck: the team can direct it.
  a.close();
  ana = null;
  await sleep(1500);
  const bob = await joinOverLan(lan!.urls[0], lan!.code!, "Bob");
  const bobWarned = bob.next((m): m is Extract<ServerMessage, { t: "loop" }> => m.t === "loop" && /🔒/.test(m.text ?? ""), 3000);
  bob.send({ t: "quickTask", deskId: "desk-2", text: "Bob picks up Ana's agent after she left" });
  check("someone who left doesn't hold their agent", !(await bobWarned));
  bob.close();
} catch (e) {
  check("ran without crashing", false, String((e as Error).stack ?? e));
} finally {
  ana?.close();
  host?.close();
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* gone */
  }
  server.kill();
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
