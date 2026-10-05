import type { OfficeState } from "../../shared/protocol.js";
import { AGENT_LABELS, doingLabel } from "../../shared/protocol.js";
import { dueLabel, goalProgress, type ProgressState } from "../../shared/progress.js";
import { PLACES } from "../../shared/layout.js";
import { TEAM_THREAD } from "../../shared/chat.js";
import { TRACKS, type TrackId } from "../music.js";
import { AGENT_COLOR } from "../scene/characters.js";
import { historyEvents, onHistory, timelineHtml } from "./history.js";
import type { Reminder } from "./reminders.js";
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

export type PhoneApp = "home" | "alerts" | "chat" | "tasks" | "reviews" | "workers" | "history" | "music" | "travel";

export interface PhoneActions {
  office(): OfficeState;
  progress(): ProgressState;
  reminders(): Reminder[];
  music(): { on: boolean; track: TrackId; volume: number };
  setMusic(m: { on: boolean; track: TrackId; volume: number }): void;
  sendTeam(text: string): void;
  openChat(threadId?: string): void;
  openTerminal(deskId: string): void;
  goToDesk(deskId: string): void;
  openGoals(goalId?: string): void;
  officeHours(): void;
  roundup(): void;
  standup(): void;
  focus(): void;
  lessons(): void;
  openHistory(): void;
  openLaptop(): void;
  travel(place: (typeof PLACES)[number]): void;
  /** The phone opened or closed (to free or take the mouse). */
  shown(open: boolean): void;
}

const APPS: { id: Exclude<PhoneApp, "home">; icon: string; label: string; color: string }[] = [
  { id: "alerts", icon: "🔔", label: "Alerts", color: "#ef476f" },
  { id: "chat", icon: "💬", label: "Chat", color: "#4cc9f0" },
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
    this.button.title = "Your phone (P): alerts, chat, goals, reviews, workers, history, music, travel";
    this.button.innerHTML = `📱 <span class="lbl">Phone</span><span class="ph-badge"></span>`;
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
    this.app = app;
    this.refresh(true);
  }

  /** How many things need you: urgent reminders, workers waiting, and the line. */
  private badges(): Partial<Record<PhoneApp, number>> {
    const office = this.a.office();
    const urgent = this.a.reminders().filter((r) => r.urgency >= 2).length;
    const waiting = office.desks.filter((d) => d.worker?.status === "waiting").length;
    const line = office.presentations.filter((p) => p.report).length;
    const overdue = this.a.progress().goals.filter((g) => g.dueAt && !g.shippedAt && g.dueAt < Date.now()).length;
    return { alerts: urgent + waiting, workers: waiting, reviews: line, tasks: overdue };
  }

  /** Redraw (only when something changed, unless forced: inputs keep their text). */
  refresh(force = false): void {
    const b = this.badges();
    const total = (b.alerts ?? 0) + (b.reviews ?? 0);
    const badge = this.button.querySelector<HTMLElement>(".ph-badge")!;
    badge.textContent = total ? String(total) : "";
    this.button.classList.toggle("ping", total > 0);
    if (!this.open_) return;
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
        const next = this.a.reminders()[0];
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
          ${next ? `<button class="ph-next u${next.urgency}" data-app="alerts">${next.icon} ${esc(next.text)}</button>` : `<div class="ph-next calm">✨ Nothing needs you right now</div>`}
          <div class="ph-grid">
            ${APPS.map((x) => `<button class="ph-app" data-app="${x.id}"><span class="ph-icon" style="background:${x.color}">${x.icon}${b[x.id] ? `<i>${b[x.id]}</i>` : ""}</span>${x.label}</button>`).join("")}
            <button class="ph-app" data-do="laptop"><span class="ph-icon" style="background:#3a3d5c">💻</span>Laptop</button>
          </div>`;
      }
      case "alerts": {
        const list = this.a.reminders();
        const waiting = office.desks.filter((d) => d.worker?.status === "waiting" && !list.some((r) => r.id === `waiting-${d.id}`));
        const rows = [
          ...waiting.map((d) => `<div class="ph-card u3"><b>🙋 ${esc(this.name(d.id))} needs you</b><span>${esc(d.worker!.activity)}</span><div class="ph-acts"><button data-term="${d.id}">🖥 Answer</button><button data-goto="${d.id}">🚶 Go there</button></div></div>`),
          ...list.map((r, i) => `<div class="ph-card u${r.urgency}"><b>${r.icon} ${esc(r.text)}</b>${r.action ? `<div class="ph-acts"><button data-rem="${i}">${esc(r.action.label)}</button></div>` : ""}</div>`),
        ];
        return this.head("🔔 Alerts") + (rows.length ? rows.join("") : `<p class="ph-empty">All clear. I'll buzz you when a worker needs you, work is waiting, or a deadline gets close.</p>`);
      }
      case "chat": {
        const desks = office.desks.filter((d) => d.worker);
        return (
          this.head("💬 Team chat", `<button class="ph-link" data-do="chat">Open ›</button>`) +
          `<div class="ph-send"><input type="text" maxlength="500" placeholder="Message everyone…" />${micButton("ph-mic")}<button class="ph-go">Send</button></div>
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
                  return `<button class="ph-card goal" data-goal="${g.id}"><b>${g.kind === "research" ? "📊" : "🎯"} ${esc(g.title)}</b>
                    <span class="ph-meta">${pr.done}/${pr.total} tasks${g.dueAt ? ` · <em class="${g.dueAt < Date.now() ? "over" : ""}">📅 ${esc(dueLabel(g.dueAt))}</em>` : ""}${g.group?.length ? ` · 👥 ${g.group.length}` : ""}</span>
                    <span class="ph-bar-p"><span style="width:${Math.round(pr.pct * 100)}%"></span></span>
                    ${doing.map((t) => `<span class="ph-sub">⌨️ ${esc(t.title)}${t.deskId ? ` — ${esc(this.name(t.deskId))}` : ""}</span>`).join("")}</button>`;
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
                .map((p) => `<div class="ph-card"><b>${esc(this.name(p.deskId))}: ${esc(p.report!.title)}</b><span>${esc(p.report!.summary.slice(0, 140))}</span>${p.report!.check ? `<span class="ph-sub">${p.report!.check.status === "pass" ? "✅ checks pass" : p.report!.check.status === "running" ? "⏳ checking…" : "❌ checks fail"}</span>` : ""}</div>`)
                .join("") + `<button class="ph-wide primary" data-do="hours">🎤 Hold office hours (${line.length})</button>`
            : `<p class="ph-empty">Nobody's waiting to present.</p>`) +
          `<button class="ph-wide" data-do="roundup">📣 Round everyone up</button>`
        );
      }
      case "workers": {
        const desks = office.desks.filter((d) => d.worker);
        return (
          this.head("🧑‍💻 Workers") +
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
      const d = el.dataset.do;
      if (d === "standup") away(() => this.a.standup());
      else if (d === "focus") away(() => this.a.focus());
      else if (d === "lessons") away(() => this.a.lessons());
      else if (d === "laptop") away(() => this.a.openLaptop());
      else if (d === "chat") away(() => this.a.openChat());
      else if (d === "hours") away(() => this.a.officeHours());
      else if (d === "roundup") away(() => this.a.roundup());
      else if (d === "history") away(() => this.a.openHistory());
    });
    on("[data-chat]", (el) => away(() => this.a.openChat(el.dataset.chat)));
    on("[data-term]", (el) => away(() => this.a.openTerminal(el.dataset.term!)));
    on("[data-goto]", (el) => this.a.goToDesk(el.dataset.goto!));
    on("[data-goal]", (el) => away(() => this.a.openGoals(el.dataset.goal || undefined)));
    on("[data-rem]", (el) => {
      const r = this.a.reminders()[Number(el.dataset.rem)];
      if (r?.action) away(() => r.action!.run());
    });
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
    if (input) wireMic(s.querySelector<HTMLButtonElement>(".ph-mic"), input);
  }
}
