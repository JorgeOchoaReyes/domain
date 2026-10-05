import { randomUUID } from "node:crypto";
import type { AgentKind, Report, WorkerStatus } from "../shared/protocol.js";
import { AGENT_LABELS } from "../shared/protocol.js";
import type { IWorkerSession } from "./workerSession.js";

/**
 * A simulated agent worker.
 *
 * This is the scripted stub behind a desk: instead of spawning a real PTY and
 * a real agent CLI, it fakes a terminal session — a boot banner, a prompt,
 * line editing, and a scripted response when you submit a prompt. It is used
 * as a fallback when no local terminal backend is available, or when the
 * server is started in simulate mode (DOMAIN_SIMULATE=1), so the app always
 * runs even with no agent CLIs installed.
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
type ReportListener = (report: Report) => void;
type SayListener = (text: string) => void;

export class SimulatedWorker implements IWorkerSession {
  readonly id = randomUUID();
  readonly agent: AgentKind;

  private status: WorkerStatus = "booting";
  private activity = "Booting up…";
  private scrollback = "";
  private line = ""; // current, unsubmitted input line
  private timers = new Set<NodeJS.Timeout>();
  private disposed = false;
  private note?: string;

  private outputListeners = new Set<OutputListener>();
  private statusListeners = new Set<StatusListener>();
  private reportListeners = new Set<ReportListener>();
  private sayListeners = new Set<SayListener>();
  private taskCount = 0;
  /** What it has worked on so far, for its progress report at a round-up. */
  private history: string[] = [];

  constructor(agent: AgentKind, note?: string) {
    this.agent = agent;
    this.note = note;
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

  onReport(listener: ReportListener): () => void {
    this.reportListeners.add(listener);
    return () => this.reportListeners.delete(listener);
  }

  onSay(listener: SayListener): () => void {
    this.sayListeners.add(listener);
    return () => this.sayListeners.delete(listener);
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
    this.reportListeners.clear();
    this.sayListeners.clear();
  }

  // --- office hours ---------------------------------------------------------

  /** Called to the manager's office: put together a progress report. */
  summon(): void {
    if (this.disposed) return;
    this.emit(`
${MAGENTA}▸ called to office hours — preparing a progress report…${RESET}
`);
    this.setStatus("presenting", "Preparing a progress report");
    this.later(2200, () => {
      const done = this.history.slice(-4);
      const report: Report = {
        status: "ready",
        title: done.length ? `Progress update: ${done.length} task${done.length > 1 ? "s" : ""}` : "Progress update: just getting started",
        summary: done.length
          ? `Here's where I am. I've worked through ${done.length} task${done.length > 1 ? "s" : ""} since I sat down, and everything is ready for your review.`
          : "I haven't been given a task yet, so there's not much to show. I'm set up, I've read the repository, and I'm ready for my first assignment.",
        slides: done.length
          ? [...done.map((t) => `Done: ${t.length > 60 ? t.slice(0, 60) + "…" : t}`), "Next: whatever you'd like me to pick up"]
          : ["Set up at my desk", "Read through the repository", "Waiting for my first task"],
        at: Date.now(),
      };
      this.emit(`${GREEN}▸ report ready — lined up outside your office${RESET}

`);
      for (const l of this.reportListeners) l(report);
    });
  }

  /** Put on a task from one of the manager's goals; plan-first tasks present a plan before any work. */
  assign(title: string, planFirst = false): void {
    if (this.disposed) return;
    this.emit(`\r\n${YELLOW}🎯 New task:${RESET} ${title}\r\n`);
    this.line = "";
    if (!planFirst) {
      this.submit(title);
      return;
    }
    this.emit(`${MAGENTA}▸ plan first — sketching an approach before touching anything…${RESET}\r\n`);
    this.setStatus("working", `🧠 Planning: ${title}`);
    this.later(2600, () => {
      const short = title.length > 50 ? title.slice(0, 50) + "…" : title;
      const plan: Report = {
        status: "plan",
        title: `Plan: ${short}`,
        summary: `Here's how I'd tackle "${short}". I'll keep the change small and covered by tests. Say go and I'll build it, or tell me what to change.`,
        slides: [
          "Read the code it touches and the existing tests",
          "Make the change in one focused commit",
          "Add or update tests for the new behaviour",
          "Risk: other callers of the same code — I'll check them",
        ],
        at: Date.now(),
      };
      this.emit(`${GREEN}▸ plan ready — lined up to present it${RESET}\r\n\r\n`);
      for (const l of this.reportListeners) l(plan);
    });
  }

  /** A one-off job from the loop (plan a goal, ship it): act it out, then hand over. */
  act(activity: string, steps: string[], done: () => void): void {
    if (this.disposed) return;
    this.emit(`\r\n${YELLOW}▸ ${activity}${RESET}\r\n`);
    this.setStatus("working", activity);
    const lines = steps.length ? steps : ["· working on it…"];
    let i = 0;
    const tick = () => {
      if (i < lines.length) {
        this.emit(`${DIM}${lines[i]}${RESET}\r\n`);
        i++;
        this.later(650, tick);
        return;
      }
      done();
      this.emit(`${GREEN}▸ done.${RESET}\r\n\r\n`);
      this.setStatus("idle", "Idle — ready for a task");
      this.prompt();
    };
    this.later(500, tick);
  }

  /** The manager said something during the review: answer back. */
  tell(text: string): void {
    if (this.disposed) return;
    this.emit(`${CYAN}[Office hours] you:${RESET} ${text}
`);
    const q = text.toLowerCase();
    const reply = /\?\s*$|^(what|why|how|when|which|can|could|did|do|is|are)/.test(q)
      ? "Good question. Short answer: I kept it simple and covered the main path. I can dig deeper on that if you want."
      : /(good|great|nice|love|perfect|thanks)/.test(q)
        ? "Thank you! I'll keep going in the same direction."
        : /(change|fix|instead|don't|dont|rather|should)/.test(q)
          ? "Understood. I'll make that change as soon as we're done here."
          : "Got it, I've noted that down.";
    this.later(1300, () => {
      this.emit(`${this.color()}${this.label()}:${RESET} ${reply}
`);
      for (const l of this.sayListeners) l(reply);
    });
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
    if (this.note) this.emit(`${DIM}${this.note}${RESET}\r\n`);
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
    if (task.startsWith("[Review] Approved")) {
      this.emit(`${GREEN}▸ approved — back to my desk.${RESET}\r\n\r\n`);
      this.setStatus("idle", "Approved — ready for the next task");
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
        this.present(task);
      }
    };
    this.later(500, tick);
  }

  /**
   * Produce a report and line up to present it. Every third task "blocks" on a
   * question instead of finishing, so the two report kinds are both exercised.
   */
  private present(task: string): void {
    this.taskCount++;
    this.history.push(task);
    const blocked = this.taskCount % 3 === 0;
    const short = task.length > 46 ? task.slice(0, 46) + "…" : task;

    const report: Report = blocked
      ? {
          status: "blocked",
          title: `Need a decision: ${short}`,
          summary: `I started on "${short}" but hit a fork I should not pick alone. I need your call before I continue.`,
          slides: [
            `Task: ${short}`,
            "Explored two viable approaches",
            "Blocked on which direction you prefer",
          ],
          question: "Which approach should I take — the simple one or the thorough one?",
          at: Date.now(),
        }
      : {
          status: "ready",
          title: `Finished: ${short}`,
          summary: `I finished "${short}". Here is a quick rundown of what changed so you can review and tell me to continue or adjust.`,
          slides: [
            `Task: ${short}`,
            "Implemented the change end to end",
            "Added a couple of tests",
            "Ready for your review",
          ],
          at: Date.now(),
        };

    this.emit(
      blocked
        ? `${YELLOW}▸ lined up to present (blocked): ${report.title}${RESET}\r\n\r\n`
        : `${GREEN}▸ lined up to present: ${report.title}${RESET}\r\n\r\n`,
    );
    this.setStatus("presenting", blocked ? "Waiting to present (blocked)" : "Waiting to present");
    for (const l of this.reportListeners) l(report);
  }
}
