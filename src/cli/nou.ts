import { readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, resolve } from "node:path";
import { MAX_ATTACH_BYTES } from "../shared/policy.js";
import { createInterface } from "node:readline";
import WebSocket from "ws";
import { readOfficeAddress } from "../server/address.js";
import { TEAM_THREAD, type ChatMessage, type ChatThread } from "../shared/chat.js";
import { BAY_DESK_IDS } from "../shared/layout.js";
import { AGENT_LABELS, SHARED_HIRERS, doingLabel, type ClientMessage, type Desk, type OfficeState, type ServerMessage } from "../shared/protocol.js";
import type { ProgressState } from "../shared/progress.js";
import { ROLES, roleCharacter } from "../shared/roles.js";
import { deckOf, parseSlide } from "../shared/slides.js";
import type { StandupDraft } from "../shared/standupDraft.js";
import type { RepoStatus } from "../shared/project.js";
import { ANY_LOCAL, accuracyLabel, basisLabel, estimateAccuracy, estimateLabel, estimateTask, tookLabel } from "../shared/estimate.js";

/**
 * nou — your own command line for the office. It talks to the office running
 * on this machine (the desktop app or `npm run dev`), as you: see what every
 * agent is doing, hand out tasks (to someone, or to whoever offers to take
 * it), message them, hold the stand-up, review work, and hire ready-made
 * agents — without opening the 3D office. It doesn't walk in as a person.
 */

const HELP = `nou — your command line for the office

  nou                          what everyone's doing, and what's waiting for you
  nou task "…" [--to NAME] [--file notes.md,spec.txt] [--repo REPO]
                               give a task (to everyone: someone offers to take it),
                               with notes or files from your computer for it to read,
                               in another open repo than the agent's own
  nou estimate "…" [--to NAME] how long a task will likely take and what it'll cost —
                               on cloud and on a local model (or on NAME's model) —
                               and how close the last estimates came
  nou say NAME|all "…"         message an agent (or everyone)
  nou ask NAME "…"             message an agent and wait for its answer
  nou watch [NAME]             live: what happens in the office — or one agent's terminal
  nou screen NAME              what an agent's screen shows right now
  nou review [NAME]            work waiting for you (with NAME: its whole deck)
  nou approve NAME [note]      approve it (it merges into your branch)
  nou back NAME "…"            send it back with what to change
  nou standup "…"              say what you want today: Claude plans it and picks who does what
  nou repo                     where each open repo stands: your branch, agents' branches, pull requests
  nou repo add PATH            open another repo alongside the project (no restart)
  nou repo close REPO          close it (its branches are kept)
  nou repo hire REPO           new hires work there
  nou move NAME REPO           move an agent to another open repo
  nou roles                    the ready-made agents
  nou hire ROLE [--desk N] [--repo REPO]
                               hire one (e.g. nou hire reviewer)

  Options: --yes (don't ask), --name YOU (who you are in the chat)
  It finds the office running on this machine; set NOU_PORT to point it elsewhere.`;

// --- output ------------------------------------------------------------------------

const TTY = process.stdout.isTTY;
const c = (code: number) => (s: string) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c(1);
const dim = c(2);
const red = c(31);
const green = c(32);
const yellow = c(33);
const magenta = c(35);
const cyan = c(36);

const STATUS: Record<string, [string, (s: string) => string]> = {
  booting: ["starting", dim],
  idle: ["free", dim],
  working: ["working", yellow],
  waiting: ["NEEDS YOU", red],
  presenting: ["in line", magenta],
  done: ["done", green],
  asleep: ["asleep", dim],
};

function pad(s: string, n: number): string {
  // Emoji count as two columns in most terminals; close enough for a table.
  const width = [...s].reduce((w, ch) => w + (/\p{Extended_Pictographic}/u.test(ch) ? 2 : 1), 0);
  return s + " ".repeat(Math.max(1, n - width));
}

export function workerName(d: Desk): string {
  return d.worker?.identity?.name ?? AGENT_LABELS[d.worker!.agent];
}

// --- finding an agent by name ------------------------------------------------------------------

/** The agent you mean: its name, its desk ("desk-3", "Desk 3", "3") or its agent ("codex"), or the start of one of those. */
export function findDesk(desks: Desk[], query: string): Desk | string {
  const staffed = desks.filter((d) => d.worker);
  const q = query.trim().toLowerCase();
  const keys = (d: Desk) => [workerName(d), d.id, d.label, d.id.replace("desk-", ""), AGENT_LABELS[d.worker!.agent], d.worker!.agent].map((k) => k.toLowerCase());
  const exact = staffed.filter((d) => keys(d).includes(q));
  if (exact.length === 1) return exact[0];
  const starts = staffed.filter((d) => keys(d).some((k) => k.startsWith(q)));
  if (starts.length === 1) return starts[0];
  const options = staffed.map((d) => `${workerName(d)} (${d.label})`).join(", ");
  if (!staffed.length) return "Nobody's hired yet — try: nou hire builder";
  return `${exact.length + starts.length > 1 ? `"${query}" could be more than one` : `No agent called "${query}"`}: ${options}`;
}

// --- the connection ---------------------------------------------------------------------------

export interface Conn {
  /** Who you are in the office. */
  me: string;
  office: OfficeState;
  progress: ProgressState;
  threads: ChatThread[];
  send(m: ClientMessage): void;
  /** Wait for a message the test likes (or time out with null). */
  next<T extends ServerMessage>(test: (m: ServerMessage) => m is T, ms?: number): Promise<T | null>;
  on(fn: (m: ServerMessage) => void): () => void;
  close(): void;
}

export function officeUrl(): string {
  const port = process.env.NOU_PORT ?? process.env.DOMAIN_PORT;
  if (port) return `ws://127.0.0.1:${port}`;
  const a = readOfficeAddress();
  return `ws://127.0.0.1:${a?.port ?? 8787}`;
}

export function connect(name: string, url = officeUrl()): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const listeners = new Set<(m: ServerMessage) => void>();
    const conn: Conn = {
      me: name,
      office: { desks: [], peers: [], presentations: [] },
      progress: null as unknown as ProgressState,
      threads: [],
      send: (m) => ws.send(JSON.stringify(m)),
      on: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      next: (test, ms = 30_000) =>
        new Promise((done) => {
          const timer = setTimeout(() => {
            off();
            done(null);
          }, ms);
          const off = conn.on((m) => {
            if (!test(m)) return;
            clearTimeout(timer);
            off();
            done(m);
          });
        }),
      close: () => ws.close(),
    };
    let ready = false;
    ws.on("error", (e) => {
      if (!ready) reject(new Error(`Can't reach the office at ${url} — is it running? (${(e as Error).message})`));
    });
    ws.on("message", (raw) => {
      let m: ServerMessage;
      try {
        m = JSON.parse(String(raw)) as ServerMessage;
      } catch {
        return;
      }
      if (m.t === "welcome" || m.t === "office") conn.office = m.office;
      else if (m.t === "progress") conn.progress = m.progress;
      else if (m.t === "chat") conn.threads = m.threads;
      for (const fn of [...listeners]) fn(m);
      if (!ready && conn.progress && conn.office.desks.length) {
        ready = true;
        resolve(conn);
      }
    });
    ws.on("open", () => {
      conn.send({ t: "join", name, cli: true });
      conn.send({ t: "chatGet" });
    });
  });
}

// --- the commands ---------------------------------------------------------------------------------

function currentTask(p: ProgressState, deskId: string): string | null {
  for (const g of p.goals) for (const t of g.tasks) if (t.deskId === deskId && t.status !== "done") return t.title + (t.estimate ? dim(` (est ~${t.estimate.minutes} min)`) : "");
  return null;
}

/**
 * What a task will likely take: on a given agent's model, or on a cloud model
 * and on a local one; then the last few finished tasks against their estimates.
 */
export function estimateText(progress: ProgressState, text: string, d?: Desk | null): string {
  const samples = progress.estimates ?? [];
  const out: string[] = [bold(`⏳ ${text}`)];
  if (d?.worker) {
    const e = estimateTask({ title: text, agent: d.worker.agent, model: d.worker.model }, samples);
    out.push(`   ${workerName(d)} (${d.worker.model || AGENT_LABELS[d.worker.agent]}): ${estimateLabel(e)}`, dim(`   ${basisLabel(e)}`));
  } else {
    const cloud = estimateTask({ title: text }, samples);
    const local = estimateTask({ title: text, model: ANY_LOCAL }, samples);
    out.push(`   ☁️  on a cloud model: ${estimateLabel(cloud)}`, `   💻 on a local model: ${estimateLabel(local)}`, dim(`   ${basisLabel(cloud)}`));
  }
  const done = progress.goals.flatMap((g) => g.tasks.filter((t) => t.status === "done" && t.took));
  if (done.length) {
    out.push("", bold("📏 Lately"));
    for (const t of done.sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)).slice(0, 5)) out.push(`   ${t.title} — ${dim(tookLabel(t.took!, t.estimate))}`);
  }
  out.push("", dim(accuracyLabel(estimateAccuracy(samples))));
  return out.join("\n");
}

export function statusText(office: OfficeState, progress: ProgressState, me = ""): string {
  const out: string[] = [];
  const s = progress.session;
  const goal = s?.goalId ? progress.goals.find((g) => g.id === s.goalId) : null;
  if (s) {
    const left = Math.max(0, Math.round((s.endsAt - Date.now()) / 60000));
    const done = goal ? goal.tasks.filter((t) => t.status === "done").length : 0;
    out.push(`${bold("☀️  Today")}  ${goal ? `${goal.title} · ${done}/${goal.tasks.length} done` : "no particular goal"} · ${Math.floor(left / 60)}h ${left % 60}m left`);
    if (s.eod?.length) out.push(dim(`   🌙 by end of day: ${s.eod.join("; ")}`));
  } else out.push(`${bold("☀️  No session on")}  ${dim('— start one: nou standup "what you want today"')}`);
  const staffed = office.desks.filter((d) => d.worker);
  out.push("", bold(`👥 Agents (${staffed.length})`));
  if (!staffed.length) out.push(dim("   Nobody yet — nou roles, then nou hire builder"));
  for (const d of staffed) {
    const w = d.worker!;
    const [st, color] = STATUS[w.status] ?? [w.status, dim];
    const task = currentTask(progress, d.id);
    const doing = w.status === "working" && w.doing ? doingLabel(w.doing) : w.activity;
    // Its activity often just repeats the task: say it once.
    const extra = task && doing.includes(task) ? "" : doing;
    const owner = me && w.hiredBy !== me && !SHARED_HIRERS.includes(w.hiredBy) ? dim(` (${w.hiredBy}'s)`) : "";
    const where = w.repo ? dim(` 📂 ${basename(w.repo)}`) : "";
    out.push(`   ${pad(bold(workerName(d)) + owner, 14 + (TTY ? 8 : 0) + (owner ? owner.length : 0))}${pad(dim(AGENT_LABELS[w.agent]), 13 + (TTY ? 8 : 0))}${pad(color(st), 11 + (TTY ? 9 : 0))}${task ? `🎯 ${task}${extra ? " — " : ""}` : ""}${dim(extra)}${where}`);
  }
  const ready = office.presentations.filter((p) => p.report);
  const waiting = staffed.filter((d) => d.worker!.status === "waiting");
  if (ready.length || waiting.length) {
    out.push("", bold("🔔 Waiting for you"));
    for (const d of waiting) out.push(`   ${red("●")} ${workerName(d)} is asking something — ${dim(`nou screen ${workerName(d).split(" ")[0]}`)}`);
    for (const p of ready) {
      const d = office.desks.find((x) => x.id === p.deskId);
      out.push(`   ${magenta("●")} ${d ? workerName(d) : p.deskId}: ${p.report!.title} ${checkBadge(p.report!.check?.status)} — ${dim(`nou review ${d ? workerName(d).split(" ")[0] : p.deskId}`)}`);
    }
  }
  const open = progress.goals.flatMap((g) => g.tasks.filter((t) => t.status === "todo" && !t.deskId).map((t) => t.title));
  if (open.length) out.push("", dim(`📋 ${open.length} task${open.length === 1 ? "" : "s"} waiting for someone: ${open.slice(0, 3).join("; ")}${open.length > 3 ? "…" : ""}`));
  return out.join("\n");
}

function checkBadge(status: string | undefined): string {
  return status === "pass" ? green("✓ checks pass") : status === "fail" ? red("✗ checks fail") : status === "running" ? yellow("⏳ checking") : "";
}

function deckText(title: string, slides: string[]): string {
  const out = [bold(title)];
  slides.forEach((s, i) => {
    const p = parseSlide(s);
    out.push("", cyan(`  ${i + 1}. ${p.heading || p.bullets[0] || ""}`));
    for (const b of p.heading ? p.bullets : p.bullets.slice(1)) out.push(`     • ${b}`);
    if (p.code) out.push(...p.code.split("\n").map((l) => dim(`       ${l}`)));
  });
  return out.join("\n");
}

async function askLine(question: string): Promise<string> {
  if (!process.stdin.isTTY) return "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((r) => rl.question(question, r));
  rl.close();
  return answer.trim().toLowerCase();
}

/** Flags out, words in: --to NAME, --desk N, --yes, --name YOU. */
export function parseArgs(argv: string[]): { words: string[]; flags: Record<string, string | true> } {
  const words: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (["yes", "y"].includes(k)) flags.yes = true;
      else flags[k] = argv[++i] ?? "";
    } else if (a === "-y") flags.yes = true;
    else words.push(a);
  }
  return { words, flags };
}

export async function main(argv: string[]): Promise<number> {
  const { words, flags } = parseArgs(argv);
  const cmd = (words.shift() ?? "status").toLowerCase();
  if (cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(HELP);
    return 0;
  }
  if (cmd === "roles") {
    console.log(bold("🧩 Ready-made agents") + dim("  — nou hire ROLE"));
    for (const r of ROLES) console.log(`   ${r.icon} ${pad(bold(r.id), 12 + (TTY ? 8 : 0))}${pad(r.title, 20)}${dim(r.blurb)}`);
    return 0;
  }
  const me = typeof flags.name === "string" ? flags.name : process.env.NOU_NAME || userInfo().username || "You";
  let conn: Conn;
  try {
    conn = await connect(me);
  } catch (e) {
    console.error(red((e as Error).message));
    console.error(dim("Start the office first: the desktop app, or npm run dev."));
    return 1;
  }
  try {
    return await run(conn, cmd, words, flags);
  } finally {
    conn.close();
  }
}

async function run(conn: Conn, cmd: string, words: string[], flags: Record<string, string | true>): Promise<number> {
  const desk = (q: string | undefined): Desk | null => {
    if (!q) {
      console.error(red("Who? Give an agent's name."));
      return null;
    }
    const d = findDesk(conn.office.desks, q);
    if (typeof d === "string") {
      console.error(red(d));
      return null;
    }
    return d;
  };

  switch (cmd) {
    case "status":
    case "s":
      console.log(statusText(conn.office, conn.progress, conn.me));
      return 0;

    case "task":
    case "t": {
      const text = words.join(" ").trim();
      if (!text) return usage('nou task "what to do" [--to NAME] [--file a.md,b.txt]');
      // Files to read first: their text goes with the task, into the agent's own folder.
      const files: { name: string; text: string }[] = [];
      for (const path of typeof flags.file === "string" ? flags.file.split(",").map((x) => x.trim()).filter(Boolean) : []) {
        try {
          if (statSync(path).size > MAX_ATTACH_BYTES) {
            console.error(yellow(`Left out ${path}: over ${MAX_ATTACH_BYTES / 1000} KB`));
            continue;
          }
          files.push({ name: basename(path), text: readFileSync(path, "utf8") });
        } catch {
          console.error(red(`Can't read ${path}`));
          return 1;
        }
      }
      const withFiles = { ...(files.length ? { files } : {}), ...(typeof flags.repo === "string" ? { repo: flags.repo } : {}) };
      if (files.length) console.log(dim(`📎 ${files.map((f) => f.name).join(", ")}`));
      if (typeof flags.to === "string") {
        const d = desk(flags.to);
        if (!d) return 1;
        conn.send({ t: "quickTask", deskId: d.id, text, ...withFiles });
        console.log(`🎯 ${bold(workerName(d))} has it: ${text}`);
        await sleep(400);
        return 0;
      }
      // To everyone: whoever's best placed offers to take it, and you say yes (or ask someone else).
      conn.send({ t: "quickTask", deskId: "any", text, ...withFiles });
      let asked = new Set<string>();
      for (;;) {
        const offer = await conn.next((m): m is Extract<ServerMessage, { t: "chat" }> => m.t === "chat" && !!openOffer(m.threads, asked), 15_000);
        const msg = offer ? openOffer(offer.threads, asked) : null;
        if (!msg?.offer) {
          const last = conn.threads.find((t) => t.id === TEAM_THREAD)?.messages.at(-1);
          console.log(last?.who === "Office" ? yellow(last.text) : yellow("Nobody offered yet — it's waiting for the next one free."));
          return 0;
        }
        const o = msg.offer;
        asked = new Set([...asked, o.taskId + o.deskId]);
        console.log(`🙋 ${bold(msg.who)}: ${msg.text}`);
        const a = flags.yes ? "y" : await askLine(`   Let ${msg.who.split(" ")[0]} take it? [Y]es / [s]omeone else / [a]nyone free / [l]ater: `);
        if (a === "s") {
          conn.send({ t: "offerAnswer", taskId: o.taskId, answer: "next" });
          continue;
        }
        if (a === "a" || a === "l") {
          conn.send({ t: "offerAnswer", taskId: o.taskId, answer: "anyone" });
          console.log(dim("   Left for whoever's free next."));
          await sleep(300);
          return 0;
        }
        conn.send({ t: "offerAnswer", taskId: o.taskId, answer: "take" });
        const said = await conn.next((m): m is Extract<ServerMessage, { t: "chat" }> => m.t === "chat" && /On it|It's mine/.test(m.threads.find((t) => t.id === TEAM_THREAD)?.messages.at(-1)?.text ?? ""), 8000);
        const last = said?.threads.find((t) => t.id === TEAM_THREAD)?.messages.at(-1);
        console.log(last ? `✅ ${bold(last.who)}: ${last.text}` : green("✅ It's theirs."));
        return 0;
      }
    }

    case "say":
    case "ask": {
      const who = words.shift();
      const text = words.join(" ").trim();
      if (!who || !text) return usage(`nou ${cmd} NAME "message"`);
      if (who.toLowerCase() === "all" || who.toLowerCase() === "everyone") {
        conn.send({ t: "chatSend", to: TEAM_THREAD, text });
        console.log(`💬 To everyone: ${text}`);
        await sleep(300);
        return 0;
      }
      const d = desk(who);
      if (!d) return 1;
      const before = conn.threads.find((t) => t.id === d.id)?.messages.length ?? 0;
      conn.send({ t: "chatSend", to: d.id, text });
      console.log(`💬 To ${bold(workerName(d))}: ${text}`);
      if (cmd === "say") {
        await sleep(300);
        return 0;
      }
      console.log(dim("   waiting for the answer… (Ctrl+C to stop)"));
      const reply = await conn.next(
        (m): m is Extract<ServerMessage, { t: "chat" }> => m.t === "chat" && (m.threads.find((t) => t.id === d.id)?.messages ?? []).slice(before).some((x) => x.from === "agent"),
        180_000,
      );
      const answer = reply?.threads.find((t) => t.id === d.id)?.messages.slice(before).filter((x) => x.from === "agent").at(-1);
      console.log(answer ? `🗨  ${bold(answer.who)}: ${answer.text}` : yellow("No answer yet — it'll be in the chat when it comes."));
      return 0;
    }

    case "estimate":
    case "e": {
      const text = words.join(" ").trim();
      if (!text) return usage('nou estimate "what to do" [--to NAME]');
      const d = typeof flags.to === "string" ? desk(flags.to) : null;
      if (typeof flags.to === "string" && !d) return 1;
      console.log(estimateText(conn.progress, text, d));
      return 0;
    }

    case "repo": {
      const sub = (words[0] ?? "").toLowerCase();
      if (["add", "close", "hire"].includes(sub)) {
        const what = words.slice(1).join(" ").trim();
        if (!what) return usage(`nou repo ${sub} ${sub === "add" ? "PATH" : "REPO"}`);
        // A folder is named from where you are; the office knows open repos by name too.
        const path = sub === "add" ? resolve(what) : what;
        conn.send({ t: sub === "add" ? "repoAdd" : sub === "close" ? "repoClose" : "repoHire", path });
        const got = await conn.next((m): m is Extract<ServerMessage, { t: "project" }> => m.t === "project", 15_000);
        if (!got) {
          console.log(yellow("The office didn't confirm — see its Logs (Projects → Logs)."));
          return 1;
        }
        console.log(openReposText(got));
        return 0;
      }
      conn.send({ t: "repoStatus" });
      const got = await conn.next((m): m is Extract<ServerMessage, { t: "repoStatus" }> => m.t === "repoStatus", 45_000);
      if (!got) {
        console.log(red("The office didn't answer."));
        return 1;
      }
      console.log(repoText(got.status));
      return 0;
    }

    case "move": {
      const d = desk(words[0]);
      const repo = words.slice(1).join(" ").trim();
      if (!d) return 1;
      if (!repo) return usage("nou move NAME REPO");
      conn.send({ t: "workerRepo", deskId: d.id, repo });
      const got = await conn.next((m): m is Extract<ServerMessage, { t: "project" }> => m.t === "project", 15_000);
      const now = got?.workers?.find((w) => w.deskId === d.id);
      console.log(now ? green(`📦 ${workerName(d)} works in ${basename(now.repo)} now.`) : yellow(`“${repo}” isn't an open repo (nou repo), or ${workerName(d)} isn't running.`));
      return now ? 0 : 1;
    }

    case "screen": {
      const d = desk(words[0]);
      if (!d) return 1;
      conn.send({ t: "chatPeek", deskId: d.id });
      const peek = await conn.next((m): m is Extract<ServerMessage, { t: "chatPeek" }> => m.t === "chatPeek" && m.peek.deskId === d.id, 8000);
      console.log(bold(`🖥  ${workerName(d)} · ${d.label} · ${STATUS[d.worker!.status]?.[0] ?? d.worker!.status}`));
      console.log((peek?.peek.lines ?? []).map((l) => `   ${l}`).join("\n") || dim("   (nothing on screen)"));
      return 0;
    }

    case "watch":
    case "w": {
      if (words[0]) {
        // One agent's terminal, live.
        const d = desk(words[0]);
        if (!d) return 1;
        console.log(dim(`— ${workerName(d)}'s terminal, live (Ctrl+C to stop) —`));
        let first = true;
        conn.on((m) => {
          if (m.t === "scrollback" && m.deskId === d.id && first) {
            first = false;
            process.stdout.write(m.data);
          } else if (m.t === "output" && m.deskId === d.id && !first) process.stdout.write(m.data);
        });
        conn.send({ t: "open", deskId: d.id });
        await forever();
        return 0;
      }
      console.log(statusText(conn.office, conn.progress, conn.me));
      console.log(dim("\n— live (Ctrl+C to stop) —"));
      watchEvents(conn);
      await forever();
      return 0;
    }

    case "review":
    case "r": {
      const ready = conn.office.presentations.filter((p) => p.report);
      if (words[0]) {
        const d = desk(words[0]);
        if (!d) return 1;
        const p = ready.find((x) => x.deskId === d.id);
        if (!p) {
          console.log(yellow(`${workerName(d)} has nothing waiting for you.`));
          return 0;
        }
        const r = p.report!;
        console.log(`${magenta("🎤")} ${bold(workerName(d))} ${checkBadge(r.check?.status)}`);
        console.log(deckText(r.title, deckOf(r)));
        console.log("", dim(r.summary));
        if (r.question) console.log(yellow(`\n❓ ${r.question}`));
        console.log(dim(`\nnou approve ${workerName(d).split(" ")[0]}   ·   nou back ${workerName(d).split(" ")[0]} "what to change"`));
        return 0;
      }
      if (!ready.length) {
        console.log(green("✨ Nothing waiting for you."));
        return 0;
      }
      for (const p of ready) {
        const d = conn.office.desks.find((x) => x.id === p.deskId);
        const r = p.report!;
        const name = d ? workerName(d) : p.deskId;
        console.log(`${magenta("●")} ${bold(name)}: ${r.title} ${checkBadge(r.check?.status)}`);
        console.log(dim(`   ${deckOf(r).map((s) => parseSlide(s).heading || parseSlide(s).bullets[0]).join(" · ")}`));
      }
      console.log(dim("\nnou review NAME for the whole deck · nou approve NAME · nou back NAME \"…\""));
      return 0;
    }

    case "approve":
    case "back": {
      const d = desk(words.shift());
      if (!d) return 1;
      const note = words.join(" ").trim();
      if (cmd === "back" && !note) return usage('nou back NAME "what to change"');
      const p = conn.office.presentations.find((x) => x.deskId === d.id && x.report);
      if (!p) {
        console.log(yellow(`${workerName(d)} has nothing waiting for you${d.worker?.report ? " yet (it's still with its auditor)" : ""}.`));
        return 1;
      }
      conn.send({ t: "review", deskId: d.id, approve: cmd === "approve", ...(note ? { text: note } : {}) });
      const gone = await conn.next((m): m is Extract<ServerMessage, { t: "office" }> => m.t === "office" && !m.office.presentations.some((x) => x.deskId === d.id && x.report), 8000);
      console.log(gone ? (cmd === "approve" ? green(`✅ Approved ${workerName(d)}'s “${p.report!.title}”`) : `↩ Sent back to ${bold(workerName(d))}: ${note}`) : yellow("Sent — the office hasn't confirmed yet."));
      return gone ? 0 : 1;
    }

    case "standup": {
      const text = words.join(" ").trim();
      if (!text) return usage('nou standup "what you want done today"');
      if (conn.progress.session) {
        console.log(yellow("A session's already on:"));
        console.log(statusText(conn.office, conn.progress, conn.me));
        return 1;
      }
      conn.send({ t: "standupVoice", text });
      console.log(dim("✨ Planning it… (Claude takes up to a minute)"));
      const got = await conn.next((m): m is Extract<ServerMessage, { t: "standupDraft" }> => m.t === "standupDraft", 75_000);
      if (!got) {
        console.log(red("No plan came back."));
        return 1;
      }
      const d: StandupDraft = got.draft;
      const name = (id: string | null) => {
        const x = id ? conn.office.desks.find((k) => k.id === id) : null;
        return x?.worker ? workerName(x) : "whoever's free";
      };
      console.log("", bold(d.goal.title), dim(`  (${got.via === "claude" ? "Claude's plan" : "from your words"} · ${d.tone} · ${Math.round(d.minutes / 60)}h)`));
      console.log(d.summary);
      if (d.eod.length) console.log(dim(`🌙 By end of day: ${d.eod.join("; ")}`));
      console.log(bold("\n👥 Who does what"));
      d.assign.forEach((a, i) => console.log(`   ${i + 1}. ${a.task}  →  ${bold(name(a.deskId))}${a.why ? dim(`  (${a.why})`) : ""}`));
      const a = flags.yes ? "y" : await askLine("\nStart the day with this? [Y/n] ");
      if (a === "n") {
        console.log(dim("Not started."));
        return 0;
      }
      const open = conn.progress.goals.find((g) => !g.doneAt && !g.shippedAt && g.title.toLowerCase() === d.goal.title.toLowerCase());
      conn.send({
        t: "standup",
        goalId: open?.id ?? null,
        ...(open ? {} : { newGoal: { title: d.goal.title, why: d.goal.why, tasks: d.goal.tasks, kind: d.goal.kind } }),
        tone: d.tone,
        intention: d.intention,
        minutes: d.minutes,
        summary: d.summary,
        eod: d.eod,
        dispatch: true,
        assign: d.assign.map((x) => ({ task: x.task, deskId: x.deskId ?? "" })),
      });
      await conn.next((m): m is Extract<ServerMessage, { t: "progress" }> => m.t === "progress" && !!m.progress.session, 8000);
      console.log(green("🔔 Day started — the tasks are going out. nou watch to follow along."));
      return 0;
    }

    case "hire": {
      const q = (words[0] ?? "").toLowerCase();
      const role = ROLES.find((r) => r.id === q) ?? ROLES.find((r) => r.id.startsWith(q) || r.title.toLowerCase().includes(q));
      if (!role) return usage("nou hire ROLE   (see nou roles)");
      const want = typeof flags.desk === "string" ? (flags.desk.startsWith("desk-") ? flags.desk : `desk-${flags.desk}`) : null;
      const free = conn.office.desks.find((d) => !d.worker && (want ? d.id === want : !BAY_DESK_IDS.includes(d.id)));
      if (!free) {
        console.log(red(want ? `${want} isn't free.` : "No free desk."));
        return 1;
      }
      const ch = roleCharacter(role, conn.progress.team.map((x) => x.name));
      conn.send({ t: "characterSave", character: ch });
      conn.send({ t: "hire", deskId: free.id, agent: ch.agent, characterId: ch.id, ...(typeof flags.repo === "string" ? { repo: flags.repo } : {}) });
      const up = await conn.next((m): m is Extract<ServerMessage, { t: "office" }> => m.t === "office" && !!m.office.desks.find((d) => d.id === free.id)?.worker, 10_000);
      console.log(up ? green(`${role.icon} ${ch.name} (${role.title}) is at ${free.label}.`) : yellow("Asked — the office hasn't confirmed yet."));
      return up ? 0 : 1;
    }
  }
  console.error(red(`Unknown command: ${cmd}`));
  console.log(HELP);
  return 1;
}

/** The open repos, where new hires work, and who works where. */
export function openReposText(m: Extract<ServerMessage, { t: "project" }>): string {
  const all = [m.info, ...(m.repos ?? [])];
  const same = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
  return all
    .map((r, i) => {
      const who = (m.workers ?? []).filter((w) => same(w.repo, r.path)).map((w) => w.name);
      const hire = same(m.hireRepo ?? m.info.path, r.path) ? green(" ← new hires") : "";
      return `${bold(`📂 ${r.name}`)}${i === 0 ? dim(" (project)") : ""}${hire}  ${dim(r.path)}\n   ${who.length ? who.join(", ") : dim("nobody works here")}`;
    })
    .join("\n");
}

/** The newest offer you haven't answered (or been asked about) yet. */
function openOffer(threads: ChatThread[], asked: Set<string>): ChatMessage | null {
  const m = threads.find((t) => t.id === TEAM_THREAD)?.messages.filter((x) => x.offer?.state === "open" && !asked.has(x.offer.taskId + x.offer.deskId)).at(-1);
  return m ?? null;
}

/** nou watch: one line per thing that happens. */
function watchEvents(conn: Conn): void {
  let last = new Map(conn.office.desks.filter((d) => d.worker).map((d) => [d.id, d.worker!.status]));
  let seen = new Map(conn.threads.map((t) => [t.id, t.messages.length]));
  const stamp = () => dim(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  conn.on((m) => {
    if (m.t === "office") {
      for (const d of m.office.desks) {
        const st = d.worker?.status;
        if (!st || st === last.get(d.id)) continue;
        const [label, color] = STATUS[st] ?? [st, dim];
        console.log(`${stamp()} ${bold(workerName(d))} → ${color(label)}${st === "working" ? dim(` ${d.worker!.activity}`) : ""}`);
      }
      last = new Map(m.office.desks.filter((d) => d.worker).map((d) => [d.id, d.worker!.status]));
    } else if (m.t === "report" && m.presentation.report) {
      const d = conn.office.desks.find((x) => x.id === m.presentation.deskId);
      console.log(`${stamp()} ${magenta("🎤")} ${bold(d ? workerName(d) : m.presentation.deskId)} is ready: ${m.presentation.report.title} ${dim("— nou review")}`);
    } else if (m.t === "chat") {
      for (const t of m.threads) {
        const fresh = t.messages.slice(seen.get(t.id) ?? t.messages.length);
        for (const x of fresh) if (x.from === "agent") console.log(`${stamp()} 🗨  ${bold(x.who)}: ${x.text}`);
      }
      seen = new Map(m.threads.map((t) => [t.id, t.messages.length]));
    } else if (m.t === "loop" && m.text) console.log(`${stamp()} ${dim(m.text)}`);
  });
}

export function repoText(s: RepoStatus): string {
  // Every open repo the same way: the project, then the others open alongside it.
  if (s.others?.length) return [s, ...s.others].map((r) => `${bold(cyan(`📂 ${r.name ?? "project"}`))} ${dim(r.path ?? "")}\n${repoText({ ...r, others: undefined })}`).join("\n\n");
  if (!s.isGit) return yellow("This project isn't a git repo.");
  const out: string[] = [];
  const commit = (c: RepoStatus["last"]) => (c ? `${dim(c.sha)} ${c.subject} ${dim(c.when)}` : dim("no commits"));
  const sync = s.ahead === null ? dim("no upstream") : s.ahead === 0 && s.behind === 0 ? green("up to date with GitHub") : [s.ahead ? yellow(`↑ ${s.ahead} to push`) : "", s.behind ? yellow(`↓ ${s.behind} to pull`) : ""].filter(Boolean).join(" ");
  out.push(`${bold(`📦 ${s.github ? `${s.github.owner}/${s.github.repo}` : "local repo"}`)}  🌿 ${s.branch}  ${sync}  ${s.dirty.length ? red(`✎ ${s.dirty.length} uncommitted`) : green("clean")}`);
  out.push(`   last: ${commit(s.last)}`);
  if (s.dirty.length) out.push(dim(`   uncommitted: ${s.dirty.join(", ")}`));
  out.push("", bold("👥 Agents' branches"));
  if (!s.agents.length) out.push(dim("   none"));
  for (const a of s.agents) out.push(`   ${pad(bold(a.name), 14 + (TTY ? 8 : 0))}${pad(a.branch, 30)}${pad(a.ahead ? `↑${a.ahead}` : "—", 6)}${pad(a.dirty ? `✎${a.dirty}` : "—", 6)}${commit(a.last)}`);
  out.push("", bold("🔀 Open pull requests"));
  if (s.pulls === null) out.push(dim(`   ${s.github ? (s.pullsError ?? "sign in with GitHub to see them") : "not on GitHub"}`));
  else if (!s.pulls.length) out.push(dim("   none"));
  else for (const p of s.pulls) out.push(`   #${p.number} ${p.title} ${dim(p.head)} ${checkBadge(p.checks === "success" ? "pass" : p.checks === "failure" ? "fail" : p.checks === "pending" ? "running" : undefined)}`);
  return out.join("\n");
}

function usage(u: string): number {
  console.error(`Usage: ${u}`);
  return 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function forever(): Promise<void> {
  return new Promise((r) => process.on("SIGINT", () => r()));
}
