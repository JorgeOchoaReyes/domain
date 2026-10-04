import { esc } from "./modal.js";

/**
 * Pip, your office assistant: a little robot in the corner of the HUD who
 * keeps you oriented. Pip says the one thing that matters right now (a worker
 * is waiting on you, work is ready to review, the session's about to end, the
 * goal's stuck), answers "what should I do now?", runs the guided tour —
 * walking you room by room and spotlighting the buttons and keys that matter —
 * and walks you through getting something done (start a session, put a worker
 * on a task, ship a pull request…) as a checklist that ticks itself off as you
 * go.
 *
 * It owns no game state: main.ts hands it what's going on (a Situation) and
 * the actions it may take (travel, open a window, start the stand-up).
 */

export interface Tip {
  /** Stable id, so the same reminder isn't repeated too often. */
  id: string;
  text: string;
  /** 0 = nice to know … 3 = someone's waiting on you. */
  urgency: number;
  action?: { label: string; run: () => void };
}

export interface TourStep {
  title: string;
  text: string;
  /** Where to stand for this step. */
  go?: () => void;
  /** A HUD element to spotlight (CSS selector). */
  spot?: string;
  /** A button that does the thing ("Hold the stand-up"). */
  action?: { label: string; run: () => void };
}

/** One step of a guide: done when the game says so, with a button that does it. */
export interface GuideStep {
  title: string;
  text: string;
  /** Already done (or just now): the guide moves on by itself. */
  done(): boolean;
  action?: { label: string; run: () => void };
  /** A HUD element to spotlight (CSS selector). */
  spot?: string;
}

/** Something Pip can walk you through, start to finish. */
export interface Guide {
  id: string;
  icon: string;
  title: string;
  /** Built fresh when it starts, so it reflects what's there. */
  steps(): GuideStep[];
  /** Said when every step is done. */
  finish: string;
}

export interface AssistantCtx {
  /** The tips that apply right now, most urgent first. */
  tips(): Tip[];
  /** The guided tour's steps (built fresh, so they reflect what's available). */
  tour(): TourStep[];
  /** "What should I do now?" — the next step, in a sentence, with a button. */
  whatNow(): Tip;
  /** Free the mouse so the tour's buttons can be clicked. */
  freeMouse(): void;
  /** Windows are open (Pip stays quiet and out of the way). */
  busy(): boolean;
  /** What Pip can walk you through. */
  guides(): Guide[];
  /** A step of a guide got done (a sound, a sparkle). */
  cheer?(final: boolean): void;
}

const TOUR_DONE = "domain.tour.done";
/** Don't say the same reminder again within this long. */
const REPEAT_MS = 3 * 60_000;

export class Assistant {
  readonly el: HTMLElement;
  private bubble: HTMLElement;
  private shown: Tip | null = null;
  private said = new Map<string, number>();
  private dismissedUntil = 0;
  private touring = false;
  /** The guide you're on, its steps, and the step showing. */
  private guide: { g: Guide; steps: GuideStep[]; at: number } | null = null;
  private guideTimer = 0;
  private spotEl: HTMLElement | null = null;
  private timer = 0;

  constructor(parent: HTMLElement, private ctx: AssistantCtx) {
    this.el = document.createElement("div");
    this.el.className = "pip";
    this.el.innerHTML = `
      <button class="pip-face" title="Pip, your assistant — click for help" aria-label="Pip, your assistant">${PIP_SVG}</button>
      <div class="pip-bubble hidden" role="status" aria-live="polite"></div>`;
    this.bubble = this.el.querySelector(".pip-bubble")!;
    this.el.querySelector(".pip-face")!.addEventListener("click", () => this.menu());
    parent.appendChild(this.el);
    this.timer = window.setInterval(() => this.tick(), 2500);
  }

  /** Whether the guided tour has been taken (or skipped). */
  get toured(): boolean {
    try {
      return localStorage.getItem(TOUR_DONE) === "1";
    } catch {
      return true;
    }
  }

  /** First visit: offer the tour, then carry on with `then` (e.g. the stand-up). */
  welcome(name: string, then: () => void): void {
    this.say(
      {
        id: "welcome",
        urgency: 3,
        text: `Hi ${name}! I'm Pip — I'll keep you pointed at what matters. Want a two-minute tour of the office first?`,
        action: { label: "🗺 Take the tour", run: () => this.startTour(then) },
      },
      { label: "Skip — start the stand-up", run: () => (this.markToured(), then()) },
    );
  }

  /** Say something now, with up to two buttons. */
  say(tip: Tip, second?: { label: string; run: () => void }): void {
    this.shown = tip;
    this.said.set(tip.id, Date.now());
    const buttons = [tip.action, second].filter((b): b is { label: string; run: () => void } => !!b);
    this.bubble.innerHTML = `
      <button class="pip-x" title="Hush for a few minutes" aria-label="Dismiss">✕</button>
      <p>${esc(tip.text)}</p>
      ${buttons.length ? `<div class="pip-actions">${buttons.map((b, i) => `<button class="btn ${i === 0 ? "primary" : ""} small" data-i="${i}">${esc(b.label)}</button>`).join("")}</div>` : ""}`;
    this.bubble.classList.remove("hidden");
    this.el.classList.toggle("urgent", tip.urgency >= 3);
    this.el.classList.remove("pop");
    void this.el.offsetWidth;
    this.el.classList.add("pop");
    this.bubble.querySelector(".pip-x")!.addEventListener("click", () => this.hush());
    this.bubble.querySelectorAll<HTMLButtonElement>("[data-i]").forEach((b) =>
      b.addEventListener("click", () => {
        const btn = buttons[Number(b.dataset.i)];
        this.hide();
        btn.run();
      }),
    );
  }

  hide(): void {
    this.shown = null;
    this.bubble.classList.add("hidden");
    this.el.classList.remove("urgent");
  }

  /** Quiet for a while (the ✕). */
  private hush(): void {
    this.dismissedUntil = Date.now() + 90_000;
    this.hide();
  }

  /** Click on Pip: what now, plus everything Pip can walk you through. */
  private menu(): void {
    if (this.touring) return;
    if (this.guide) {
      this.showGuide();
      return;
    }
    const now = this.ctx.whatNow();
    const guides = this.ctx.guides();
    this.shown = { id: "menu", text: now.text, urgency: 1 };
    this.said.set("menu", Date.now());
    this.bubble.innerHTML = `
      <button class="pip-x" title="Hush for a few minutes" aria-label="Dismiss">✕</button>
      <p>${esc(now.text)}</p>
      ${now.action ? `<div class="pip-actions"><button class="btn primary small now">${esc(now.action.label)}</button></div>` : ""}
      <div class="pip-step">Or walk me through…</div>
      <div class="pip-guides">
        ${guides.map((g, i) => `<button class="btn small pip-guide" data-g="${i}">${g.icon} ${esc(g.title)}</button>`).join("")}
        <button class="btn small pip-guide tour">🗺 The office tour</button>
      </div>`;
    this.bubble.classList.remove("hidden");
    this.ctx.freeMouse();
    this.bubble.querySelector(".pip-x")!.addEventListener("click", () => this.hush());
    this.bubble.querySelector(".now")?.addEventListener("click", () => {
      this.hide();
      now.action!.run();
    });
    this.bubble.querySelector(".tour")!.addEventListener("click", () => this.startTour());
    this.bubble.querySelectorAll<HTMLButtonElement>("[data-g]").forEach((b) => b.addEventListener("click", () => this.startGuide(guides[Number(b.dataset.g)])));
  }

  // --- guides ------------------------------------------------------------------------------

  /** Walk through a guide: each step ticks itself off when it's done. */
  startGuide(g: Guide): void {
    this.endGuide();
    this.guide = { g, steps: g.steps(), at: -1 };
    this.ctx.freeMouse();
    this.guideTimer = window.setInterval(() => this.followGuide(), 600);
    this.followGuide();
  }

  get guiding(): boolean {
    return this.guide !== null;
  }

  private followGuide(): void {
    const gd = this.guide;
    if (!gd) return;
    const next = gd.steps.findIndex((s) => !safe(s.done));
    if (next === -1) {
      const g = gd.g;
      this.endGuide();
      this.ctx.cheer?.(true);
      this.say({ id: `guide-done-${g.id}-${Date.now()}`, urgency: 2, text: `🎉 ${g.finish}` });
      return;
    }
    if (next === gd.at) return;
    if (gd.at !== -1 && next > gd.at) this.ctx.cheer?.(false);
    gd.at = next;
    this.showGuide();
  }

  private showGuide(): void {
    const gd = this.guide;
    if (!gd) return;
    const step = gd.steps[gd.at];
    this.shown = { id: "guide", text: step.text, urgency: 2 };
    this.bubble.innerHTML = `
      <div class="pip-step">${gd.g.icon} ${esc(gd.g.title)} · step ${gd.at + 1} of ${gd.steps.length}</div>
      <ol class="pip-checklist">${gd.steps.map((s, i) => `<li class="${i < gd.at || (i > gd.at && safe(s.done)) ? "done" : i === gd.at ? "now" : ""}">${esc(s.title)}</li>`).join("")}</ol>
      <p>${esc(step.text)}</p>
      <div class="pip-actions">
        ${step.action ? `<button class="btn primary small act">${esc(step.action.label)}</button>` : ""}
        <span class="grow"></span>
        <button class="btn small stop">End guide</button>
      </div>`;
    this.bubble.classList.remove("hidden");
    this.el.classList.remove("pop");
    void this.el.offsetWidth;
    this.el.classList.add("pop");
    requestAnimationFrame(() => this.spot(step.spot));
    this.bubble.querySelector(".act")?.addEventListener("click", () => {
      this.unspot();
      step.action!.run();
    });
    this.bubble.querySelector(".stop")!.addEventListener("click", () => {
      this.endGuide();
      this.hide();
    });
  }

  private endGuide(): void {
    clearInterval(this.guideTimer);
    this.guide = null;
    this.unspot();
  }

  /** Every few seconds: say the most urgent tip that hasn't been said lately. */
  private tick(): void {
    if (this.touring || this.guide || this.ctx.busy() || Date.now() < this.dismissedUntil) return;
    const fresh = this.ctx.tips().find((t) => Date.now() - (this.said.get(t.id) ?? 0) > REPEAT_MS);
    if (!fresh) return;
    // Don't talk over something more urgent that's still up.
    if (this.shown && this.shown.urgency > fresh.urgency) return;
    this.say(fresh);
    // Lesser tips fade on their own.
    if (fresh.urgency < 2) {
      const id = fresh.id;
      setTimeout(() => {
        if (this.shown?.id === id) this.hide();
      }, 12_000);
    }
  }

  private markToured(): void {
    try {
      localStorage.setItem(TOUR_DONE, "1");
    } catch {
      /* storage blocked */
    }
  }

  // --- the guided tour ------------------------------------------------------------------

  startTour(then?: () => void): void {
    const steps = this.ctx.tour();
    if (!steps.length) return;
    this.touring = true;
    this.ctx.freeMouse();
    document.body.classList.add("touring");
    let i = 0;
    const end = () => {
      this.touring = false;
      this.unspot();
      document.body.classList.remove("touring");
      this.hide();
      this.markToured();
      then?.();
    };
    const show = () => {
      const step = steps[i];
      step.go?.();
      // Give the HUD a frame to settle after a teleport before measuring the spotlight.
      requestAnimationFrame(() => this.spot(step.spot));
      const last = i === steps.length - 1;
      this.shown = { id: "tour", text: step.text, urgency: 2 };
      this.bubble.innerHTML = `
        <div class="pip-step">Tour · ${i + 1} of ${steps.length}</div>
        <h4>${esc(step.title)}</h4>
        <p>${esc(step.text)}</p>
        <div class="pip-actions">
          ${i > 0 ? `<button class="btn small back">◀ Back</button>` : ""}
          ${step.action ? `<button class="btn small act">${esc(step.action.label)}</button>` : ""}
          <span class="grow"></span>
          <button class="btn small skip">${last ? "Close" : "End tour"}</button>
          ${last ? "" : `<button class="btn primary small next">Next ▶</button>`}
        </div>`;
      this.bubble.classList.remove("hidden");
      this.bubble.querySelector(".next")?.addEventListener("click", () => {
        i++;
        show();
      });
      this.bubble.querySelector(".back")?.addEventListener("click", () => {
        i--;
        show();
      });
      this.bubble.querySelector(".skip")!.addEventListener("click", end);
      this.bubble.querySelector(".act")?.addEventListener("click", () => {
        const run = step.action!.run;
        end();
        run();
      });
    };
    show();
  }

  /** Dim the screen around one HUD element. */
  private spot(selector?: string): void {
    this.unspot();
    if (!selector) return;
    const target = document.querySelector<HTMLElement>(selector);
    if (!target) return;
    const r = target.getBoundingClientRect();
    if (!r.width) return;
    const el = document.createElement("div");
    el.className = "pip-spot";
    Object.assign(el.style, { left: `${r.left - 8}px`, top: `${r.top - 8}px`, width: `${r.width + 16}px`, height: `${r.height + 16}px` });
    document.body.appendChild(el);
    this.spotEl = el;
  }

  private unspot(): void {
    this.spotEl?.remove();
    this.spotEl = null;
  }

  dispose(): void {
    clearInterval(this.timer);
    this.endGuide();
    this.unspot();
    this.el.remove();
  }
}

/** A step's check, never throwing. */
function safe(f: () => boolean): boolean {
  try {
    return f();
  } catch {
    return false;
  }
}

/** Pip: a round little robot with an antenna, in the game's toon style. */
const PIP_SVG = `<svg viewBox="0 0 64 64" width="56" height="56" aria-hidden="true">
  <line x1="32" y1="10" x2="32" y2="3" stroke="#2b2d42" stroke-width="3" stroke-linecap="round"/>
  <circle class="pip-bulb" cx="32" cy="4" r="4" fill="#ffd166" stroke="#2b2d42" stroke-width="2.5"/>
  <rect x="8" y="10" width="48" height="40" rx="18" fill="#5bc0eb" stroke="#2b2d42" stroke-width="3.5"/>
  <rect x="15" y="19" width="34" height="20" rx="10" fill="#fffaf3" stroke="#2b2d42" stroke-width="2.5"/>
  <circle class="pip-eye" cx="25" cy="29" r="3.6" fill="#2b2d42"/>
  <circle class="pip-eye" cx="39" cy="29" r="3.6" fill="#2b2d42"/>
  <path d="M27 34 q5 4 10 0" stroke="#2b2d42" stroke-width="2.5" fill="none" stroke-linecap="round"/>
  <rect x="20" y="50" width="24" height="8" rx="4" fill="#3d405b" stroke="#2b2d42" stroke-width="2.5"/>
</svg>`;
