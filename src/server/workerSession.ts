import { freemem, totalmem } from "node:os";
import { existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import type { AgentKind, Report, WorkerStatus } from "../shared/protocol.js";
import { AGENT_LABELS } from "../shared/protocol.js";
import { SimulatedWorker } from "./worker.js";
import { PtyWorker, ptyAvailable } from "./ptyWorker.js";
import { isModelName, type Leash } from "../shared/policy.js";

/**
 * The contract every worker session fulfils, whether it is a real local
 * terminal (PtyWorker) or the scripted stub (SimulatedWorker). The server and
 * office only ever talk to this interface, so the two backends are
 * interchangeable.
 */
export interface IWorkerSession {
  readonly id: string;
  readonly agent: AgentKind;
  onOutput(listener: (data: string) => void): () => void;
  onStatus(listener: (status: WorkerStatus, activity: string) => void): () => void;
  getStatus(): WorkerStatus;
  getActivity(): string;
  getScrollback(): string;
  write(data: string): void;
  /**
   * Type something on the office's behalf (a brief, a review): held until the
   * agent's screen is up and nothing is waiting on you, so it isn't lost in a
   * startup prompt. Backends without one just write.
   */
  send?(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
  /** What it's doing right now, in a word or three, read off its screen (when the backend can tell). */
  doing?(): string;
  /** Told when that changes. */
  onDoing?(listener: () => void): () => void;
  /**
   * Some backends (the simulated worker) emit reports in-process. Real
   * terminal workers instead write report files that the server watches, so
   * this is optional.
   */
  onReport?(listener: (report: Report) => void): () => void;
  /**
   * The simulated worker acts out a round-up and talking back itself. Real
   * terminal workers have none of these: the office types the instruction
   * into their CLI instead, and they answer through reply files.
   */
  summon?(): void;
  /** The lines on its screen right now (real terminals). */
  screen?(): string[];
  /** Stopped at the agent's "trust this folder?": answer yes. Real terminals only. */
  trust?(): Promise<boolean>;
  readonly askingTrust?: boolean;
  /** Start on a task from a goal (the simulated worker just gets to work). */
  assign?(title: string, planFirst?: boolean): void;
  tell?(text: string): void;
  /** Act out a one-off job (plan, ship…) and call `done` at the end — simulated workers only. */
  act?(activity: string, steps: string[], done: () => void): void;
  onSay?(listener: (text: string) => void): () => void;
}

export interface CreateWorkerOptions {
  /** Working directory a real terminal starts in. */
  cwd: string;
  /** Force the scripted stub even when a terminal backend is available. */
  simulate: boolean;
  /** The model to launch the CLI on ("" = its default). */
  model?: string;
  /** How much it may do without asking. */
  leash?: Leash;
  /** More arguments for the agent's command line (already safe to type into a shell). */
  extraArgs?: string[];
  /** More environment for the agent. */
  env?: Record<string, string>;
  /** The desk this worker sits at — names its report file. */
  deskId: string;
  /** Answer the agent's trust prompt for you (you've trusted this project's worker folders). */
  autoTrust?: () => boolean;
  /** Pick up its last conversation (a worker woken after the office restarted). */
  resume?: boolean;
  /** Absolute path of the directory where report files are watched. */
  reportsDir: string;
  /** Absolute path of the directory where reply files are watched. */
  repliesDir: string;
}

/** The CLI command each agent kind launches when a real terminal is used. */
const AGENT_COMMAND: Record<AgentKind, string> = {
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
  gemini: "gemini",
};

/** Local model servers Codex can run on with `--oss`: `ollama/<model>` or `lmstudio/<model>`. */
const LOCAL_PROVIDERS = ["ollama", "lmstudio"] as const;

/**
 * The command line that starts an agent's CLI on a model and leash. Only flags
 * each CLI documents in its --help are used; a model name is validated before
 * it goes on a command line typed into a real shell.
 *
 * - Claude Code: `--model <alias|name>`; "auto" = `--permission-mode acceptEdits`.
 *   An Ollama model (`ollama/<m>`) runs as `--model <m>` with Claude Code
 *   pointed at Ollama's Anthropic-compatible API (see localEnv).
 * - Codex: `--model <name>`, or a local model (`ollama/<m>`, `lmstudio/<m>`)
 *   via `--oss --local-provider <p> --model <m>`; "auto" =
 *   `--sandbox workspace-write --ask-for-approval on-request` (edits in the
 *   project, asks before anything outside it).
 * - Gemini CLI: `--model <name>`; "auto" = `--approval-mode auto_edit`.
 * - OpenCode: `--model <provider/model>` (any provider it's configured for,
 *   local ones included); its own prompts decide edits.
 */
/**
 * Local models that can't "think": Codex asks every model to reason, and these
 * refuse ("does not support thinking"), so they run with reasoning off. Filled
 * in by detectLocalModels from what Ollama says each model can do.
 */
export const LOCAL_NO_THINKING = new Set<string>();

/** How big each local model is (bytes), as Ollama reports it — to warn before one can't fit in memory. */
export const LOCAL_MODEL_BYTES = new Map<string, number>();

/**
 * A warning when a local model won't fit (or barely fits) in this computer's
 * memory; null when it's fine or its size isn't known.
 */
export function localModelWarning(model: string, total = totalmem(), free = freemem()): string | null {
  const bytes = LOCAL_MODEL_BYTES.get(model);
  if (!bytes) return null;
  const gb = (n: number) => `${Math.round(n / 1024 ** 3)} GB`;
  const name = model.replace(/^[a-z]+\//, "");
  if (bytes > total * 0.75) return `${name} needs about ${gb(bytes)} of memory and this computer has ${gb(total)} — it will be very slow or fail. Pick a smaller model.`;
  if (bytes > free) return `${name} needs about ${gb(bytes)} of memory and ${gb(free)} is free right now — close some apps, or it may crawl.`;
  return null;
}

/**
 * Each CLI's own flags for a permission level (only flags in its --help):
 *
 * |          | Claude Code                         | Codex                                                     | Gemini CLI              |
 * | ask      | (its prompts)                       | --sandbox read-only --ask-for-approval on-request         | (its prompts)           |
 * | auto     | --permission-mode acceptEdits       | --sandbox workspace-write --ask-for-approval on-request   | --approval-mode auto_edit |
 * | safe     | --permission-mode auto              | --approve-for-me                                          | --approval-mode auto_edit |
 * | full     | --permission-mode bypassPermissions | --sandbox workspace-write --ask-for-approval never        | --approval-mode yolo    |
 *
 * Codex's "full" keeps its sandbox: it never asks, but it can't write outside
 * the worker's own folder. OpenCode has no flags for this (its config decides).
 */
export function leashFlags(agent: AgentKind, leash: Leash): string[] {
  if (agent === "claude") {
    return leash === "auto" ? ["--permission-mode", "acceptEdits"] : leash === "safe" ? ["--permission-mode", "auto"] : leash === "full" ? ["--permission-mode", "bypassPermissions"] : [];
  }
  if (agent === "codex") {
    if (leash === "ask") return ["--sandbox", "read-only", "--ask-for-approval", "on-request"];
    if (leash === "auto") return ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"];
    if (leash === "safe") return ["--approve-for-me"];
    return ["--sandbox", "workspace-write", "--ask-for-approval", "never"];
  }
  if (agent === "gemini") return leash === "ask" ? [] : leash === "full" ? ["--approval-mode", "yolo"] : ["--approval-mode", "auto_edit"];
  return [];
}

export function launchCommand(agent: AgentKind, model = "", leash: Leash = "ask", extraArgs: string[] = [], resume = false): string {
  const parts = [AGENT_COMMAND[agent]];
  // Back into its last conversation in this folder.
  if (resume) {
    if (agent === "codex") parts.push("resume", "--last");
    else if (agent === "gemini") parts.push("--resume", "latest");
    else parts.push("--continue");
  }
  if (model && isModelName(model)) {
    const [provider, ...rest] = model.split("/");
    const local = agent === "codex" && rest.length > 0 && (LOCAL_PROVIDERS as readonly string[]).includes(provider);
    if (agent === "claude" && provider === "ollama" && rest.length) parts.push("--model", rest.join("/"));
    else if (local) {
      parts.push("--oss", "--local-provider", provider, "--model", rest.join("/"));
      if (LOCAL_NO_THINKING.has(model)) parts.push("-c", "model_reasoning_effort=none");
    } else parts.push("--model", model);
  }
  parts.push(...leashFlags(agent, leash));
  parts.push(...extraArgs);
  return parts.join(" ");
}

/**
 * Pick a worker backend for a desk. Prefers a real local terminal; falls back
 * to the simulated worker when asked, or when no PTY backend is available
 * (e.g. the native module failed to load on this platform).
 */
/**
 * Environment for running an agent on a local model. Claude Code talks to
 * Ollama's Anthropic-compatible API: just for this worker, it's pointed at
 * Ollama (your own Claude login is left alone). Codex and OpenCode need none.
 */
export function localEnv(agent: AgentKind, model: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (agent !== "claude" || !/^ollama\/./.test(model)) return {};
  const host = env.OLLAMA_HOST ? (/^https?:\/\//.test(env.OLLAMA_HOST) ? env.OLLAMA_HOST : `http://${env.OLLAMA_HOST}`) : "http://127.0.0.1:11434";
  return { ANTHROPIC_BASE_URL: host.replace(/\/+$/, ""), ANTHROPIC_AUTH_TOKEN: "ollama", ANTHROPIC_API_KEY: "" };
}

export function createWorker(agent: AgentKind, opts: CreateWorkerOptions): IWorkerSession {
  if (opts.simulate || !ptyAvailable) {
    const note = ptyAvailable ? undefined : "no local terminal backend — running simulated";
    return new SimulatedWorker(agent, note);
  }
  const command = AGENT_COMMAND[agent];
  const found = findOnPath(command);
  return new PtyWorker(agent, {
    cwd: opts.cwd,
    // Launch the agent CLI if it is on PATH; otherwise hand over a plain shell
    // with a note, which is still a real local terminal.
    launch: found ? launchCommand(agent, opts.model ?? "", opts.leash ?? "ask", opts.extraArgs ?? [], opts.resume ?? false) : null,
    env: { ...localEnv(agent, opts.model ?? ""), ...opts.env },
    missingLabel: found ? null : AGENT_LABELS[agent],
    deskId: opts.deskId,
    reportsDir: opts.reportsDir,
    repliesDir: opts.repliesDir,
    autoTrust: opts.autoTrust,
  });
}

/**
 * Look up an executable on PATH without spawning anything. Returns the full
 * path, or null if not found. Handles Windows' PATHEXT extensions.
 */
/** Whether an agent's CLI is on your PATH. */
export function agentInstalled(agent: AgentKind): boolean {
  return findOnPath(AGENT_COMMAND[agent]) !== null;
}

export function findOnPath(command: string): string | null {
  const pathVar = process.env.PATH ?? "";
  const dirs = pathVar.split(delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase())
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * How long to wait after typing a line before pressing Enter. Codex takes fast
 * typing for a paste, and an Enter inside the paste becomes a new line in its
 * box instead of sending it.
 */
export function enterDelay(agent: AgentKind): number {
  return agent === "codex" ? 800 : 150;
}
