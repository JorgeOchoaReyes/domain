import { copyAll, copyOnSelect } from "./termcopy.js";
import { TEAM_THREAD, type ChatThread } from "../../shared/chat.js";
import { UPDATE_ASK } from "./chat.js";
import { micButton, wireMic } from "../voice.js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { OfficeState, ServerMessage } from "../../shared/protocol.js";
import { AGENT_LABELS } from "../../shared/protocol.js";
import { EMPTY_PROGRESS, goalProgress, goalStage, stageLabel, STAGE_ICON, type Goal, type ProgressState } from "../../shared/progress.js";
import { AGENT_COLOR, STATUS_BULB } from "../scene/characters.js";
import { esc, openModal, type Modal } from "./modal.js";
import { workerName } from "./team.js";
import { ingestLoop, loopState, onLoop, renderLoop, type LoopHandlers } from "./loop.js";
import { openDeck, paintDeckSlide } from "./deck.js";
import "../styles/loop.css";

/**
 * Your own laptop, open anywhere (L): a little desktop with a dock of apps.
 *
 * - 🌐 Browser: the app your workers are building, in a frame — the preview
 *   URL from domain.config.json, or any dev server found running locally.
 * - 🖥 Workers: any worker's live terminal, to watch or type into.
 * - 🎯 Loop: where each goal is in the loop, and the next thing to do.
 * - 📊 Decks: research goals' slide decks, to present or download.
 * - 🚀 Deploy: the deploy command's output, live.
 *
 * Feed it every server message with onMessage(); it keeps its own copy of
 * the office and progress.
 */

export type LaptopApp = "team" | "browser" | "workers" | "loop" | "decks" | "deploy";

const APPS: { id: LaptopApp; icon: string; label: string }[] = [
  { id: "team", icon: "💬", label: "Team" },
  { id: "browser", icon: "🌐", label: "Browser" },
  { id: "workers", icon: "🖥", label: "Workers" },
  { id: "loop", icon: "🎯", label: "Loop" },
  { id: "decks", icon: "📊", label: "Decks" },
  { id: "deploy", icon: "🚀", label: "Deploy" },
];

const TERM_THEME = { background: "#1e1f2e", foreground: "#cdd6f4", cursor: "#ff8a5b", selectionBackground: "#585b70" };

export type LaptopActions = Omit<LoopHandlers, "openLaptop">;

export class MyLaptop {
  private modal: Modal | null = null;
  private app: LaptopApp = "team";
  /** The Team app: chat threads, and who's selected ("team" is everyone). */
  private threads: ChatThread[] = [];
  private teamTo = TEAM_THREAD;
  private office: OfficeState = { desks: [], peers: [], presentations: [] };
  private progress: ProgressState = EMPTY_PROGRESS;
  private root!: HTMLElement;
  private content!: HTMLElement;
  private clockTimer: number | null = null;
  private loopGoal: string | null = null;
  private renderKey = "";

  // Browser: tabs, each with its own page and history (kept across visits).
  private tabs: BrowserTab[] = loadTabs();
  private activeTab = 0;
  private frames = new Map<number, HTMLIFrameElement>();
  private nextTabId = 1;

  // Workers' terminal
  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private termHost = document.createElement("div");
  private watching: string | null = null;
  private waitingScrollback = false;

  // Deploy console
  private dterm: Terminal | null = null;
  private dfit: FitAddon | null = null;
  private dHost = document.createElement("div");
  private dShownGoal: string | null = null;

  private resizer = new ResizeObserver(() => this.refit());

  constructor(private actions: LaptopActions) {
    this.termHost.className = "lt-term";
    this.dHost.className = "lt-term";
    this.resizer.observe(this.termHost);
    this.resizer.observe(this.dHost);
    onLoop((msg) => {
      if (msg.t === "deployOutput") {
        if (this.dterm && this.dShownGoal === msg.goalId) this.dterm.write(msg.data);
        else this.dShownGoal = null;
        if (this.isOpen && this.app === "deploy") this.renderDeployHead();
      } else if (msg.t === "deployLog") {
        this.dShownGoal = null;
        if (this.isOpen && this.app === "deploy") this.showDeploy();
      } else if (msg.t === "devServers" || msg.t === "config") {
        if (this.isOpen && this.app === "browser") this.renderBrowserChrome();
      }
    });
  }

  get isOpen(): boolean {
    return this.modal !== null;
  }

  /** Every server message goes through here. */
  onMessage(msg: ServerMessage): void {
    ingestLoop(msg);
    switch (msg.t) {
      case "welcome":
      case "office":
        this.office = msg.office;
        this.soft();
        break;
      case "progress":
        this.progress = msg.progress;
        this.soft();
        break;
      case "chat":
        this.threads = msg.threads;
        if (this.isOpen && this.app === "team") this.renderTeamLog();
        break;
      case "output":
        if (this.term && this.watching === msg.deskId && !this.waitingScrollback) this.term.write(msg.data);
        break;
      case "scrollback":
        if (this.term && this.watching === msg.deskId && this.waitingScrollback) {
          this.waitingScrollback = false;
          this.term.reset();
          this.term.write(msg.data);
        }
        break;
    }
  }

  open(app?: LaptopApp): void {
    if (app) this.app = app;
    if (this.modal) {
      this.show(this.app);
      return;
    }
    const body = document.createElement("div");
    body.className = "laptop";
    body.innerHTML = `
      <div class="lt-screen">
        <div class="lt-bar">
          <span class="lt-logo">🏢 domain OS</span>
          <nav class="lt-tabs">${APPS.map((a) => `<button data-app="${a.id}"><span>${a.icon}</span> ${a.label}</button>`).join("")}</nav>
          <span class="lt-clock"></span>
          <button class="lt-close" title="Close (Esc)" aria-label="Close">✕</button>
        </div>
        <div class="lt-content"></div>
      </div>
      <div class="lt-hinge"></div>
      <div class="lt-base"><span></span></div>`;
    this.root = body;
    this.content = body.querySelector(".lt-content")!;
    body.querySelector(".lt-tabs")!.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-app]");
      if (b) this.show(b.dataset.app as LaptopApp);
    });
    body.querySelector(".lt-close")!.addEventListener("click", () => this.close());
    this.modal = openModal({
      title: "My laptop",
      className: "mylaptop",
      body,
      onClose: () => {
        this.modal = null;
        this.watching = null;
        if (this.clockTimer !== null) clearInterval(this.clockTimer);
        this.clockTimer = null;
      },
    });
    const clock = body.querySelector<HTMLElement>(".lt-clock")!;
    const tick = () => (clock.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    tick();
    this.clockTimer = window.setInterval(tick, 10_000);
    this.actions.send({ t: "probe" });
    this.show(this.app);
  }

  close(): void {
    this.modal?.close();
  }

  private show(app: LaptopApp): void {
    this.app = app;
    this.renderKey = "";
    this.root.querySelectorAll<HTMLElement>(".lt-tabs [data-app]").forEach((b) => b.classList.toggle("on", b.dataset.app === app));
    this.content.innerHTML = "";
    this.content.dataset.app = app;
    if (app === "team") this.showTeam();
    else if (app === "browser") this.showBrowser();
    else if (app === "workers") this.showWorkers();
    else if (app === "deploy") this.showDeploy();
    else this.soft();
  }

  /** New office or progress: refresh what depends on it, without disturbing the browser or terminals. */
  private soft(): void {
    if (!this.modal) return;
    if (this.app === "loop") this.renderLoopApp();
    else if (this.app === "decks") this.renderDecks();
    else if (this.app === "workers") this.renderWorkerList();
    else if (this.app === "team") this.renderTeamPeople();
    else if (this.app === "deploy") this.renderDeployHead();
  }

  // --- team: message anyone, hand out work, ask for updates -------------------------

  private showTeam(): void {
    this.actions.send({ t: "chatGet" });
    this.content.innerHTML = `
      <div class="tm">
        <div class="tm-people"></div>
        <div class="tm-log"></div>
        <div class="tm-compose">
          <div class="tm-box"><textarea rows="2" placeholder="Write to them — or press 🎤 and say it…"></textarea>${micButton("tm-mic")}</div>
          <div class="tm-acts">
            <button class="btn small tm-say">💬 Send message</button>
            <button class="btn small primary tm-task">🎯 Give as a task</button>
            <button class="btn small tm-update">📍 Ask for an update</button>
          </div>
        </div>
      </div>`;
    const box = this.content.querySelector<HTMLTextAreaElement>(".tm-compose textarea")!;
    wireMic(this.content.querySelector<HTMLButtonElement>(".tm-mic"), box);
    box.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        say();
      }
    });
    const text = () => box.value.trim();
    const say = () => {
      if (!text()) return;
      this.actions.send({ t: "chatSend", to: this.teamTo, text: text() });
      box.value = "";
    };
    this.content.querySelector(".tm-say")!.addEventListener("click", say);
    this.content.querySelector(".tm-task")!.addEventListener("click", () => {
      if (!text()) return box.focus();
      // To everyone: the first one who's free takes it (the office says who — or that it's waiting for the next).
      this.actions.send({ t: "quickTask", deskId: this.teamTo === TEAM_THREAD ? "any" : this.teamTo, text: text() });
      box.value = "";
    });
    this.content.querySelector(".tm-update")!.addEventListener("click", () => this.actions.send({ t: "chatSend", to: this.teamTo, text: UPDATE_ASK }));
    this.renderTeamPeople();
    this.renderTeamLog();
  }

  private renderTeamPeople(): void {
    const el = this.content.querySelector<HTMLElement>(".tm-people");
    if (!el) return;
    const staffed = this.office.desks.filter((d) => d.worker);
    const key = JSON.stringify([this.teamTo, staffed.map((d) => [d.id, d.worker!.status, d.worker!.activity])]);
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    el.innerHTML =
      `<button class="tm-p ${this.teamTo === TEAM_THREAD ? "on" : ""}" data-to="${TEAM_THREAD}"><b># Everyone</b><small>${staffed.length} worker${staffed.length === 1 ? "" : "s"}</small></button>` +
      staffed
        .map((d) => {
          const w = d.worker!;
          const name = w.identity?.name ?? AGENT_LABELS[w.agent];
          return `<button class="tm-p ${this.teamTo === d.id ? "on" : ""}" data-to="${d.id}"><b><i style="background:${AGENT_COLOR[w.agent]}"></i>${esc(name)}</b><small>${esc(w.status === "waiting" ? "needs you" : w.status)} · ${esc(w.activity.slice(0, 38))}</small></button>`;
        })
        .join("") +
      (staffed.length ? "" : `<p class="tm-none">Nobody's hired yet — walk up to a desk with a + and press E.</p>`);
    el.querySelectorAll<HTMLButtonElement>(".tm-p").forEach((b) =>
      b.addEventListener("click", () => {
        this.teamTo = b.dataset.to!;
        this.renderTeamPeople();
        this.renderTeamLog();
      }),
    );
  }

  private renderTeamLog(): void {
    const el = this.content.querySelector<HTMLElement>(".tm-log");
    if (!el) return;
    const t = this.threads.find((x) => x.id === this.teamTo);
    const msgs = (t?.messages ?? []).slice(-30);
    el.innerHTML = msgs.length
      ? msgs.map((m) => `<div class="tm-m ${m.from}"><b>${esc(m.who)}</b> <span>${new Date(m.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span><p>${esc(m.text)}</p></div>`).join("")
      : `<p class="tm-none">${this.teamTo === TEAM_THREAD ? "Say something to everyone, or ask for an update." : "No messages yet — message it, give it a task, or ask how it's going."}</p>`;
    el.scrollTop = el.scrollHeight;
  }

  // --- browser ----------------------------------------------------------------------

  private get tab(): BrowserTab {
    if (!this.tabs.length) this.tabs.push(newTab());
    this.activeTab = Math.min(this.activeTab, this.tabs.length - 1);
    return this.tabs[this.activeTab];
  }

  private showBrowser(): void {
    this.frames.clear();
    this.content.innerHTML = `
      <div class="br-tabs"></div>
      <div class="br-bar">
        <button class="br-btn back" title="Back">←</button>
        <button class="br-btn fwd" title="Forward">→</button>
        <button class="br-btn reload" title="Reload">↻</button>
        <form class="br-url"><input type="text" spellcheck="false" placeholder="localhost:3000" /></form>
        <button class="br-btn ext" title="Open in your browser">↗</button>
      </div>
      <div class="br-view"></div>`;
    const input = this.content.querySelector<HTMLInputElement>(".br-url input")!;
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") e.stopPropagation();
    });
    this.content.querySelector(".br-url")!.addEventListener("submit", (e) => {
      e.preventDefault();
      this.navigate(input.value);
    });
    this.content.querySelector(".back")!.addEventListener("click", () => {
      const t = this.tab;
      const u = t.back.pop();
      if (!u) return;
      if (t.url) t.fwd.push(t.url);
      this.navigate(u, false);
    });
    this.content.querySelector(".fwd")!.addEventListener("click", () => {
      const t = this.tab;
      const u = t.fwd.pop();
      if (!u) return;
      if (t.url) t.back.push(t.url);
      this.navigate(u, false);
    });
    this.content.querySelector(".reload")!.addEventListener("click", () => {
      const f = this.frames.get(this.tab.id);
      if (f) f.src = f.src;
      else this.actions.send({ t: "probe" });
    });
    this.content.querySelector(".ext")!.addEventListener("click", () => {
      if (this.tab.url) window.open(this.tab.url, "_blank", "noopener");
    });
    this.content.querySelector(".br-tabs")!.addEventListener("click", (e) => {
      const el = e.target as HTMLElement;
      const close = el.closest<HTMLElement>("[data-close]");
      if (close) return this.closeTab(Number(close.dataset.close));
      if (el.closest(".br-new")) return this.openTab(null);
      const t = el.closest<HTMLElement>("[data-tab]");
      if (t) this.switchTab(Number(t.dataset.tab));
    });
    // Middle-click closes a tab, like any browser.
    this.content.querySelector(".br-tabs")!.addEventListener("auxclick", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]");
      if (t && (e as MouseEvent).button === 1) this.closeTab(Number(t.dataset.tab));
    });
    this.content.querySelector(".br-view")!.addEventListener("click", (e) => {
      const c = (e.target as HTMLElement).closest<HTMLElement>("[data-url]");
      if (c) this.navigate(c.dataset.url!);
      else if ((e.target as HTMLElement).closest(".scan")) this.actions.send({ t: "probe" });
    });
    // The first visit opens your app, if it's running.
    if (!this.tab.url && this.tabs.length === 1) this.tab.url = loopState.config?.preview ?? loopState.devServers.find((u) => !isSelf(u)) ?? null;
    this.renderBrowserChrome();
    this.loadFrame();
  }

  /** The URLs worth a click: the preview and any dev servers running. */
  private devUrls(): string[] {
    return [...new Set([loopState.config?.preview, ...loopState.devServers].filter((u): u is string => !!u && !isSelf(u)))];
  }

  private renderBrowserChrome(): void {
    if (this.app !== "browser" || !this.content.querySelector(".br-tabs")) return;
    const label = (t: BrowserTab) => (t.url ? t.url.replace(/^https?:\/\//, "").replace(/\/$/, "") : "New tab");
    this.content.querySelector(".br-tabs")!.innerHTML =
      this.tabs
        .map(
          (t, i) =>
            `<div class="br-tab ${i === this.activeTab ? "on" : ""}" data-tab="${t.id}" title="${esc(t.url ?? "New tab")}"><span>${t.url ? "🌐" : "✨"} ${esc(label(t).slice(0, 28))}</span><button class="br-x" data-close="${t.id}" title="Close tab">×</button></div>`,
        )
        .join("") + `<button class="br-new" title="New tab">＋</button>`;
    const input = this.content.querySelector<HTMLInputElement>(".br-url input")!;
    if (document.activeElement !== input) input.value = this.tab.url ?? "";
    this.content.querySelector<HTMLButtonElement>(".back")!.disabled = !this.tab.back.length;
    this.content.querySelector<HTMLButtonElement>(".fwd")!.disabled = !this.tab.fwd.length;
    // A blank tab lists what's running: refresh it when that changes.
    if (!this.tab.url) this.loadFrame();
    saveTabs(this.tabs);
  }

  private openTab(url: string | null): void {
    this.tabs.push({ ...newTab(), id: this.nextTabId++ + Date.now(), url });
    this.activeTab = this.tabs.length - 1;
    this.renderBrowserChrome();
    this.loadFrame();
    if (!url) setTimeout(() => this.content.querySelector<HTMLInputElement>(".br-url input")?.focus(), 0);
  }

  private closeTab(id: number): void {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    this.frames.get(id)?.remove();
    this.frames.delete(id);
    this.tabs.splice(i, 1);
    if (!this.tabs.length) this.tabs.push(newTab());
    if (this.activeTab >= i) this.activeTab = Math.max(0, this.activeTab - 1);
    this.renderBrowserChrome();
    this.loadFrame();
  }

  private switchTab(id: number): void {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0 || i === this.activeTab) return;
    this.activeTab = i;
    this.renderBrowserChrome();
    this.loadFrame();
  }

  private navigate(raw: string, record = true): void {
    let u = raw.trim();
    if (!u) return;
    if (/^\d+$/.test(u)) u = `localhost:${u}`;
    if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
    try {
      u = new URL(u).toString();
    } catch {
      return;
    }
    const t = this.tab;
    if (record && t.url && t.url !== u) {
      t.back.push(t.url);
      t.fwd = [];
    }
    t.url = u;
    const f = this.frames.get(t.id);
    if (f) f.src = u;
    this.loadFrame();
    this.renderBrowserChrome();
  }

  /** Show the active tab: its page (each tab keeps its own, so switching doesn't reload), or a blank tab's start page. */
  private loadFrame(): void {
    const view = this.content.querySelector<HTMLElement>(".br-view");
    if (!view) return;
    const t = this.tab;
    view.querySelector(".lt-empty")?.remove();
    for (const [id, f] of this.frames) f.style.display = id === t.id ? "" : "none";
    if (!t.url) {
      const urls = this.devUrls();
      view.insertAdjacentHTML(
        "beforeend",
        `<div class="lt-empty"><div class="big">🌐</div><h3>${urls.length ? "Open something" : "Nothing running yet"}</h3>
        ${urls.length ? `<div class="br-start">${urls.map((u) => `<button class="chip" data-url="${esc(u)}">${u === loopState.config?.preview ? "⭐ " : "🟢 "}${esc(u.replace(/^https?:\/\//, ""))}</button>`).join("")}</div>` : ""}
        <p>Type an address above, or start your app's dev server (for example <code>npm run dev</code>) or ask a worker to.<br/>
        <button class="chip scan">🔎 Scan for dev servers</button> · set <code>"preview"</code> in <code>domain.config.json</code> to open it here every time.</p></div>`,
      );
      return;
    }
    if (!this.frames.has(t.id)) {
      const f = document.createElement("iframe");
      f.src = t.url;
      f.allow = "clipboard-read; clipboard-write; fullscreen";
      f.referrerPolicy = "no-referrer";
      view.appendChild(f);
      this.frames.set(t.id, f);
    }
  }

  // --- workers' terminals -------------------------------------------------------------

  private showWorkers(): void {
    this.content.innerHTML = `<aside class="wk-list"></aside><section class="wk-term"><div class="wk-head"></div></section>`;
    this.content.querySelector(".wk-term")!.appendChild(this.termHost);
    this.content.querySelector(".wk-list")!.addEventListener("click", (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>("[data-desk]");
      if (li) this.watch(li.dataset.desk!);
    });
    this.ensureTerm();
    const staffed = this.office.desks.filter((d) => d.worker);
    const pick = staffed.find((d) => d.id === this.watching) ?? staffed[0];
    this.watching = null;
    this.renderWorkerList();
    if (pick) this.watch(pick.id);
    else this.term!.reset();
  }

  private renderWorkerList(): void {
    const list = this.content.querySelector<HTMLElement>(".wk-list");
    if (!list) return;
    const staffed = this.office.desks.filter((d) => d.worker);
    const key = JSON.stringify([this.watching, staffed.map((d) => [d.id, d.worker!.status, d.worker!.activity])]);
    if (key === this.renderKey) return;
    this.renderKey = key;
    list.innerHTML = staffed.length
      ? staffed
          .map((d) => {
            const w = d.worker!;
            return `<button class="wk ${d.id === this.watching ? "on" : ""}" data-desk="${d.id}">
              <span class="dot" style="background:${AGENT_COLOR[w.agent]}"></span>
              <span class="wk-main"><b>${esc(workerName(w))}</b><small>${esc(d.label)} · ${esc(w.activity)}</small></span>
              <i style="background:${STATUS_BULB[w.status]}"></i></button>`;
          })
          .join("")
      : `<p class="lt-note">No workers yet. Hire one at a desk with a <b>+</b>.</p>`;
    const head = this.content.querySelector<HTMLElement>(".wk-head");
    const d = staffed.find((x) => x.id === this.watching);
    if (head) head.innerHTML = d ? `<b>${esc(workerName(d.worker!))}</b> · ${esc(d.label)} · hired by ${esc(d.worker!.hiredBy)} <span class="grow"></span><span class="lt-note">Type to talk to it · select to copy · Ctrl+[ sends Esc</span><button class="btn small wk-copy">📋 Copy all</button>` : "";
    head?.querySelector(".wk-copy")?.addEventListener("click", () => this.term && copyAll(this.term));
  }

  private watch(deskId: string): void {
    this.ensureTerm();
    this.watching = deskId;
    this.waitingScrollback = true;
    this.term!.reset();
    this.renderKey = "";
    this.renderWorkerList();
    this.actions.send({ t: "open", deskId });
    requestAnimationFrame(() => {
      this.refit();
      this.term?.focus();
    });
  }

  private ensureTerm(): void {
    if (this.term) return;
    const term = new Terminal({ cursorBlink: true, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 13, theme: TERM_THEME });
    copyOnSelect(term);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(this.termHost);
    term.onData((data) => {
      if (this.watching) this.actions.send({ t: "input", deskId: this.watching, data });
    });
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.key === "Escape") {
        this.close();
        return false;
      }
      return true;
    });
    this.term = term;
    this.fit = fit;
  }

  private refit(): void {
    if (!this.modal) return;
    try {
      if (this.app === "workers" && this.term && this.fit && this.termHost.isConnected) {
        this.fit.fit();
        if (this.watching) this.actions.send({ t: "resize", deskId: this.watching, cols: this.term.cols, rows: this.term.rows });
      }
      if (this.app === "deploy" && this.dfit && this.dHost.isConnected) this.dfit.fit();
    } catch {
      /* no size yet */
    }
  }

  // --- the loop ------------------------------------------------------------------------

  private handlers(): LoopHandlers {
    return { ...this.actions, openLaptop: (app) => this.open(app) };
  }

  private renderLoopApp(): void {
    const goals = this.progress.goals;
    const live = goals.filter((g) => !g.shippedAt);
    const sessionGoal = this.progress.session?.goalId;
    if (!this.loopGoal || !goals.some((g) => g.id === this.loopGoal)) this.loopGoal = sessionGoal ?? live[0]?.id ?? goals[0]?.id ?? null;
    const goal = goals.find((g) => g.id === this.loopGoal) ?? null;
    const key = JSON.stringify([this.loopGoal, goals, this.office.desks.map((d) => [d.id, d.worker?.status]), this.office.presentations.map((p) => [p.deskId, !!p.report]), loopState.config?.deploy]);
    if (key === this.renderKey) return;
    this.renderKey = key;
    if (!goal) {
      this.content.innerHTML = `<div class="lt-empty"><div class="big">🎯</div><h3>No goals yet</h3><p>Hold a stand-up or press <span class="key">G</span> to set one — then the loop takes it from plan to shipped.</p></div>`;
      return;
    }
    this.content.innerHTML = `
      <aside class="lp-goals">${goals
        .map((g) => {
          const st = goalStage(g);
          const p = goalProgress(g);
          return `<button class="lp-goal ${g.id === goal.id ? "on" : ""}" data-goal="${g.id}"><b>${g.kind === "research" ? "📊" : "🛠"} ${esc(g.title)}</b><small>${STAGE_ICON[st]} ${stageLabel(st, g.kind)} · ${p.done}/${p.total}</small></button>`;
        })
        .join("")}</aside>
      <section class="lp-main">
        <h3>${esc(goal.title)}</h3>${goal.why ? `<p class="lt-note">${esc(goal.why)}</p>` : ""}
        <div class="lp-loop"></div>
        <ul class="lp-tasks">${goal.tasks
          .map((t) => {
            const d = t.deskId ? this.office.desks.find((x) => x.id === t.deskId) : null;
            const icon = { todo: "⬜", doing: "⌨️", review: "🎤", done: "✅" }[t.status];
            return `<li class="${t.status}">${icon} <span>${esc(t.title)}</span>${d?.worker ? `<small>${esc(workerName(d.worker))}</small>` : ""}</li>`;
          })
          .join("")}</ul>
      </section>`;
    renderLoop(this.content.querySelector(".lp-loop")!, goal, this.office.desks, goals, this.office.presentations, this.handlers());
    this.content.querySelector(".lp-goals")!.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-goal]");
      if (!b) return;
      this.loopGoal = b.dataset.goal!;
      this.renderKey = "";
      this.renderLoopApp();
    });
  }

  // --- decks ---------------------------------------------------------------------------------

  private renderDecks(): void {
    const research = this.progress.goals.filter((g) => g.kind === "research");
    const key = JSON.stringify(research.map((g) => [g.id, g.title, g.deck?.updatedAt, g.shippedAt]));
    if (key === this.renderKey) return;
    this.renderKey = key;
    if (!research.length) {
      this.content.innerHTML = `<div class="lt-empty"><div class="big">📊</div><h3>No research goals</h3><p>Set a goal of kind <b>Research</b> — its workers write their findings as a slide deck, which you present and download as PowerPoint.</p></div>`;
      return;
    }
    this.content.innerHTML = `<div class="dk-grid">${research
      .map(
        (g) => `<button class="dk-card" data-goal="${g.id}"><canvas width="640" height="360"></canvas>
        <b>${esc(g.title)}</b><small>${g.deck ? `${g.deck.slides.length} slides` : "No slides yet"} · ${g.shippedAt ? "📊 delivered" : stageLabel(goalStage(g), "research")}</small></button>`,
      )
      .join("")}</div>`;
    this.content.querySelectorAll<HTMLElement>(".dk-card").forEach((card) => {
      const g = research.find((x) => x.id === card.dataset.goal)!;
      const c = card.querySelector("canvas")!;
      const paint = () => paintDeckSlide(c, g.deck?.slides[0] ?? null, 0, g.deck?.slides.length ?? 0, { onImage: paint });
      paint();
      card.addEventListener("click", () => openDeck(g));
    });
  }

  // --- deploy ------------------------------------------------------------------------------------

  private deployGoal(): Goal | null {
    const id = loopState.deploy.goalId;
    return (id && this.progress.goals.find((g) => g.id === id)) || this.progress.goals.find((g) => g.ship && g.ship.mode === "deploy") || null;
  }

  private showDeploy(): void {
    if (!this.content || this.app !== "deploy") return;
    this.content.innerHTML = `<div class="dp-head"></div>`;
    this.content.appendChild(this.dHost);
    if (!this.dterm) {
      const t = new Terminal({ disableStdin: true, convertEol: false, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 13, theme: TERM_THEME });
      copyOnSelect(t);
      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(this.dHost);
      this.dterm = t;
      this.dfit = fit;
    }
    this.dterm.reset();
    this.dShownGoal = loopState.deploy.goalId;
    if (loopState.deploy.log) this.dterm.write(loopState.deploy.log);
    else this.dterm.write("\x1b[2mNo deploys yet. When every task of a goal is approved, 🚀 Ship it runs your deploy command here.\x1b[0m\r\n");
    this.renderKey = "";
    this.renderDeployHead();
    requestAnimationFrame(() => this.refit());
  }

  private renderDeployHead(): void {
    const head = this.content?.querySelector<HTMLElement>(".dp-head");
    if (!head) return;
    const g = this.deployGoal();
    const cfg = loopState.config;
    const s = g?.ship ?? null;
    const status = !s
      ? `<span class="pill">idle</span>`
      : s.status === "running"
        ? `<span class="pill run">running</span>`
        : s.status === "failed"
          ? `<span class="pill bad">failed · exit ${s.exitCode ?? "?"}</span>`
          : `<span class="pill ok">shipped</span>`;
    const key = JSON.stringify([g?.id, s, cfg?.deploy, this.office.desks.map((d) => d.worker?.status)]);
    if (key === this.renderKey) return;
    this.renderKey = key;
    head.innerHTML = `<div><b>${g ? esc(g.title) : "Deploys"}</b> ${status}<br/><small class="lt-note">${
      cfg?.deploy ? `Runs <code>${esc(cfg.deploy)}</code> in ${esc(cfg.project)}` : `No deploy command — add <code>"deploy"</code> to <code>domain.config.json</code>, or let a worker ship a PR`
    }</small></div><div class="dp-loop"></div>`;
    if (g && goalStage(g) === "ship") {
      renderLoop(head.querySelector(".dp-loop")!, g, this.office.desks, this.progress.goals, this.office.presentations, this.handlers());
      head.querySelector(".dp-loop .loop-track")?.remove();
      head.querySelector(".dp-loop .loop-status")?.remove();
    }
  }
}

/** domain's own page (its dev server or its own port) isn't the app being built. */
function isSelf(u: string): boolean {
  try {
    const url = new URL(u);
    return url.port === location.port && ["localhost", "127.0.0.1", location.hostname].includes(url.hostname);
  } catch {
    return false;
  }
}

// --- browser tabs, remembered in this browser ------------------------------------------------

interface BrowserTab {
  id: number;
  url: string | null;
  back: string[];
  fwd: string[];
}

const TABS_KEY = "domain.laptopTabs";
let tabSeq = 1;
function newTab(): BrowserTab {
  return { id: tabSeq++, url: null, back: [], fwd: [] };
}

function loadTabs(): BrowserTab[] {
  try {
    const raw = JSON.parse(localStorage.getItem(TABS_KEY) ?? "[]") as unknown;
    const urls = Array.isArray(raw) ? raw.filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u)).slice(0, 12) : [];
    if (urls.length) return urls.map((url) => ({ ...newTab(), url }));
  } catch {
    /* none saved */
  }
  return [newTab()];
}

function saveTabs(tabs: BrowserTab[]): void {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(tabs.map((t) => t.url).filter(Boolean)));
  } catch {
    /* fine */
  }
}

