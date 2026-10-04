import { existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import type { AgentKind, Report, WorkerStatus } from "../shared/protocol.js";
import { AGENT_LABELS } from "../shared/protocol.js";
import { SimulatedWorker } from "./worker.js";
import { PtyWorker, ptyAvailable } from "./ptyWorker.js";

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
  resize(cols: number, rows: number): void;
  dispose(): void;
  /**
   * Some backends (the simulated worker) emit reports in-process. Real
   * terminal workers instead write report files that the server watches, so
   * this is optional.
   */
  onReport?(listener: (report: Report) => void): () => void;
}

export interface CreateWorkerOptions {
  /** Working directory a real terminal starts in. */
  cwd: string;
  /** Force the scripted stub even when a terminal backend is available. */
  simulate: boolean;
  /** The desk this worker sits at — names its report file. */
  deskId: string;
  /** Absolute path of the directory where report files are watched. */
  reportsDir: string;
}

/** The CLI command each agent kind launches when a real terminal is used. */
const AGENT_COMMAND: Record<AgentKind, string> = {
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
  gemini: "gemini",
};

/**
 * Pick a worker backend for a desk. Prefers a real local terminal; falls back
 * to the simulated worker when asked, or when no PTY backend is available
 * (e.g. the native module failed to load on this platform).
 */
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
    launch: found ? command : null,
    missingLabel: found ? null : AGENT_LABELS[agent],
    deskId: opts.deskId,
    reportsDir: opts.reportsDir,
  });
}

/**
 * Look up an executable on PATH without spawning anything. Returns the full
 * path, or null if not found. Handles Windows' PATHEXT extensions.
 */
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
