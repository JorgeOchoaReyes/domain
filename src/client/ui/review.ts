import { deckOf, parseSlide, slideSpeech } from "../../shared/slides.js";
import type { CheckResult, Presentation } from "../../shared/protocol.js";
import type { WorkerIdentity } from "../../shared/team.js";
import { AGENT_LABELS } from "../../shared/protocol.js";
import { AGENT_COLOR } from "../scene/characters.js";
import { Dictation, speak, stopSpeaking, sttSupported } from "../voice.js";
import { esc, openModal, type Modal } from "./modal.js";
import { Sketchpad, sketchTools } from "./sketchpad.js";

/**
 * Office hours: a worker presents in your office. On the left, its report as
 * a slide deck, narrated in its voice. On the right, the review whiteboard you
 * draw and write on, and the conversation — talk to it by voice (dictated into
 * its CLI) or text, and hear it answer. Then approve it, send it back with
 * changes, or see it later.
 */

export interface ReviewHandlers {
  /** approve=true continues; otherwise text (and the sketch) are the changes. */
  onReview(approve: boolean, text: string, sketch: string | null): void;
  /** Say something to the worker presenting. */
  onSay(text: string): void;
  /** See this one later: close it and keep it in line. */
  onLater(): void;
  onClose(): void;
  /** The slide on screen changed (for the screen in the 3D office). */
  onSlide(index: number): void;
  /** The whiteboard changed (to mirror it onto the one in the office). */
  onBoard(canvas: HTMLCanvasElement | null): void;
  /** Dictation isn't available here (e.g. no speech service in this window). */
  onVoiceError(error: string): void;
  /** Show this review the other way (window ↔ projector). */
  onSwitch?(): void;
}

export class ReviewPanel {
  private modal: Modal | null = null;
  private handlers: ReviewHandlers | null = null;
  private p: Presentation | null = null;
  deskId: string | null = null;

  private slideIndex = 0;
  private slideCount = 1;
  private auto = true;
  private talking: Dictation;
  private noting: Dictation;
  private pad: Sketchpad | null = null;
  private sent = false;

  private el = {} as {
    stage: HTMLElement;
    dots: HTMLElement;
    autoBtn: HTMLButtonElement;
    board: HTMLCanvasElement;
    notes: HTMLTextAreaElement;
    log: HTMLElement;
    say: HTMLInputElement;
    talkBtn: HTMLButtonElement;
    noteMic: HTMLButtonElement;
  };

  constructor() {
    this.talking = new Dictation(
      (text) => (this.el.say.value = text),
      () => {
        this.el.talkBtn?.classList.remove("live");
        if (this.el.talkBtn) this.el.talkBtn.innerHTML = "🎤 Talk";
        const text = this.el.say?.value.trim();
        if (text && this.modal) this.sendSay();
      },
      (err) => this.handlers?.onVoiceError(err),
    );
    this.noting = new Dictation(
      (text) => (this.el.notes.value = text),
      () => {
        this.el.noteMic?.classList.remove("live");
      },
      (err) => this.handlers?.onVoiceError(err),
    );
  }

  get isOpen(): boolean {
    return this.modal !== null;
  }

  /** The whiteboard canvas, while a review is open. */
  get board(): HTMLCanvasElement | null {
    return this.modal ? this.el.board : null;
  }

  /** The presenter's character (its name and voice), when it's one of your team. */
  private who: WorkerIdentity | null = null;

  open(p: Presentation, place: { index: number; total: number }, handlers: ReviewHandlers, who: WorkerIdentity | null = null): void {
    if (!p.report) return;
    this.close();
    this.p = p;
    this.who = who;
    this.deskId = p.deskId;
    this.handlers = handlers;
    this.slideIndex = 0;
    this.slideCount = 1 + deckOf(p.report).length + (p.report.preview?.url || p.report.preview?.image ? 1 : 0);
    this.auto = true;
    this.sent = false;

    const label = who ? `${who.name} (${AGENT_LABELS[p.agent]})` : AGENT_LABELS[p.agent];
    const body = document.createElement("div");
    body.className = "review";
    body.style.setProperty("--agent", AGENT_COLOR[p.agent]);
    body.innerHTML = `
      <section class="deck">
        ${checkBanner(p.report.check)}
        <div class="slide-stage"></div>
        <div class="deck-bar">
          <button class="btn prev" title="Previous slide (←)">◀</button>
          <div class="slide-dots"></div>
          <button class="btn next" title="Next slide (→)">▶</button>
          <button class="btn auto on" title="Narrate and advance on its own">🔊 Narrating</button>
          <button class="btn replay" title="Read this slide again">↻</button>
        </div>
      </section>
      <section class="side-col">
        <div class="wb">
          <div class="wb-head"><h3>✍️ Review board</h3>
            <div class="wb-tools">${sketchTools()}</div>
          </div>
          <canvas class="wb-canvas" width="960" height="560"></canvas>
          <div class="notes-row">
            <textarea class="notes" rows="2" placeholder="Written feedback — what should change? (sent with Send changes)"></textarea>
            <button class="btn mic note-mic" title="Dictate notes">🎤</button>
          </div>
        </div>
        <div class="convo">
          <h3>💬 Talk to ${esc(label)}</h3>
          <ul class="log"><li class="sys">Ask questions while it presents — it hears you in its terminal and answers out loud.</li></ul>
          <div class="say-row">
            <button class="btn mic talk" title="Talk (click to start, click again to send)">🎤 Talk</button>
            <input type="text" class="say" placeholder="…or type to ${esc(label)}" />
            <button class="btn send">Send</button>
          </div>
        </div>
      </section>`;
    const footer = document.createElement("div");
    footer.style.display = "contents";
    footer.innerHTML = `
      <button class="btn later" title="Keep it in line and see the next one">⏭ Later</button>
      <span class="grow">${place.total > 1 ? `${place.index} of ${place.total} in line` : "Last one in line"} · hired by ${esc(p.hiredBy)}</span>
      <button class="btn danger changes">${p.report.status === "plan" ? "✏️ Change the plan" : "✏️ Send changes"}</button>
      <button class="btn good approve">${p.report.status === "plan" ? "✅ Approve plan ▸ build it" : p.report.check?.status === "fail" ? "⚠️ Approve anyway" : "✅ Approve ▸ continue"}</button>`;

    this.modal = openModal({
      title: `${p.report.status === "blocked" ? "Needs a decision" : p.report.status === "plan" ? "Plan to approve" : "Presenting"} · ${label}`,
      icon: `<span class="dot" style="background:${AGENT_COLOR[p.agent]}"></span>`,
      className: "review-modal",
      body,
      footer,
      onClose: () => this.closed(),
    });

    const q = <T extends Element>(s: string) => body.querySelector<T>(s)!;
    this.el = {
      stage: q(".slide-stage"),
      dots: q(".slide-dots"),
      autoBtn: q(".auto"),
      board: q(".wb-canvas"),
      notes: q(".notes"),
      log: q(".log"),
      say: q(".say"),
      talkBtn: q(".talk"),
      noteMic: q(".note-mic"),
    };
    q(".prev").addEventListener("click", () => this.go(this.slideIndex - 1, true));
    q(".next").addEventListener("click", () => this.go(this.slideIndex + 1, true));
    q(".replay").addEventListener("click", () => this.narrate());
    this.el.autoBtn.addEventListener("click", () => {
      this.auto = !this.auto;
      this.el.autoBtn.classList.toggle("on", this.auto);
      this.el.autoBtn.textContent = this.auto ? "🔊 Narrating" : "🔇 Quiet";
      if (this.auto) this.narrate();
      else stopSpeaking();
    });
    this.el.dots.addEventListener("click", (e) => {
      const d = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
      if (d) this.go(Number(d.dataset.i), true);
    });
    this.pad = new Sketchpad(this.el.board, q(".wb-tools"), (c) => this.handlers?.onBoard(c));
    q(".send").addEventListener("click", () => this.sendSay());
    // Typing stays in the box (no walking or slide flipping), but Esc still closes.
    this.el.say.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") e.stopPropagation();
      if (e.key === "Enter") this.sendSay();
    });
    this.el.notes.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") e.stopPropagation();
    });
    this.el.talkBtn.addEventListener("click", () => this.toggleTalk());
    this.el.noteMic.addEventListener("click", () => this.toggleNotes());
    if (!sttSupported()) {
      for (const b of [this.el.talkBtn, this.el.noteMic]) {
        b.disabled = true;
        b.title = "Speech recognition isn't available in this browser";
      }
    }
    footer.querySelector(".approve")!.addEventListener("click", () => this.decide(true));
    footer.querySelector(".changes")!.addEventListener("click", () => this.decide(false));
    footer.querySelector(".later")!.addEventListener("click", () => {
      const h = this.handlers;
      this.sent = true;
      this.close();
      h?.onLater();
    });

    this.render();
    this.narrate();
  }

  /** Arrow keys flip slides while the window is open (not while typing). */
  key(e: KeyboardEvent): boolean {
    if (!this.modal) return false;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return false;
    if (e.key === "ArrowRight") this.go(this.slideIndex + 1, true);
    else if (e.key === "ArrowLeft") this.go(this.slideIndex - 1, true);
    else return false;
    return true;
  }

  /** Something said in this review, by you or the worker. */
  addLine(from: "agent" | "you", text: string): void {
    if (!this.modal || !this.p) return;
    const li = document.createElement("li");
    li.className = from;
    li.innerHTML = `<b>${from === "you" ? "You" : esc(this.who?.name ?? AGENT_LABELS[this.p.agent])}</b> ${esc(text)}`;
    this.el.log.appendChild(li);
    this.el.log.scrollTop = this.el.log.scrollHeight;
    if (from === "agent") {
      // It answers out loud; narration pauses so the two don't talk over each other.
      this.auto = false;
      this.el.autoBtn.classList.remove("on");
      this.el.autoBtn.textContent = "🔇 Quiet";
      speak(text, this.p.agent, undefined, this.who?.voice ?? "");
    }
  }

  close(): void {
    this.modal?.close();
  }

  // --- slides ------------------------------------------------------------------

  private go(i: number, manual: boolean): void {
    const next = Math.max(0, Math.min(this.slideCount - 1, i));
    if (next === this.slideIndex && manual) return;
    this.slideIndex = next;
    this.render();
    if (manual && this.auto) this.narrate();
    else if (manual) stopSpeaking();
  }

  private render(): void {
    const p = this.p!;
    const r = p.report!;
    const i = this.slideIndex;
    const slides = deckOf(r);
    const previewAt = 1 + slides.length;
    let html: string;
    if (i === 0) {
      html = `<div class="slide title-slide">
        <div class="kicker">${esc(this.who ? `${this.who.name} · ${AGENT_LABELS[p.agent]}` : AGENT_LABELS[p.agent])} · ${r.status === "blocked" ? "needs a decision" : r.status === "plan" ? "plan — approve it before any code" : "progress report"}</div>
        <h1>${esc(r.title)}</h1>
        <p>${esc(r.summary)}</p>
        ${r.question ? `<div class="question">❓ ${esc(r.question)}</div>` : ""}
      </div>`;
    } else if (i < previewAt) {
      html = slideBodyHtml(slides[i - 1], r.title);
    } else {
      const prev = r.preview!;
      html = `<div class="slide preview-slide">
        <div class="kicker">Live preview</div>
        ${prev.url ? `<iframe src="${esc(prev.url)}" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>` : `<img src="${esc(prev.image!)}" alt="preview" />`}
      </div>`;
    }
    this.el.stage.innerHTML = `${html}<div class="slide-no">${i + 1} / ${this.slideCount}</div>`;
    this.el.dots.innerHTML = Array.from({ length: this.slideCount }, (_, k) => `<button class="sd ${k === i ? "on" : ""}" data-i="${k}" aria-label="slide ${k + 1}"></button>`).join("");
    this.handlers?.onSlide(i);
  }

  /** Read the current slide aloud, then (narrating) move on to the next. */
  private narrate(): void {
    if (!this.p?.report || !this.modal) return;
    const r = this.p.report;
    const i = this.slideIndex;
    let text: string;
    if (i === 0) text = `${r.title}. ${r.summary}${r.question ? ` My question for you: ${r.question}` : ""}`;
    else if (i <= deckOf(r).length) text = slideSpeech(deckOf(r)[i - 1]);
    else text = "And here's a live preview.";
    const at = i;
    speak(
      text,
      this.p.agent,
      () => {
        if (!this.auto || !this.modal || this.slideIndex !== at) return;
        if (at < this.slideCount - 1) {
          setTimeout(() => {
            if (!this.auto || !this.modal || this.slideIndex !== at) return;
            this.go(at + 1, false);
            this.narrate();
          }, 600);
        }
      },
      this.who?.voice ?? "",
    );
  }

  // --- talking -----------------------------------------------------------------------

  private sendSay(): void {
    const text = this.el.say.value.trim();
    if (!text) return;
    this.el.say.value = "";
    stopSpeaking();
    this.handlers?.onSay(text);
  }

  private toggleTalk(): void {
    if (this.talking.isActive) {
      this.talking.stop();
      return;
    }
    stopSpeaking(); // don't transcribe the worker's own voice
    this.auto = false;
    this.el.autoBtn.classList.remove("on");
    this.el.autoBtn.textContent = "🔇 Quiet";
    this.el.talkBtn.classList.add("live");
    this.el.talkBtn.innerHTML = "● Listening… click to send";
    this.talking.start(this.el.say.value);
  }

  private toggleNotes(): void {
    if (this.noting.isActive) {
      this.noting.stop();
      return;
    }
    stopSpeaking();
    this.el.noteMic.classList.add("live");
    this.noting.start(this.el.notes.value);
  }

  // --- deciding ------------------------------------------------------------------------

  private decide(approve: boolean): void {
    const text = this.el.notes.value.trim();
    if (!approve && !text && !this.pad?.ink) {
      this.el.notes.focus();
      this.el.notes.placeholder = "Write (or dictate, or draw) what should change first";
      this.el.notes.classList.add("nudge");
      return;
    }
    const sketch = this.pad?.png() ?? null;
    this.sent = true;
    const h = this.handlers;
    this.close();
    h?.onReview(approve, text, sketch);
  }

  private closed(): void {
    this.talking.stop();
    this.noting.stop();
    stopSpeaking();
    this.modal = null;
    const h = this.handlers;
    const sent = this.sent;
    this.handlers = null;
    this.p = null;
    this.deskId = null;
    if (!sent) h?.onClose();
  }
}

/** The check's verdict on this work, shown above the slides (nothing when no check ran). */
function checkBanner(c: CheckResult | undefined): string {
  if (!c) return "";
  const secs = c.ms ? ` · ${Math.max(1, Math.round(c.ms / 1000))}s` : "";
  if (c.status === "pass") return `<div class="check-banner pass">✅ <code>${esc(c.command)}</code> passed${secs}</div>`;
  if (c.status === "running") return `<div class="check-banner running">🧪 Running <code>${esc(c.command)}</code>…</div>`;
  return `<details class="check-banner fail"><summary>❌ <code>${esc(c.command)}</code> failed${c.exitCode !== null ? ` (exit ${c.exitCode})` : ""}${secs} — show output</summary><pre>${esc(c.tail.split("\n").slice(-30).join("\n"))}</pre></details>`;
}

/** A slide in the review window: its heading, its points, and its code. One-liners show as one big point. */
export function slideBodyHtml(text: string, title: string): string {
  const s = parseSlide(text);
  if (!s.heading && s.bullets.length === 1 && !s.code)
    return `<div class="slide point-slide"><div class="kicker">${esc(title)}</div><div class="point"><span class="bullet"></span><span>${esc(s.bullets[0])}</span></div></div>`;
  return `<div class="slide rich-slide">
    <div class="kicker">${esc(title)}</div>
    ${s.heading ? `<h2>${esc(s.heading)}</h2>` : ""}
    ${s.bullets.length ? `<ul>${s.bullets.map((b) => `<li>${inlineCode(b)}</li>`).join("")}</ul>` : ""}
    ${s.code ? `<pre><code>${esc(s.code)}</code></pre>` : ""}
  </div>`;
}

/** \`code\` in a bullet, shown as code. */
function inlineCode(t: string): string {
  return esc(t).replace(/`([^`]+)`/g, "<code>$1</code>");
}
