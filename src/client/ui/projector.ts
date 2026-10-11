import { deckOf, slideSpeech } from "../../shared/slides.js";
import type { Presentation } from "../../shared/protocol.js";
import type { WorkerIdentity } from "../../shared/team.js";
import { AGENT_LABELS } from "../../shared/protocol.js";
import { Dictation, speak, stopSpeaking, sttSupported } from "../voice.js";
import { esc } from "./modal.js";
import type { ReviewHandlers } from "./review.js";
import "../styles/projector.css";

/**
 * Office hours on the projector: you're in your chair, the worker's slides
 * play on the big screen in front of you, read aloud — and a slim bar along
 * the bottom does the rest: flip slides, say something (typed or spoken),
 * approve, send changes, or see it later. No window over the room.
 */
export class ProjectorReview {
  private el: HTMLElement | null = null;
  private p: Presentation | null = null;
  private who: WorkerIdentity | null = null;
  private handlers: ReviewHandlers | null = null;
  private slide = 0;
  private count = 1;
  private auto = true;
  private dictation: Dictation | null = null;
  deskId: string | null = null;

  get isOpen(): boolean {
    return this.el !== null;
  }

  open(p: Presentation, place: { index: number; total: number }, handlers: ReviewHandlers, who: WorkerIdentity | null = null): void {
    if (!p.report) return;
    this.close(true);
    this.p = p;
    this.who = who;
    this.deskId = p.deskId;
    this.handlers = handlers;
    this.slide = 0;
    this.count = 1 + deckOf(p.report).length;
    this.auto = true;
    const name = who ? `${who.name} (${AGENT_LABELS[p.agent]})` : AGENT_LABELS[p.agent];
    const r = p.report;
    const el = document.createElement("div");
    el.className = "projector-bar";
    el.innerHTML = `
      <div class="pj-top">
        <span class="pj-who">📽 <b>${esc(name)}</b> · ${esc(r.title)}</span>
        <span class="pj-place">${place.total > 1 ? `${place.index} of ${place.total} in line` : "last in line"}</span>
        ${r.check ? `<span class="pj-check ${r.check.status}">${r.check.status === "pass" ? "✅ checks pass" : r.check.status === "fail" ? "❌ checks failed" : "🧪 checking"}</span>` : ""}
        <button class="btn small pj-window" title="Show it in a window instead">🪟 Window</button>
      </div>
      <div class="pj-row">
        <button class="btn small pj-prev" title="Previous slide (←)">◀</button>
        <span class="pj-dots"></span>
        <button class="btn small pj-next" title="Next slide (→)">▶</button>
        <button class="btn small pj-auto on" title="Read the slides aloud">🔊</button>
        <input class="pj-say" type="text" placeholder="Ask it something, or say what should change…" />
        ${sttSupported() ? `<button class="btn mic small pj-mic" title="Dictate">🎤</button>` : ""}
        <button class="btn small pj-ask" title="Ask it (it answers out loud)">💬 Ask</button>
        <button class="btn small danger pj-changes" title="Send what's in the box as changes">✏️ Changes</button>
        <button class="btn small good pj-approve">${r.status === "plan" ? "✅ Approve plan" : "✅ Approve"}</button>
        <button class="btn small pj-later" title="Keep it in line, see the next one">⏭</button>
      </div>
      <ul class="pj-log"></ul>`;
    document.body.appendChild(el);
    this.el = el;
    const q = <T extends Element>(s: string) => el.querySelector<T>(s)!;
    q(".pj-prev").addEventListener("click", () => this.go(this.slide - 1, true));
    q(".pj-next").addEventListener("click", () => this.go(this.slide + 1, true));
    q(".pj-auto").addEventListener("click", (e) => {
      this.auto = !this.auto;
      (e.currentTarget as HTMLElement).classList.toggle("on", this.auto);
      (e.currentTarget as HTMLElement).textContent = this.auto ? "🔊" : "🔇";
      if (this.auto) this.narrate();
      else stopSpeaking();
    });
    const box = q<HTMLInputElement>(".pj-say");
    box.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") e.stopPropagation();
      if (e.key === "Enter") this.ask();
    });
    q(".pj-ask").addEventListener("click", () => this.ask());
    q(".pj-changes").addEventListener("click", () => this.decide(false));
    q(".pj-approve").addEventListener("click", () => this.decide(true));
    q(".pj-later").addEventListener("click", () => {
      const h = this.handlers;
      this.close(true);
      h?.onLater();
    });
    q(".pj-window").addEventListener("click", () => this.handlers?.onSwitch?.());
    const mic = el.querySelector<HTMLButtonElement>(".pj-mic");
    if (mic) {
      this.dictation = new Dictation(
        (text) => (box.value = text),
        () => mic.classList.remove("live"),
        (err) => this.handlers?.onVoiceError(err),
        (p) => mic.classList.toggle("busy", !!p && p.phase !== "listening"),
      );
      mic.addEventListener("click", () => {
        if (this.dictation!.isActive) return this.dictation!.stop();
        stopSpeaking();
        mic.classList.add("live");
        this.dictation!.start(box.value);
      });
    }
    this.go(0, false);
    this.narrate();
  }

  /** ← → flip slides (not while typing). */
  key(e: KeyboardEvent): boolean {
    if (!this.el) return false;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return false;
    if (e.key === "ArrowRight") this.go(this.slide + 1, true);
    else if (e.key === "ArrowLeft") this.go(this.slide - 1, true);
    else return false;
    return true;
  }

  /** Something said in this review: the worker's answers are read aloud. */
  addLine(from: "agent" | "you", text: string): void {
    if (!this.el || !this.p) return;
    const log = this.el.querySelector(".pj-log")!;
    const li = document.createElement("li");
    li.className = from;
    li.innerHTML = `<b>${from === "you" ? "You" : esc(this.who?.name ?? AGENT_LABELS[this.p.agent])}</b> ${esc(text)}`;
    log.appendChild(li);
    while (log.children.length > 3) log.firstElementChild?.remove();
    if (from === "agent") {
      this.auto = false;
      speak(text, this.p.agent, undefined, this.who?.voice ?? "");
    }
  }

  /** Close it (quietly when it's being replaced; otherwise office hours end). */
  close(quiet = false): void {
    if (!this.el) return;
    this.dictation?.cancel();
    stopSpeaking();
    this.el.remove();
    this.el = null;
    const h = this.handlers;
    this.handlers = null;
    this.p = null;
    this.deskId = null;
    if (!quiet) h?.onClose();
  }

  private go(i: number, manual: boolean): void {
    const next = Math.max(0, Math.min(this.count - 1, i));
    if (next === this.slide && manual) return;
    this.slide = next;
    this.handlers?.onSlide(next);
    const dots = this.el?.querySelector(".pj-dots");
    if (dots) dots.innerHTML = Array.from({ length: this.count }, (_, k) => `<i class="${k === next ? "on" : ""}"></i>`).join("");
    if (manual && this.auto) this.narrate();
    else if (manual) stopSpeaking();
  }

  private narrate(): void {
    const r = this.p?.report;
    if (!r || !this.el) return;
    const at = this.slide;
    const text = at === 0 ? `${r.title}. ${r.summary}${r.question ? ` My question for you: ${r.question}` : ""}` : slideSpeech(deckOf(r)[at - 1] ?? "");
    speak(
      text,
      this.p!.agent,
      () => {
        if (!this.auto || !this.el || this.slide !== at || at >= this.count - 1) return;
        setTimeout(() => {
          if (!this.auto || !this.el || this.slide !== at) return;
          this.go(at + 1, false);
          this.narrate();
        }, 600);
      },
      this.who?.voice ?? "",
    );
  }

  private ask(): void {
    const box = this.el?.querySelector<HTMLInputElement>(".pj-say");
    const text = box?.value.trim();
    if (!box || !text) return;
    stopSpeaking();
    this.handlers?.onSay(text);
    box.value = "";
  }

  private decide(approve: boolean): void {
    const box = this.el?.querySelector<HTMLInputElement>(".pj-say");
    const text = box?.value.trim() ?? "";
    if (!approve && !text) {
      box?.focus();
      if (box) box.placeholder = "Say what should change first (type, or 🎤)";
      return;
    }
    const h = this.handlers;
    this.close(true);
    h?.onReview(approve, text, null);
  }
}
