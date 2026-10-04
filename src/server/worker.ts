import { randomUUID } from "node:crypto";
import type { AgentKind, WorkerStatus } from "../shared/protocol.js";
import { AGENT_LABELS } from "../shared/protocol.js";

/**
 * A simulated agent worker.
 *
 * This is the "stub" behind every desk: instead of spawning a real PTY and a
 * real agent CLI, it fakes a terminal session — a boot banner, a prompt, line
 * editing, and a scripted response when you submit a prompt. The surface it
 * exposes (onOutput / onStatus / write / resize / scrollback) is deliberately
 * the same shape a real PTY-backed worker would have, so swapping in a real
 * agent later means replacing this class, not the server around it.
 */

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const DIM = `${ESC}2m`;
const BOLD = `${ESC}1m`;
const CYAN = `${ESC}36m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const MAGENTA = `${ESC}35m`;

const AGENT_COLOR: Record<AgentKind, string> = {
  claude: MAGENTA,
  codex: GREEN,
  opencode: CYAN,
  gemini: YELLOW,
};

type OutputListener = (data: string) => void;
type StatusListener = (status: WorkerStatus, activity: string) => void;

export class WorkerSession {
  readonly id = randomUUID();
  readonly agent: AgentKind;

  private status: WorkerStatus = "booting";
  private activity = "Booting up…";
  private scrollback = "";
  private line = ""; // current, unsubmitted input line
  private timers = new Set<NodeJS.Timeout>();
  private disposed = false;

  private outputListeners = new Set<OutputListener>();
  private statusListeners = new Set<StatusListener>();

  constructor(agent: AgentKind) {
    this.agent = agent;
    this.boot();
  }

  // --- subscription -------------------------------------------------------

  onOutput(listener: OutputListener): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  getStatus(): WorkerStatus {
    return this.status;
  }

  getActivity(): string {
    return this.activity;
  }

  getScrollback(): string {
    return this.scrollback;
  }

  // --- input --------------------------------------------------------------

  /** Feed raw keystrokes from a client's terminal. */
  write(data: string): void {
    if (this.disposed || this.status === "booting") return;
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        this.emit("\r\n");
        this.submit(this.line.trim());
        this.line = "";
      } else if (ch === "\x7f" || ch === "\b") {
        // backspace
        if (this.line.length > 0) {
          this.line = this.line.slice(0, -1);
          this.emit("\b \b");
        }
      } else if (ch >= " ") {
        this.line += ch;
        this.emit(ch); // local echo
      }
    }
  }

  resize(_cols: number, _rows: number): void {
    // The simulated worker does not reflow to a size, but a real PTY-backed
    // worker would call pty.resize(cols, rows) here.
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.outputListeners.clear();
    this.statusListeners.clear();
  }

  // --- internals ----------------------------------------------------------

  private label(): string {
    return AGENT_LABELS[this.agent];
  }

  private color(): string {
    return AGENT_COLOR[this.agent];
  }

  private emit(data: string): void {
    if (this.disposed) return;
    this.scrollback += data;
    // Cap scrollback so a long-lived desk does not grow unbounded.
    const MAX = 64 * 1024;
    if (this.scrollback.length > MAX) {
      this.scrollback = this.scrollback.slice(this.scrollback.length - MAX);
    }
    for (const l of this.outputListeners) l(data);
  }

  private setStatus(status: WorkerStatus, activity: string): void {
    if (this.disposed) return;
    this.status = status;
    this.activity = activity;
    for (const l of this.statusListeners) l(status, activity);
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.disposed) fn();
    }, ms);
    this.timers.add(t);
  }

  private prompt(): void {
    this.emit(`${this.color()}${this.label()} ${DIM}›${RESET} `);
  }

  private boot(): void {
    const c = this.color();
    this.emit(`${c}${BOLD}${this.label()}${RESET}${DIM} — simulated worker${RESET}\r\n`);
    this.later(350, () => {
      this.emit(`${DIM}connecting to runtime…${RESET}\r\n`);
      this.later(450, () => {
        this.emit(`${GREEN}ready.${RESET} Type a task and press Enter.\r\n\r\n`);
        this.setStatus("idle", "Idle — ready for a task");
        this.prompt();
      });
    });
  }

  private submit(task: string): void {
    if (task === "") {
      this.prompt();
      return;
    }
    if (task === "clear") {
      this.emit("\x1b[2J\x1b[H");
      this.prompt();
      return;
    }
    if (task === "help") {
      this.emit(
        `${DIM}This is a simulated agent. Any line you type is "worked on".` +
          `\r\nCommands: ${RESET}help, clear\r\n\r\n`,
      );
      this.prompt();
      return;
    }

    this.setStatus("working", `Working: ${task.slice(0, 40)}`);
    const steps = [
      `${DIM}· reading the task…${RESET}`,
      `${DIM}· scanning the repository…${RESET}`,
      `${DIM}· drafting a plan…${RESET}`,
      `${DIM}· making changes…${RESET}`,
    ];
    let i = 0;
    const tick = () => {
      if (i < steps.length) {
        this.emit(steps[i] + "\r\n");
        i++;
        this.later(600, tick);
      } else {
        // Occasionally "block" on a question so the waiting state is visible.
        if (Math.random() < 0.3) {
          this.emit(`${YELLOW}? I need a decision before continuing.${RESET}\r\n`);
          this.emit(`${DIM}(answer, then Enter)${RESET}\r\n\r\n`);
          this.setStatus("waiting", "Waiting on you");
          this.prompt();
        } else {
          this.finish(task);
        }
      }
    };
    this.later(500, tick);
  }

  private finish(task: string): void {
    this.emit(`${GREEN}✓ done:${RESET} ${task}\r\n\r\n`);
    this.setStatus("done", "Finished — needs review");
    this.prompt();
    // Settle back to idle after a short celebration.
    this.later(4000, () => {
      if (this.status === "done") this.setStatus("idle", "Idle — ready for a task");
    });
  }
}
