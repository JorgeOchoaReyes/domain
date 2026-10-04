import type { Presentation } from "../../shared/protocol.js";
import { AGENT_LABELS } from "../../shared/protocol.js";
import { speak, stopSpeaking, sttSupported, Dictation } from "../voice.js";

export interface ReviewHandlers {
  /** approve=true continues; otherwise text is the revision feedback. */
  onReview(approve: boolean, text: string): void;
  onClose(): void;
}

/**
 * The "office hours" panel: an agent presents its report (slides + preview),
 * its summary is read aloud, and you respond by voice or text — approve to let
 * it continue, or send changes to revise.
 */
export class ReviewPanel {
  private root: HTMLElement;
  private handlers: ReviewHandlers | null = null;
  private dictation: Dictation;
  deskId: string | null = null;

  private titleEl: HTMLElement;
  private subEl: HTMLElement;
  private queueEl: HTMLElement;
  private slidesEl: HTMLElement;
  private previewEl: HTMLElement;
  private feedbackEl: HTMLTextAreaElement;
  private micBtn: HTMLButtonElement;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "review-wrap card interactive";
    this.root.style.display = "none";
    this.root.innerHTML = `
      <div class="review-head">
        <div>
          <div class="review-title"></div>
          <div class="review-sub"></div>
        </div>
        <span class="review-queue"></span>
        <button class="review-close" title="Close (Esc)">Close</button>
      </div>
      <div class="review-stage">
        <ul class="review-slides"></ul>
        <div class="review-preview"></div>
      </div>
      <div class="review-foot">
        <textarea class="review-feedback" rows="2" placeholder="Speak or type feedback… (approve needs none)"></textarea>
        <div class="review-actions">
          <button class="review-mic" title="Hold a thought — dictate feedback">🎤 Speak</button>
          <button class="review-revise">Send changes</button>
          <button class="review-approve">Approve ▸ continue</button>
        </div>
      </div>`;
    parent.appendChild(this.root);

    this.titleEl = this.root.querySelector(".review-title")!;
    this.subEl = this.root.querySelector(".review-sub")!;
    this.queueEl = this.root.querySelector(".review-queue")!;
    this.slidesEl = this.root.querySelector(".review-slides")!;
    this.previewEl = this.root.querySelector(".review-preview")!;
    this.feedbackEl = this.root.querySelector(".review-feedback")!;
    this.micBtn = this.root.querySelector(".review-mic")!;

    this.dictation = new Dictation(
      (text) => {
        this.feedbackEl.value = text;
      },
      () => {
        this.micBtn.classList.remove("live");
        this.micBtn.textContent = "🎤 Speak";
      },
    );

    this.root.querySelector(".review-close")!.addEventListener("click", () => this.requestClose());
    this.root.querySelector(".review-approve")!.addEventListener("click", () => {
      this.handlers?.onReview(true, "");
    });
    this.root.querySelector(".review-revise")!.addEventListener("click", () => {
      const text = this.feedbackEl.value.trim();
      if (!text) {
        this.feedbackEl.focus();
        return;
      }
      this.handlers?.onReview(false, text);
    });
    this.micBtn.addEventListener("click", () => this.toggleMic());
    if (!sttSupported()) {
      this.micBtn.disabled = true;
      this.micBtn.title = "Speech recognition isn't available in this browser";
    }
  }

  get isOpen(): boolean {
    return this.root.style.display !== "none";
  }

  open(p: Presentation, queueTotal: number, handlers: ReviewHandlers): void {
    this.handlers = handlers;
    this.deskId = p.deskId;

    const label = AGENT_LABELS[p.agent];
    this.titleEl.textContent = p.report.title;
    const kind = p.report.status === "blocked" ? "needs a decision" : "finished — review";
    this.subEl.textContent = `${label} · hired by ${p.hiredBy} · ${kind}`;
    this.queueEl.textContent = queueTotal > 1 ? `1 of ${queueTotal} waiting` : "";

    // Slides: the summary leads, then the bullet points, then any question.
    this.slidesEl.innerHTML = "";
    const lead = document.createElement("li");
    lead.className = "lead";
    lead.textContent = p.report.summary;
    this.slidesEl.appendChild(lead);
    for (const s of p.report.slides) {
      const li = document.createElement("li");
      li.textContent = s;
      this.slidesEl.appendChild(li);
    }
    if (p.report.question) {
      const q = document.createElement("li");
      q.className = "question";
      q.textContent = `❓ ${p.report.question}`;
      this.slidesEl.appendChild(q);
    }

    // Preview: a running app URL (iframe) or an image, if provided.
    this.previewEl.innerHTML = "";
    const prev = p.report.preview;
    if (prev?.url) {
      const frame = document.createElement("iframe");
      frame.src = prev.url;
      frame.className = "review-frame";
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
      this.previewEl.appendChild(frame);
    } else if (prev?.image) {
      const img = document.createElement("img");
      img.src = prev.image;
      img.className = "review-img";
      this.previewEl.appendChild(img);
    }
    this.previewEl.style.display = prev?.url || prev?.image ? "block" : "none";

    this.feedbackEl.value = "";
    this.root.style.display = "flex";

    // Read the summary aloud in the agent's voice.
    speak(`${label} reporting. ${p.report.summary}${p.report.question ? " " + p.report.question : ""}`, p.agent);
  }

  close(): void {
    this.dictation.stop();
    stopSpeaking();
    this.root.style.display = "none";
    this.deskId = null;
    this.handlers = null;
  }

  private requestClose(): void {
    const h = this.handlers;
    this.close();
    h?.onClose();
  }

  private toggleMic(): void {
    if (this.dictation.isActive) {
      this.dictation.stop();
      return;
    }
    stopSpeaking(); // don't transcribe the agent's own voice
    this.micBtn.classList.add("live");
    this.micBtn.textContent = "● Listening…";
    this.dictation.start(this.feedbackEl.value);
  }
}
