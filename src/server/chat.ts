import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MAX_CHAT_MESSAGES, TEAM_THREAD, type ChatMessage, type ChatThread, type ChatWork } from "../shared/chat.js";
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
  const threads = (): ChatThread[] => [
    { id: TEAM_THREAD, title: "#team", messages: store.get(TEAM_THREAD) },
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

  return {
    chatGet: (_msg, _client, ws) => ctx.send(ws, { t: "chat", threads: threads() }),
    chatSend: (msg, client) => {
      const text = typeof msg.text === "string" ? msg.text.trim().slice(0, 4000) : "";
      const to = typeof msg.to === "string" ? msg.to : "";
      if (!text) return;
      if (to === TEAM_THREAD) {
        // To everyone: one message in #team, and each worker hears it.
        const staffed = desks().filter((d) => d.worker);
        store.add(TEAM_THREAD, { from: "you", who: client.name, text, at: Date.now() });
        for (const d of staffed) ctx.office.say(d.id, text, "chat", true);
        push();
        return;
      }
      if (!who(to)) return;
      if (msg.raw === true) {
        // Straight into the terminal, as if typed there.
        store.add(who(to)!.key, { from: "you", who: client.name, text, at: Date.now(), raw: true });
        ctx.office.input(to, text + "\r");
        push();
      } else ctx.office.say(to, text, "chat");
    },
    chatWork: (msg, _client, ws) => {
      const deskId = typeof msg.deskId === "string" ? msg.deskId : "";
      const d = desks().find((x) => x.id === deskId);
      if (!d?.worker) return;
      const tasks = ctx.progress
        .snapshot()
        .goals.flatMap((g) => g.tasks.filter((t) => t.deskId === deskId).map((t) => ({ title: t.title, goal: g.title, status: t.status })));
      const ws_ = ctx.office.workspaceOf(deskId);
      void workOf(ctx.office.workdir(deskId), ctx.office.workspaces?.base() ?? null, !!ws_).then((w) =>
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
