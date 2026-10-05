import { doingFrom } from "./doing.js";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { AgentKind, WorkerStatus } from "../shared/protocol.js";
import { AGENT_LABELS } from "../shared/protocol.js";
import { enterDelay, type IWorkerSession } from "./workerSession.js";

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
export interface IPty {
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

/** Spawn a process in a real terminal, or return null when there's no backend. */
export function spawnPty(file: string, args: string[], options: Parameters<PtyModule["spawn"]>[2]): IPty | null {
  return ptyModule ? ptyModule.spawn(file, args, options) : null;
}

const ESC = "\x1b[";
const DIM = `${ESC}2m`;
const RESET = `${ESC}0m`;
const YELLOW = `${ESC}33m`;

/** A terminal with no window: fed the same output, it knows what's on screen. */
type HeadlessTerminal = {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
  rows: number;
  buffer: { active: { viewportY: number; getLine(y: number): { translateToString(trim?: boolean): string } | undefined } };
};
let HeadlessCtor: (new (o: { cols: number; rows: number; scrollback: number; allowProposedApi: boolean }) => HeadlessTerminal) | null = null;
try {
  HeadlessCtor = (createRequire(import.meta.url)("@xterm/headless") as { Terminal: typeof HeadlessCtor }).Terminal;
} catch {
  /* without it, the screen is read from the raw output instead */
}

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
  /** Absolute replies directory — its file is exposed as $DOMAIN_REPLY_FILE. */
  repliesDir: string;
  /** Extra environment for the agent (e.g. pointing it at its MCP config). */
  env?: Record<string, string>;
  /** You've said this project's worker folders can be trusted: answer the agent's trust prompt. */
  autoTrust?: () => boolean;
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
  /** Briefs typed before the agent was ready, in order. */
  private queue: string[] = [];
  private ready = true;
  private launchedAt = 0;
  /** The folder the agent runs in (its shell prompt names it once the agent quits). */
  private cwd = "";
  /** What it's doing in a word or three (see doing.ts), and who wants to know when it changes. */
  private doingNow = "";
  private doingListeners = new Set<() => void>();
  /** Where this desk's report and reply go (typed out in full: see withPaths). */
  private paths = { report: "", reply: "", reports: "", desk: "" };
  /** Already skipped an "update available" menu this many times. */
  private updatesSkipped = 0;
  /** The agent quit back to the shell: nothing more is typed until it's running again. */
  private exited = false;
  private promptSince = 0;
  private autoTrust: () => boolean;
  private lastOutputAt = 0;
  /** When the question now on screen first showed up (0: none). */
  private askingSince = 0;
  private readyTimer: ReturnType<typeof setInterval> | null = null;
  /** The agent asked whether to trust its folder: waiting on you. */
  private trustAsked = false;
  /** Where in the scrollback to look for a startup prompt from. */
  private scanFrom = 0;
  /** What's on the agent's screen right now (null when the emulator isn't there). */
  private term: HeadlessTerminal | null = HeadlessCtor ? new HeadlessCtor({ cols: 80, rows: 24, scrollback: 0, allowProposedApi: true }) : null;
  /** Output since the last pause (bytes), and when that run began: a real burst means it's working. */
  private burst = 0;
  /** Once ready: watching for it to go quiet (free), ask you something (needs you), or start again. */
  private watchTimer: ReturnType<typeof setInterval> | null = null;

  private outputListeners = new Set<OutputListener>();
  private statusListeners = new Set<StatusListener>();

  constructor(agent: AgentKind, opts: PtyWorkerOptions) {
    if (!ptyModule) throw new Error("PTY backend unavailable");
    this.agent = agent;
    this.autoTrust = opts.autoTrust ?? (() => false);
    this.cwd = opts.cwd;
    this.paths = {
      report: join(opts.reportsDir, `${opts.deskId}.json`),
      reply: join(opts.repliesDir, `${opts.deskId}.json`),
      reports: opts.reportsDir,
      desk: opts.deskId,
    };

    const shell = defaultShell();
    this.pty = ptyModule.spawn(shell.file, shell.args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: opts.cwd,
      env: {
        ...workerEnv(process.env),
        DOMAIN_WORKER: "1",
        TERM: "xterm-256color",
        // Where the agent should drop its presentation when it reaches a
        // checkpoint. See .domain/BRIEF.md for the contract.
        DOMAIN_DESK: opts.deskId,
        DOMAIN_REPORTS: opts.reportsDir,
        DOMAIN_REPORT_FILE: join(opts.reportsDir, `${opts.deskId}.json`),
        DOMAIN_REPLY_FILE: join(opts.repliesDir, `${opts.deskId}.json`),
        ...opts.env,
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
      this.setStatus("working", `${AGENT_LABELS[agent]} starting…`);
      this.ready = false;
      this.launchedAt = Date.now();
      this.scanFrom = this.scrollback.length;
      this.readyTimer = setInterval(() => this.checkReady(), 250);
      this.readyTimer.unref?.();
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

  /**
   * Answer the agent's "trust this folder?" with yes: move the highlight until
   * it's on the yes option (read off the screen, never assumed), then Enter.
   * Returns whether it got there; if the screen can't be read, the prompt is
   * left for you.
   */
  async trust(): Promise<boolean> {
    if (!this.trustAsked || this.disposed) return false;
    this.setStatus("working", `${AGENT_LABELS[this.agent]} starting…`);
    let from = this.scanFrom;
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 350));
      // What's highlighted on screen now; the raw output since the last key as a fallback.
      const choice = highlighted(this.screen().join("\n")) ?? highlighted(plain(this.scrollback.slice(from)));
      if (choice === null) break;
      if (YES_OPTION.test(choice)) {
        this.pty.write("\r");
        this.trustAsked = false;
        this.scanFrom = this.scrollback.length;
        this.lastOutputAt = Date.now();
        return true;
      }
      from = this.scrollback.length;
      this.pty.write("\x1b[B");
    }
    this.setStatus("waiting", `${AGENT_LABELS[this.agent]} asks whether to trust this folder — answer in its terminal`);
    return false;
  }

  /** Whether it's stopped at a trust prompt. */
  get askingTrust(): boolean {
    return this.trustAsked;
  }

  send(data: string): void {
    // Never type a brief into a bare shell: it would run as commands.
    if (this.exited) return;
    data = this.withPaths(data);
    if (this.ready) this.write(data);
    else this.queue.push(data);
  }

  write(data: string): void {
    if (this.disposed) return;
    // You answered the startup prompt: look for the agent's screen again.
    if (this.trustAsked) {
      this.trustAsked = false;
      this.scanFrom = this.scrollback.length;
      this.lastOutputAt = Date.now();
      this.setStatus("working", `${AGENT_LABELS[this.agent]} starting…`);
    }
    try {
      this.pty.write(data);
    } catch {
      /* terminal may have exited between frames */
    }
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    const c = Math.max(2, Math.floor(cols));
    const r = Math.max(1, Math.floor(rows));
    try {
      this.pty.resize(c, r);
      this.term?.resize(c, r);
    } catch {
      /* ignore resize on a dead pty */
    }
  }

  /** The lines on the agent's screen now (from the raw output when there's no emulator). */
  screen(): string[] {
    const t = this.term;
    if (!t) return plain(this.scrollback.slice(-6000)).split("\n").slice(-30);
    const b = t.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < t.rows; y++) out.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? "");
    return out;
  }

  /**
   * Ready once the agent's screen has settled (quiet for a moment after it
   * drew something), unless it's asking whether to trust this folder — then
   * it's waiting on you, and briefs wait too.
   */
  private checkReady(): void {
    if (this.ready || this.disposed) return;
    const now = Date.now();
    if (!this.trustAsked && (TRUST_PROMPT.test(this.screen().join("\n")) || TRUST_PROMPT.test(plain(this.scrollback.slice(this.scanFrom))))) {
      this.trustAsked = true;
      if (this.autoTrust()) void this.trust();
      else this.setStatus("waiting", `${AGENT_LABELS[this.agent]} asks whether to trust this folder — answer in its terminal`);
      return;
    }
    if (this.trustAsked) return;
    if (this.skipUpdateMenu()) return;
    // Still loading (Codex shows "model: loading" until it's connected): anything typed now is lost.
    if (STILL_LOADING.test(this.screen().join("\n"))) {
      if (now - this.launchedAt > 90_000 && this.status !== "waiting") {
        this.setStatus("waiting", `${AGENT_LABELS[this.agent]} is stuck starting up (its model won't load) — check its terminal: signed in? online?`);
      }
      return;
    }
    // Settled: the agent drew its screen (more than the shell echoing the command) and went quiet.
    const drawn = this.scrollback.length - this.scanFrom > DRAWN;
    const settled = drawn && now - this.lastOutputAt > 1500 && now - this.launchedAt > 2500;
    // A CLI that draws nothing we recognise still gets its brief eventually.
    if (settled || now - this.launchedAt > 45_000) this.becomeReady();
  }

  private becomeReady(): void {
    this.ready = true;
    if (this.readyTimer) clearInterval(this.readyTimer);
    this.readyTimer = null;
    const queued = this.queue.splice(0);
    // With a brief waiting, whatever the office set meanwhile ("🧠 Planning…") stays on the desk.
    if (this.status !== "waiting") this.setStatus("working", queued.length ? "" : `${AGENT_LABELS[this.agent]} ready`);
    // Typed one piece at a time, spaced as typeLine spaces them.
    queued.forEach((d, i) => setTimeout(() => this.write(d), i * enterDelay(this.agent)));
    this.watchTimer = setInterval(() => this.watch(), 1000);
    this.watchTimer.unref?.();
  }

  /**
   * After start-up, what the screen says about the agent: quiet for a while
   * means it's done and free; a question on screen ("Do you want to…",
   * "Allow command?") means it needs you. Output starting up again (see emit)
   * means it's back at work.
   */
  private watch(): void {
    if (this.disposed || this.trustAsked || (this.status === "done" && !this.exited)) return;
    const quiet = Date.now() - this.lastOutputAt;
    // Read the actual screen: agents redraw only what changes, so the raw
    // output often doesn't contain the question that's sitting on screen.
    const screen = this.screen();
    if (this.skipUpdateMenu(screen)) return;
    // The agent quit and left its shell: say so, and stop typing into it.
    const atPrompt = looksLikeShellPrompt(screen, this.cwd);
    if (!atPrompt) this.promptSince = 0;
    else if (!this.promptSince) this.promptSince = Date.now();
    if (atPrompt && !this.exited && Date.now() - this.promptSince >= 3000) {
      this.exited = true;
      this.setStatus("done", `${AGENT_LABELS[this.agent]} quit — open its terminal to start it again`);
      return;
    }
    if (this.exited) {
      if (!atPrompt && Date.now() - this.lastOutputAt < 3000) {
        // Started again in its terminal: back in business.
        this.exited = false;
        this.setStatus("working", `${AGENT_LABELS[this.agent]} is back`);
      }
      return;
    }
    // What it's on, in a word or three, for the bubble over its desk.
    const doing = this.status === "working" ? doingFrom(screen) : "";
    if (doing !== this.doingNow) {
      this.doingNow = doing;
      for (const l of this.doingListeners) l();
    }
    const asking = ASKING.test(screen.join("\n"));
    // On screen for a moment and it's a real question — even while a spinner keeps drawing under it.
    if (!asking) this.askingSince = 0;
    else if (!this.askingSince) this.askingSince = Date.now();
    if (asking && this.status !== "waiting" && Date.now() - this.askingSince >= 2000) {
      this.setStatus("waiting", `${AGENT_LABELS[this.agent]} is asking you something — answer in its terminal`);
    } else if (!asking && this.status === "waiting") {
      // Answered (here or in its terminal): back to it, or free if it's gone quiet.
      this.setStatus(quiet >= QUIET_MS ? "idle" : "working", "");
    } else if (this.status === "working" && quiet >= QUIET_MS) {
      this.setStatus("idle", "");
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.readyTimer) clearInterval(this.readyTimer);
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.term?.dispose();
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
    const now = Date.now();
    // A run of output after a pause: once it's more than a cursor blink, it's working again.
    this.burst = now - this.lastOutputAt > 1500 ? data.length : this.burst + data.length;
    this.lastOutputAt = now;
    this.term?.write(data);
    // Back at work after a pause (a question on screen stays "needs you": a repaint isn't an answer).
    if (this.ready && this.status === "idle" && this.burst > BURST) this.setStatus("working", "");
    this.scrollback += data;
    const MAX = 128 * 1024;
    if (this.scrollback.length > MAX) {
      this.scrollback = this.scrollback.slice(this.scrollback.length - MAX);
    }
    for (const l of this.outputListeners) l(data);
  }

  doing(): string {
    return this.doingNow;
  }

  onDoing(listener: () => void): () => void {
    this.doingListeners.add(listener);
    return () => this.doingListeners.delete(listener);
  }

  /** The office's instructions with this desk's real file paths in place of the variables. */
  private withPaths(text: string): string {
    return text
      .replace(/\$DOMAIN_REPORT_FILE\b/g, this.paths.report)
      .replace(/\$DOMAIN_REPLY_FILE\b/g, this.paths.reply)
      .replace(/\$DOMAIN_REPORTS\b/g, this.paths.reports)
      .replace(/\$DOMAIN_DESK\b/g, this.paths.desk);
  }

  /**
   * Codex (and others) can open with an "Update available" menu whose first
   * option installs the update and quits — and any "1" typed into it picks
   * that. Skip it (Esc) before anything else is typed; you update on your own.
   */
  private skipUpdateMenu(screen = this.screen()): boolean {
    if (this.updatesSkipped >= 3 || !UPDATE_MENU.test(screen.join("\n"))) return false;
    this.updatesSkipped++;
    try {
      this.pty.write("\x1b");
    } catch {
      /* gone */
    }
    this.lastOutputAt = Date.now();
    return true;
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

/** An agent CLI's first screen is well over this much output; a shell echoing the command is under it. */
const DRAWN = 800;
/** This long without output and an agent is done with what it was doing. */
const QUIET_MS = 8000;
/** More than this much output in one run and it's working again (not just a cursor or a clock). */
const BURST = 400;
/** An agent asking for permission or a choice: Claude Code, Codex, Gemini CLI, and plain y/n. */
export const ASKING =
  /do\s*you\s*want\s*to\s*(?:proceed|make\s*this\s*edit|create|run|allow)|allow\s*(?:this\s*)?(?:command|execution|edit)\??|approve\s*this|\(y\/n\)|\[y\/n\]|press\s*enter\s*to\s*confirm|yes,\s*proceed\s*\(y\)/i;

/** Claude Code, Codex and Gemini CLI each ask, on a folder they haven't seen, whether to trust it. */
export const TRUST_PROMPT = /trust (?:this folder|the (?:contents|files) (?:of|in) this (?:directory|folder))|do you trust/i;

/** The "yes" in a trust prompt (Claude Code: "Yes, I trust this folder"; Codex and Gemini: "Yes…", "Trust folder"). */
const YES_OPTION = /^(?:\d+\.\s*)?(?:yes|trust\b)/i;

/** The option a menu has highlighted ("❯ No, exit"), from the latest repaint; null if there's none. */
export function highlighted(screen: string): string | null {
  const marks = [...screen.matchAll(/[❯›▶>]\s*([^\n❯›▶>]{2,80})/g)];
  return marks.length ? marks[marks.length - 1][1].trim() : null;
}

/** Terminal output as text: escape codes gone, cursor moves read as spaces, jumps to a row as new lines. */
export function plain(s: string): string {
  return s
    .replace(/\x1b\[\d+;\d+H/g, "\n")
    .replace(/\x1b\[\d*C/g, " ")
    .replace(/\x1b\[[0-9;?>]*[ -\/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "");
}

/** A startup menu offering to update the CLI (Codex: "Update available … 1. Update now 2. Skip"). */
export const UPDATE_MENU = /update\s*available[\s\S]*\bskip\b/i;

/**
 * The agent's gone and its shell is waiting: the screen's last line is a shell
 * prompt in the agent's folder — cmd ("C:\\…\\desk-2>"), PowerShell
 * ("PS C:\\…>"), or a POSIX shell ("…/desk-2 $", "desk-2 %").
 */
export function looksLikeShellPrompt(screen: string[], cwd: string): boolean {
  const last = [...screen].reverse().find((l) => l.trim())?.trimEnd() ?? "";
  if (!last || !cwd) return false;
  const base = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  if (/^(?:PS )?[A-Za-z]:\\.*>$/.test(last)) return true;
  // A long cmd prompt wraps: its last line ends "\desk-2>".
  if (base && last.toLowerCase().endsWith(`\\${base.toLowerCase()}>`)) return true;
  return /[$%#]$/.test(last) && !!base && last.includes(base);
}


/** An agent still connecting: Codex's header reads "model: loading" until it is. */
export const STILL_LOADING = /model:\s*loading\b/i;

/**
 * The environment a worker's shell starts with: yours, minus the markers a
 * Claude Code session sets for its own children (the app launched from a
 * Claude Code terminal would otherwise pass them on, and a worker's Claude
 * Code would think it's a sub-session — no transcripts, odd behaviour).
 */
export function workerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!/^(CLAUDECODE|CLAUDE_CODE_[A-Z_]*|CLAUDE_AGENT_SDK_[A-Z_]*)$/.test(k)) out[k] = v;
  return out;
}

