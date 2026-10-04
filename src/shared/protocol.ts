/**
 * The wire protocol shared by the client and the server.
 *
 * Everything that crosses the WebSocket is one of these tagged objects. The
 * `t` field is the discriminant, so both sides can switch on it exhaustively.
 * Keep this file free of any runtime or platform-specific imports — it is
 * compiled into both the browser bundle and the Node server.
 */

/** The kinds of coding agent a desk can be staffed with. */
export const AGENT_KINDS = ["claude", "codex", "opencode", "gemini"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** Human-friendly labels for each agent kind, used in the UI. */
export const AGENT_LABELS: Record<AgentKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  gemini: "Gemini CLI",
};

/** Lifecycle of a worker sitting at a desk. */
export type WorkerStatus =
  | "booting" // just hired, starting up
  | "idle" // ready, waiting for a prompt
  | "working" // busy on a task
  | "waiting" // needs a human (blocked on input / a question)
  | "done"; // finished a task, celebrating

/** A worker currently occupying a desk. */
export interface Worker {
  id: string;
  agent: AgentKind;
  /** The person who hired it (display name). */
  hiredBy: string;
  status: WorkerStatus;
  /** Short line describing what it is doing, shown over the desk. */
  activity: string;
}

/** A desk in the office. Fixed position; may or may not be occupied. */
export interface Desk {
  id: string;
  /** World-space position on the floor. */
  x: number;
  z: number;
  worker: Worker | null;
}

/** Another connected person, drawn as an avatar in the room. */
export interface Peer {
  id: string;
  name: string;
  x: number;
  z: number;
  /** Facing angle in radians. */
  facing: number;
}

/** The full office snapshot the server broadcasts. */
export interface OfficeState {
  desks: Desk[];
  peers: Peer[];
}

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export type ClientMessage =
  /** Sent once on connect to announce who you are. */
  | { t: "join"; name: string }
  /** Presence update as you walk around. */
  | { t: "move"; x: number; z: number; facing: number }
  /** Staff an empty desk with an agent. */
  | { t: "hire"; deskId: string; agent: AgentKind }
  /** Open a worker's terminal; the server replies with its scrollback. */
  | { t: "open"; deskId: string }
  /** Send a worker home and free its desk. */
  | { t: "fire"; deskId: string }
  /** Keystrokes typed into a worker's terminal. */
  | { t: "input"; deskId: string; data: string }
  /** Resize a worker's terminal. */
  | { t: "resize"; deskId: string; cols: number; rows: number };

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export type ServerMessage =
  /** First message after join: your id plus the current office. */
  | { t: "welcome"; selfId: string; office: OfficeState }
  /** A fresh full snapshot (someone joined/left, a desk changed, etc.). */
  | { t: "office"; office: OfficeState }
  /** Terminal output from a worker, to be written to its xterm. */
  | { t: "output"; deskId: string; data: string }
  /** The scrollback for a desk, sent when you open its terminal. */
  | { t: "scrollback"; deskId: string; data: string };

/** Narrow a parsed JSON value to a ClientMessage, or return null. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!raw || typeof raw !== "object" || !("t" in raw)) return null;
  const t = (raw as { t: unknown }).t;
  if (typeof t !== "string") return null;
  // Trust the shape beyond the tag; the server validates fields it depends on.
  return raw as ClientMessage;
}
