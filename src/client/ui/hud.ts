import { doingLabel } from "../../shared/protocol.js";
import type { Desk, Peer, Presentation, WorkerStatus } from "../../shared/protocol.js";
import { SHIRT_COLORS } from "../../shared/protocol.js";
import { AGENT_COLOR, STATUS_BULB } from "../scene/characters.js";
import { esc, openModal } from "./modal.js";
import { workerName } from "./team.js";
import type { ProgressState } from "../../shared/progress.js";
import { modelLabel } from "../../shared/policy.js";

function ago(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * The 2D chrome over the office: the floor's name and the dock across the
 * top, the Workers and People panels down the right, the hint bar, toasts,
 * and the hire and round-up windows. It raises callbacks and holds no game
 * state of its own.
 */

const STATUS_LABEL: Record<WorkerStatus, string> = {
  booting: "starting",
  idle: "ready",
  working: "working",
  waiting: "needs you",
  presenting: "in line",
  done: "done",
  asleep: "asleep",
};

export interface HudHandlers {
  onOpenWorker(deskId: string): void;
  onRoundup(): void;
  onOfficeHours(): void;
  onGoals(): void;
  onFocus(): void;
  onProfile(): void;
  onStandup(): void;
  onTravel(): void;
  onLaptop(): void;
  onMonitor(): void;
  onSettings(): void;
}

export class Hud {
  private root: HTMLElement;
  private metaEl!: HTMLElement;
  private connEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private workersEl!: HTMLElement;
  private workersCount!: HTMLElement;
  private peopleEl!: HTMLElement;
  private peopleCount!: HTMLElement;
  private sideEl!: HTMLElement;
  private hoursBtn!: HTMLButtonElement;
  private toastsEl!: HTMLElement;
  private alertEl!: HTMLElement;
  private hintHtml = "";
  private bannerEl!: HTMLElement;
  private everConnected = false;
  private feedEl!: HTMLElement;
  private focusBtn!: HTMLButtonElement;
  private goalsCount!: HTMLElement;
  /** Where the player card sits, beside the floor's name. */
  leftEl!: HTMLElement;

  constructor(root: HTMLElement, private handlers: HudHandlers) {
    this.root = root;
    this.build();
  }

  private build(): void {
    const top = document.createElement("div");
    top.className = "topbar";
    top.innerHTML = `
      <div class="tb-left">
        <div class="panel project">
          <div class="project-name">🏢 <span>domain</span><span class="conn-dot" title="connecting…"></span></div>
          <div class="project-meta">connecting…</div>
        </div>
      </div>
      <div class="dock">
        <button class="btn dock-btn moved" data-act="standup" title="Stand-up: set the goal and tone (U)">☀️ <span class="lbl">Stand-up</span></button>
        <button class="btn dock-btn" data-act="goals" title="Goals (G)">🎯 <span class="lbl">Goals</span> <span class="svc-count goals-n hidden">0</span></button>
        <button class="btn dock-btn sec moved" data-act="focus" title="Focus session (F)">⏱ <span class="lbl">Focus</span></button>
        <button class="btn dock-btn sec moved" data-act="roundup" title="Call workers to your office (R)">📣 <span class="lbl">Round up</span></button>
        <button class="btn dock-btn sec moved" data-act="hours" title="Hold office hours (O)">🎤 <span class="lbl">Office hours</span> <span class="svc-count hidden">0</span></button>
        <button class="btn dock-btn" data-act="laptop" title="Your laptop: browser, workers, loop, decks (L)">💻 <span class="lbl">Laptop</span></button>
        <button class="btn dock-btn" data-act="monitor" title="Agent monitor: every agent's live CLI at once — watch and answer them (K)">📺 <span class="lbl">Monitor</span></button>
        <button class="btn dock-btn sec moved" data-act="travel" title="Fast travel (T)">🌀 <span class="lbl">Travel</span></button>
        <button class="btn dock-btn dock-icon" data-act="settings" title="Settings: speed, mouse, view (Esc)" aria-label="Settings">⚙️</button>
        <button class="btn dock-btn dock-icon dock-help" data-act="help" title="Controls (H)" aria-label="Controls">?</button>
      </div>`;
    this.root.appendChild(top);
    this.metaEl = top.querySelector(".project-meta")!;
    this.connEl = top.querySelector(".conn-dot")!;
    this.hoursBtn = top.querySelector('[data-act="hours"]')!;
    top.querySelector('[data-act="roundup"]')!.addEventListener("click", () => this.handlers.onRoundup());
    this.hoursBtn.addEventListener("click", () => this.handlers.onOfficeHours());
    top.querySelector('[data-act="help"]')!.addEventListener("click", () => this.openHelp());
    top.querySelector('[data-act="goals"]')!.addEventListener("click", () => this.handlers.onGoals());
    this.focusBtn = top.querySelector('[data-act="focus"]')!;
    this.focusBtn.addEventListener("click", () => this.handlers.onFocus());
    top.querySelector('[data-act="standup"]')!.addEventListener("click", () => this.handlers.onStandup());
    top.querySelector('[data-act="travel"]')!.addEventListener("click", () => this.handlers.onTravel());
    top.querySelector('[data-act="laptop"]')!.addEventListener("click", () => this.handlers.onLaptop());
    top.querySelector('[data-act="monitor"]')!.addEventListener("click", () => this.handlers.onMonitor());
    top.querySelector('[data-act="settings"]')!.addEventListener("click", () => this.handlers.onSettings());
    this.goalsCount = top.querySelector(".goals-n")!;
    this.leftEl = top.querySelector(".tb-left")!;

    this.bannerEl = document.createElement("div");
    this.bannerEl.className = "conn-banner hidden";
    this.bannerEl.textContent = "Reconnecting to the office…";
    this.root.appendChild(this.bannerEl);

    this.sideEl = document.createElement("div");
    this.sideEl.className = "side";
    this.sideEl.innerHTML = `
      <section class="panel workers"><h3>🤖 Workers <span class="count">0</span></h3><ul></ul></section>
      <section class="panel feed"><h3>📣 Activity</h3><ul></ul></section>
      <section class="panel people"><h3>👥 People <span class="count">0</span></h3><ul></ul></section>`;
    this.feedEl = this.sideEl.querySelector(".feed ul")!;
    this.root.appendChild(this.sideEl);
    this.workersEl = this.sideEl.querySelector(".workers ul")!;
    this.workersCount = this.sideEl.querySelector(".workers .count")!;
    this.peopleEl = this.sideEl.querySelector(".people ul")!;
    this.peopleCount = this.sideEl.querySelector(".people .count")!;
    this.workersEl.addEventListener("click", (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-desk]");
      if (li) this.handlers.onOpenWorker(li.dataset.desk!);
    });

    this.hintEl = document.createElement("div");
    this.hintEl.className = "hint hidden";
    this.root.appendChild(this.hintEl);

    this.alertEl = document.createElement("button");
    this.alertEl.className = "line-alert hidden";
    this.alertEl.addEventListener("click", () => this.handlers.onOfficeHours());
    this.root.appendChild(this.alertEl);

    this.toastsEl = document.createElement("div");
    this.toastsEl.id = "toasts";
    this.root.appendChild(this.toastsEl);

    const help = document.createElement("div");
    help.className = "panel keys";
    help.innerHTML = `<span class="key">WASD</span>walk <span class="key">⇧</span>run <span class="key">␣</span>jump <span class="key">E</span>use <span class="key">T</span>travel <span class="key">V</span>view <span class="key">G</span>goals <span class="key">H</span>help`;
    this.root.appendChild(help);
  }

  /** The game side of the HUD: the activity feed and the dock counts. */
  updateGame(progress: ProgressState): void {
    const open = progress.goals.filter((g) => !g.doneAt).length;
    this.goalsCount.textContent = String(open);
    this.goalsCount.classList.toggle("hidden", open === 0);
    this.focusBtn.classList.toggle("on", progress.session !== null);

    this.feedEl.innerHTML = progress.feed.length
      ? progress.feed
          .slice(0, 6)
          .map((f) => `<li><span class="name"><b>${esc(f.who)}</b> ${esc(f.text)}<span class="sub">${ago(f.at)}</span></span>${f.xp ? `<span class="xp-chip">+${f.xp}</span>` : ""}</li>`)
          .join("")
      : `<li class="empty">Progress shows up here as it happens.</li>`;
  }

  togglePanel(): void {
    this.sideEl.classList.toggle("hud-off");
  }

  setConnected(connected: boolean): void {
    if (connected) this.everConnected = true;
    // Only shout about it once we had a connection to lose.
    this.bannerEl.classList.toggle("hidden", connected || !this.everConnected);
    this.connEl.classList.toggle("ok", connected);
    this.connEl.title = connected ? "connected" : "reconnecting…";
    if (!connected) this.metaEl.textContent = "reconnecting…";
  }

  /** Refresh everything that depends on the office snapshot. */
  update(desks: Desk[], line: Presentation[], peers: Peer[], selfId: string): void {
    const staffed = desks.filter((d) => d.worker);
    const waiting = staffed.filter((d) => d.worker!.status === "waiting").length;
    const ready = line.filter((p) => p.report).length;
    this.metaEl.textContent =
      `${staffed.length} worker${staffed.length === 1 ? "" : "s"} · ${peers.length} here` +
      (line.length ? ` · ${line.length} in line` : "") +
      (waiting ? ` · ${waiting} need${waiting === 1 ? "s" : ""} you` : "");

    const count = this.hoursBtn.querySelector(".svc-count")!;
    count.textContent = String(line.length);
    count.classList.toggle("hidden", line.length === 0);

    this.workersCount.textContent = String(staffed.length);
    const inLine = new Map(line.map((p, i) => [p.deskId, i + 1]));
    this.workersEl.innerHTML = staffed.length
      ? staffed
          .map((d) => {
            const w = d.worker!;
            const place = inLine.get(d.id);
            const pillText = place ? `#${place} in line` : w.status === "working" && w.doing ? doingLabel(w.doing) : STATUS_LABEL[w.status];
            return `<li data-desk="${d.id}" class="${w.status === "waiting" ? "needs-you-row" : ""}" title="Open terminal">
              <span class="dot" style="background:${AGENT_COLOR[w.agent]}"></span>
              <span class="name">${esc(workerName(w))} <span class="sub">${esc(d.label)} · ${esc(modelLabel(w.model))} · ${esc(w.activity)}${w.mcp?.length ? ` · 🧰 ${esc(w.mcp.join(", "))}` : ""}${w.internOf ? ` · 🎓 intern of ${esc(w.internOf.replace("desk-", "desk "))}` : ""}</span></span>
              <span class="pill" style="background:${STATUS_BULB[w.status]}">${esc(pillText)}</span>
            </li>`;
          })
          .join("")
      : `<li class="empty">Walk to a desk with a <b>+</b> and press <span class="key">E</span> to hire one.</li>`;

    this.peopleCount.textContent = String(peers.length);
    this.sideEl.querySelector(".people")!.classList.toggle("hidden", peers.length < 2);
    this.peopleEl.innerHTML = peers
      .map(
        (p) =>
          `<li><span class="dot" style="background:${SHIRT_COLORS[p.look.shirt]}"></span><span class="name">${esc(p.name)}${p.id === selfId ? ' <span class="you">(you)</span>' : ""}</span></li>`,
      )
      .join("");

    if (ready > 0) {
      this.alertEl.innerHTML = `🔔 <b>${ready}</b> ready to present outside your office · <span class="key">O</span> start the review`;
      this.alertEl.classList.remove("hidden");
    } else if (line.length > 0) {
      this.alertEl.innerHTML = `📝 ${line.length} preparing their reports…`;
      this.alertEl.classList.remove("hidden");
    } else {
      this.alertEl.classList.add("hidden");
    }
  }

  /** The dark hint bar at the bottom: what E (or another key) does here. */
  setHint(html: string | null): void {
    if ((html ?? "") === this.hintHtml) return;
    this.hintHtml = html ?? "";
    this.hintEl.innerHTML = this.hintHtml;
    this.hintEl.classList.toggle("hidden", !html);
  }

  /** A toast with markup (achievements, XP). `html` must already be escaped. */
  /** Hears every toast as plain text (e.g. to float it in front of you in VR). */
  onToast: ((text: string) => void) | null = null;

  toastHtml(html: string, kind: string, ms = 4200): void {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.innerHTML = html;
    this.onToast?.(el.textContent ?? "");
    this.toastsEl.prepend(el);
    setTimeout(() => el.remove(), ms);
  }

  toast(text: string, kind: "" | "warn" | "error" = ""): void {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.textContent = text;
    this.onToast?.(text);
    this.toastsEl.prepend(el);
    setTimeout(() => el.remove(), 3800);
  }

  // --- windows ---------------------------------------------------------------

  openHelp(): void {
    const rows: [string, string][] = [
      ["W A S D", "Walk (relative to where you look) · Shift to run · Space to jump"],
      ["Drag · Scroll", "Look around · zoom (scroll all the way in for first person)"],
      ["V", "Switch between first and third person"],
      ["B", "Skateboard: hop on or off — twice as fast, and you glide"],
      ["Q", "Put your coffee down (and its speed boost with it)"],
      ["C", "Team chat: message a worker or everyone; see what each is doing now and what it has done; type into its terminal"],
      ["T", "Fast travel: work floor, your office, stand-up, kitchen, game room, outside — or straight to a worker who needs you"],
      ["U", "Stand-up: say your day out loud (🎤) and it becomes the plan — summary, end-of-day goals, tasks handed out — or Resume yesterday in one click"],
      ["L", "Your laptop: a browser for what's being built, workers' screens, the loop, decks and deploys — near a couch or table you sit down and it stays there"],
      ["K", "Agent monitor: every agent's live CLI at once, whoever needs you first — answer with a message, a task or a key (1, 2, 3, Enter, Esc) without leaving your seat · also the monitor wall in your office, the laptop's 📺 Monitor and the phone"],
      ["N", "The next thing that needs you: an agent's question, then finished work to review — opened big in the Agent monitor, ready to answer, approve or send back"],
      ["P", "Your phone: alerts, chat, goals and deadlines, reviews, workers, history, music and travel — keep walking with it out"],
      ["M", "Show or hide the minimap"],
      ["E", "At a desk: hire a worker, or open its terminal · At your desk: start office hours · At the monitor wall in your office: the Agent monitor · At a whiteboard: the idea board · At a jukebox: pick the music · Coffee, arcades, hoops, the ball: have fun"],
      ["G", "Goals: set one, break it into tasks, assign them to workers"],
      ["F", "Focus session: a timed sprint — finish it for XP and to keep your streak"],
      ["R", "Round up workers: they prepare a progress report and line up outside your office"],
      ["O", "Office hours: the next worker in line presents"],
      ["← →", "Flip slides during a presentation"],
      ["Click", "Capture the mouse to play: it hides and steers the view · click again to use things"],
      ["Tab · Ctrl", "Free the mouse to use the menus · Tab with the mouse free shows or hides the Workers panel"],
      ["Esc", "Close any window · with nothing open: settings (speed, mouse, field of view) · Ctrl+[ sends Esc to a terminal"],
      ["H", "These controls"],
    ];
    openModal({
      title: "Controls",
      icon: "⌨️",
      body: `<div class="help-grid">${rows.map(([k, v]) => `<span>${k.split(" ").map((x) => `<span class="key">${esc(x)}</span>`).join("")}</span><span>${esc(v)}</span>`).join("")}</div>
        <p class="setting-note"><b>How you level up:</b> set goals, put workers on their tasks, and approve their work in reviews — each approved task checks itself off. Finish focus sessions every day to keep your 🔥 streak.</p>
        <p class="setting-note"><b>VR:</b> with a headset, 🥽 VR in the dock puts you in the office. Left stick walks, right turns, the trigger presses what the laser points at (or draws on an idea board), A uses, B opens the menu, and holding a grip talks.</p>
        <p class="setting-note">In a review, talk to the worker with 🎤 (or type): your words go straight into its terminal and it answers out loud. Draw on the review board and it travels with your feedback.</p>`,
    });
  }

  /** Pick who to call to your office: everyone, or the ones you tick. */
  openRoundup(desks: Desk[], line: Presentation[], onCall: (deskIds: string[]) => void, onClose: () => void): void {
    const inLine = new Set(line.map((p) => p.deskId));
    const staffed = desks.filter((d) => d.worker);
    const body = document.createElement("div");
    if (!staffed.length) {
      body.innerHTML = `<p class="empty">Nobody to round up yet: hire a worker at a desk first.</p>`;
      openModal({ title: "Round up for review", icon: "📣", body, onClose });
      return;
    }
    body.innerHTML = `
      <p class="setting-note" style="margin-top:0">Each worker stops to put together a progress report — a short slide deck — and lines up outside your office to present it.</p>
      <label class="check all"><input type="checkbox" checked /> <b>Everyone</b></label>
      <ul class="svc-list pick">
        ${staffed
          .map((d) => {
            const w = d.worker!;
            const already = inLine.has(d.id);
            return `<li><label class="check">
              <input type="checkbox" data-desk="${d.id}" ${already ? "disabled" : "checked"} />
              <span class="dot" style="background:${AGENT_COLOR[w.agent]}"></span>
              <div class="svc-main"><div class="svc-title">${esc(workerName(w))} · ${esc(w.hiredBy)}</div>
              <div class="svc-meta">${esc(d.label)} · ${already ? "already in line" : esc(w.activity)}</div></div>
            </label></li>`;
          })
          .join("")}
      </ul>`;
    const footer = document.createElement("div");
    footer.style.display = "contents";
    footer.innerHTML = `<span class="grow">They line up outside ⭐ Your office</span><button class="btn primary call">📣 Call to my office</button>`;
    let called = false;
    const modal = openModal({
      title: "Round up for review",
      icon: "📣",
      body,
      footer,
      onClose: () => {
        if (!called) onClose();
      },
    });
    const boxes = [...body.querySelectorAll<HTMLInputElement>("input[data-desk]:not(:disabled)")];
    const all = body.querySelector<HTMLInputElement>(".all input")!;
    all.addEventListener("change", () => boxes.forEach((b) => (b.checked = all.checked)));
    boxes.forEach((b) => b.addEventListener("change", () => (all.checked = boxes.every((x) => x.checked))));
    const call = footer.querySelector<HTMLButtonElement>(".call")!;
    call.addEventListener("click", () => {
      const ids = boxes.filter((b) => b.checked).map((b) => b.dataset.desk!);
      if (!ids.length) return;
      called = true;
      modal.close();
      onCall(ids);
    });
    if (!boxes.length) call.disabled = true;
    call.focus();
  }
}
