import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MAX_CHAT_MESSAGES, PEOPLE_THREAD, TEAM_THREAD, pickVolunteer, type ChatMessage, type ChatThread, type ChatWork } from "../shared/chat.js";
import { AGENT_LABELS } from "../shared/protocol.js";
import type { Routes, ServerCtx } from "./ctx.js";
import { plain } from "./ptyWorker.js";

/**
 * Team chat on the server. Each worker's thread is kept under a stable key —
 * its character when it's one of your team (so the history follows it from
 * hire to hire), else the desk and that particular session — in
 * .domain/chat.json. #team holds what you send to everyone and every answer.
 */

interface Stored {
  key: string;
  messages: ChatMessage[];
}

export class ChatStore {
  private threads = new Map<string, Stored>();

  constructor(private file: string | null) {
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, Stored>;
      for (const [k, v] of Object.entries(raw)) if (v && Array.isArray(v.messages)) this.threads.set(k, { key: v.key, messages: v.messages.slice(-MAX_CHAT_MESSAGES) });
    } catch {
      /* none yet */
    }
  }

  get(key: string): ChatMessage[] {
    return this.threads.get(key)?.messages ?? [];
  }

  /** A message changed in place (an offer answered): save it. */
  touch(): void {
    this.save();
  }

  add(key: string, m: ChatMessage): void {
    const t = this.threads.get(key) ?? { key, messages: [] };
    t.messages.push(m);
    if (t.messages.length > MAX_CHAT_MESSAGES) t.messages.splice(0, t.messages.length - MAX_CHAT_MESSAGES);
    this.threads.set(key, t);
    this.save();
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.threads), null, 1));
    } catch {
      /* best effort */
    }
  }
}

/** The last few lines of a terminal worth reading: no escape codes, no blank or spinner-only lines, no repeats. */
export function screenLines(scrollback: string, max = 8): string[] {
  const lines = plain(scrollback.slice(-12000))
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => /[A-Za-z]{3}/.test(l) && !/^[─━═\-_\s]+$/.test(l));
  const out: string[] = [];
  for (const l of lines.reverse()) {
    if (out.length >= max) break;
    if (!out.includes(l)) out.push(l.slice(0, 200));
  }
  return out.reverse();
}

function gitOut(cwd: string, args: string[]): Promise<string> {
  return new Promise((done) => execFile("git", args, { cwd, windowsHide: true, timeout: 8000 }, (err, out) => done(err ? "" : String(out))));
}

/** A worker's commits and changed files: on its own branch since it left yours, or the project's latest. */
export async function workOf(workdir: string, base: string | null, own: boolean): Promise<Pick<ChatWork, "commits" | "changed">> {
  const range = own && base ? [`${base}..HEAD`] : ["-10"];
  const log = await gitOut(workdir, ["log", "--format=%h%x09%s%x09%ct", "-30", ...range]);
  const commits = log
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [hash, subject, at] = l.split("\t");
      return { hash, subject: subject ?? "", at: Number(at) * 1000 };
    });
  const changed = own && base ? (await gitOut(workdir, ["diff", "--name-only", `${base}...HEAD`])).split("\n").filter(Boolean).slice(0, 60) : [];
  // Not yet committed counts too.
  const dirty = own ? (await gitOut(workdir, ["status", "--porcelain"])).split("\n").filter(Boolean).map((l) => l.slice(3).trim()) : [];
  return { commits, changed: [...new Set([...changed, ...dirty])].slice(0, 60) };
}

export function chatModule(ctx: ServerCtx, store = new ChatStore(join(ctx.cwd, ".domain", "chat.json"))): Routes {
  const desks = () => ctx.office.snapshot().desks;
  /** A worker's thread key and name. */
  const who = (deskId: string): { key: string; name: string } | null => {
    const d = desks().find((x) => x.id === deskId);
    const w = d?.worker;
    if (!d || !w) return null;
    const name = w.identity ? `${w.identity.name} (${AGENT_LABELS[w.agent]})` : `${AGENT_LABELS[w.agent]} · ${d.label}`;
    return { key: w.identity ? `char:${w.identity.characterId}` : `desk:${d.id}:${ctx.office.sessionId(d.id)}`, name };
  };
  /** #people shows once there's someone to talk to (or something was said there). */
  const others = () => [...(ctx.clients?.() ?? new Map()).values()].filter((c) => c.joined).length > 1;
  const threads = (): ChatThread[] => [
    { id: TEAM_THREAD, title: "#team", messages: store.get(TEAM_THREAD) },
    ...(others() || store.get(PEOPLE_THREAD).length ? [{ id: PEOPLE_THREAD, title: "#people", messages: store.get(PEOPLE_THREAD) }] : []),
    ...desks()
      .filter((d) => d.worker)
      .map((d) => {
        const w = who(d.id)!;
        return { id: d.id, title: w.name, messages: store.get(w.key) };
      }),
  ];
  const push = () => ctx.broadcast({ t: "chat", threads: threads() });

  // Everything said to and by a worker (here, or in office hours) lands in its thread; its answers in #team too.
  const before = ctx.office.onSaid;
  ctx.office.onSaid = (deskId, from, text) => {
    before?.(deskId, from, text);
    const w = who(deskId);
    if (!w) return;
    const m: ChatMessage = { from, who: from === "agent" ? w.name : "You", text, at: Date.now() };
    store.add(w.key, m);
    if (from === "agent") store.add(TEAM_THREAD, m);
    push();
  };

  // --- "I'll take it" ---------------------------------------------------------------
  /** What each worker is on (its open task's title). */
  const onTask = () => {
    const m = new Map<string, string>();
    for (const g of ctx.progress.snapshot().goals) for (const t of g.tasks) if (t.deskId && t.status !== "done") m.set(t.deskId, t.title);
    return m;
  };
  /** A just-hired worker starts on its task once it's booted (or gives up after a few minutes: the task stays saved for it). */
  const startWhenUp = (goalId: string, taskId: string, deskId: string, by: string) => {
    const until = Date.now() + 5 * 60_000;
    const timer = setInterval(() => {
      const w = desks().find((d) => d.id === deskId)?.worker;
      const task = ctx.progress.snapshot().goals.find((g) => g.id === goalId)?.tasks.find((t) => t.id === taskId);
      // Gone, fired, or someone else has it now: nothing to do.
      if (!w || !task || task.status !== "todo" || task.deskId || task.for !== deskId || Date.now() > until) return void clearInterval(timer);
      if (!["idle", "done"].includes(w.status) || onTask().has(deskId)) return;
      clearInterval(timer);
      if (ctx.assignTask(by, goalId, taskId, deskId)) {
        store.add(TEAM_THREAD, { from: "agent", who: who(deskId)?.name ?? "New hire", text: `🚀 On “${task.title}”.`, at: Date.now() });
        push();
      }
    }, 1000);
    timer.unref?.();
  };
  /** A task given to everyone: the best-placed worker offers to take it, in #team, and waits for your OK. */
  ctx.offerTask = (goalId, taskId, title, skip = [], asker) => {
    // Only agents the asker may direct offer (in a shared office, yours — and the office's own).
    const mine = asker && ctx.mayDirectDesk ? desks().filter((d) => !d.worker || ctx.mayDirectDesk!(asker, d.id)) : desks();
    const pick = pickVolunteer(mine, onTask(), skip);
    // Nobody can: a new agent is hired for it, and starts on it once it's up.
    const hired = pick ? null : ctx.hireFor?.(asker);
    if (hired) {
      ctx.progress.setOffered(goalId, taskId, null);
      ctx.progress.reserve(goalId, taskId, hired);
      store.add(TEAM_THREAD, { from: "agent", who: "Office", text: `🧑‍💻 Nobody ${skip.length ? "else " : ""}was free for “${title}”, so ${asker?.name ?? "the office"} hired ${who(hired)?.name ?? "a new agent"} — it starts as soon as it's up.`, at: Date.now() });
      push();
      startWhenUp(goalId, taskId, hired, asker?.name ?? "Office");
      return;
    }
    if (!pick) {
      ctx.progress.setOffered(goalId, taskId, null);
      store.add(TEAM_THREAD, { from: "agent", who: "Office", text: `${skip.length ? "Nobody else can" : "Nobody on the team can"} take “${title}” yet — it's waiting for the next one free${skip.length ? "" : " (or hire someone)"}.`, at: Date.now() });
      push();
      return;
    }
    ctx.progress.setOffered(goalId, taskId, pick.deskId);
    const w = who(pick.deskId)!;
    const text = pick.free ? `🙋 I'll take “${title}” — I'm free now.` : `🙋 I can take “${title}” right after I finish “${pick.after}”.`;
    store.add(TEAM_THREAD, {
      from: "agent",
      who: w.name,
      text,
      at: Date.now(),
      offer: { goalId, taskId, title, deskId: pick.deskId, free: pick.free, state: "open", asked: [...skip, pick.deskId] },
    });
    push();
  };

  return {
    // Your answer to "I'll take it".
    offerAnswer: (msg, client) => {
      const taskId = typeof msg.taskId === "string" ? msg.taskId : "";
      const m = store.get(TEAM_THREAD).find((x) => x.offer?.taskId === taskId && x.offer.state === "open");
      const o = m?.offer;
      if (!m || !o) return;
      const task = ctx.progress.snapshot().goals.find((g) => g.id === o.goalId)?.tasks.find((t) => t.id === taskId);
      ctx.progress.setOffered(o.goalId, taskId, null);
      if (!task || task.status !== "todo" || task.deskId) {
        o.state = "anyone";
        store.touch();
        push();
        return;
      }
      if (msg.answer === "next") {
        o.state = "passed";
        store.touch();
        ctx.offerTask!(o.goalId, taskId, o.title, o.asked, client);
        return;
      }
      if (msg.answer === "anyone") {
        o.state = "anyone";
        store.add(TEAM_THREAD, { from: "you", who: client.name, text: `“${o.title}” is up for whoever's free next.`, at: Date.now() });
        push();
        return;
      }
      o.state = "taken";
      const w = who(o.deskId);
      const free = !onTask().has(o.deskId) && ["idle", "done"].includes(desks().find((d) => d.id === o.deskId)?.worker?.status ?? "");
      if (w && free && ctx.assignTask(client.name, o.goalId, taskId, o.deskId)) {
        store.add(TEAM_THREAD, { from: "agent", who: w.name, text: "🚀 On it.", at: Date.now() });
      } else if (w) {
        // Busy: it's saved for them, and they pick it up the moment they're done.
        ctx.progress.reserve(o.goalId, taskId, o.deskId);
        store.add(TEAM_THREAD, { from: "agent", who: w.name, text: "👍 It's mine — I'll start as soon as I'm done with this one.", at: Date.now() });
      }
      store.touch();
      push();
    },
    chatGet: (_msg, _client, ws) => ctx.send(ws, { t: "chat", threads: threads() }),
    // The people here, among themselves: everyone sees it, no worker hears it, and it's not feedback to learn from.
    peopleSend: (msg, client) => {
      const text = typeof msg.text === "string" ? msg.text.trim().slice(0, 1000) : "";
      if (!text) return;
      store.add(PEOPLE_THREAD, { from: "you", who: client.name, text, at: Date.now() });
      push();
    },
    chatSend: (msg, client) => {
      const text = typeof msg.text === "string" ? msg.text.trim().slice(0, 4000) : "";
      const to = typeof msg.to === "string" ? msg.to : "";
      if (!text) return;
      if (to === TEAM_THREAD) {
        // To everyone: one message in #team, and each worker hears it.
        const staffed = desks().filter((d) => d.worker);
        store.add(TEAM_THREAD, { from: "you", who: client.name, text, at: Date.now() });
        for (const d of staffed) ctx.office.say(d.id, text, "chat", true);
        ctx.heard?.(text, undefined, client);
        push();
        return;
      }
      if (!who(to)) return;
      if (msg.raw === true) {
        // Straight into the terminal, as if typed there.
        store.add(who(to)!.key, { from: "you", who: client.name, text, at: Date.now(), raw: true });
        ctx.office.input(to, text + "\r");
        push();
      } else if (ctx.office.say(to, text, "chat")) ctx.heard?.(text, to, client);
    },
    chatWork: (msg, _client, ws) => {
      const deskId = typeof msg.deskId === "string" ? msg.deskId : "";
      const d = desks().find((x) => x.id === deskId);
      if (!d?.worker) return;
      const tasks = ctx.progress
        .snapshot()
        .goals.flatMap((g) => g.tasks.filter((t) => t.deskId === deskId).map((t) => ({ title: t.title, goal: g.title, status: t.status })));
      const ws_ = ctx.office.workspaceOf(deskId);
      void workOf(ctx.office.workdir(deskId), ctx.office.workspacesOf(deskId)?.base() ?? null, !!ws_).then((w) =>
        ctx.send(ws, { t: "chatWork", work: { deskId, branch: d.worker!.branch, tasks, ...w } }),
      );
    },
    chatPeek: (msg, _client, ws) => {
      const deskId = typeof msg.deskId === "string" ? msg.deskId : "";
      const d = desks().find((x) => x.id === deskId);
      if (!d?.worker) return;
      // Its screen as it is (a real terminal), else read off the raw output.
      const screen = ctx.office.screen(deskId);
      const lines = screen ? screen.map((l) => l.replace(/\s+$/, "")).filter((l) => /[A-Za-z]{2}/.test(l)).slice(-14) : screenLines(ctx.office.scrollback(deskId));
      ctx.send(ws, { t: "chatPeek", peek: { deskId, status: d.worker.status, activity: d.worker.activity, lines } });
    },
  };
}
