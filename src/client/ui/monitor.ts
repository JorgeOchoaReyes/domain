import { deckOf, parseSlide } from "../../shared/slides.js";
import type { ClientMessage, Desk, OfficeState, Report } from "../../shared/protocol.js";
import { AGENT_LABELS, doingLabel } from "../../shared/protocol.js";
import { TEAM_THREAD } from "../../shared/chat.js";
import type { ProgressState } from "../../shared/progress.js";
import { STATUS_BULB } from "../scene/characters.js";
import { currentTask, monitorOrder, WALL_STATUS } from "../scene/monitorwall.js";
import { esc, openModal, type Modal } from "./modal.js";
import { workerName } from "./team.js";
import { UPDATE_ASK } from "./chat.js";
import "../styles/monitor.css";

/**
 * The Agent monitor (K, the monitor wall in your office, the laptop's
 * Monitor app, the phone): every worker's live terminal at once, in a grid,
 * like watching a wall of CLIs. Each tile says who it is, what it's on and
 * how it's doing; you can answer it right there — a message, a task, or a
 * key for the prompt it's stuck on (1, 2, 3, Enter, Esc) — without walking
 * over or opening its terminal. Whoever needs you comes first. Work that's
 * ready to present can be reviewed right on its tile: its title, its check
 * and summary, and Approve or Send back (with what you typed) — no need to
 * hold office hours for it.
 *
 * The terminals are the ones the desks' laptops already keep (every worker's
 * output reaches every client), painted into each tile's canvas when they
 * change.
 */

export interface MonitorActions {
  office(): OfficeState;
  progress(): ProgressState;
  send(msg: ClientMessage): void;
  /** Draw a worker's terminal into a box on a canvas, and how many times it has changed. */
  paintTerminal(deskId: string, g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void;
  terminalVersion(deskId: string): number;
  /** Visitors watch; they don't type into workers. */
  canType(): boolean;
  openTerminal(deskId: string): void;
  goToDesk(deskId: string): void;
}

type Filter = "all" | "waiting" | "review" | "working" | "free";

/** `ready`: the desks whose work has reached your line (not still with an auditor). */
const FILTERS: { id: Filter; label: string; test: (d: Desk, ready: Set<string>) => boolean }[] = [
  { id: "all", label: "All", test: () => true },
  { id: "waiting", label: "🔴 Needs you", test: (d) => d.worker?.status === "waiting" },
  { id: "review", label: "🎤 To review", test: (d, ready) => ready.has(d.id) },
  { id: "working", label: "⚙️ Working", test: (d) => d.worker?.status === "working" || d.worker?.status === "booting" },
  { id: "free", label: "💤 Free", test: (d, ready) => ["idle", "done", "asleep"].includes(d.worker?.status ?? "") && !ready.has(d.id) },
];

/** The desks whose work is in your line, ready for you. */
function readyDesks(office: OfficeState): Set<string> {
  return new Set(office.presentations.filter((p) => p.report).map((p) => p.deskId));
}

/** Raw keys for whatever the CLI is asking: its numbered choices, Enter, and Esc to stop it. */
const KEYS: { label: string; data: string; title: string }[] = [
  { label: "1", data: "1", title: "Choose option 1" },
  { label: "2", data: "2", title: "Choose option 2" },
  { label: "3", data: "3", title: "Choose option 3" },
  { label: "⏎", data: "\r", title: "Press Enter" },
  { label: "Esc", data: "\x1b", title: "Press Esc (stops what it's doing)" },
];

interface Tile {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  /** What was last painted: the terminal's version and the canvas size. */
  painted: string;
  head: string;
}

export class MonitorView {
  private filter: Filter = "all";
  private focused: string | null = null;
  private tiles = new Map<string, Tile>();
  private grid: HTMLElement;
  private chips: HTMLElement;
  private timer: number;
  private resizer = new ResizeObserver(() => this.paintAll(true));
  private shellKey = "";

  constructor(
    private host: HTMLElement,
    private a: MonitorActions,
  ) {
    host.classList.add("mon");
    const typing = a.canType();
    host.innerHTML = `
      <div class="mon-top">
        <div class="mon-chips"></div>
        ${
          typing
            ? `<form class="mon-all">
          <input type="text" placeholder="To everyone — or a task for whoever's free…" maxlength="4000" />
          <button type="submit" class="btn small" title="Every worker hears it">💬 Everyone</button>
          <button type="button" class="btn small primary mon-all-task" title="Tracked as a task: the first free worker takes it">🎯 Task</button>
          <button type="button" class="btn small mon-all-update" title="Ask everyone where they're at">📍 Updates</button>
        </form>`
            : `<span class="mon-note">👀 You're visiting: watch only</span>`
        }
      </div>
      <div class="mon-grid"></div>`;
    this.grid = host.querySelector(".mon-grid")!;
    this.chips = host.querySelector(".mon-chips")!;
    this.chips.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-filter]");
      if (!b) return;
      this.filter = b.dataset.filter as Filter;
      this.focused = null;
      this.refresh();
    });
    const all = host.querySelector<HTMLFormElement>(".mon-all");
    if (all) {
      const input = all.querySelector("input")!;
      guardKeys(input);
      const text = () => input.value.trim();
      all.addEventListener("submit", (e) => {
        e.preventDefault();
        if (!text()) return input.focus();
        a.send({ t: "chatSend", to: TEAM_THREAD, text: text() });
        input.value = "";
      });
      all.querySelector(".mon-all-task")!.addEventListener("click", () => {
        if (!text()) return input.focus();
        a.send({ t: "quickTask", deskId: "any", text: text() });
        input.value = "";
      });
      all.querySelector(".mon-all-update")!.addEventListener("click", () => a.send({ t: "chatSend", to: TEAM_THREAD, text: UPDATE_ASK }));
    }
    this.refresh();
    // Terminals change all the time: repaint the tiles whose screen moved, a few times a second.
    this.timer = window.setInterval(() => this.paintAll(false), 300);
  }

  /** The office or the goals changed: tiles come and go, headers update (typing is never disturbed). */
  refresh(): void {
    const staffed = monitorOrder(this.a.office().desks);
    const ready = readyDesks(this.a.office());
    // Chips with counts.
    this.chips.innerHTML = FILTERS.map((f) => {
      const n = staffed.filter((d) => f.test(d, ready)).length;
      return `<button class="mon-chip ${f.id === this.filter ? "on" : ""} ${(f.id === "waiting" || f.id === "review") && n ? "hot" : ""}" data-filter="${f.id}">${f.label} <b>${n}</b></button>`;
    }).join("");
    const test = FILTERS.find((f) => f.id === this.filter)!.test;
    let shown = staffed.filter((d) => test(d, ready));
    if (this.focused) shown = shown.filter((d) => d.id === this.focused);
    if (this.focused && !shown.length) this.focused = null;

    // Tiles: make the new ones, drop the gone ones, keep the order.
    const ids = shown.map((d) => d.id);
    for (const [id, t] of this.tiles) {
      if (!ids.includes(id)) {
        this.resizer.unobserve(t.canvas);
        t.el.remove();
        this.tiles.delete(id);
      }
    }
    const key = `${this.focused}|${ids.join(",")}`;
    for (const d of shown) {
      let t = this.tiles.get(d.id);
      if (!t) {
        t = this.makeTile(d.id);
        this.tiles.set(d.id, t);
      }
      this.updateHead(t, d);
    }
    if (key !== this.shellKey) {
      this.shellKey = key;
      for (const id of ids) this.grid.appendChild(this.tiles.get(id)!.el);
      this.grid.dataset.n = String(Math.min(ids.length, 9));
      this.grid.classList.toggle("focused", !!this.focused);
    }
    let empty = this.grid.querySelector<HTMLElement>(".mon-empty");
    if (!ids.length) {
      if (!empty) {
        empty = document.createElement("p");
        empty.className = "mon-empty";
        this.grid.appendChild(empty);
      }
      empty.innerHTML = staffed.length ? "Nobody here right now." : "No agents yet. Hire one at a desk with a green <b>+</b> and its terminal shows up here.";
    } else empty?.remove();
    this.paintAll(false);
  }

  destroy(): void {
    clearInterval(this.timer);
    this.resizer.disconnect();
    this.tiles.clear();
    this.host.innerHTML = "";
    this.host.classList.remove("mon");
  }

  private makeTile(deskId: string): Tile {
    const el = document.createElement("div");
    el.className = "mon-tile";
    el.dataset.desk = deskId;
    const typing = this.a.canType();
    el.innerHTML = `
      <div class="mon-bar"><span class="mon-who"></span><span class="mon-st"></span>
        <button class="mon-ic mon-focus" title="Just this one, big">⤢</button>
        <button class="mon-ic mon-open" title="Open its terminal (to type into it directly)">🖥</button>
        <button class="mon-ic mon-go" title="Walk to its desk">🚶</button>
      </div>
      <div class="mon-now"></div>
      <div class="mon-review hidden"></div>
      <canvas class="mon-term" title="Click to open its terminal"></canvas>
      ${
        typing
          ? `<form class="mon-say">
        <span class="mon-keys">${KEYS.map((k, i) => `<button type="button" data-key="${i}" title="${k.title}">${k.label}</button>`).join("")}</span>
        <input type="text" maxlength="4000" />
        <button type="submit" class="btn small" title="Send (Enter)">💬</button>
        <button type="button" class="btn small primary mon-task" title="Give it as a tracked task">🎯</button>
      </form>`
          : ""
      }`;
    const canvas = el.querySelector<HTMLCanvasElement>("canvas")!;
    canvas.addEventListener("click", () => this.a.openTerminal(deskId));
    el.querySelector(".mon-review")!.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-review]");
      if (!b) return;
      const input = el.querySelector<HTMLInputElement>(".mon-say input");
      const text = input?.value.trim() ?? "";
      if (b.dataset.review === "approve") {
        this.a.send({ t: "review", deskId, approve: true, ...(text ? { text } : {}) });
      } else {
        // Sending back needs to say what to change (or, for a question, the answer).
        if (!text) {
          input?.focus();
          if (input) input.placeholder = "Type what to change (or your answer), then Send back";
          return;
        }
        this.a.send({ t: "review", deskId, approve: false, text });
      }
      if (input) input.value = "";
      b.closest(".mon-review")?.classList.add("sent");
    });
    el.querySelector(".mon-open")!.addEventListener("click", () => this.a.openTerminal(deskId));
    el.querySelector(".mon-go")!.addEventListener("click", () => this.a.goToDesk(deskId));
    el.querySelector(".mon-focus")!.addEventListener("click", () => {
      this.focused = this.focused === deskId ? null : deskId;
      this.refresh();
    });
    const form = el.querySelector<HTMLFormElement>(".mon-say");
    if (form) {
      const input = form.querySelector("input")!;
      guardKeys(input);
      const text = () => input.value.trim();
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        if (!text()) {
          // Nothing typed: Enter answers the prompt it's on.
          this.a.send({ t: "input", deskId, data: "\r" });
          return;
        }
        this.a.send({ t: "chatSend", to: deskId, text: text() });
        input.value = "";
      });
      form.querySelector(".mon-task")!.addEventListener("click", () => {
        if (!text()) return input.focus();
        this.a.send({ t: "quickTask", deskId, text: text() });
        input.value = "";
      });
      form.querySelector(".mon-keys")!.addEventListener("click", (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>("[data-key]");
        if (b) this.a.send({ t: "input", deskId, data: KEYS[Number(b.dataset.key)].data });
      });
    }
    this.resizer.observe(canvas);
    return { el, canvas, painted: "", head: "" };
  }

  private updateHead(t: Tile, d: Desk): void {
    const w = d.worker!;
    const task = currentTask(this.a.progress(), d.id);
    const doing = w.status === "working" && w.doing ? doingLabel(w.doing) : w.activity;
    // Only work that has reached your line can be reviewed here (a report still with its auditor isn't yours yet).
    const report = this.a.office().presentations.find((p) => p.deskId === d.id)?.report ?? null;
    const auditing = !report && !!w.report;
    const head = JSON.stringify([w.status, workerName(w), w.agent, w.model, d.label, task, doing, w.branch, report?.at, report?.check?.status, auditing]);
    if (head === t.head) return;
    t.head = head;
    t.el.classList.toggle("waiting", w.status === "waiting");
    t.el.style.setProperty("--st", STATUS_BULB[w.status]);
    t.el.querySelector(".mon-who")!.innerHTML = `<b>${esc(workerName(w))}</b> <small>${[w.identity ? AGENT_LABELS[w.agent] : "", w.model, d.label].filter(Boolean).map(esc).join(" · ")}</small>`;
    t.el.querySelector(".mon-st")!.textContent = WALL_STATUS[w.status] ?? w.status;
    t.el.querySelector(".mon-now")!.innerHTML = `${task ? `<span class="mon-task-t">🎯 ${esc(task)}</span>` : ""}<span>${esc(doing)}</span>${w.branch ? `<span class="mon-br">🌿 ${esc(w.branch)}</span>` : ""}`;
    const input = t.el.querySelector<HTMLInputElement>(".mon-say input");
    if (input) input.placeholder = report ? "A note with your review (needed to send it back)…" : w.status === "waiting" ? `It's asking you — answer, or use the keys` : `Tell ${workerName(w)}…`;
    const rv = t.el.querySelector<HTMLElement>(".mon-review")!;
    rv.classList.toggle("hidden", !report);
    rv.classList.remove("sent");
    t.el.classList.toggle("ready", !!report);
    rv.innerHTML = report ? reviewHtml(report, this.a.canType()) : "";
    if (auditing) {
      rv.classList.remove("hidden");
      rv.innerHTML = `<div class="mon-rv-head"><b>🔍 Being audited:</b> <span class="mon-rv-title">${esc(w.report!.title)}</span></div><p class="mon-rv-hint">A teammate is checking it first — it comes to you when they're done.</p>`;
    }
  }

  /** Just this one, big, with its box ready to type in (N: the next one that needs you). */
  focus(deskId: string): void {
    this.filter = "all";
    this.focused = deskId;
    this.refresh();
    requestAnimationFrame(() => this.tiles.get(deskId)?.el.querySelector<HTMLInputElement>(".mon-say input")?.focus());
  }

  /** Repaint the tiles whose terminal changed (or all, after a resize). */
  private paintAll(force: boolean): void {
    if (!this.host.isConnected) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    for (const [id, t] of this.tiles) {
      const c = t.canvas;
      const w = Math.round(c.clientWidth * dpr);
      const h = Math.round(c.clientHeight * dpr);
      if (!w || !h) continue;
      const key = `${this.a.terminalVersion(id)}|${w}x${h}`;
      if (!force && key === t.painted) continue;
      t.painted = key;
      if (c.width !== w) c.width = w;
      if (c.height !== h) c.height = h;
      const g = c.getContext("2d")!;
      const pad = Math.round(6 * dpr);
      g.fillStyle = "#1e1f2e";
      g.fillRect(0, 0, w, h);
      this.a.paintTerminal(id, g, pad, pad, w - pad * 2, h - pad * 2);
    }
  }
}

/** A report, ready to review on its tile. */
function reviewHtml(r: Report, canReview: boolean): string {
  const check = r.check
    ? r.check.status === "pass"
      ? `<span class="mon-chk pass">✅ checks pass</span>`
      : r.check.status === "running"
        ? `<span class="mon-chk run">⏳ checking…</span>`
        : `<span class="mon-chk fail">❌ checks fail</span>`
    : "";
  const kind = r.status === "plan" ? "🗒 Plan to approve" : r.status === "blocked" ? "❓ Needs a decision" : "🎤 Ready to review";
  const approve = r.status === "plan" ? "✅ Approve plan" : r.status === "blocked" ? "" : "✅ Approve";
  const back = r.status === "blocked" ? "💬 Answer" : "↩ Send back";
  // The buttons sit by the title, so they're in view however small the tile.
  const acts = canReview
    ? `<span class="mon-rv-acts">${approve ? `<button class="btn small primary" data-review="approve">${approve}</button>` : ""}<button class="btn small" data-review="back" title="Uses what you typed in the box below">${back}</button></span>`
    : "";
  return `<div class="mon-rv-head"><b>${kind}:</b> <span class="mon-rv-title">${esc(r.title)}</span>${check}${acts}</div>
    ${r.question ? `<p class="mon-rv-q">❓ ${esc(r.question)}</p>` : ""}
    <p class="mon-rv-sum">${esc(r.summary)}</p>
    ${r.slides.length ? `<ul class="mon-rv-slides">${deckOf(r).slice(0, 7).map((x) => { const p = parseSlide(x); return `<li>${esc(p.heading || p.bullets[0] || "")}</li>`; }).join("")}</ul>` : ""}
    ${canReview ? `<p class="mon-rv-hint">A note in the box below goes with it · or hold office hours (O) to hear it presented</p>` : ""}`;
}

/** Typing in a box isn't walking or a shortcut (Esc still closes the window). */
function guardKeys(input: HTMLInputElement): void {
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") e.stopPropagation();
  });
}

/** The Agent monitor in its own window. */
export function openMonitor(a: MonitorActions, onClose?: () => void, focus?: string): { modal: Modal; view: MonitorView } {
  const body = document.createElement("div");
  const view = new MonitorView(body, a);
  const modal = openModal({
    title: "Agent monitor",
    icon: "📺",
    className: "monitor",
    body,
    footer: `<span class="grow">Every agent's live CLI · whoever needs you comes first (N jumps to the next) · review finished work right on its tile · click a screen to open its terminal · Enter on an empty box presses Enter for it</span>`,
    onClose: () => {
      view.destroy();
      onClose?.();
    },
  });
  if (focus) view.focus(focus);
  return { modal, view };
}
