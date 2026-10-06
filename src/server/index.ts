import { Alumni } from "./alumni.js";
import { Autopilot } from "./autopilot.js";
import { BAY_DESK_IDS, DESKS } from "../shared/layout.js";
import { Lessons } from "./lessons.js";
import { EodSync } from "./sync.js";
import { scanSkills } from "./skills.js";
import { isLeash } from "../shared/policy.js";
import { homedir } from "node:os";
import { HistoryLog } from "./history.js";
import { Audits } from "./audits.js";
import type { HistoryEvent } from "../shared/history.js";
import { DEFAULT_AUDIT_ROUNDS } from "../shared/policy.js";
import { connectToApp } from "./parentPort.js";
import { localModelWarning } from "./workerSession.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { AGENT_KINDS, AGENT_LABELS, coerceLook, parseClientMessage, type CheckResult, type Presentation, type ServerMessage } from "../shared/protocol.js";
import { GATE_RETRIES, coerceBrief, coercePolicy, isModelName } from "../shared/policy.js";
import { runCheck, simulateCheck } from "./checks.js";
import { OpLogger } from "./oplog.js";
import { allowed } from "./permissions.js";
import { MODULES } from "./modules.js";
import { describeLaunch, mcpCleanup, mcpLaunch, scanAgents, serversFor, withGithubAuth } from "./mcp.js";
import type { ClientRec, Route, ServerCtx } from "./ctx.js";
import { personaBrief, type WorkerIdentity } from "../shared/team.js";
import { Office } from "./office.js";
import { isTrusted, trustProject } from "./prefs.js";
import { Progress } from "./progress.js";
import { isTone } from "../shared/progress.js";
import {
  Deployer,
  GoalFiles,
  deckBrief,
  fixDeployBrief,
  detectLocalModels,
  loadConfig,
  parseDeck,
  parsePlan,
  parseShipped,
  planBrief,
  probeDevServers,
  researchBrief,
  saveLog,
  shipBrief,
  simAppendSlides,
  simPlan, MIN_AGENT_CONTEXT, ollamaContext } from "./loop.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";

// dist/server/server/index.js -> project root is three levels up.
const here = dirname(fileURLToPath(import.meta.url));
// The built client: next to the built server (dist/), or — running from source
// — the last build in dist/client, so guests can join a dev office too.
const CLIENT_DIR = [join(here, "..", "..", "client"), join(here, "..", "..", "dist", "client")].find((d) => existsSync(join(d, "index.html"))) ?? join(here, "..", "..", "client");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const CWD = process.env.DOMAIN_CWD || process.cwd();
const SIMULATE = process.env.DOMAIN_SIMULATE === "1";
// The office remembers who's at which desk between runs (real workers only).
const office = new Office({ cwd: CWD, simulate: SIMULATE, trusted: () => isTrusted(CWD), memory: SIMULATE ? null : join(CWD, ".domain", "office.json") });

// ---------------------------------------------------------------------------
// Static file server (serves the built client in production).
// ---------------------------------------------------------------------------

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!localHost(req.headers.host)) {
    res.writeHead(421).end("Misdirected request");
    return;
  }
  let urlPath: string;
  try {
    urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }
  // Prevent path traversal: resolve within CLIENT_DIR and verify containment.
  const rel = normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, "");
  let filePath = join(CLIENT_DIR, rel);
  try {
    const info = await stat(filePath).catch(() => null);
    if (!info || info.isDirectory()) filePath = join(CLIENT_DIR, "index.html");
    if (!filePath.startsWith(CLIENT_DIR)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const body = await readFile(filePath);
    const hashed = filePath.includes(`${join("client", "assets")}`);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      // Vite's hashed assets never change; the page itself always revalidates.
      "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    });
    res.end(body);
  } catch {
    // SPA fallback: unknown routes get index.html if it exists, else a note.
    try {
      const body = await readFile(join(CLIENT_DIR, "index.html"));
      res.writeHead(200, { "Content-Type": MIME[".html"] }).end(body);
    } catch {
      res
        .writeHead(200, { "Content-Type": MIME[".html"] })
        .end(
          "<h1>domain server</h1><p>No built client found. Run <code>npm run dev</code> for the Vite dev server on :5173, or <code>npm run build</code> first.</p>",
        );
    }
  }
}

const httpServer = createServer((req, res) => {
  serveStatic(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

/**
 * Only this machine may use the office: anyone who can reach the socket can
 * type into real terminals. The Host header must name this machine (which
 * defeats DNS rebinding), and a browser's Origin must be a page served from
 * this machine (so another website open in your browser can't connect).
 */
const LOCAL_NAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
function localHost(host: string | undefined): boolean {
  if (!host) return false;
  if (HOST !== "127.0.0.1" && HOST !== "localhost") return true; // deliberately exposed
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return LOCAL_NAMES.has(name);
}
function localOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // not a browser (e.g. a CLI client on this machine)
  try {
    const u = new URL(origin);
    if (HOST !== "127.0.0.1" && HOST !== "localhost") return u.host !== "";
    return (u.protocol === "http:" || u.protocol === "https:") && LOCAL_NAMES.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// WebSocket layer.
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({
  server: httpServer,
  // Room for a whiteboard sketch sent with a review.
  maxPayload: 12 * 1024 * 1024,
  verifyClient: ({ req, origin }: { req: IncomingMessage; origin: string }) =>
    localHost(req.headers.host) && localOrigin(origin),
});
const clients = new Map<WebSocket, ClientRec>();

/** Every git, GitHub, MCP, check and deploy step, streamed to everyone. */
const log = new OpLogger();
log.onEntry = (entry) => broadcast({ t: "oplog", entry });

// Drop connections that stopped answering, so ghosts don't linger in the room.
setInterval(() => {
  for (const [ws, client] of clients) {
    if (!client.alive) {
      ws.terminate();
      continue;
    }
    client.alive = false;
    try {
      ws.ping();
    } catch {
      /* closing */
    }
  }
}, 30_000).unref();

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  for (const ws of clients.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// Coalesce office snapshots so a burst of changes becomes one broadcast.
let snapshotScheduled = false;
function scheduleSnapshot(): void {
  if (snapshotScheduled) return;
  snapshotScheduled = true;
  setImmediate(() => {
    snapshotScheduled = false;
    broadcast({ t: "office", office: office.snapshot() });
  });
}

office.onChange = scheduleSnapshot;

// The game layer: goals, focus sessions and everyone's score, saved with the project.
const progress = new Progress(join(CWD, ".domain", "progress.json"));
// The team's defaults start from domain.config.json until someone changes them in game.
{
  const { team } = loadConfig(CWD);
  if (team) progress.seedPolicy(coercePolicy(team));
}
let progressScheduled = false;
progress.onChange = () => {
  if (progressScheduled) return;
  progressScheduled = true;
  setImmediate(() => {
    progressScheduled = false;
    broadcast({ t: "progress", progress: progress.snapshot() });
  });
};
progress.onAward = (a) => broadcast({ t: "award", ...a });
progress.onSessionEnd = (summary) => broadcast({ t: "sessionEnd", summary });
progress.workers = () => office.workerCount();
progress.present = () => [...new Set([...clients.values()].filter((c) => c.joined).map((c) => c.name))];
setInterval(() => progress.tick(), 1000).unref();
office.onOutput = (deskId, data) => broadcast({ t: "output", deskId, data });
// Task clocks: when a task's time budget runs out, nudge its worker or call it in to present.
setInterval(() => {
  for (const { goal, task } of progress.timeUps()) {
    const deskId = task.deskId!;
    const worker = office.workerAt(deskId);
    if (!worker) continue;
    const who = AGENT_LABELS[worker.agent];
    const minutes = task.brief?.minutes ?? 0;
    if (task.brief?.onTimeUp === "nudge") {
      office.nudge(
        deskId,
        `[Time check] Your ${minutes}-minute budget for "${task.title}" is up. Wrap up: finish the step you're on, then present it (status "ready"), or present it as "blocked" if you're stuck.`,
      );
      broadcast({ t: "loop", goalId: goal.id, event: "timeUp", text: `⏱ Time's up for ${who} on “${task.title}” — nudged to wrap up` });
    } else {
      if (!office.inLine(deskId)) office.roundup([deskId]);
      broadcast({ t: "loop", goalId: goal.id, event: "timeUp", text: `⏱ Time's up for ${who} on “${task.title}” — it's stopping to present` });
    }
  }
}, 2000).unref();

/** Models served on this machine (Ollama, LM Studio), refreshed every minute. */
let localModels: string[] = [];
const refreshLocalModels = () => void detectLocalModels().then((m) => (localModels = m));
refreshLocalModels();
setInterval(refreshLocalModels, 60_000).unref();

/** How many times each desk's current work has been sent back by a failed check. */
const gateTries = new Map<string, number>();

// --- the office's history ------------------------------------------------------------------

const history = new HistoryLog(join(CWD, ".domain", "history.json"));
history.onEvent = (event) => broadcast({ t: "historyEvent", event });

/** The worker at a desk, for history lines (null when nobody's there). */
function workerRef(deskId: string): HistoryEvent["worker"] {
  const w = office.workerAt(deskId);
  if (!w) return null;
  const name = w.identity?.name ?? AGENT_LABELS[w.agent];
  return { deskId, name, agent: w.agent, ...(w.identity ? { characterId: w.identity.characterId } : {}) };
}
const nameAt = (deskId: string) => workerRef(deskId)?.name ?? deskId;

// --- former workers, kept to bring back -------------------------------------------------------

const alumni = new Alumni(SIMULATE ? null : join(CWD, ".domain", "alumni.json"));
alumni.onChange = (list) => broadcast({ t: "alumni", list });

// --- what the team learns: your feedback, audit findings, and the end-of-day sync ----------

/** Workers who can take part in a sync (or take work): staffed, not asleep or quit. */
const activeDesks = () => office.snapshot().desks.filter((d) => d.worker && office.isStaffed(d.id) && d.worker.status !== "asleep").map((d) => d.id);
const lessons = new Lessons(SIMULATE ? null : join(CWD, ".domain", "lessons.json"), () => {
  const dirs = new Set([join(CWD, ".domain")]);
  for (const d of office.snapshot().desks) if (d.worker) dirs.add(join(office.workdir(d.id), ".domain"));
  return [...dirs];
});
lessons.onChange = (state) => broadcast({ t: "lessons", state, syncing: eod.isRunning });
const eod = new EodSync({
  lessons,
  simulate: SIMULATE,
  note: (text) => {
    history.add({ kind: "sync", who: "office", text: text.replace(/^🌙 /, "") });
    broadcast({ t: "loop", goalId: "", event: "warn", text });
    broadcast({ t: "lessons", state: lessons.snapshot, syncing: eod.isRunning });
  },
  office: { staffed: activeDesks, workdir: (d) => office.workdir(d), instruct: (d, t) => office.instruct(d, t), nameOf: nameAt },
});
/**
 * Something you said to a worker (or, with no desk, to everyone). When it is
 * feedback — a rule, a correction, praise — it goes into the team lessons, so
 * every worker learns from it, not just the one you told.
 */
function heard(text: string, deskId: string | undefined, client: ClientRec): void {
  const about = deskId ? progress.taskAt(deskId)?.title : undefined;
  // You (the host) are "your manager" in the lessons; a teammate on your network is credited by name.
  const from = client.role === "host" ? "you" : client.name;
  if (lessons.heard(text, about, from)) broadcast({ t: "loop", goalId: "", event: "warn", text: `📚 Noted for the team${from === "you" ? "" : ` (from ${from})`}: every worker will learn from that` });
}
// Workers hired since the last write get the lessons in their own folder too.
setInterval(() => lessons.write(), 60_000).unref();

// --- pair workers: an auditor reviews the work before it comes to you --------------------

/** A report reaches you: into the line, announced, and in the history. */
function toYou(presentation: Presentation): void {
  const { deskId, report } = presentation;
  progress.reported(deskId);
  broadcast({ t: "report", presentation });
  if (!report) return;
  const text = `${nameAt(deskId)} is ready to present: “${report.title}”`;
  // The same report announced twice (released after an audit, say) is one line.
  if (history.latest(5).some((e) => e.kind === "reported" && e.text === text && Date.now() - e.at < 60_000)) return;
  history.add({ kind: "reported", who: nameAt(deskId), text, worker: workerRef(deskId), task: progress.taskAt(deskId)?.title });
}

const audits = new Audits({
  office,
  base: () => office.workspaces?.base() ?? null,
  nameOf: nameAt,
  release: (deskId) => {
    const presentation = office.release(deskId);
    if (presentation) toYou(presentation);
  },
  onFinding: (builder, task, issues) => lessons.note({ from: `Audit of ${nameAt(builder)}`, text: issues, about: task, kind: "audit" }),
  note: (text, deskId) => {
    history.add({ kind: "audit", who: "office", text, worker: workerRef(deskId) });
    broadcast({ t: "loop", goalId: progress.taskAt(deskId)?.goal.id ?? "", event: "warn", text: `🔍 ${text}` });
  },
  simulate: SIMULATE
    ? {
        // A scripted auditor finds two things the first time and approves the second.
        verdict: (auditor, report, file) =>
          setTimeout(() => {
            // Every other look finds something: issues first, then an approval.
            const n = simAudited.get(auditor) ?? 0;
            simAudited.set(auditor, n + 1);
            const first = n % 2 === 0;
            void report;
            writeFileSync(
              file,
              JSON.stringify(
                first
                  ? { status: "blocked", summary: "Two things to fix before it's ready", slides: ["The empty case isn't handled", "A helper is misnamed"] }
                  : { status: "ready", summary: "Looks good now — both fixed" },
              ),
            );
          }, 4000).unref(),
        recall: (builder) => setTimeout(() => office.roundup([builder]), 6000).unref(),
      }
    : undefined,
});
const simAudited = new Map<string, number>();
setInterval(() => audits.tick(), 10_000).unref();
setInterval(() => audits.checkVerdicts(), 3_000).unref();

office.onReport = (presentation) => {
  const { deskId, report } = presentation;
  // An auditor's verdict on a builder's work isn't for you: it goes back and forth.
  if (report && audits.auditorReport(deskId, report)) return;
  const check = loadConfig(CWD).check ?? null;
  // Finished work an auditor reviews first; otherwise it comes to you.
  const pass = (p: Presentation) => {
    if (p.report?.status === "ready" && audits.builderReady(deskId, p.report)) return;
    toYou(p);
  };
  // Plans and questions come straight in; finished work is checked first.
  if (!report || report.status !== "ready" || (!check && !SIMULATE)) {
    pass(presentation);
    return;
  }
  office.setCheck(deskId, { status: "running", command: check ?? "npm test (simulated)", exitCode: null, ms: 0, tail: "" });
  const verdict = (r: CheckResult) => {
    const worker = office.workerAt(deskId);
    // Only for the report it was run on: a newer one has its own check.
    if (!worker?.report || worker.report.at !== report.at) return;
    office.setCheck(deskId, r);
    const tries = gateTries.get(deskId) ?? 0;
    if (r.status === "fail" && progress.policy.gate === "fix" && tries < GATE_RETRIES) {
      gateTries.set(deskId, tries + 1);
      const tail = r.tail.split("\n").slice(-25).join("\n");
      office.review(
        deskId,
        false,
        `The check \`${r.command}\` failed${r.exitCode !== null ? ` (exit ${r.exitCode})` : ""} before review. Fix it, make sure it passes, and present again. The end of its output: ${tail}`,
      );
      const at = progress.taskAt(deskId);
      broadcast({
        t: "loop",
        goalId: at?.goal.id ?? "",
        event: "checkFailed",
        text: `🧪 ${r.command} failed for ${AGENT_LABELS[worker.agent]} — sent back to fix (${tries + 1}/${GATE_RETRIES})`,
      });
      // A real agent presents again once it's fixed; a scripted one is called back in.
      if (SIMULATE) setTimeout(() => office.roundup([deskId]), 6000).unref();
      return;
    }
    gateTries.delete(deskId);
    pass({ ...presentation, report: { ...worker.report } });
  };
  if (check) runCheck(check, office.workdir(deskId), verdict);
  else simulateCheck(verdict);
};
office.onSaid = (deskId, from, text) => broadcast({ t: "said", deskId, from, text });

// ---------------------------------------------------------------------------
// The agent loop: plans, research decks, shipping and deploys.
// ---------------------------------------------------------------------------

const goalFiles = new GoalFiles(join(CWD, ".domain", "goals"), (goalId, file, text) => {
  const goal = progress.getGoal(goalId);
  if (!goal) return;
  if (file === "plan") {
    const added = progress.addPlannedTasks(goalId, parsePlan(text));
    if (added) {
      broadcast({ t: "loop", goalId, event: "planned", text: `🧠 The plan for “${goal.title}” is in: ${added} task${added === 1 ? "" : "s"} added` });
      history.add({ kind: "goal", who: "office", text: `The plan for “${goal.title}” is in: ${added} task${added === 1 ? "" : "s"}`, goalId });
      if (goal.group?.length) setTimeout(() => groupContinue(goalId, goal.createdBy), 1500).unref();
    }
  } else if (file === "deck") {
    if (progress.setDeck(goalId, parseDeck(text), goalFiles.path(goalId, "deck"))) {
      broadcast({ t: "loop", goalId, event: "deck", text: `📊 The deck for “${goal.title}” was updated — ${progress.getGoal(goalId)?.deck?.slides.length ?? 0} slides` });
    }
  } else if (file === "shipped" && !goal.shippedAt) {
    const { url, note } = parseShipped(text);
    if (progress.shipped(goal.ship?.by ?? goal.createdBy, goalId, { mode: goal.ship?.mode === "deploy" ? "deploy" : "agent", url, note })) {
      broadcast({ t: "loop", goalId, event: "shipped", text: `🚢 “${goal.title}” shipped${url ? ` — ${url}` : ""}` });
      history.add({ kind: "shipped", who: "office", text: `“${goal.title}” shipped${url ? ` — ${url}` : ""}`, goalId });
    }
  }
});
goalFiles.start(() => progress.goalIds());

const deployer = new Deployer();
deployer.onOutput = (goalId, data) => broadcast({ t: "deployOutput", goalId, data });
deployer.onExit = (goalId, code, log) => {
  const goal = progress.getGoal(goalId);
  if (!goal) return;
  if (code === 0) {
    if (progress.shipped(goal.ship?.by ?? goal.createdBy, goalId, { mode: "deploy", exitCode: 0, url: /https?:\/\/[^\s"'<>)\x1b]+/.exec(log.slice(-4000))?.[0] ?? null })) {
      broadcast({ t: "loop", goalId, event: "shipped", text: `🚢 “${goal.title}” deployed!` });
      history.add({ kind: "shipped", who: "office", text: `“${goal.title}” deployed`, goalId });
    }
  } else {
    goalFiles.ensure(goalId);
    saveLog(goalFiles.path(goalId, "deploy.log"), log);
    progress.shipFailed(goalId, code, log.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));
    broadcast({ t: "loop", goalId, event: "deployFailed", text: `💥 The deploy of “${goal.title}” failed (exit ${code ?? "?"}) — ask a worker to fix it` });
  }
};

/** Ask the worker at a desk to plan a goal into tasks. */
function startPlan(who: string, goalId: string, deskId: string): void {
  const goal = progress.getGoal(goalId);
  if (!goal || !office.workerAt(deskId)) return;
  goalFiles.ensure(goalId);
  goalFiles.mark(goalId, "plan");
  const path = goalFiles.path(goalId, "plan");
  const briefed = office.brief(deskId, planBrief(goal, path), `🧠 Planning: ${goal.title}`, {
    steps: ["· reading the goal…", "· looking around the project…", "· breaking it into tasks…", `· writing ${path}`],
    done: () => writeQuietly(path, simPlan(goal)),
  });
  if (briefed) progress.planning(who, goalId, deskId);
}

/** Ship a goal: run the deploy command, or brief a worker to ship it (or fix a failed deploy). */
function startShip(who: string, goalId: string, deskId: string | null): void {
  const goal = progress.getGoal(goalId);
  if (!goal || goal.shippedAt || deployer.running) return;
  goalFiles.ensure(goalId);
  const shippedPath = goalFiles.path(goalId, "shipped");
  if (deskId) {
    if (!office.workerAt(deskId)) return;
    const failed = goal.ship?.status === "failed" ? goal.ship : null;
    goalFiles.mark(goalId, "shipped");
    const text = goal.kind === "research"
      ? deckBrief(goal, goalFiles.path(goalId, "deck"), shippedPath)
      : failed
      ? fixDeployBrief(goal, failed.command ?? "the deploy", failed.exitCode, goalFiles.path(goalId, "deploy.log"), shippedPath)
      : shipBrief(goal, shippedPath);
    const research = goal.kind === "research";
    const briefed = office.brief(deskId, text, research ? `📊 Writing the deck: ${goal.title}` : failed ? `🔧 Fixing the deploy: ${goal.title}` : `🚢 Shipping: ${goal.title}`, {
      steps: research
        ? ["· gathering the findings…", "· drafting the slides…", "· writing the summary…"]
        : failed
        ? ["· reading deploy.log…", "· found it: a missing env var", "· fixing and re-running the deploy…"]
        : ["· committing on a new branch…", "· pushing…", "· opening a pull request…"],
      done: () => {
        if (research) {
          simAppendSlides(goalFiles.path(goalId, "deck"), goal, "Summary and recommendations");
          setTimeout(() => writeQuietly(shippedPath, `Recommendation for ${goal.title} (simulated)
`), 2500).unref();
          return;
        }
        const pr = `https://github.com/you/project/pull/${10 + Math.floor(Math.random() * 90)}`;
        writeQuietly(shippedPath, `${pr}

${failed ? "Fixed the deploy" : "Opened a PR"} for ${goal.title} (simulated)
`);
      },
    });
    if (briefed) progress.shipStarted(who, goalId, "agent", failed?.command ?? null, deskId);
    return;
  }
  const { deploy } = loadConfig(CWD);
  if (deploy) {
    if (progress.shipStarted(who, goalId, "deploy", deploy, null) && deployer.run(goalId, deploy, CWD)) {
      broadcast({ t: "loop", goalId, event: "deployStarted", text: `🚀 Deploying “${goal.title}”…` });
    }
  } else if (SIMULATE) {
    if (progress.shipStarted(who, goalId, "deploy", "(simulated) npm run deploy", null)) {
      deployer.simulate(goalId, goal.title);
      broadcast({ t: "loop", goalId, event: "deployStarted", text: `🚀 Deploying “${goal.title}”… (simulated)` });
    }
  }
}

function writeQuietly(path: string, text: string): void {
  try {
    writeFileSync(path, text);
  } catch {
    /* best effort */
  }
}

// Presence moves are frequent; broadcast them on a fixed cadence if dirty.
let presenceDirty = false;
const PRESENCE_HZ = 15;
setInterval(() => {
  if (presenceDirty) {
    presenceDirty = false;
    broadcast({ t: "office", office: office.snapshot() });
  }
}, 1000 / PRESENCE_HZ).unref();

wss.on("connection", (ws, req: IncomingMessage & { domainRole?: ClientRec["role"] }) => {
  const id = randomUUID();
  // Connections accepted on the local-network listener carry their guest role.
  clients.set(ws, { id, name: "Guest", alive: true, joined: false, role: req?.domainRole ?? "host" });
  ws.on("pong", () => {
    const c = clients.get(ws);
    if (c) c.alive = true;
  });

  ws.on("message", (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const msg = parseClientMessage(parsed);
    if (!msg) return;
    const client = clients.get(ws);
    if (!client) return;
    // Guests from the local network only get what their role allows.
    if (!allowed(client.role, msg.t)) {
      // Speech they can't have: say so now, so their browser's own voice speaks instead of waiting.
      if (msg.t === "tts" && typeof msg.id === "string") send(ws, { t: "ttsAudio", id: msg.id.slice(0, 40), error: "not allowed" });
      return;
    }

    // Every message but join and roundup names a desk.
    const deskId = "deskId" in msg ? str(msg.deskId, 64) : null;
    if ("deskId" in msg && !deskId) return;

    switch (msg.t) {
      case "join": {
        client.name = (typeof msg.name === "string" ? msg.name : "").replace(/\s+/g, " ").trim().slice(0, 24) || "Guest";
        client.joined = true;
        office.addPeer(id, client.name, coerceLook(msg.look));
        send(ws, { t: "welcome", selfId: id, office: office.snapshot() });
        send(ws, { t: "progress", progress: progress.snapshot() });
        send(ws, { t: "oplogAll", entries: log.all() });
        const cfg = loadConfig(CWD);
        send(ws, {
          t: "config",
          project: CWD,
          preview: cfg.preview,
          deploy: cfg.deploy ?? (SIMULATE ? "(simulated) npm run deploy" : null),
          simulate: SIMULATE,
          check: cfg.check ?? (SIMULATE ? "npm test (simulated)" : null),
          git: office.workspaces ? { base: office.workspaces.base() } : null,
          localModels,
        });
        if (deployer.goalId) send(ws, { t: "deployLog", goalId: deployer.goalId, data: deployer.log });
        break;
      }
      case "move": {
        const x = num(msg.x);
        const z = num(msg.z);
        const facing = num(msg.facing);
        if (x === null || z === null || facing === null) break;
        office.movePeer(id, x, z, facing);
        presenceDirty = true;
        break;
      }
      case "hire": {
        // One of your team's characters brings its own agent, model and leash.
        const character = typeof msg.characterId === "string" ? progress.character(msg.characterId) : null;
        const agent = character?.agent ?? msg.agent;
        if (!AGENT_KINDS.includes(agent)) break;
        const policy = progress.policy;
        const model =
          typeof msg.model === "string" && isModelName(msg.model) ? msg.model : character?.model || policy.defaultModel[agent];
        const leash = isLeash(msg.leash) ? msg.leash : (character?.leash ?? policy.leash);
        const identity: WorkerIdentity | null = character
          ? { characterId: character.id, name: character.name, look: character.look, voice: character.voice }
          : null;
        if (office.hire(msg.deskId, agent, client.name, model, leash, policy.isolate, identity)) {
          warnIfTooBig(model);
          watchLocalContext(model);
          history.add({ kind: "hired", who: client.name, text: `${client.name} hired ${nameAt(msg.deskId)} at ${msg.deskId.replace("desk-", "desk ")}`, worker: workerRef(msg.deskId) });
          if (character) progress.characterHired(character.id);
          progress.hired(client.name);
          progress.recheck(client.name);
          send(ws, { t: "scrollback", deskId: msg.deskId, data: office.scrollback(msg.deskId) });
        }
        break;
      }
      case "fire": {
        fireWorker(client.name, msg.deskId, str(msg.reason, 1000)?.trim() || undefined);
        break;
      }
      case "alumniGet": {
        send(ws, { t: "alumni", list: alumni.all });
        break;
      }
      case "rehire": {
        const a = alumni.get(str(msg.id, 32) ?? "");
        if (!a || office.workerAt(msg.deskId)) break;
        const character = a.characterId ? progress.character(a.characterId) : null;
        const identity: WorkerIdentity | null = character ? { characterId: character.id, name: character.name, look: character.look, voice: character.voice } : null;
        if (office.hire(msg.deskId, a.agent, client.name, a.model, a.leash, progress.policy.isolate, identity)) {
          alumni.remove(a.id);
          history.add({ kind: "hired", who: client.name, text: `${client.name} brought ${a.name} back, at ${msg.deskId.replace("desk-", "desk ")}`, worker: workerRef(msg.deskId) });
        }
        break;
      }
      case "open": {
        send(ws, { t: "scrollback", deskId: msg.deskId, data: office.scrollback(msg.deskId) });
        break;
      }
      case "input": {
        if (str(msg.data, 64 * 1024) === null) break;
        office.input(msg.deskId, msg.data);
        break;
      }
      case "resize": {
        const cols = num(msg.cols);
        const rows = num(msg.rows);
        if (cols === null || rows === null || cols > 1000 || rows > 500) break;
        office.resize(msg.deskId, cols, rows);
        break;
      }
      case "review": {
        reviewWork(client.name, msg.deskId, !!msg.approve, str(msg.text, 8000) ?? undefined, typeof msg.sketch === "string" ? msg.sketch : undefined);
        break;
      }
      case "goalCreate": {
        const tasks = Array.isArray(msg.tasks) ? msg.tasks.filter((t): t is string => typeof t === "string").slice(0, 40) : [];
        const due = num(msg.dueAt);
        const goal = progress.createGoal(client.name, str(msg.title, 500) ?? "", str(msg.why, 1000) ?? "", tasks, msg.kind === "research" ? "research" : "build", due);
        if (goal) history.add({ kind: "goal", who: client.name, text: `${client.name} set a goal: “${goal.title}”${due ? `, due ${new Date(due).toLocaleString()}` : ""}`, goalId: goal.id });
        break;
      }
      case "goalDue": {
        const goalId = str(msg.goalId, 64);
        const due = msg.dueAt === null ? null : num(msg.dueAt);
        if (goalId && progress.setDue(goalId, due)) {
          const g = progress.getGoal(goalId)!;
          history.add({ kind: "deadline", who: client.name, text: due ? `“${g.title}” is due ${new Date(due).toLocaleString()}` : `“${g.title}” has no deadline now`, goalId });
        }
        break;
      }
      case "goalGroup": {
        const goalId = str(msg.goalId, 64);
        const deskIds = Array.isArray(msg.deskIds) ? msg.deskIds.filter((d): d is string => typeof d === "string" && office.isStaffed(d)).slice(0, 12) : [];
        if (!goalId || !progress.setGroup(goalId, deskIds)) break;
        const g = progress.getGoal(goalId)!;
        if (deskIds.length) {
          history.add({ kind: "group", who: client.name, text: `${client.name} gave “${g.title}” to ${deskIds.map(nameAt).join(", ")}`, goalId });
          groupContinue(goalId, client.name);
        }
        break;
      }
      case "lessonsGet": {
        send(ws, { t: "lessons", state: lessons.snapshot, syncing: eod.isRunning });
        break;
      }
      case "lessonTeach": {
        const text = str(msg.text, 240);
        if (text) lessons.teach(text);
        break;
      }
      case "lessonForget": {
        lessons.forget({ lesson: str(msg.lesson, 240) ?? undefined, noteAt: typeof msg.noteAt === "number" ? msg.noteAt : undefined });
        break;
      }
      case "eodSync": {
        void eod.run();
        broadcast({ t: "lessons", state: lessons.snapshot, syncing: true });
        break;
      }
      case "skillsGet": {
        send(ws, { t: "skills", seen: scanSkills(homedir(), CWD, AGENT_KINDS) });
        break;
      }
      case "historyGet": {
        send(ws, { t: "history", events: history.latest() });
        break;
      }
      case "goalDelete": {
        const goalId = str(msg.goalId, 64);
        if (goalId) progress.deleteGoal(goalId);
        break;
      }
      case "taskAdd": {
        const goalId = str(msg.goalId, 64);
        if (goalId) progress.addTask(goalId, str(msg.title, 500) ?? "");
        break;
      }
      case "taskAssign": {
        const goalId = str(msg.goalId, 64);
        const taskId = str(msg.taskId, 64);
        if (goalId && taskId) assignTask(client.name, goalId, taskId, msg.deskId, msg.brief);
        break;
      }
      case "quickTask": {
        // "Work on this" from the chat, the laptop or the phone: a real task, tracked and reviewed like any other.
        // deskId "any": the first free worker takes it — or, with nobody free, it waits on the goal for the next one.
        const said = str(msg.text, 4000)?.trim();
        if (!said) break;
        const toAny = msg.deskId === "any";
        if (!toAny && !office.isStaffed(msg.deskId)) break;
        const snap = progress.snapshot();
        const open = (id: string | null | undefined) => snap.goals.find((g) => g.id === id && !g.shippedAt && !g.doneAt);
        let goal = open(str(msg.goalId, 64)) ?? open(snap.session?.goalId) ?? snap.goals.find((g) => g.title === "Quick tasks" && !g.shippedAt && !g.doneAt);
        goal ??= progress.createGoal(client.name, "Quick tasks", "Small things handed out from the chat", [], "build") ?? undefined;
        if (!goal) break;
        const deskId = toAny ? freeWorker() : msg.deskId;
        // A long one, handed out now: its first line (or the start) is the title, and all of it goes in the brief.
        // Waiting for someone, it keeps as much as a title holds.
        const firstLine = said.split("\n")[0].trim();
        const max = deskId ? 120 : 300;
        const title = deskId && firstLine.length <= max ? firstLine : said.length <= max ? said : `${(deskId ? firstLine : said).slice(0, max - 3).trimEnd()}…`;
        const brief = title === said ? {} : { notes: said };
        const taskId = progress.addTask(goal.id, title);
        if (!taskId) break;
        if (!deskId) {
          send(ws, { t: "loop", goalId: goal.id, event: "warn", text: `🎯 Nobody's free right now — “${title}” is waiting on “${goal.title}” for the next one` });
          break;
        }
        office.onSaid?.(deskId, "you", `🎯 New task: ${said}`);
        if (assignTask(client.name, goal.id, taskId, deskId, brief)) send(ws, { t: "loop", goalId: goal.id, event: "warn", text: `🎯 ${nameAt(deskId)} is on “${title}”` });
        break;
      }
      case "policySet": {
        progress.setPolicy(client.name, coercePolicy(msg.policy, progress.policy));
        break;
      }
      case "taskDone": {
        const goalId = str(msg.goalId, 64);
        const taskId = str(msg.taskId, 64);
        if (goalId && taskId) progress.setDone(client.name, goalId, taskId, !!msg.done);
        break;
      }
      case "sessionStart": {
        const minutes = num(msg.minutes);
        if (minutes === null) break;
        progress.startSession(client.name, minutes, typeof msg.goalId === "string" ? msg.goalId : null);
        break;
      }
      case "sessionStop": {
        progress.endSession(false);
        break;
      }
      case "standup": {
        const minutes = num(msg.minutes);
        if (minutes === null || !isTone(msg.tone)) break;
        const ng = msg.newGoal && typeof msg.newGoal === "object" ? msg.newGoal : undefined;
        progress.standup(client.name, {
          goalId: str(msg.goalId, 64),
          newGoal: ng
            ? {
                title: str(ng.title, 500) ?? "",
                why: str(ng.why, 1000) ?? "",
                tasks: Array.isArray(ng.tasks) ? ng.tasks.filter((t): t is string => typeof t === "string").slice(0, 40) : [],
                kind: ng.kind === "research" ? "research" : "build",
                dueAt: num(ng.dueAt),
              }
            : undefined,
          tone: msg.tone,
          intention: str(msg.intention, 1000) ?? "",
          minutes,
        });
        break;
      }
      case "plan": {
        const goalId = str(msg.goalId, 64);
        if (goalId) startPlan(client.name, goalId, msg.deskId);
        break;
      }
      case "ship": {
        const goalId = str(msg.goalId, 64);
        if (goalId) startShip(client.name, goalId, deskId);
        break;
      }
      case "shipDone": {
        const goalId = str(msg.goalId, 64);
        const goal = goalId ? progress.getGoal(goalId) : undefined;
        if (!goal || deployer.goalId === goal.id && deployer.running) break;
        if (progress.shipped(client.name, goal.id, { mode: "manual", url: str(msg.url, 500) })) {
          broadcast({ t: "loop", goalId: goal.id, event: "shipped", text: goal.kind === "research" ? `📊 “${goal.title}” delivered` : `🚢 “${goal.title}” shipped` });
        }
        break;
      }
      case "shipCancel": {
        const goalId = str(msg.goalId, 64);
        if (!goalId) break;
        if (deployer.goalId === goalId) deployer.cancel();
        progress.shipCancelled(goalId);
        break;
      }
      case "probe": {
        void probeDevServers([PORT]).then((urls) => send(ws, { t: "devServers", urls }));
        break;
      }
      case "roundup": {
        if (!Array.isArray(msg.deskIds) || msg.deskIds.length > 100) break;
        office.roundup(msg.deskIds.filter((d): d is string => typeof d === "string"));
        break;
      }
      case "say": {
        if (str(msg.text, 4000) !== null && office.say(msg.deskId, msg.text)) heard(msg.text, msg.deskId, client);
        break;
      }
      default: {
        // Projects and GitHub, the team, MCP, local multiplayer…
        routes.get(msg.t)?.(msg as never, client, ws);
        break;
      }
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    office.removePeer(id);
  });
  ws.on("error", () => ws.close());
});

// ---------------------------------------------------------------------------
// Feature modules plug in here.
// ---------------------------------------------------------------------------

/** The standing instructions of the character at a desk, for its task briefs. */
/** A local model too big for this computer's memory: say so now, not after it hangs. */
function warnIfTooBig(model: string): void {
  const warning = localModelWarning(model);
  if (!warning) return;
  log.start("agent", `⚠ ${warning}`).done(false);
  broadcast({ t: "loop", goalId: "", event: "warn", text: `🧠 ${warning}` });
}

/**
 * A worker free to take something new: at work today (not asleep), nothing
 * open on its plate (not mid-task, not presenting one) — idle ones first.
 */
function freeWorker(): string | null {
  const busy = new Set(progress.snapshot().goals.flatMap((g) => g.tasks.filter((t) => t.deskId && t.status !== "done").map((t) => t.deskId!)));
  const free = office
    .snapshot()
    .desks.filter((d) => d.worker && office.isStaffed(d.id) && !busy.has(d.id) && (d.worker.status === "idle" || d.worker.status === "done"));
  return (free.find((d) => d.worker!.status === "idle") ?? free[0])?.id ?? null;
}

/** Extra lines for task briefs, from feature modules (e.g. the idea a task came from). */
const briefNotes: ((goalId: string, taskId: string, deskId: string) => string)[] = [];

/** Put the worker at a desk on a task and brief it. */
function assignTask(who: string, goalId: string, taskId: string, deskId: string, rawBrief: unknown): boolean {
  const desk = office.snapshot().desks.find((d) => d.id === deskId);
  if (!desk?.worker) return false;
  const brief = coerceBrief(rawBrief ?? {}, progress.policy);
  const got = progress.assign(who, goalId, taskId, deskId, brief);
  if (!got) return false;
  const paired = brief.auditor ? audits.start(deskId, brief.auditor, got.title, brief.rounds ?? DEFAULT_AUDIT_ROUNDS, brief.auditWhen === "along") : false;
  history.add({
    kind: "assigned",
    who,
    text: `${who} put ${nameAt(deskId)} on “${got.title}”${paired ? `, audited by ${nameAt(brief.auditor!)}${brief.auditWhen === "along" ? " along the way" : ""}` : ""}`,
    worker: workerRef(deskId),
    goalId,
    task: got.title,
  });
  if (brief.model) warnIfTooBig(brief.model);
  // Put the worker on the task's model first: Claude Code switches in
  // place; other CLIs restart on it, so give them a moment to boot.
  const switched = brief.model ? office.switchModel(deskId, brief.model) : "same";
  const delay = switched === "restarted" ? 6000 : switched === "switched" && !SIMULATE ? 1500 : 0;
  const ws = office.workspaceOf(deskId);
  if (ws) office.workspaces?.sync(ws.path);
  const notes = briefNotes.map((f) => f(goalId, taskId, deskId)).join("") + (brief.notes ? ` Notes from your manager: "${brief.notes}"` : "");
  const handOver = () => {
    if (got.goal.kind === "research") {
      goalFiles.ensure(goalId);
      const deckPath = goalFiles.path(goalId, "deck");
      office.assign(deskId, got.goal.title, got.title, " " + researchBrief(deckPath) + notes + personaFor(deskId), got.goal.why, brief);
      // A scripted worker "writes" its slides as it presents.
      if (SIMULATE) setTimeout(() => simAppendSlides(deckPath, got.goal, got.title), 3000).unref();
    } else {
      office.assign(deskId, got.goal.title, got.title, notes + personaFor(deskId), got.goal.why, brief);
    }
  };
  if (delay) setTimeout(handOver, delay).unref();
  else handOver();
  return true;
}

/**
 * Send a worker home: its pairing, its MCP configs and (if it's merged) its
 * branch go with it. It's kept among your former workers (to bring back), and
 * why you let it go — if you say — is something the whole team learns from.
 */
function fireWorker(who: string, deskId: string, reason?: string): boolean {
  const ws = office.workspaceOf(deskId);
  const leaving = workerRef(deskId);
  const w = office.workerAt(deskId);
  const tasksDone = history.of({ deskId, characterId: w?.identity?.characterId }).filter((e) => e.kind === "approved").length;
  const isIntern = !!office.snapshot().desks.find((d) => d.id === deskId)?.worker?.internOf;
  if (!office.fire(deskId)) return false;
  office.setInternOf(deskId, undefined);
  audits.forget(deskId);
  if (leaving) history.add({ kind: "left", who, text: `${leaving.name} went home${reason ? ` — “${reason}”` : ""}`, worker: leaving });
  if (w && leaving && !isIntern) {
    alumni.add({ name: leaving.name, agent: w.agent, model: w.model, leash: w.leash, characterId: w.identity?.characterId, reason, desk: deskId, branch: ws?.branch, tasksDone });
  }
  if (reason && leaving) lessons.note({ from: "you", text: `Let ${leaving.name} go: ${reason}`, kind: "feedback" });
  progress.unlinkDesk(deskId);
  // Its MCP configs may hold tokens: they go with it.
  mcpCleanup(CWD, deskId);
  gateTries.delete(deskId);
  if (ws && office.workspaces?.remove(ws) === "kept") {
    broadcast({ t: "loop", goalId: "", event: "mergeFailed", text: `🌿 Kept ${ws.branch} — it has work that isn't on your branch yet` });
  }
  return true;
}

/**
 * A review's outcome — yours, or autopilot's: approve (merging the worker's
 * branch, when merges are automatic) or send back with changes. Feedback is
 * something the whole team learns from.
 */
function reviewWork(who: string, deskId: string, approve: boolean, text?: string, sketch?: string): boolean {
  const wasPlan = office.reportStatus(deskId) === "plan";
  const ws = office.workspaceOf(deskId);
  if (approve && !wasPlan && ws && office.workspaces && progress.policy.merge === "auto") {
    const at = progress.taskAt(deskId);
    const title = at?.title ?? "work";
    office.workspaces.commitAll(office.workdir(deskId), `domain: ${title}`);
    const m = office.workspaces.merge(ws.branch, title);
    if (m.outcome === "conflict") {
      // It can't land cleanly: back to the worker to resolve, not onto your branch.
      const base = office.workspaces.base() ?? "your branch";
      if (office.review(deskId, false, `Approved — but your branch conflicts with ${base}. Merge ${base} into your branch, resolve the conflicts, make sure the checks pass, and present again.`)) {
        progress.reviewed(who, deskId, false);
      }
      broadcast({ t: "loop", goalId: at?.goal.id ?? "", event: "mergeFailed", text: `🌿 ${m.message} — sent back to resolve` });
      return false;
    }
    if (m.outcome === "merged") broadcast({ t: "loop", goalId: at?.goal.id ?? "", event: "merged", text: `🌿 ${m.message}` });
    else if (m.outcome === "dirty" || m.outcome === "error") broadcast({ t: "loop", goalId: at?.goal.id ?? "", event: "mergeFailed", text: `🌿 ${m.message}` });
  }
  const reviewed = office.review(deskId, approve, text, sketch);
  if (!reviewed) return false;
  const task = progress.taskAt(deskId);
  const said = text?.trim();
  if (!approve && said && !wasPlan) lessons.note({ from: who === "Autopilot" ? "Autopilot" : "you", text: said, about: task?.title, kind: "feedback" });
  progress.reviewed(who, deskId, approve, wasPlan);
  history.add({
    kind: approve ? "approved" : "changes",
    who,
    text: approve
      ? `${who} approved ${wasPlan ? "the plan of" : "the work of"} ${nameAt(deskId)}${task ? ` on “${task.title}”` : ""}`
      : `${who} sent ${nameAt(deskId)} back with changes${task ? ` on “${task.title}”` : ""}`,
    worker: workerRef(deskId),
    goalId: task?.goal.id,
    task: task?.title,
  });
  // A group's member who finished gets the goal's next task.
  if (approve && !wasPlan && task?.goal.group?.includes(deskId)) setTimeout(() => groupContinue(task.goal.id, who), 2500).unref();
  return true;
}

/**
 * A group works a goal together: if it has no tasks yet, its first member
 * plans it; otherwise every member who's free gets the next task to do.
 */
function groupContinue(goalId: string, who: string): void {
  const goal = progress.getGoal(goalId);
  const group = (goal?.group ?? []).filter((d) => office.isStaffed(d));
  if (!goal || !group.length || goal.shippedAt) return;
  if (!goal.tasks.length) {
    if (!goal.planningDesk) startPlan(who, goalId, group[0]);
    return;
  }
  for (const deskId of group) {
    const busy = goal.tasks.some((t) => t.deskId === deskId && t.status !== "done") || office.workerAt(deskId)?.status === "presenting";
    if (busy) continue;
    const next = progress.getGoal(goalId)?.tasks.find((t) => t.status === "todo" && !t.deskId);
    if (!next) break;
    assignTask(who, goalId, next.id, deskId, {});
  }
}

function personaFor(deskId: string): string {
  const id = office.workerAt(deskId)?.identity?.characterId;
  const c = id ? progress.character(id) : null;
  // Skills it's not to use: Claude Code has them blocked; the others are told.
  const off = c?.skillsOff?.length && c.agent !== "claude" ? ` Don't use these skills: ${c.skillsOff.join(", ")}.` : "";
  return (c ? personaBrief(c) : "") + off;
}

const ctx: ServerCtx = {
  cwd: CWD,
  port: PORT,
  simulate: SIMULATE,
  office,
  progress,
  log,
  send,
  broadcast,
  clients: () => clients,
  wss,
  serveStatic,
  relaunch: (path: string) => {
    const hook = (globalThis as { __domainRelaunch?: (p: string) => void }).__domainRelaunch;
    if (!hook) return false;
    hook(path);
    return true;
  },
  assignTask,
  briefNotes,
  heard,
};
// Per-session MCP configs from a previous run (e.g. after a crash) can hold tokens: clear them.
mcpCleanup(CWD);

// What a worker's tools are, to show: its CLI's own MCP servers (user and project config) plus the office's.
office.mcpNames = (agent, identity, model) => {
  const picks = identity ? (progress.character(identity.characterId)?.mcp ?? []) : null;
  let own: string[] = [];
  try {
    // Claude Code on a local model starts lean (see leanLocalArgs): none of your own.
    if (!(agent === "claude" && model.startsWith("ollama/"))) own = scanAgents({ home: homedir(), projectDir: CWD }).filter((s) => s.agent === agent).map((s) => s.name);
  } catch {
    /* unreadable config: just the office's */
  }
  return [...new Set([...own, ...serversFor(progress.mcp, picks).map((s) => s.name)])].slice(0, 20);
};

// Its skills: all its CLI has, minus any its character turned off.
office.skillsFor = (agent, identity) => {
  const off = identity ? (progress.character(identity.characterId)?.skillsOff ?? []) : [];
  let all: string[] = [];
  try {
    all = scanSkills(homedir(), CWD, [agent]).map((s) => s.name);
  } catch {
    /* unreadable: none to show */
  }
  return { on: all.filter((n) => !off.includes(n)), off: off.filter((n) => all.includes(n)) };
};

// Each worker launches with its MCP servers: its character's picks plus the ones for everyone.
office.mcpFor = (deskId, agent, identity) => {
  const picks = identity ? (progress.character(identity.characterId)?.mcp ?? []) : null;
  // Servers that use your GitHub sign-in get it now; without a sign-in they're left out (and the log says so).
  const token = ctx.githubToken?.() ?? null;
  const servers = serversFor(progress.mcp, picks).flatMap((s) => {
    const authed = withGithubAuth(s, token);
    if (!authed) log.start("mcp", `${s.name} left out for ${deskId}: sign in to GitHub first`, { topic: "mcp:launch" }).done(false);
    return authed ? [authed] : [];
  });
  if (!servers.length) return null;
  try {
    const launch = mcpLaunch(agent, servers, { projectDir: CWD, deskId });
    log.start("mcp", describeLaunch(agent, servers, launch), { topic: "mcp:launch" }).done(true);
    return launch;
  } catch (e) {
    log.start("mcp", `Couldn't give ${deskId} its MCP servers`, { topic: "mcp:launch" }).done(false, (e as Error).message);
    return null;
  }
};

/**
 * A local model on Ollama: once it's loaded, check the context window it got.
 * Ollama's default (4K) is far too small for an agent — it can't even read its
 * own instructions — so say how to raise it.
 */
function watchLocalContext(model: string): void {
  if (!model.startsWith("ollama/")) return;
  const name = model.slice("ollama/".length);
  const started = Date.now();
  const look = async () => {
    const ctxLen = await ollamaContext(name);
    if (ctxLen === null) {
      if (Date.now() - started < 4 * 60_000) setTimeout(() => void look(), 10_000).unref();
      return;
    }
    if (ctxLen < MIN_AGENT_CONTEXT) {
      broadcast({
        t: "loop",
        goalId: "",
        event: "warn",
        text: `🧠 ${name} is running with a ${Math.round(ctxLen / 1024)}K context window — an agent needs 32K or more. In Ollama's settings set Context length to 32K (or start Ollama with OLLAMA_CONTEXT_LENGTH=32768), then hire it again. And keep its tasks small.`,
      });
    }
  };
  setTimeout(() => void look(), 15_000).unref();
}

// --- autopilot: the office runs itself --------------------------------------------------------

/** A worker's request for interns ({"interns": ["…"]} in its .domain/requests/<desk>.json), read and cleared. */
function internRequests(): { deskId: string; pieces: string[] }[] {
  const out: { deskId: string; pieces: string[] }[] = [];
  for (const d of office.snapshot().desks) {
    if (!d.worker || d.worker.internOf) continue;
    const file = join(office.workdir(d.id), ".domain", "requests", `${d.id}.json`);
    if (!existsSync(file)) continue;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { interns?: unknown };
      const pieces = Array.isArray(raw.interns) ? raw.interns.filter((x): x is string => typeof x === "string" && x.trim().length > 3).map((x) => x.trim().slice(0, 200)) : [];
      if (pieces.length) out.push({ deskId: d.id, pieces });
    } catch {
      /* half-written: next time */
      continue;
    }
    rmSync(file, { force: true });
  }
  return out;
}

const autopilot = new Autopilot({
  policy: () => progress.policy,
  goals: () => progress.snapshot().goals,
  desks: () => office.snapshot().desks,
  line: () => office.snapshot().presentations,
  isAuditing: (d) => audits.isAuditing(d),
  assign: (g, t, d, brief) => void assignTask("Autopilot", g, t, d, brief),
  plan: (g, d) => startPlan("Autopilot", g, d),
  approve: (d) => void reviewWork("Autopilot", d, true),
  addTask: (g, title) => progress.addTask(g, title),
  hire: (deskId, agent, model, leash, mentor) => {
    if (!office.hire(deskId, agent, "Autopilot", model, leash, progress.policy.isolate, null)) return false;
    office.setInternOf(deskId, mentor);
    history.add({ kind: "hired", who: "Autopilot", text: `${nameAt(mentor)} brought in an intern at ${deskId.replace("desk-", "desk ")}`, worker: workerRef(deskId) });
    return true;
  },
  fire: (d) => void fireWorker("Autopilot", d),
  requests: internRequests,
  internDesks: () => [...BAY_DESK_IDS, ...DESKS.map((d) => d.id).filter((id) => !BAY_DESK_IDS.includes(id))],
  eod: () => void eod.run(),
  note: (text, deskId) => {
    history.add({ kind: "audit", who: "Autopilot", text, ...(deskId ? { worker: workerRef(deskId) } : {}) });
    broadcast({ t: "loop", goalId: "", event: "warn", text: `🤖 ${text}` });
  },
});
setInterval(() => autopilot.tick(), 20_000).unref();

// Workers can ask for interns when the policy allows it.
briefNotes.push((_g, _t, deskId) =>
  progress.policy.autopilot.interns && !/^(ollama|lmstudio)\//.test(office.workerAt(deskId)?.model ?? "")
    ? ` If this task splits into independent pieces, you can bring in up to three interns: write {"interns": ["one piece, described fully", "…"]} to .domain/requests/$DOMAIN_DESK.json — each gets one piece at the intern bay, and you review their work before it reaches your manager.`
    : "",
);

// In the desktop app the server runs in a background process of its own:
// hook up the app's folder picker and relaunch before the modules read them.
const tellAppReady = connectToApp(() => closeUp());

const routes = new Map<string, Route>();
routes.set("logs", (_msg, _client, ws) => send(ws, { t: "oplogAll", entries: log.all() }));
// The gong (or E at a sleeping worker's desk): last time's team gets back to work.
routes.set("wake", (msg, client) => {
  const deskId = typeof msg.deskId === "string" ? msg.deskId : undefined;
  const n = office.wake(deskId);
  if (n) log.start("agent", `${client.name} woke ${n === 1 && deskId ? `the worker at ${deskId}` : `${n} worker${n === 1 ? "" : "s"}`}: each picks up its last conversation`).done(true);
});
// You said this project's worker folders can be trusted: remember it, and answer any agent asking now.
routes.set("trustWorkers", () => {
  trustProject(CWD);
  void office.trustAll().then((n) => log.start("agent", n ? `Trusted this project's worker folders (answered ${n} waiting)` : "Trusted this project's worker folders").done(true));
});
for (const make of MODULES) {
  for (const [t, route] of Object.entries(make(ctx))) if (route) routes.set(t, route);
}
// A character edited while it's working updates its worker at the desk too.
{
  const save = routes.get("characterSave");
  if (save) {
    routes.set("characterSave", (msg, client, ws) => {
      save(msg, client, ws);
      office.updateIdentities(progress.team);
    });
  }
}

/** Resolves to the base URL once the server is accepting connections. */
export const serverReady: Promise<string> = new Promise((resolve) => {
  httpServer.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}`;
    console.log(`domain server listening on ${url}`);
    tellAppReady(url);
    resolve(url);
  });
});

/**
 * Close up: every worker's terminal (and what it started) is ended — the team
 * itself is remembered in .domain/office.json, asleep at its desks next time.
 */
function closeUp(): void {
  mcpCleanup(CWD);
  deployer.cancel();
  goalFiles.stop();
  progress.dispose();
  office.dispose();
}
// The desktop app calls this as it quits.
(globalThis as { __domainShutdown?: () => void }).__domainShutdown = closeUp;

function shutdown(): void {
  closeUp();
  for (const ws of clients.keys()) ws.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
