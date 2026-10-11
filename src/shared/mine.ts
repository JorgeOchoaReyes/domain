import type { AgentKind } from "./protocol.js";

/**
 * "💻 Mine": the host's own terminals, on the laptop. Each tab is a real shell
 * on this computer (or your own agent CLI session in one) — not a worker: no
 * desk, no brief, no review line. Host-only, and their output only ever goes
 * to the host's own clients.
 */

/** A tab: a shell (or your own agent session) running in one of the open repos. */
export interface MineTab {
  id: string;
  /** "PowerShell", "bash", "Claude Code (mine)"… */
  title: string;
  /** The shell it runs in (an id from the shells list). */
  shell: string;
  /** Your own agent session in it, if any. */
  agent: AgentKind | null;
  /** The folder it started in: the project or an open repo. */
  folder: string;
  /** Still running (false once its shell has exited). */
  alive: boolean;
  startedAt: number;
}

/** A shell you can open a tab in (the server's own list: the client only names one). */
export interface MineShellChoice {
  id: string;
  label: string;
}

/** A folder a tab can start in. */
export interface MineFolder {
  path: string;
  name: string;
  /** The office's own project. */
  main: boolean;
}

export interface MineState {
  tabs: MineTab[];
  shells: MineShellChoice[];
  /** Agent CLIs installed here, for "your own session" tabs. */
  agents: { id: AgentKind; label: string }[];
  folders: MineFolder[];
  /** `code` is on your PATH (Open in VS Code). */
  code: boolean;
  max: number;
}

export const MAX_MINE_TABS = 6;
/** The most a tab keeps of its output, for when you come back to it. */
export const MINE_SCROLLBACK = 256 * 1024;
/** The most one keystroke message (a paste) may carry. */
export const MINE_MAX_INPUT = 64 * 1024;

/** The last `n` lines of some terminal text, without trailing blank lines (for handing it to the team). */
export function lastLines(text: string, n = 40): string {
  const lines = text.replace(/\r/g, "").split("\n");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-n).join("\n");
}
