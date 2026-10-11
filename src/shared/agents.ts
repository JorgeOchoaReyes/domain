import type { AgentKind } from "./protocol.js";

/**
 * The agent CLIs and how to get them: each is an npm package that puts its
 * command on your PATH. The office checks which are installed and can
 * install a missing one for you.
 */
export const AGENT_PACKAGES: Record<AgentKind, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  gemini: "@google/gemini-cli",
  opencode: "opencode-ai",
};

export interface AgentsState {
  /** Which agent CLIs are on your PATH. */
  installed: Record<AgentKind, boolean>;
  /** The one being installed right now, if any. */
  installing: AgentKind | null;
  /** Whether npm is there to install with (it comes with Node.js). */
  npm: boolean;
  /** Each installed CLI's version, the newest out, and the one you've pinned. */
  versions: Partial<Record<AgentKind, AgentVersion>>;
  /** The one being updated right now, if any. */
  updating: AgentKind | null;
  /** Updates you asked for, waiting until that agent's workers are free. */
  queued: AgentKind[];
  /** When the versions were last looked up (0: not yet). */
  checkedAt: number;
}

export interface AgentVersion {
  /** Installed (null: not found by npm — e.g. installed another way). */
  current: string | null;
  /** The newest on npm (null: couldn't tell — offline). */
  latest: string | null;
  /** The version you've said to stay on, if any. */
  pinned: string | null;
  /** How it was installed: with npm (the office can update and pin it), or its own installer. */
  via: "npm" | "own";
}

/** CLIs installed with their own installer that update themselves (to the newest). */
export const SELF_UPDATE: Partial<Record<AgentKind, string>> = { claude: "claude update" };

/** Whether the office can update this install (and so pin it, for npm ones). */
export function canUpdate(agent: AgentKind, v: AgentVersion | undefined): boolean {
  return !!v && (v.via === "npm" || !!SELF_UPDATE[agent]);
}

/** A version npm will take: 1.2.3, 0.157.0-alpha.1. */
export const VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/;

/** -1, 0 or 1 as a is older than, the same as, or newer than b (a pre-release is older than its release). */
export function compareVersions(a: string, b: string): number {
  const [ma, pa = ""] = a.split("-", 2);
  const [mb, pb = ""] = b.split("-", 2);
  const na = ma.split(".").map(Number);
  const nb = mb.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((na[i] ?? 0) !== (nb[i] ?? 0)) return (na[i] ?? 0) < (nb[i] ?? 0) ? -1 : 1;
  if (pa === pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  return pa < pb ? -1 : 1;
}

/**
 * The version an update would install, or null when there's nothing to do:
 * the pinned one if you're not on it, else the newest if it's newer.
 */
export function updateTarget(v: AgentVersion | undefined): string | null {
  if (!v) return null;
  if (v.pinned && v.via === "npm") return v.pinned !== v.current ? v.pinned : null;
  if (!v.latest || !v.current) return null;
  return compareVersions(v.latest, v.current) > 0 ? v.latest : null;
}
