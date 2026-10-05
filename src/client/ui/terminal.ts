import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { WorkerStatus } from "../../shared/protocol.js";
import { STATUS_BULB } from "../scene/characters.js";
import { openModal, type Modal } from "./modal.js";

const STATUS_LABEL: Record<WorkerStatus, string> = {
  booting: "starting",
  idle: "ready",
  working: "working",
  waiting: "needs you",
  presenting: "presenting",
  done: "done",
  asleep: "asleep",
};

export interface TerminalHandlers {
  onInput(data: string): void;
  onResize(cols: number, rows: number): void;
  onFire(): void;
  onClose(): void;
}

/**
 * A worker's terminal in a window. One xterm is created lazily and kept; each
 * open() moves it into a fresh window and attaches it to a desk.
 */
export class TerminalOverlay {
  private host = document.createElement("div");
  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private handlers: TerminalHandlers | null = null;
  private modal: Modal | null = null;
  private pill: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  deskId: string | null = null;

  constructor() {
    this.host.className = "term-host";
  }

  get isOpen(): boolean {
    return this.modal !== null;
  }

  private ensureTerm(): void {
    if (this.term) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 14,
      theme: {
        background: "#1e1f2e",
        foreground: "#cdd6f4",
        cursor: "#ff8a5b",
        selectionBackground: "#585b70",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(this.host);
    term.onData((data) => this.handlers?.onInput(data));
    // Esc goes to the worker with Ctrl+[; plain Esc closes the window.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.key === "Escape") {
        this.handlers?.onClose();
        return false;
      }
      return true;
    });
    this.term = term;
    this.fit = fit;
    this.resizeObserver = new ResizeObserver(() => this.refit());
    this.resizeObserver.observe(this.host);
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
    this.modal = openModal({
      title,
      icon: "💻",
      className: "term",
      body: this.host,
      footer: `<span class="pill status"></span><span class="grow">Esc closes · Ctrl+[ sends Esc to the agent</span><button class="btn small term-copy" title="Copy what's selected — or all of it">📋 Copy</button><button class="btn small term-big" title="Bigger / smaller">⤢ Enlarge</button><button class="btn danger fire">👋 Send home</button>`,
      onClose: () => {
        this.modal = null;
        this.deskId = null;
        const h = this.handlers;
        this.handlers = null;
        h?.onClose();
      },
    });
    this.pill = this.modal.footer!.querySelector(".status");
    this.modal.footer!.querySelector(".fire")!.addEventListener("click", () => this.handlers?.onFire());
    // Bigger: nearly the whole window (and back).
    const big = this.modal.footer!.querySelector<HTMLButtonElement>(".term-big")!;
    big.addEventListener("click", () => {
      const el = this.host.closest(".modal");
      const on = !el?.classList.contains("big");
      el?.classList.toggle("big", on);
      big.textContent = on ? "⤡ Smaller" : "⤢ Enlarge";
      requestAnimationFrame(() => this.refit());
    });
    // Copy: the selection if there is one, else everything in the terminal.
    const copy = this.modal.footer!.querySelector<HTMLButtonElement>(".term-copy")!;
    copy.addEventListener("click", () => {
      const t = this.term;
      if (!t) return;
      let text = t.getSelection();
      if (!text) {
        const b = t.buffer.active;
        const lines: string[] = [];
        for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? "");
        text = lines.join("\n").replace(/\n+$/, "\n");
      }
      void navigator.clipboard.writeText(text).then(
        () => {
          copy.textContent = "✅ Copied";
          setTimeout(() => (copy.textContent = "📋 Copy"), 1500);
        },
        () => (copy.textContent = "Couldn't copy"),
      );
    });
    this.setStatus(status);
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
    if (!this.pill) return;
    this.pill.textContent = STATUS_LABEL[status];
    this.pill.style.background = STATUS_BULB[status];
  }

  close(): void {
    this.modal?.close();
  }
}
