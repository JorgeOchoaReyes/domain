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
  | "presenting" // has a finished report and is lined up to present
  | "done"; // finished a task, celebrating

/**
 * A structured "presentation" an agent drops when it reaches a checkpoint.
 * The agent writes this as JSON to `.domain/reports/<deskId>.json`; the office
 * turns it into something you review. `summary` is what gets spoken aloud.
 */
export interface Report {
  /** "ready" = finished work to review; "blocked" = needs a decision. */
  status: "ready" | "blocked";
  title: string;
  /** One short paragraph, read aloud at the presentation. */
  summary: string;
  /** Bullet points shown on the presentation screen. */
  slides: string[];
  /** The question to answer, when status is "blocked". */
  question?: string;
  /** Something to look at: a running dev-server URL or an image path. */
  preview?: { url?: string; image?: string };
  /** When the report was produced (epoch ms). */
  at: number;
}

/** A worker currently occupying a desk. */
export interface Worker {
  id: string;
  agent: AgentKind;
  /** The person who hired it (display name). */
  hiredBy: string;
  status: WorkerStatus;
  /** Short line describing what it is doing, shown over the desk. */
  activity: string;
  /** The latest unreviewed report, if the worker is waiting to present. */
  report: Report | null;
}

/** A worker's place in the line waiting to present in your office. */
export interface Presentation {
  deskId: string;
  workerId: string;
  agent: AgentKind;
  hiredBy: string;
  report: Report;
  /** 0 = at the podium presenting; 1+ = position in the line behind. */
  order: number;
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
  /** Workers lined up to present, in queue order (order 0 = at the podium). */
  presentations: Presentation[];
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
  | { t: "resize"; deskId: string; cols: number; rows: number }
  /**
   * Respond to a worker's presentation. `approve` lets it continue; otherwise
   * `text` is the revision feedback sent back into its session. Either way the
   * report is cleared and the worker returns to its desk.
   */
  | { t: "review"; deskId: string; approve: boolean; text?: string };

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
  | { t: "scrollback"; deskId: string; data: string }
  /** A worker just dropped a new report and is heading to your office. */
  | { t: "report"; presentation: Presentation };

/** Narrow a parsed JSON value to a ClientMessage, or return null. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!raw || typeof raw !== "object" || !("t" in raw)) return null;
  const t = (raw as { t: unknown }).t;
  if (typeof t !== "string") return null;
  // Trust the shape beyond the tag; the server validates fields it depends on.
  return raw as ClientMessage;
}

/**
 * Coerce an untrusted JSON value (a report file an agent wrote) into a Report,
 * filling in sane defaults and clamping sizes. Returns null if there is nothing
 * usable. Kept permissive on purpose: agents hand-write these.
 */
export function coerceReport(raw: unknown): Report | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown, max: number): string =>
    typeof v === "string" ? v.slice(0, max) : "";

  const title = str(o.title, 120) || "Update";
  const summary = str(o.summary, 1200);
  const question = str(o.question, 600);
  const status: Report["status"] = o.status === "blocked" ? "blocked" : "ready";

  let slides: string[] = [];
  if (Array.isArray(o.slides)) {
    slides = o.slides
      .filter((s): s is string => typeof s === "string")
      .slice(0, 12)
      .map((s) => s.slice(0, 240));
  }

  let preview: Report["preview"] | undefined;
  if (o.preview && typeof o.preview === "object") {
    const p = o.preview as Record<string, unknown>;
    const url = typeof p.url === "string" ? p.url.slice(0, 500) : undefined;
    const image = typeof p.image === "string" ? p.image.slice(0, 500) : undefined;
    if (url || image) preview = { url, image };
  }

  // Require at least something to show or say.
  if (!summary && slides.length === 0 && !question) return null;

  return {
    status,
    title,
    summary: summary || question || title,
    slides,
    question: question || undefined,
    preview,
    at: typeof o.at === "number" ? o.at : Date.now(),
  };
}
