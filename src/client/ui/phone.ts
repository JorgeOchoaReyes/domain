import type { OfficeState } from "../../shared/protocol.js";
import { AGENT_LABELS, doingLabel } from "../../shared/protocol.js";
import { dueLabel, goalProgress, type ProgressState } from "../../shared/progress.js";
import { remainingLabel, taskEstimateLine } from "../../shared/estimate.js";
import { PLACES } from "../../shared/layout.js";
import { TEAM_THREAD } from "../../shared/chat.js";
import { TRACKS, type TrackId } from "../music.js";
import { AGENT_COLOR } from "../scene/characters.js";
import { historyEvents, onHistory, timelineHtml } from "./history.js";
import type { InboxItem } from "../../shared/inbox.js";
import { inboxItemHtml, wireInboxList } from "./inbox.js";
import { esc } from "./modal.js";
import { micButton, wireMic } from "../voice.js";
import "../styles/phone.css";

/**
 * Your phone (P): the office in your pocket. It doesn't stop you — you can
 * keep walking with it out — and it has what your laptop has, small: what
 * needs you, your team's chat, goals and deadlines, the line, every worker
 * (chat, terminal, go there), the day's history, the music and travel. The
 * button in the corner shows how many things need you even when it's away.
 */

export type PhoneApp = "home" | "alerts" | "chat" | "monitor" | "tasks" | "reviews" | "workers" | "history" | "music" | "travel";

export interface PhoneActions {
  office(): OfficeState;
  progress(): ProgressState;
  /** What needs you: the same list as 🔔 Needs you in the dock. */
  inbox(): InboxItem[];
  /** Do what one of its buttons says, or dismiss it. */
  act(item: InboxItem, action: string): void;
  dismiss(id: string): void;
  music(): { on: boolean; track: TrackId; volume: number };
  setMusic(m: { on: boolean; track: TrackId; volume: number }): void;
  sendTeam(text: string): void;
  /** Hand it to the first free worker (or, with nobody free, leave it waiting for the next). */
  giveTask(text: string): void;
  openChat(threadId?: string): void;
  openTerminal(deskId: string): void;
  goToDesk(deskId: string): void;
  openGoals(goalId?: string): void;
  officeHours(): void;
  roundup(): void;
  standup(): void;
  focus(): void;
  lessons(): void;
  /** Is autopilot on, and turn it on or off. */
  autopilot(): boolean;
  setAutopilot(on: boolean): void;
  openHistory(): void;
  openLaptop(): void;
  /** The Agent monitor: every worker's live CLI at once. */
  openMonitor(): void;
  /** Approve a worker's finished work, or send it back with a note — without office hours. */
  review(deskId: string, approve: boolean, text: string): void;
  travel(place: (typeof PLACES)[number]): void;
  /** The phone opened or closed (to free or take the mouse). */
  shown(open: boolean): void;
}

const APPS: { id: Exclude<PhoneApp, "home">; icon: string; label: string; color: string }[] = [
  { id: "alerts", icon: "🔔", label: "Alerts", color: "#ef476f" },
  { id: "chat", icon: "💬", label: "Chat", color: "#4cc9f0" },
  { id: "monitor", icon: "📺", label: "Monitor", color: "#3a86ff" },
  { id: "tasks", icon: "🎯", label: "Goals", color: "#ffd166" },
  { id: "reviews", icon: "🎤", label: "Reviews", color: "#c77dff" },
  { id: "workers", icon: "🧑‍💻", label: "Workers", color: "#06d6a0" },
  { id: "history", icon: "📜", label: "History", color: "#f4a261" },
  { id: "music", icon: "🎵", label: "Music", color: "#ff70a6" },
  { id: "travel", icon: "🧭", label: "Travel", color: "#90be6d" },
];

const STATUS: Record<string, [string, string]> = {
  booting: ["starting", "#adb5bd"],
  idle: ["free", "#adb5bd"],
  working: ["working", "#ffd166"],
  waiting: ["needs you", "#ef476f"],
  presenting: ["ready to present", "#c77dff"],
  done: ["done", "#06d6a0"],
  asleep: ["asleep", "#6c757d"],
};

export class Phone {
  private el: HTMLElement;
  private screen: HTMLElement;
  private button: HTMLButtonElement;
  private app: PhoneApp = "home";
  private open_ = false;
  private lastKey = "";

  constructor(private a: PhoneActions) {
    this.button = document.createElement("button");
    this.button.className = "btn dock-btn phone-btn";
    this.button.dataset.act = "phone";
    this.button.title = "Your phone (P): what needs you, chat, goals, reviews, workers, history, music, travel — keep walking with it out";
    this.button.innerHTML = `📱 <span class="lbl">Phone</span>`;
    this.button.addEventListener("click", () => this.toggle());
    this.el = document.createElement("div");
    this.el.className = "phone hidden";
    this.el.innerHTML = `
      <div class="ph-notch"></div>
      <div class="ph-status"><span class="ph-clock"></span><span>📶 🔋</span></div>
      <div class="ph-screen"></div>
      <div class="ph-bar"><button class="ph-back" title="Back">‹</button><button class="ph-home" title="Home"></button><button class="ph-close" title="Put it away (P)">✕</button></div>`;
    this.screen = this.el.querySelector(".ph-screen")!;
    this.el.querySelector(".ph-home")!.addEventListener("click", () => this.go("home"));
    this.el.querySelector(".ph-back")!.addEventListener("click", () => this.go("home"));
    this.el.querySelector(".ph-close")!.addEventListener("click", () => this.close());
    // Typing on the phone isn't walking.
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
      e.stopPropagation();
    });
    // The button sits in the dock (see dockButton); the phone itself over the game.
    document.body.append(this.el);
    onHistory(() => this.app === "history" && this.refresh(true));
    setInterval(() => this.refresh(), 1000);
  }

  /**
   * A notification: the phone buzzes and a banner drops from it for a while
   * (tap it to open that app). The banners stack, newest on top.
   */
  notify(text: string, app: PhoneApp = "alerts"): void {
    this.button.classList.remove("buzz");
    void this.button.offsetWidth;
    this.button.classList.add("buzz");
    const b = document.createElement("button");
    b.className = "ph-banner";
    b.innerHTML = `<span class="ph-banner-app">📱 domain</span><span class="ph-banner-text"></span>`;
    b.querySelector(".ph-banner-text")!.textContent = text;
    b.addEventListener("click", () => {
      b.remove();
      this.open(app);
    });
    let stack = document.querySelector<HTMLElement>(".ph-banners");
    if (!stack) {
      stack = document.createElement("div");
      stack.className = "ph-banners";
      document.body.append(stack);
    }
    stack.prepend(b);
    while (stack.children.length > 2) stack.lastElementChild!.remove();
    setTimeout(() => b.remove(), 6000);
    this.refresh();
  }

  /** The phone's button, for the dock. */
  get dockButton(): HTMLButtonElement {
    return this.button;
  }

  get isOpen(): boolean {
    return this.open_;
  }

  toggle(app?: PhoneApp): void {
    if (this.open_ && !app) this.close();
    else this.open(app);
  }

  open(app: PhoneApp = this.app): void {
    this.app = app;
    this.open_ = true;
    this.el.classList.remove("hidden");
    this.button.classList.add("on");
    this.refresh(true);
    this.a.shown(true);
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.el.classList.add("hidden");
    this.button.classList.remove("on");
    this.a.shown(false);
  }

  private go(app: PhoneApp): void {
    // Too many screens for a phone: the monitor opens big, and the phone goes away.
    if (app === "monitor") {
      this.close();
      this.a.openMonitor();
      return;
    }
    this.app = app;
    this.refresh(true);
  }

  /** How many things need you: the inbox, workers waiting, the line, overdue goals. */
  private badges(): Partial<Record<PhoneApp, number>> {
    const office = this.a.office();
    const waiting = office.desks.filter((d) => d.worker?.status === "waiting").length;
    const line = office.presentations.filter((p) => p.report).length;
    const overdue = this.a.progress().goals.filter((g) => g.dueAt && !g.shippedAt && g.dueAt < Date.now()).length;
    return { alerts: this.items.length, monitor: waiting, workers: waiting, reviews: line, tasks: overdue };
  }

  /** The inbox as of this redraw (its buttons are wired by index). */
  private items: InboxItem[] = [];

  /** Redraw (only when something changed, unless forced: inputs keep their text). */
  refresh(force = false): void {
    // What needs you is counted once, on 🔔 Needs you in the dock: the phone's button only buzzes when it's notified.
    if (!this.open_) return;
    this.items = this.a.inbox();
    const b = this.badges();
    this.el.querySelector(".ph-clock")!.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const html = this.render(b);
    const key = this.app + html;
    if (!force && key === this.lastKey) return;
    if (!force && this.screen.contains(document.activeElement) && (document.activeElement as HTMLElement).tagName === "INPUT") return;
    this.lastKey = key;
    const scroll = this.screen.scrollTop;
    this.screen.innerHTML = html;
    this.screen.scrollTop = scroll;
    this.wire();
  }

  private head(title: string, extra = ""): string {
    return `<div class="ph-head"><h3>${title}</h3>${extra}</div>`;
  }

  private name(deskId: string): string {
    const w = this.a.office().desks.find((d) => d.id === deskId)?.worker;
    return w ? (w.identity?.name ?? AGENT_LABELS[w.agent]) : deskId;
  }

  private render(b: Partial<Record<PhoneApp, number>>): string {
    const office = this.a.office();
    const progress = this.a.progress();
    switch (this.app) {
      case "home": {
        const session = progress.session;
        const left = session ? Math.max(0, session.endsAt - Date.now()) : 0;
        const next = this.items[0];
        return `
          <div class="ph-hero">
            <div class="ph-time">${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</div>
            <div class="ph-date">${new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</div>
            ${session ? `<div class="ph-session">🔥 Focus · ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")} left</div>` : ""}
          </div>
          <div class="ph-quick">
            <button data-do="standup"><span>☀️</span>Stand-up</button>
            <button data-do="focus"><span>⏱</span>Focus</button>
            <button data-do="roundup"><span>📣</span>Round up</button>
            <button data-do="hours"><span>🎤</span>Reviews${b.reviews ? ` <i>${b.reviews}</i>` : ""}</button>
            <button data-do="lessons"><span>🌙</span>Lessons</button>
          </div>
          <button class="ph-wide ph-auto ${this.a.autopilot() ? "primary" : ""}" data-do="autopilot">🤖 Autopilot ${this.a.autopilot() ? "on — the office runs itself" : "off — tap to let the office run itself"}</button>
          ${next ? `<button class="ph-next u${next.urgency}" data-app="alerts">${next.icon} ${esc(next.title)}${this.items.length > 1 ? ` <i>+${this.items.length - 1}</i>` : ""}</button>` : `<div class="ph-next calm">✨ Nothing needs you right now</div>`}
          <div class="ph-grid">
            ${APPS.map((x) => `<button class="ph-app" data-app="${x.id}"><span class="ph-icon" style="background:${x.color}">${x.icon}${b[x.id] ? `<i>${b[x.id]}</i>` : ""}</span>${x.label}</button>`).join("")}
            <button class="ph-app" data-do="laptop"><span class="ph-icon" style="background:#3a3d5c">💻</span>Laptop</button>
          </div>`;
      }
      case "alerts":
        // The same list as 🔔 Needs you in the dock.
        return (
          this.head("🔔 Needs you", this.items.length ? `<span class="ph-count">${this.items.length}</span>` : "") +
          (this.items.length
            ? `<ul class="ib-list ph-inbox">${this.items.map(inboxItemHtml).join("")}</ul>`
            : `<p class="ph-empty">All clear. I'll buzz you when a worker needs you, work is waiting, someone offers or asks, or a deadline gets close.</p>`)
        );
      case "monitor":
        // Never shown here (go() opens the big monitor instead).
        return "";
      case "chat": {
        const desks = office.desks.filter((d) => d.worker);
        return (
          this.head("💬 Team chat", `<button class="ph-link" data-do="chat">Open ›</button>`) +
          `<div class="ph-send"><input type="text" maxlength="2000" placeholder="Message everyone, or give a task…" />${micButton("ph-mic")}<button class="ph-go">Send</button><button class="ph-task" title="Give it as a task to whoever's free">🎯 Task</button></div>
          <button class="ph-row" data-chat="${TEAM_THREAD}"><span class="ph-av" style="background:#4cc9f0">#</span><span><b>team</b><small>Everyone at once</small></span></button>
          ${desks
            .map((d) => {
              const [st, c] = STATUS[d.worker!.status] ?? [d.worker!.status, "#adb5bd"];
              return `<button class="ph-row" data-chat="${d.id}"><span class="ph-av" style="background:${AGENT_COLOR[d.worker!.agent]}">${esc(this.name(d.id).slice(0, 1))}</span><span><b>${esc(this.name(d.id))}</b><small><i class="dot" style="background:${c}"></i>${esc(st)} · ${esc(d.worker!.activity.slice(0, 40))}</small></span></button>`;
            })
            .join("")}`
        );
      }
      case "tasks": {
        const goals = progress.goals.filter((g) => !g.shippedAt);
        return (
          this.head("🎯 Goals", `<button class="ph-link" data-goal="">All ›</button>`) +
          (goals.length
            ? goals
                .map((g) => {
                  const pr = goalProgress(g);
                  const doing = g.tasks.filter((t) => t.status === "doing" || t.status === "review");
                  // Before it goes out: what the next task will likely take, on cloud or local.
                  const next = g.tasks.find((t) => t.status === "todo" && !t.deskId);
                  const left = remainingLabel(g.tasks, progress.estimates);
                  return `<button class="ph-card goal" data-goal="${g.id}"><b>${g.kind === "research" ? "📊" : "🎯"} ${esc(g.title)}</b>
                    <span class="ph-meta">${pr.done}/${pr.total} tasks${g.dueAt ? ` · <em class="${g.dueAt < Date.now() ? "over" : ""}">📅 ${esc(dueLabel(g.dueAt))}</em>` : ""}${g.group?.length ? ` · 👥 ${g.group.length}` : ""}</span>
                    <span class="ph-bar-p"><span style="width:${Math.round(pr.pct * 100)}%"></span></span>
                    ${left ? `<span class="ph-sub">⏳ ${esc(left)}</span>` : ""}
                    ${doing.map((t) => `<span class="ph-sub">⌨️ ${esc(t.title)}${t.deskId ? ` — ${esc(this.name(t.deskId))}` : ""}${t.estimate ? `<br>${esc(taskEstimateLine(t))}` : ""}</span>`).join("")}
                    ${next ? `<span class="ph-sub">⬜ Next: ${esc(next.title)}<br>${esc(taskEstimateLine(next, progress.estimates))}</span>` : ""}</button>`;
                })
                .join("")
            : `<p class="ph-empty">No goals yet.</p>`) +
          `<button class="ph-wide" data-goal="new">＋ New goal</button>`
        );
      }
      case "reviews": {
        const line = office.presentations.filter((p) => p.report);
        return (
          this.head("🎤 Reviews") +
          (line.length
            ? line
                .map(
                  (p) =>
                    `<div class="ph-card"><b>${esc(this.name(p.deskId))}: ${esc(p.report!.title)}</b><span>${esc(p.report!.summary.slice(0, 140))}</span>${p.report!.check ? `<span class="ph-sub">${p.report!.check.status === "pass" ? "✅ checks pass" : p.report!.check.status === "running" ? "⏳ checking…" : "❌ checks fail"}</span>` : ""}
                    ${p.report!.question ? `<span class="ph-sub">❓ ${esc(p.report!.question)}</span>` : ""}
                    <input class="ph-rv-note" data-rvnote="${p.deskId}" placeholder="${p.report!.status === "blocked" ? "Your answer" : "A note (needed to send it back)"}" />
                    <div class="ph-acts">${p.report!.status === "blocked" ? "" : `<button data-approve="${p.deskId}">✅ ${p.report!.status === "plan" ? "Approve plan" : "Approve"}</button>`}<button data-back="${p.deskId}">${p.report!.status === "blocked" ? "💬 Answer" : "↩ Send back"}</button></div></div>`,
                )
                .join("") + `<button class="ph-wide primary" data-do="hours">🎤 Hold office hours (${line.length})</button>`
            : `<p class="ph-empty">Nobody's waiting to present.</p>`) +
          `<button class="ph-wide" data-do="roundup">📣 Round everyone up</button>`
        );
      }
      case "workers": {
        const desks = office.desks.filter((d) => d.worker);
        return (
          this.head("🧑‍💻 Workers", desks.length ? `<button class="ph-link" data-app="monitor">📺 Watch all ›</button>` : "") +
          (desks.length
            ? desks
                .map((d) => {
                  const w = d.worker!;
                  const [st, c] = STATUS[w.status] ?? [w.status, "#adb5bd"];
                  const task = progress.goals.flatMap((g) => g.tasks).find((t) => t.deskId === d.id && t.status !== "done");
                  return `<div class="ph-card"><b><i class="dot" style="background:${c}"></i>${esc(this.name(d.id))} <small>${esc(AGENT_LABELS[w.agent])} · ${esc(d.label)}</small></b>
                    <span>${esc(w.status === "working" && w.doing ? doingLabel(w.doing) : st)}${task ? ` — “${esc(task.title)}”` : ""}</span><span class="ph-sub">${esc(w.activity.slice(0, 80))}${w.mcp?.length ? ` · 🧰 ${esc(w.mcp.join(", "))}` : ""}${w.skills?.length ? ` · 🎓 ${w.skills.length} skills` : ""}</span>
                    <div class="ph-acts"><button data-chat="${d.id}">💬</button><button data-term="${d.id}">🖥 Terminal</button><button data-goto="${d.id}">🚶 Go</button></div></div>`;
                })
                .join("")
            : `<p class="ph-empty">No one's hired yet — walk up to an empty desk.</p>`)
        );
      }
      case "history":
        return this.head("📜 History", `<button class="ph-link" data-do="history">Open ›</button>`) + `<div class="ph-hist">${timelineHtml(historyEvents(), 60)}</div>`;
      case "music": {
        const m = this.a.music();
        return (
          this.head("🎵 Music") +
          `<button class="ph-wide ${m.on ? "primary" : ""}" data-music="toggle">${m.on ? "⏸ Pause" : "▶ Play"}</button>
          ${TRACKS.map((t) => `<button class="ph-row ${m.on && m.track === t.id ? "on" : ""}" data-track="${t.id}"><span class="ph-av" style="background:#ff70a6">${t.icon}</span><span><b>${esc(t.name)}</b><small>${esc(t.vibe)}</small></span></button>`).join("")}
          <label class="ph-vol">🔈 <input type="range" min="0" max="1" step="0.05" value="${m.volume}" /> 🔊</label>`
        );
      }
      case "travel":
        return this.head("🧭 Travel") + PLACES.map((p, i) => `<button class="ph-row" data-place="${i}"><span class="ph-av" style="background:#90be6d">${p.icon}</span><span><b>${esc(p.label)}</b></span></button>`).join("");
    }
  }

  private wire(): void {
    const s = this.screen;
    const on = (sel: string, fn: (el: HTMLElement) => void) => s.querySelectorAll<HTMLElement>(sel).forEach((el) => el.addEventListener("click", () => fn(el)));
    on("[data-app]", (el) => this.go(el.dataset.app as PhoneApp));
    // Things that open a window put the phone away.
    const away = (fn: () => void) => {
      this.close();
      fn();
    };
    on("[data-do]", (el) => {
      // Needs you's buttons are its own (wired below).
      if (el.closest(".ph-inbox")) return;
      const d = el.dataset.do;
      if (d === "standup") away(() => this.a.standup());
      else if (d === "focus") away(() => this.a.focus());
      else if (d === "lessons") away(() => this.a.lessons());
      else if (d === "autopilot") {
        this.a.setAutopilot(!this.a.autopilot());
        this.refresh(true);
      }
      else if (d === "laptop") away(() => this.a.openLaptop());
      else if (d === "chat") away(() => this.a.openChat());
      else if (d === "hours") away(() => this.a.officeHours());
      else if (d === "roundup") away(() => this.a.roundup());
      else if (d === "history") away(() => this.a.openHistory());
    });
    on("[data-chat]", (el) => away(() => this.a.openChat(el.dataset.chat)));
    on("[data-term]", (el) => away(() => this.a.openTerminal(el.dataset.term!)));
    const note = (deskId: string) => s.querySelector<HTMLInputElement>(`[data-rvnote="${deskId}"]`);
    on("[data-approve]", (el) => {
      const id = el.dataset.approve!;
      this.a.review(id, true, note(id)?.value.trim() ?? "");
      el.closest(".ph-card")?.classList.add("done");
    });
    on("[data-back]", (el) => {
      const id = el.dataset.back!;
      const n = note(id);
      if (!n?.value.trim()) {
        n?.focus();
        return;
      }
      this.a.review(id, false, n.value.trim());
      el.closest(".ph-card")?.classList.add("done");
    });
    on("[data-goto]", (el) => this.a.goToDesk(el.dataset.goto!));
    on("[data-goal]", (el) => away(() => this.a.openGoals(el.dataset.goal || undefined)));
    const list = s.querySelector<HTMLElement>(".ph-inbox");
    if (list) {
      wireInboxList(list, () => this.items, { act: (item, action) => {
        // Answers in place (offers, loans, trust) keep the phone out; the rest open a window.
        if (["take", "next", "lend", "refuse", "trust"].includes(action)) this.a.act(item, action);
        else away(() => this.a.act(item, action));
      }, dismiss: (id) => this.a.dismiss(id) }, () => this.refresh(true));
    }
    on("[data-place]", (el) => this.a.travel(PLACES[Number(el.dataset.place)]));
    on("[data-music]", () => {
      const m = this.a.music();
      this.a.setMusic({ ...m, on: !m.on });
      this.refresh(true);
    });
    on("[data-track]", (el) => {
      this.a.setMusic({ ...this.a.music(), on: true, track: el.dataset.track as TrackId });
      this.refresh(true);
    });
    s.querySelector<HTMLInputElement>(".ph-vol input")?.addEventListener("input", (e) => this.a.setMusic({ ...this.a.music(), volume: Number((e.target as HTMLInputElement).value) }));
    const input = s.querySelector<HTMLInputElement>(".ph-send input");
    const send = () => {
      const text = input!.value.trim();
      if (!text) return;
      input!.value = "";
      this.a.sendTeam(text);
    };
    input?.addEventListener("keydown", (e) => e.key === "Enter" && send());
    s.querySelector(".ph-go")?.addEventListener("click", send);
    s.querySelector(".ph-task")?.addEventListener("click", () => {
      const text = input!.value.trim();
      if (!text) return input!.focus();
      input!.value = "";
      this.a.giveTask(text);
    });
    if (input) wireMic(s.querySelector<HTMLButtonElement>(".ph-mic"), input);
  }
}
