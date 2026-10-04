import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { AgentKind, WorkerStatus } from "../shared/protocol.js";
import { AGENT_LABELS } from "../shared/protocol.js";
import type { IWorkerSession } from "./workerSession.js";

/**
 * A worker backed by a real pseudo-terminal on the host machine.
 *
 * It spawns the user's shell in the project directory and (optionally) runs an
 * agent CLI inside it, then streams that terminal to the browser and feeds
 * keystrokes back. This is what makes the office drive real local agents.
 *
 * The native PTY module is loaded lazily with createRequire so the server
 * still imports and runs (in simulated mode) on platforms where the prebuilt
 * binary is missing. `ptyAvailable` reflects whether the load succeeded.
 */

// Minimal shape of the bits of @lydell/node-pty we use.
interface IPty {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
interface PtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    },
  ): IPty;
}

const nodeRequire = createRequire(import.meta.url);
let ptyModule: PtyModule | null = null;
try {
  ptyModule = nodeRequire("@lydell/node-pty") as PtyModule;
} catch {
  ptyModule = null;
}

/** True when a real terminal backend loaded successfully on this host. */
export const ptyAvailable = ptyModule !== null;

const ESC = "\x1b[";
const DIM = `${ESC}2m`;
const RESET = `${ESC}0m`;
const YELLOW = `${ESC}33m`;

export interface PtyWorkerOptions {
  cwd: string;
  /** Command to run inside the shell (an agent CLI), or null for a bare shell. */
  launch: string | null;
  /** When the agent CLI was not found, its label — shown as a hint. */
  missingLabel: string | null;
  /** The desk id — exposed to the agent as $DOMAIN_DESK for its report file. */
  deskId: string;
  /** Absolute reports directory — exposed as $DOMAIN_REPORTS. */
  reportsDir: string;
}

type OutputListener = (data: string) => void;
type StatusListener = (status: WorkerStatus, activity: string) => void;

export class PtyWorker implements IWorkerSession {
  readonly id = randomUUID();
  readonly agent: AgentKind;

  private pty: IPty;
  private status: WorkerStatus = "booting";
  private activity = "Booting up…";
  private scrollback = "";
  private disposed = false;

  private outputListeners = new Set<OutputListener>();
  private statusListeners = new Set<StatusListener>();

  constructor(agent: AgentKind, opts: PtyWorkerOptions) {
    if (!ptyModule) throw new Error("PTY backend unavailable");
    this.agent = agent;

    const shell = defaultShell();
    this.pty = ptyModule.spawn(shell.file, shell.args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: opts.cwd,
      env: {
        ...process.env,
        DOMAIN_WORKER: "1",
        TERM: "xterm-256color",
        // Where the agent should drop its presentation when it reaches a
        // checkpoint. See .domain/BRIEF.md for the contract.
        DOMAIN_DESK: opts.deskId,
        DOMAIN_REPORTS: opts.reportsDir,
        DOMAIN_REPORT_FILE: `${opts.reportsDir}/${opts.deskId}.json`,
      },
    });

    this.pty.onData((data) => this.emit(data));
    this.pty.onExit(() => {
      if (!this.disposed) this.setStatus("done", "Session ended");
    });

    // A real shell is ready as soon as it is spawned.
    this.setStatus("idle", opts.launch ? `Running ${AGENT_LABELS[agent]}` : "Shell ready");

    if (opts.launch) {
      // Hand the agent CLI to the shell so it runs in the real terminal.
      this.pty.write(`${opts.launch}\r`);
      this.setStatus("working", `${AGENT_LABELS[agent]} running`);
    } else if (opts.missingLabel) {
      this.emit(
        `${YELLOW}${opts.missingLabel} CLI not found on PATH.${RESET} ` +
          `${DIM}This is a real local shell — install the CLI, or run any command.${RESET}\r\n`,
      );
    }
  }

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

  write(data: string): void {
    if (this.disposed) return;
    try {
      this.pty.write(data);
    } catch {
      /* terminal may have exited between frames */
    }
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    try {
      this.pty.resize(Math.max(2, Math.floor(cols)), Math.max(1, Math.floor(rows)));
    } catch {
      /* ignore resize on a dead pty */
    }
  }

  dispose(): void {
    this.disposed = true;
    try {
      this.pty.kill();
    } catch {
      /* already gone */
    }
    this.outputListeners.clear();
    this.statusListeners.clear();
  }

  private emit(data: string): void {
    if (this.disposed) return;
    this.scrollback += data;
    const MAX = 128 * 1024;
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
}

function defaultShell(): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: process.env.COMSPEC ?? "powershell.exe", args: [] };
  }
  // Login + interactive so the user's PATH and rc files are loaded.
  return { file: process.env.SHELL ?? "/bin/bash", args: ["-l", "-i"] };
}
