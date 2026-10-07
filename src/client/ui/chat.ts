import { doingLabel } from "../../shared/protocol.js";
import type { ChatMessage, ChatPeek, ChatThread, ChatWork } from "../../shared/chat.js";
import { PEOPLE_THREAD, TEAM_THREAD } from "../../shared/chat.js";
import type { ClientMessage, Desk } from "../../shared/protocol.js";
import { AGENT_COLOR } from "../scene/characters.js";
import { micButton, wireMic, type Dictation } from "../voice.js";
import { KIND_ICON, historyOf } from "./history.js";
import { esc, openModal, type Modal } from "./modal.js";
import "../styles/chat.css";

/**
 * Team chat: like Slack, with your workers. #team reaches everyone; each
 * worker has its own thread with its history, and a live line on what it's
 * doing (read off its terminal). Messages reach a worker as team chat and it
 * answers in the thread; flip to ⌨️ Terminal to type straight into its CLI.
 */


/** What "Ask for an update" says. */
/** The buttons under a worker's "I'll take it" (or what you answered). */
export function offerHtml(m: ChatMessage): string {
  const o = m.offer;
  if (!o) return "";
  if (o.state === "taken") return `<div class="offer done">✅ You said yes</div>`;
  if (o.state === "passed") return `<div class="offer done">🔁 Asked someone else</div>`;
  if (o.state === "anyone") return `<div class="offer done">🙋 Left for whoever's free</div>`;
  const first = m.who.split(" ")[0];
  return `<div class="offer">
    <button class="btn small primary" data-offer="${esc(o.taskId)}" data-answer="take">✅ Let ${esc(first)} take it</button>
    <button class="btn small" data-offer="${esc(o.taskId)}" data-answer="next">🔁 Someone else</button>
    <button class="btn small" data-offer="${esc(o.taskId)}" data-answer="anyone">Whoever's free</button>
  </div>`;
}

/** Answer offers clicked inside this element. */
export function wireOffers(el: HTMLElement, send: (m: ClientMessage) => void): void {
  el.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-offer]");
    if (!b) return;
    send({ t: "offerAnswer", taskId: b.dataset.offer!, answer: b.dataset.answer as "take" | "next" | "anyone" });
    b.closest(".offer")?.classList.add("sent");
  });
}

export const UPDATE_ASK = "Quick update, please: what are you on, how far along is it, and is anything blocking you? Two or three lines.";

export interface ChatActions {
  send(msg: ClientMessage): void;
  desks(): Desk[];
  openTerminal(deskId: string): void;
  onVoiceError?(err: string): void;
  /** Your name, to tell your own messages in #people from everyone else's. */
  me(): string;
  /** Someone else said something in #people (while the chat's closed, or on another channel). */
  onPeople?(who: string, text: string): void;
}

const STATUS: Record<string, string> = { booting: "starting", idle: "free", working: "working", waiting: "needs you", presenting: "presenting", done: "done" };
const STATUS_COLOR: Record<string, string> = { idle: "#06d6a0", working: "#ffd166", waiting: "#ef476f", presenting: "#9b5de5", booting: "#c9ced8", done: "#c9ced8" };

export class TeamChat {
  private modal: Modal | null = null;
  private threads: ChatThread[] = [];
  private selected = TEAM_THREAD;
  /** How many messages of each thread you've seen. */
  private seen = new Map<string, number>();
  private peeks = new Map<string, ChatPeek>();
  private works = new Map<string, ChatWork>();
  /** A worker's thread shows the conversation, or its record of work. */
  private view: "chat" | "work" = "chat";
  private raw = false;
  /** What you write becomes a task for this worker (tracked, reviewed) instead of a message. */
  private task = false;
  private draft = "";
  private timer = 0;
  private dictation: Dictation | null = null;
  /** Unread answers changed (for the badge on the dock). */
  onUnread: ((n: number) => void) | null = null;

  constructor(private actions: ChatActions) {}

  get isOpen(): boolean {
    return this.modal !== null;
  }

  /** Answers from workers you haven't read yet. */
  unread(): number {
    let n = 0;
    for (const t of this.threads) {
      if (t.id === TEAM_THREAD) continue;
      n += this.unreadIn(t);
    }
    return n;
  }

  /** New messages in a thread you'd want to read: a worker's answers, or someone else in #people. */
  private unreadIn(t: ChatThread): number {
    return t.messages.slice(this.seen.get(t.id) ?? 0).filter((m) => this.fromOthers(t.id, m)).length;
  }

  private fromOthers(threadId: string, m: ChatThread["messages"][number]): boolean {
    return threadId === PEOPLE_THREAD ? m.who !== this.actions.me() : m.from === "agent";
  }

  update(threads: ChatThread[]): void {
    const first = this.threads.length === 0;
    // Someone else in #people: a toast, unless you're reading it.
    const before = this.threads.find((t) => t.id === PEOPLE_THREAD)?.messages.length ?? 0;
    const people = threads.find((t) => t.id === PEOPLE_THREAD);
    if (!first && people && !(this.modal && this.selected === PEOPLE_THREAD))
      for (const m of people.messages.slice(before)) if (m.who !== this.actions.me()) this.actions.onPeople?.(m.who, m.text);
    this.threads = threads;
    // What was there before you ever opened it counts as read.
    if (first) for (const t of threads) this.seen.set(t.id, t.messages.length);
    if (!threads.some((t) => t.id === this.selected)) this.selected = TEAM_THREAD;
    if (this.modal) {
      this.markSeen();
      this.render();
    }
    this.onUnread?.(this.unread());
  }

  work(w: ChatWork): void {
    this.works.set(w.deskId, w);
    if (this.modal && this.selected === w.deskId && this.view === "work") this.render();
  }

  peek(p: ChatPeek): void {
    this.peeks.set(p.deskId, p);
    if (this.modal && this.selected === p.deskId) this.renderNow();
  }

  open(threadId?: string): void {
    if (threadId) this.selected = threadId;
    const body = document.createElement("div");
    body.className = "chat";
    wireOffers(body, (m) => this.actions.send(m));
    this.modal = openModal({
      title: "Team chat",
      icon: "💬",
      className: "chat-modal",
      body,
      onClose: () => {
        clearInterval(this.timer);
        this.dictation?.stop();
        this.modal = null;
      },
    });
    this.actions.send({ t: "chatGet" });
    this.markSeen();
    this.render();
    this.timer = window.setInterval(() => this.poll(), 2000);
    this.poll();
  }

  private poll(): void {
    if (this.selected === TEAM_THREAD || this.selected === PEOPLE_THREAD) return;
    this.actions.send({ t: "chatPeek", deskId: this.selected });
    if (this.view === "work") this.actions.send({ t: "chatWork", deskId: this.selected });
  }

  private markSeen(): void {
    const t = this.threads.find((x) => x.id === this.selected);
    if (t) this.seen.set(t.id, t.messages.length);
    this.onUnread?.(this.unread());
  }

  private staffedCount(): number {
    return this.actions.desks().filter((d) => d.worker).length;
  }

  private desk(id: string): Desk | undefined {
    return this.actions.desks().find((d) => d.id === id);
  }

  private render(): void {
    const body = this.modal?.body.querySelector<HTMLElement>(".chat");
    if (!body) return;
    const input = body.querySelector<HTMLTextAreaElement>(".ch-input");
    if (input) this.draft = input.value;
    const t = this.threads.find((x) => x.id === this.selected);
    const isPeople = this.selected === PEOPLE_THREAD;
    // #people works like #team here: a channel, not a worker.
    const isTeam = this.selected === TEAM_THREAD || isPeople;
    body.innerHTML = `
      <aside class="ch-side">
        <div class="ch-side-head">Channels</div>
        ${this.threads
          .map((th) => {
            const w = th.id === TEAM_THREAD || th.id === PEOPLE_THREAD ? null : this.desk(th.id)?.worker;
            const unread = th.id === TEAM_THREAD ? 0 : this.unreadIn(th);
            const last = th.messages.at(-1);
            return `<button class="ch-thread ${th.id === this.selected ? "on" : ""}" data-id="${esc(th.id)}">
              ${w ? `<span class="ch-dot" style="background:${AGENT_COLOR[w.agent]}"><i style="background:${STATUS_COLOR[w.status] ?? "#c9ced8"}"></i></span>` : `<span class="ch-hash">#</span>`}
              <span class="ch-thread-main"><b>${esc(th.id === TEAM_THREAD ? "team" : th.id === PEOPLE_THREAD ? "people" : th.title)}</b><small>${last ? esc(`${last.from === "you" && (th.id !== PEOPLE_THREAD || last.who === this.actions.me()) ? "You: " : th.id === PEOPLE_THREAD ? `${last.who}: ` : ""}${last.text}`.slice(0, 48)) : w ? esc(STATUS[w.status] ?? w.status) : th.id === PEOPLE_THREAD ? "The people here — workers don't see it" : "Message everyone"}</small></span>
              ${unread ? `<span class="ch-badge">${unread}</span>` : ""}
            </button>`;
          })
          .join("")}
        ${this.threads.length === 1 ? `<p class="ch-empty-side">Hire a worker and it gets a channel here.</p>` : ""}
      </aside>
      <section class="ch-main">
        <header class="ch-head">
          <b>${esc(isPeople ? "#people" : isTeam ? "#team" : (t?.title ?? ""))}</b>
          <span>${isPeople ? "You and the others here — the workers don't see this" : isTeam ? `Every worker at once · ${this.staffedCount()} worker${this.staffedCount() === 1 ? "" : "s"}` : esc(this.desk(this.selected)?.worker?.activity ?? "")}</span>
          ${
            isTeam
              ? ""
              : `<div class="seg ch-views"><button data-view="chat" class="${this.view === "chat" ? "on" : ""}">💬 Chat</button><button data-view="work" class="${this.view === "work" ? "on" : ""}">📜 Work</button></div>
                 <button class="btn small ch-update" title="Ask it where it's at">📍 Ask for an update</button>
                 <button class="btn small ch-term" title="Open its terminal: watch it live, type into it">🖥 Terminal</button>`
          }
        </header>
        ${isTeam ? "" : `<details class="ch-now" open><summary>🧠 Now</summary><div class="ch-now-body"></div><div class="ch-keys"><button class="btn small" data-key="enter" title="Press Enter in its terminal">⏎ Enter</button><button class="btn small" data-key="esc" title="Press Esc in its terminal">⎋ Esc</button><button class="btn small" data-key="1">1</button><button class="btn small" data-key="2">2</button></div></details>`}
        ${
          !isTeam && this.view === "work"
            ? `<div class="ch-log ch-work">${this.workHtml()}</div>`
            : `<div class="ch-log">${(t?.messages ?? []).map((m) => this.messageHtml(m, isPeople)).join("") || `<p class="ch-empty">${isPeople ? "Say hi to the people here." : isTeam ? "Say something to the whole team." : "No messages yet. Ask how it's going."}</p>`}</div>`
        }
        <footer class="ch-compose">
          ${
            isPeople
              ? ""
              : isTeam
              ? `<button class="btn small ch-update-all" title="Everyone says where they're at">📍 Ask everyone for an update</button>`
              : `<div class="seg ch-mode"><button data-mode="say" class="${!this.raw && !this.task ? "on" : ""}" title="A message it answers in the chat">💬 Message</button><button data-mode="task" class="${this.task ? "on" : ""}" title="Give it something to work on: tracked as a task, and it presents when it's done">🎯 Task</button><button data-mode="raw" class="${this.raw ? "on" : ""}" title="Type straight into its terminal (commands, answers to its prompts)">⌨️ Terminal</button></div>`
          }
          <textarea class="ch-input ${this.raw && !isTeam ? "raw" : ""}" rows="2" placeholder="${isPeople ? "Message the people here…" : isTeam ? "Message every worker…" : this.raw ? "Typed into its terminal, then Enter (e.g. /model, y, a command)…" : this.task ? `What should ${esc(t?.title ?? "it")} work on? It's tracked, and it presents when done…` : `Message ${esc(t?.title ?? "")}…`}"></textarea>
          ${micButton("ch-mic")}
          <button class="btn primary ch-send">Send</button>
        </footer>
      </section>`;
    const box = body.querySelector<HTMLTextAreaElement>(".ch-input")!;
    box.value = this.draft;
    box.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendDraft();
      }
    });
    body.querySelector(".ch-send")!.addEventListener("click", () => this.sendDraft());
    body.querySelectorAll<HTMLButtonElement>(".ch-thread").forEach((b) =>
      b.addEventListener("click", () => {
        this.selected = b.dataset.id!;
        this.draft = "";
        this.markSeen();
        this.render();
        this.poll();
      }),
    );
    body.querySelectorAll<HTMLButtonElement>(".ch-views button").forEach((b) =>
      b.addEventListener("click", () => {
        this.view = b.dataset.view === "work" ? "work" : "chat";
        this.render();
        this.poll();
      }),
    );
    body.querySelectorAll<HTMLButtonElement>(".ch-mode button").forEach((b) =>
      b.addEventListener("click", () => {
        this.raw = b.dataset.mode === "raw";
        this.task = b.dataset.mode === "task";
        this.render();
      }),
    );
    body.querySelector(".ch-update")?.addEventListener("click", () => this.actions.send({ t: "chatSend", to: this.selected, text: UPDATE_ASK }));
    body.querySelector(".ch-update-all")?.addEventListener("click", () => this.actions.send({ t: "chatSend", to: TEAM_THREAD, text: UPDATE_ASK }));
    body.querySelector(".ch-term")?.addEventListener("click", () => {
      const id = this.selected;
      this.modal?.close();
      this.actions.openTerminal(id);
    });
    body.querySelectorAll<HTMLButtonElement>(".ch-keys button").forEach((b) =>
      b.addEventListener("click", () => {
        const k = b.dataset.key!;
        this.actions.send({ t: "input", deskId: this.selected, data: k === "enter" ? "\r" : k === "esc" ? "\x1b" : k });
        setTimeout(() => this.poll(), 400);
      }),
    );
    wireMic(body.querySelector<HTMLButtonElement>(".ch-mic"), box, (err) => this.actions.onVoiceError?.(err));
    this.renderNow();
    const log = body.querySelector(".ch-log")!;
    log.scrollTop = log.scrollHeight;
    box.focus();
  }

  private renderNow(): void {
    const el = this.modal?.body.querySelector<HTMLElement>(".ch-now-body");
    if (!el) return;
    const p = this.peeks.get(this.selected);
    const w = this.desk(this.selected)?.worker;
    el.innerHTML = p
      ? `<div class="ch-now-status"><span class="ch-pill" style="background:${STATUS_COLOR[p.status] ?? "#c9ced8"}">${esc(STATUS[p.status] ?? p.status)}</span> ${esc(p.activity)}</div>
         <pre>${p.lines.map(esc).join("\n") || "(nothing on its screen yet)"}</pre>`
      : `<div class="ch-now-status">${esc(w?.activity ?? "")}</div><pre>…</pre>`;
    if (w) el.insertAdjacentHTML("afterbegin", `<div class="ch-tools">${w.doing && w.status === "working" ? `<b>${esc(doingLabel(w.doing))}</b> · ` : ""}🧰 ${w.mcp?.length ? `MCP tools: ${esc(w.mcp.join(", "))}` : "No MCP tools — add some in Office → MCP tools"}${w.skills?.length ? ` · <span title="${esc(w.skills.join(", "))}">🎓 ${w.skills.length} skills</span>` : ""}</div>`);
  }

  private workHtml(): string {
    const w = this.works.get(this.selected);
    if (!w) return `<p class="ch-empty">Reading its record…</p>`;
    const when = (at: number) => new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    return `
      <section class="ch-sec"><h4>🎯 On now</h4>${
        w.tasks.length ? `<ul>${w.tasks.map((t) => `<li><b>${esc(t.title)}</b> <span>${esc(t.goal)} · ${esc(t.status)}</span></li>`).join("")}</ul>` : `<p class="ch-none">No task right now.</p>`
      }</section>
      <section class="ch-sec"><h4>🌿 ${w.branch ? `Its branch <code>${esc(w.branch)}</code>` : "Commits"}</h4>${
        w.commits.length
          ? `<ul class="ch-commits">${w.commits.map((c) => `<li><code>${esc(c.hash)}</code> ${esc(c.subject)} <span>${when(c.at)}</span></li>`).join("")}</ul>`
          : `<p class="ch-none">${w.branch ? "Nothing committed on its branch yet." : "No commits yet."}</p>`
      }</section>
      ${w.branch ? `<section class="ch-sec"><h4>📝 Files it has changed</h4>${w.changed.length ? `<ul class="ch-files">${w.changed.map((f) => `<li><code>${esc(f)}</code></li>`).join("")}</ul>` : `<p class="ch-none">None yet.</p>`}</section>` : ""}
      <section class="ch-sec"><h4>📜 Done before</h4>${this.pastHtml()}</section>
      <p class="ch-none">Its whole conversation is under 💬 Chat; to step in, open its 🖥 Terminal.</p>`;
  }

  /** What this worker (or its character, across hires) has done: from the office's history. */
  private pastHtml(): string {
    const w = this.desk(this.selected)?.worker;
    if (!w) return "";
    const past = historyOf({ deskId: this.selected, characterId: w.identity?.characterId }).filter((e) => ["assigned", "approved", "changes", "audit", "reported"].includes(e.kind)).slice(0, 25);
    return past.length
      ? `<ul>${past.map((e) => `<li>${KIND_ICON[e.kind]} ${esc(e.text)} <span>${new Date(e.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span></li>`).join("")}</ul>`
      : `<p class="ch-none">Nothing yet.</p>`;
  }

  private messageHtml(m: ChatThread["messages"][number], people = false): string {
    const time = new Date(m.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    // In #people everyone's a person: yours on the right, everyone else's on the left.
    const side = people ? (m.who === this.actions.me() ? "you" : "agent") : m.from;
    return `<div class="ch-msg ${side}${m.raw ? " raw" : ""}">
      <div class="ch-msg-head"><b>${esc(m.who)}</b><span>${time}${m.raw ? " · typed in its terminal" : ""}</span></div>
      <div class="ch-msg-text">${m.raw ? `<code>${esc(m.text)}</code>` : esc(m.text)}</div>
      ${offerHtml(m)}
    </div>`;
  }

  private sendDraft(): void {
    const box = this.modal?.body.querySelector<HTMLTextAreaElement>(".ch-input");
    const text = box?.value.trim();
    if (!box || !text) return;
    this.dictation?.stop();
    const channel = this.selected === TEAM_THREAD || this.selected === PEOPLE_THREAD;
    const raw = this.raw && !channel;
    if (this.selected === PEOPLE_THREAD) this.actions.send({ t: "peopleSend", text });
    else if (this.task && !channel) this.actions.send({ t: "quickTask", deskId: this.selected, text });
    else this.actions.send({ t: "chatSend", to: this.selected, text, ...(raw ? { raw: true } : {}) });
    box.value = "";
    this.draft = "";
    if (raw) setTimeout(() => this.poll(), 600);
  }
}
