import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { AGENT_KINDS, AGENT_LABELS, coerceLook, parseClientMessage, type CheckResult, type ServerMessage } from "../shared/protocol.js";
import { GATE_RETRIES, coerceBrief, coercePolicy, isModelName } from "../shared/policy.js";
import { runCheck, simulateCheck } from "./checks.js";
import { OpLogger } from "./oplog.js";
import { allowed } from "./permissions.js";
import { MODULES } from "./modules.js";
import { describeLaunch, mcpCleanup, mcpLaunch, serversFor, withGithubAuth } from "./mcp.js";
import type { ClientRec, Route, ServerCtx } from "./ctx.js";
import { personaBrief, type WorkerIdentity } from "../shared/team.js";
import { Office } from "./office.js";
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
  simPlan,
} from "./loop.js";

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
const office = new Office({ cwd: CWD, simulate: SIMULATE });

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

office.onReport = (presentation) => {
  const { deskId, report } = presentation;
  const check = loadConfig(CWD).check ?? null;
  // Plans and questions come straight in; finished work is checked first.
  if (!report || report.status !== "ready" || (!check && !SIMULATE)) {
    progress.reported(deskId);
    broadcast({ t: "report", presentation });
    return;
  }
  office.setCheck(deskId, { status: "running", command: check ?? "npm test (simulated)", exitCode: null, ms: 0, tail: "" });
  const verdict = (r: CheckResult) => {
    const worker = office.workerAt(deskId);
    if (!worker?.report) return;
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
    progress.reported(deskId);
    broadcast({ t: "report", presentation: { ...presentation, report: { ...worker.report } } });
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
    if (added) broadcast({ t: "loop", goalId, event: "planned", text: `🧠 The plan for “${goal.title}” is in: ${added} task${added === 1 ? "" : "s"} added` });
  } else if (file === "deck") {
    if (progress.setDeck(goalId, parseDeck(text), goalFiles.path(goalId, "deck"))) {
      broadcast({ t: "loop", goalId, event: "deck", text: `📊 The deck for “${goal.title}” was updated — ${progress.getGoal(goalId)?.deck?.slides.length ?? 0} slides` });
    }
  } else if (file === "shipped" && !goal.shippedAt) {
    const { url, note } = parseShipped(text);
    if (progress.shipped(goal.ship?.by ?? goal.createdBy, goalId, { mode: goal.ship?.mode === "deploy" ? "deploy" : "agent", url, note })) {
      broadcast({ t: "loop", goalId, event: "shipped", text: `🚢 “${goal.title}” shipped${url ? ` — ${url}` : ""}` });
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
    if (!allowed(client.role, msg.t)) return;

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
        const leash = msg.leash === "auto" || msg.leash === "ask" ? msg.leash : (character?.leash ?? policy.leash);
        const identity: WorkerIdentity | null = character
          ? { characterId: character.id, name: character.name, look: character.look, voice: character.voice }
          : null;
        if (office.hire(msg.deskId, agent, client.name, model, leash, policy.isolate, identity)) {
          if (character) progress.characterHired(character.id);
          progress.hired(client.name);
          progress.recheck(client.name);
          send(ws, { t: "scrollback", deskId: msg.deskId, data: office.scrollback(msg.deskId) });
        }
        break;
      }
      case "fire": {
        const ws = office.workspaceOf(msg.deskId);
        if (office.fire(msg.deskId)) {
          progress.unlinkDesk(msg.deskId);
          // Its MCP configs may hold tokens: they go with it.
          mcpCleanup(CWD, msg.deskId);
          gateTries.delete(msg.deskId);
          if (ws && office.workspaces?.remove(ws) === "kept") {
            broadcast({ t: "loop", goalId: "", event: "mergeFailed", text: `🌿 Kept ${ws.branch} — it has work that isn't on your branch yet` });
          }
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
        const wasPlan = office.reportStatus(msg.deskId) === "plan";
        const ws = office.workspaceOf(msg.deskId);
        if (msg.approve && !wasPlan && ws && office.workspaces && progress.policy.merge === "auto") {
          const at = progress.taskAt(msg.deskId);
          const title = at?.title ?? "work";
          office.workspaces.commitAll(office.workdir(msg.deskId), `domain: ${title}`);
          const m = office.workspaces.merge(ws.branch, title);
          if (m.outcome === "conflict") {
            // It can't land cleanly: back to the worker to resolve, not onto your branch.
            const base = office.workspaces.base() ?? "your branch";
            if (office.review(msg.deskId, false, `Approved — but your branch conflicts with ${base}. Merge ${base} into your branch, resolve the conflicts, make sure the checks pass, and present again.`)) {
              progress.reviewed(client.name, msg.deskId, false);
            }
            broadcast({ t: "loop", goalId: at?.goal.id ?? "", event: "mergeFailed", text: `🌿 ${m.message} — sent back to resolve` });
            break;
          }
          if (m.outcome === "merged") broadcast({ t: "loop", goalId: at?.goal.id ?? "", event: "merged", text: `🌿 ${m.message}` });
          else if (m.outcome === "dirty" || m.outcome === "error") broadcast({ t: "loop", goalId: at?.goal.id ?? "", event: "mergeFailed", text: `🌿 ${m.message}` });
        }
        const reviewed = office.review(
          msg.deskId,
          !!msg.approve,
          str(msg.text, 8000) ?? undefined,
          typeof msg.sketch === "string" ? msg.sketch : undefined,
        );
        if (reviewed) progress.reviewed(client.name, msg.deskId, !!msg.approve, wasPlan);
        break;
      }
      case "goalCreate": {
        const tasks = Array.isArray(msg.tasks) ? msg.tasks.filter((t): t is string => typeof t === "string").slice(0, 40) : [];
        progress.createGoal(client.name, str(msg.title, 500) ?? "", str(msg.why, 1000) ?? "", tasks, msg.kind === "research" ? "research" : "build");
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
        if (str(msg.text, 4000) !== null) office.say(msg.deskId, msg.text);
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
/** Extra lines for task briefs, from feature modules (e.g. the idea a task came from). */
const briefNotes: ((goalId: string, taskId: string, deskId: string) => string)[] = [];

/** Put the worker at a desk on a task and brief it. */
function assignTask(who: string, goalId: string, taskId: string, deskId: string, rawBrief: unknown): boolean {
  const desk = office.snapshot().desks.find((d) => d.id === deskId);
  if (!desk?.worker) return false;
  const brief = coerceBrief(rawBrief ?? {}, progress.policy);
  const got = progress.assign(who, goalId, taskId, deskId, brief);
  if (!got) return false;
  // Put the worker on the task's model first: Claude Code switches in
  // place; other CLIs restart on it, so give them a moment to boot.
  const switched = brief.model ? office.switchModel(deskId, brief.model) : "same";
  const delay = switched === "restarted" ? 6000 : switched === "switched" && !SIMULATE ? 1500 : 0;
  const ws = office.workspaceOf(deskId);
  if (ws) office.workspaces?.sync(ws.path);
  const notes = briefNotes.map((f) => f(goalId, taskId, deskId)).join("");
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

function personaFor(deskId: string): string {
  const id = office.workerAt(deskId)?.identity?.characterId;
  const c = id ? progress.character(id) : null;
  return c ? personaBrief(c) : "";
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
};
// Per-session MCP configs from a previous run (e.g. after a crash) can hold tokens: clear them.
mcpCleanup(CWD);

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

const routes = new Map<string, Route>();
routes.set("logs", (_msg, _client, ws) => send(ws, { t: "oplogAll", entries: log.all() }));
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
    resolve(url);
  });
});

function shutdown(): void {
  mcpCleanup(CWD);
  deployer.cancel();
  goalFiles.stop();
  progress.dispose();
  office.dispose();
  for (const ws of clients.keys()) ws.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
