import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { WorkerStatus } from "../../shared/protocol.js";

const STATUS_LABEL: Record<WorkerStatus, string> = {
  booting: "booting",
  idle: "idle",
  working: "working",
  waiting: "waiting on you",
  presenting: "presenting",
  done: "done",
};
const STATUS_COLOR: Record<WorkerStatus, string> = {
  booting: "#6ea8fe",
  idle: "#4ade80",
  working: "#38bdf8",
  waiting: "#f87171",
  presenting: "#c58bff",
  done: "#fbbf24",
};

export interface TerminalHandlers {
  onInput(data: string): void;
  onResize(cols: number, rows: number): void;
  onFire(): void;
  onClose(): void;
}

/**
 * A floating xterm panel for a single worker. One instance is reused across
 * desks: open() (re)attaches it to a desk, write() streams output in, and
 * close() hides it. The xterm instance itself is created lazily and kept.
 */
export class TerminalOverlay {
  private root: HTMLElement;
  private titleEl: HTMLElement;
  private statusDot: HTMLElement;
  private statusText: HTMLElement;
  private bodyEl: HTMLElement;

  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private handlers: TerminalHandlers | null = null;
  private resizeObserver: ResizeObserver | null = null;
  deskId: string | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "terminal-wrap card interactive";
    this.root.style.display = "none";
    this.root.innerHTML = `
      <div class="terminal-head">
        <strong class="term-title"></strong>
        <span class="status-pill"><span class="status-dot" style="width:8px;height:8px;border-radius:50%;background:#4ade80;display:inline-block"></span><span class="status-text"></span></span>
        <button class="term-fire danger" title="Send this worker home">Send home</button>
        <button class="term-close" title="Close (Esc)">Close</button>
      </div>
      <div class="terminal-body"></div>`;
    parent.appendChild(this.root);

    this.titleEl = this.root.querySelector(".term-title")!;
    this.statusDot = this.root.querySelector(".status-dot")!;
    this.statusText = this.root.querySelector(".status-text")!;
    this.bodyEl = this.root.querySelector(".terminal-body")!;

    this.root.querySelector(".term-close")!.addEventListener("click", () => this.handlers?.onClose());
    this.root.querySelector(".term-fire")!.addEventListener("click", () => this.handlers?.onFire());
  }

  get isOpen(): boolean {
    return this.root.style.display !== "none";
  }

  private ensureTerm(): void {
    if (this.term) return;
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      theme: {
        background: "#06080c",
        foreground: "#e6e9ef",
        cursor: "#6ea8fe",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(this.bodyEl);
    term.onData((data) => this.handlers?.onInput(data));
    this.term = term;
    this.fit = fit;

    this.resizeObserver = new ResizeObserver(() => this.refit());
    this.resizeObserver.observe(this.bodyEl);
  }

  private refit(): void {
    if (!this.fit || !this.term || !this.isOpen) return;
    try {
      this.fit.fit();
      this.handlers?.onResize(this.term.cols, this.term.rows);
    } catch {
      /* fit can throw if the element has no size yet */
    }
  }

  open(deskId: string, title: string, status: WorkerStatus, handlers: TerminalHandlers): void {
    this.ensureTerm();
    this.deskId = deskId;
    this.handlers = handlers;
    this.titleEl.textContent = title;
    this.setStatus(status);
    this.root.style.display = "flex";
    this.term!.clear();
    this.term!.reset();
    requestAnimationFrame(() => {
      this.refit();
      this.term?.focus();
    });
  }

  write(data: string): void {
    this.term?.write(data);
  }

  setStatus(status: WorkerStatus): void {
    this.statusText.textContent = STATUS_LABEL[status];
    this.statusDot.style.background = STATUS_COLOR[status];
  }

  close(): void {
    this.root.style.display = "none";
    this.deskId = null;
    this.handlers = null;
  }
}
