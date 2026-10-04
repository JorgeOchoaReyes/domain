import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { OfficeState, ServerMessage } from "../../shared/protocol.js";
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

export type LaptopApp = "browser" | "workers" | "loop" | "decks" | "deploy";

const APPS: { id: LaptopApp; icon: string; label: string }[] = [
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
  private app: LaptopApp = "browser";
  private office: OfficeState = { desks: [], peers: [], presentations: [] };
  private progress: ProgressState = EMPTY_PROGRESS;
  private root!: HTMLElement;
  private content!: HTMLElement;
  private clockTimer: number | null = null;
  private loopGoal: string | null = null;
  private renderKey = "";

  // Browser
  private url: string | null = null;
  private back: string[] = [];
  private fwd: string[] = [];

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
    if (app === "browser") this.showBrowser();
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
    else if (this.app === "deploy") this.renderDeployHead();
  }

  // --- browser ----------------------------------------------------------------------

  private showBrowser(): void {
    this.content.innerHTML = `
      <div class="br-bar">
        <button class="br-btn back" title="Back">←</button>
        <button class="br-btn fwd" title="Forward">→</button>
        <button class="br-btn reload" title="Reload">↻</button>
        <form class="br-url"><input type="text" spellcheck="false" placeholder="localhost:3000" /></form>
        <button class="br-btn ext" title="Open in your browser">↗</button>
      </div>
      <div class="br-chips"></div>
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
      const u = this.back.pop();
      if (!u) return;
      if (this.url) this.fwd.push(this.url);
      this.navigate(u, false);
    });
    this.content.querySelector(".fwd")!.addEventListener("click", () => {
      const u = this.fwd.pop();
      if (!u) return;
      if (this.url) this.back.push(this.url);
      this.navigate(u, false);
    });
    this.content.querySelector(".reload")!.addEventListener("click", () => {
      const f = this.content.querySelector<HTMLIFrameElement>(".br-view iframe");
      if (f) f.src = f.src;
      else this.actions.send({ t: "probe" });
    });
    this.content.querySelector(".ext")!.addEventListener("click", () => {
      if (this.url) window.open(this.url, "_blank", "noopener");
    });
    this.content.querySelector(".br-chips")!.addEventListener("click", (e) => {
      const c = (e.target as HTMLElement).closest<HTMLElement>("[data-url]");
      if (c) this.navigate(c.dataset.url!);
      else if ((e.target as HTMLElement).closest(".scan")) this.actions.send({ t: "probe" });
    });
    if (!this.url) this.url = loopState.config?.preview ?? loopState.devServers.find((u) => !isSelf(u)) ?? null;
    this.renderBrowserChrome();
    this.loadFrame();
  }

  private renderBrowserChrome(): void {
    if (this.app !== "browser" || !this.content.querySelector(".br-chips")) return;
    const urls = [...new Set([loopState.config?.preview, ...loopState.devServers].filter((u): u is string => !!u && !isSelf(u)))];
    this.content.querySelector(".br-chips")!.innerHTML =
      urls.map((u) => `<button class="chip ${u === this.url ? "on" : ""}" data-url="${esc(u)}">${u === loopState.config?.preview ? "⭐ " : "🟢 "}${esc(u.replace(/^https?:\/\//, ""))}</button>`).join("") +
      `<button class="chip scan" title="Look for dev servers again">🔎 Scan</button>`;
    const input = this.content.querySelector<HTMLInputElement>(".br-url input")!;
    if (document.activeElement !== input) input.value = this.url ?? "";
    this.content.querySelector<HTMLButtonElement>(".back")!.disabled = !this.back.length;
    this.content.querySelector<HTMLButtonElement>(".fwd")!.disabled = !this.fwd.length;
    // A dev server turned up while the browser was empty: open it.
    if (!this.url && urls[0]) {
      this.url = urls[0];
      this.loadFrame();
    }
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
    if (record && this.url && this.url !== u) {
      this.back.push(this.url);
      this.fwd = [];
    }
    this.url = u;
    this.loadFrame();
    this.renderBrowserChrome();
  }

  private loadFrame(): void {
    const view = this.content.querySelector<HTMLElement>(".br-view");
    if (!view) return;
    if (!this.url) {
      view.innerHTML = `<div class="lt-empty"><div class="big">🌐</div><h3>Nothing running yet</h3>
        <p>Start your app's dev server (for example <code>npm run dev</code>) or ask a worker to, then hit <b>🔎 Scan</b>.<br/>
        Set <code>"preview"</code> in <code>domain.config.json</code> to open it here every time.</p></div>`;
      return;
    }
    view.innerHTML = "";
    const f = document.createElement("iframe");
    f.src = this.url;
    f.allow = "clipboard-read; clipboard-write; fullscreen";
    f.referrerPolicy = "no-referrer";
    view.appendChild(f);
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
    if (head) head.innerHTML = d ? `<b>${esc(workerName(d.worker!))}</b> · ${esc(d.label)} · hired by ${esc(d.worker!.hiredBy)} <span class="grow"></span><span class="lt-note">Type to talk to it · Ctrl+[ sends Esc</span>` : "";
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
