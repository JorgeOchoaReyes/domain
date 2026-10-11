import type { StandupDraft } from "./standupDraft.js";
import type { Alumnus } from "./alumni.js";
import type { LessonsState } from "./lessons.js";
import type { SkillSeen } from "./skills.js";
import type { Idea } from "./ideas.js";
import type { AgentsState } from "./agents.js";
import type { ChatPeek, ChatThread, ChatWork } from "./chat.js";
import type { HistoryEvent } from "./history.js";
import type { GoalKind, ProgressState, SessionSummary, ToneId } from "./progress.js";
import type { Leash, TaskBrief, TeamPolicy } from "./policy.js";
import type { GithubAccount, GithubIssue, GithubRepo, OpLog, ProjectInfo, PullRequestInfo, RecentProject, RepoStatus } from "./project.js";
import type { Character, WorkerIdentity } from "./team.js";
import type { McpHealth, McpSeen, McpServer } from "./mcp.js";
import type { BorrowEvent, PodsState } from "./pods.js";

/** What a guest on your local network may do in your office. */
export type GuestRole = "visitor" | "teammate";

/** An office broadcasting on the local network (found by discovery). */
export interface LanOffice {
  /** Its host's name and project. */
  name: string;
  project: string;
  /** Where to open it, e.g. http://192.168.1.23:8788 */
  url: string;
  players: number;
}

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
  | "done" // finished a task, celebrating
  | "asleep"; // remembered from last time, not running: the gong wakes it

/**
 * A structured "presentation" an agent drops when it reaches a checkpoint.
 * The agent writes this as JSON to `.domain/reports/<deskId>.json`; the office
 * turns it into something you review. `summary` is what gets spoken aloud.
 */
export interface Report {
  /** "ready" = finished work to review; "blocked" = needs a decision; "plan" = a plan to approve before building. */
  status: "ready" | "blocked" | "plan";
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
  /** The check run on it before review (set by the office, never by the agent). */
  check?: CheckResult;
}

/** Your check command's verdict on a worker's finished work. */
export interface CheckResult {
  status: "running" | "pass" | "fail";
  command: string;
  exitCode: number | null;
  /** How long it took (ms). */
  ms: number;
  /** The end of its output. */
  tail: string;
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
  /** The model its CLI runs ("" = the CLI's default). */
  model: string;
  /** How much it may do without asking. */
  leash: Leash;
  /** Its own git branch (in its own worktree), or null when it works in your checkout. */
  branch: string | null;
  /** Who it is, when it's one of your team's characters. */
  identity: WorkerIdentity | null;
  /** The MCP servers (tools) it started with: its CLI's own, plus the office's. */
  mcp?: string[];
  /** The skills it can use (its CLI's, minus any its character turned off). */
  skills?: string[];
  /** An intern: the desk of the worker who brought it in (and reviews its work). */
  internOf?: string;
  /** What it's doing right now, in a word or three ("Editing math.js", "Running tests"). */
  doing?: string;
  /** Lent to this person (they asked, its owner said yes): theirs to direct until it's back. */
  lentTo?: string;
}

/** Workers the office started itself (not one person's): anyone may direct them. */
export const SHARED_HIRERS: readonly string[] = ["Office", "Autopilot"];

/**
 * Who may direct a worker — give it tasks, type into it, review its work,
 * send it home: whoever hired it, while they're here. Everyone can watch it
 * and message it. The host (it runs on their computer) may always; workers
 * the office started are everyone's; and someone who left doesn't hold theirs.
 */
export function mayDirect(worker: Pick<Worker, "hiredBy" | "lentTo"> | null | undefined, who: { name: string; host: boolean }, present: readonly string[]): boolean {
  if (!worker || who.host) return true;
  // Lent to someone here: it works for them until it's back.
  if (worker.lentTo && present.includes(worker.lentTo)) return worker.lentTo === who.name;
  const owner = worker.hiredBy;
  return owner === who.name || SHARED_HIRERS.includes(owner) || !present.includes(owner);
}

/** "Editing math.js" → "✏️ Editing math.js": a worker's step with an icon, for its bubble. */
export function doingLabel(doing: string): string {
  const icon = /^Reading/.test(doing)
    ? "📖"
    : /^Editing/.test(doing)
      ? "✏️"
      : /tests/.test(doing)
        ? "🧪"
        : /^Installing/.test(doing)
          ? "📦"
          : /^(Committing|Pushing|Checking git)/.test(doing)
            ? "🌿"
            : /^(Searching|Exploring|Looking)/.test(doing)
              ? "🔍"
              : /^Browsing/.test(doing)
                ? "🌐"
                : /^Using/.test(doing)
                  ? "🧰"
                  : /^Thinking/.test(doing)
                    ? "💭"
                    : /^Planning/.test(doing)
                      ? "🗒"
                      : /^Building/.test(doing)
                        ? "🔨"
                        : "⚙️";
  return `${icon} ${doing}`;
}

/** A worker's place in the line waiting to present in your office. */
export interface Presentation {
  deskId: string;
  workerId: string;
  agent: AgentKind;
  hiredBy: string;
  /** Its report, or null while it is still preparing one after a round-up. */
  report: Report | null;
  /** 0 = first in line (at the podium once ready); 1+ = position behind. */
  order: number;
}

/** A desk in the office. Fixed position; may or may not be occupied. */
export interface Desk {
  id: string;
  label: string;
  /** World-space position on the floor. */
  x: number;
  z: number;
  /** Rotation around Y; at 0 the worker sits on the desk's +z side facing -z. */
  rotY: number;
  worker: Worker | null;
}

/** Skin tones, hair styles and colors, and shirts a person can pick. */
export const SKIN_TONES = ["#ffe0c7", "#f9d1b0", "#eabd8c", "#d9a066", "#c68642", "#a5693f", "#8d5524", "#5c3a21"] as const;
export const HAIR_STYLES = ["short", "long", "bun", "spiky", "curly", "ponytail", "bald"] as const;
export const HAIR_COLORS = ["#2b2d42", "#4a2f1d", "#6f4e37", "#e8c46a", "#c2451e", "#dddddd", "#d62839", "#ff8fab", "#9b5de5", "#264653"] as const;
export const SHIRT_COLORS = ["#ff8a5b", "#4f86f7", "#06d6a0", "#ef476f", "#ffd166", "#9b5de5", "#00b4d8", "#fb8500"] as const;
export type HairStyle = (typeof HAIR_STYLES)[number];

/** How a person looks: indexes into the tables above, and a hair style. */
export interface Look {
  skin: number;
  hair: HairStyle;
  hairColor: number;
  shirt: number;
}

export const DEFAULT_LOOK: Look = { skin: 2, hair: "short", hairColor: 1, shirt: 1 };

/** Clamp an untrusted look to valid choices. */
export function coerceLook(raw: unknown): Look {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const idx = (v: unknown, n: number, d: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v < n ? v : d;
  return {
    skin: idx(o.skin, SKIN_TONES.length, DEFAULT_LOOK.skin),
    hair: HAIR_STYLES.includes(o.hair as HairStyle) ? (o.hair as HairStyle) : DEFAULT_LOOK.hair,
    hairColor: idx(o.hairColor, HAIR_COLORS.length, DEFAULT_LOOK.hairColor),
    shirt: idx(o.shirt, SHIRT_COLORS.length, DEFAULT_LOOK.shirt),
  };
}

/** Another connected person, drawn as an avatar in the room. */
export interface Peer {
  id: string;
  name: string;
  look: Look;
  x: number;
  z: number;
  /** Facing angle in radians (0 looks down +z). */
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
  /** Sent once on connect to announce who you are and how you look. */
  | { t: "join"; name: string; look?: Look; cli?: boolean }
  /** Presence update as you walk around. */
  | { t: "move"; x: number; z: number; facing: number }
  /** Staff an empty desk with an agent. */
  | { t: "hire"; deskId: string; agent: AgentKind; model?: string; leash?: Leash; characterId?: string }
  /** Open a worker's terminal; the server replies with its scrollback. */
  | { t: "open"; deskId: string }
  /** Send a worker home and free its desk. */
  /** Let a worker go, with (optionally) why: the team learns from it, and they can be brought back. */
  | { t: "fire"; deskId: string; reason?: string }
  /** Former workers (answered with "alumni"), and bringing one back to a desk. */
  | { t: "alumniGet" }
  | { t: "rehire"; id: string; deskId: string }
  /** Keystrokes typed into a worker's terminal. */
  | { t: "input"; deskId: string; data: string }
  /** Resize a worker's terminal. */
  | { t: "resize"; deskId: string; cols: number; rows: number }
  /**
   * Respond to a worker's presentation. `approve` lets it continue; otherwise
   * `text` is the revision feedback sent back into its session. Either way the
   * report is cleared and the worker returns to its desk.
   */
  | {
      t: "review";
      deskId: string;
      approve: boolean;
      text?: string;
      /** The review whiteboard as a PNG data URL, saved for the agent to look at. */
      sketch?: string;
    }
  /**
   * Call workers to your office: each stops to prepare a progress report and
   * lines up outside your door. An empty list rounds up everyone.
   */
  | { t: "roundup"; deskIds: string[] }
  /** Say something to a worker during its review (dictated or typed). */
  | { t: "say"; deskId: string; text: string }
  /** Goals: set one (with its tasks), add a task, drop one. */
  | { t: "goalCreate"; title: string; why: string; tasks: string[]; kind?: GoalKind; dueAt?: number | null }
  /** When a goal is due (null: no deadline). */
  | { t: "goalDue"; goalId: string; dueAt: number | null }
  /** Give a goal to a group of workers: one plans it, then tasks go out across them. */
  | { t: "goalGroup"; goalId: string; deskIds: string[] }
  /** The office's history (the latest, or a worker's). */
  | { t: "historyGet" }
  /** Which skills each agent CLI has (answered with "skills"). */
  | { t: "skillsGet" }
  /** The team's lessons (answered with "lessons"), and the end-of-day sync. */
  | { t: "lessonsGet" }
  | { t: "eodSync" }
  /** A lesson you teach the team yourself; or take one back (a lesson by its line, a note by its time). */
  | { t: "lessonTeach"; text: string }
  /** ElevenLabs voices: what's there, your API key (host only; "" removes it), and speech in one of them. */
  | { t: "voicesGet" }
  | { t: "voicesKey"; key: string }
  | { t: "tts"; id: string; text: string; voice: string }
  | { t: "lessonForget"; lesson?: string; noteAt?: number }
  | { t: "goalDelete"; goalId: string }
  | { t: "taskAdd"; goalId: string; title: string }
  /** Put the worker at a desk on a task (it's briefed in its terminal). */
  | { t: "taskAssign"; goalId: string; taskId: string; deskId: string; brief?: TaskBrief }
  /** Hand a worker something to do, straight from the chat: tracked as a task (on the session's goal, or "Quick tasks"). deskId "any": whoever's free. */
  | { t: "quickTask"; deskId: string; text: string; goalId?: string; files?: { name: string; text: string }[] }
  /** Change the team's defaults for hiring and handing out tasks. */
  | { t: "policySet"; policy: TeamPolicy }
  /** Tick a task off (or back on) by hand. */
  | { t: "taskDone"; goalId: string; taskId: string; done: boolean }
  /** Focus sessions: start one (on a goal, or none), or stop it early. */
  | { t: "sessionStart"; minutes: number; goalId: string | null }
  | { t: "sessionStop" }
  /**
   * The stand-up that opens a session: pick a goal (or set a new one), the
   * tone and a one-line intention, and the focus session starts on it.
   */
  | {
      t: "standup";
      goalId: string | null;
      newGoal?: { title: string; why: string; tasks: string[]; kind: GoalKind; dueAt?: number | null };
      tone: ToneId;
      intention: string;
      minutes: number;
      /** From a spoken stand-up: its summary and the end-of-day goals. */
      summary?: string;
      eod?: string[];
      /** Hand the goal's tasks to free workers straight away (default true). */
      dispatch?: boolean;
      /** The tasks as planned at the stand-up and who takes each ("" = whoever's free): missing ones are added, picked ones saved for their worker. */
      assign?: { task: string; deskId: string }[];
    }
  /** A spoken stand-up, as words: answered with "standupDraft" (a plan to look over). */
  | { t: "standupVoice"; text: string }
  /** Pick up where the last stand-up left off: wake the team, same goal, tone and length, tasks handed out. */
  | { t: "resume" }
  /** The desktop app's 🎤: start (or stop) Windows voice typing in the box that has focus. */
  | { t: "dictate" }
  /** Where the repo stands: your branch, agents' branches, open pull requests (answered with "repoStatus"). */
  | { t: "repoStatus" }
  /** Answer a worker's "I'll take it": let them, ask someone else, or leave it for whoever's free. */
  | { t: "offerAnswer"; taskId: string; answer: "take" | "next" | "anyone" }
  // --- the agent loop ------------------------------------------------------
  /** Ask the worker at a desk to break a goal into tasks (it writes plan.md). */
  | { t: "plan"; goalId: string; deskId: string }
  /**
   * Ship a goal. Without a desk: run the project's configured deploy command.
   * With a desk: ask that worker to ship it (open a PR), or to fix the deploy
   * if the last one failed.
   */
  | { t: "ship"; goalId: string; deskId?: string }
  /** Mark a goal shipped (build) or delivered (research) by hand. */
  | { t: "shipDone"; goalId: string; url?: string }
  /** Stop a running deploy. */
  | { t: "shipCancel"; goalId: string }
  /** Look for dev servers running on this machine (for the laptop's browser). */
  | { t: "probe" }
  // --- projects and GitHub -------------------------------------------------
  /** Ask for the current project, recent ones and the GitHub account. */
  | { t: "projectInfo" }
  /** Switch the office to another folder (the app restarts on it). */
  | { t: "projectOpen"; path: string }
  /** Clone a repo (URL or owner/repo) into the projects folder, then open it. */
  | { t: "projectClone"; url: string }
  /** Sign in to GitHub through git's own credential manager (opens the browser once). */
  | { t: "githubSignIn" }
  | { t: "githubRepos" }
  | { t: "githubIssues" }
  /** Turn GitHub issues into tasks (on a goal, or a new goal when null). */
  | { t: "issuesImport"; goalId: string | null; numbers: number[] }
  /** Ship a goal as a GitHub pull request: push, open it, follow its checks. */
  | { t: "shipPR"; goalId: string }
  /** The full operations log (git, GitHub, MCP, checks, deploys). */
  | { t: "logs" }
  // --- your team ---------------------------------------------------------------
  | { t: "characterSave"; character: Character }
  | { t: "characterDelete"; id: string }
  // --- MCP -------------------------------------------------------------------------
  | { t: "mcpSave"; server: McpServer }
  | { t: "mcpDelete"; id: string }
  /** Read which servers each agent CLI already loads. */
  | { t: "mcpScan" }
  /** Health-check one server (by key) or all of them. */
  | { t: "mcpCheck"; key?: string }
  // --- local multiplayer -----------------------------------------------------------
  /** Open the office to your local network with a passcode. */
  | { t: "lanStart"; role: GuestRole }
  | { t: "lanStop" }
  /** Look for offices broadcasting on the local network. */
  | { t: "lanDiscover" }
  /** Pods for people (answered with "pods"); ask to borrow someone's agent, answer an ask for yours, give one back (or call yours back). */
  | { t: "podsGet" }
  | { t: "borrowAsk"; deskId: string }
  | { t: "borrowAnswer"; deskId: string; yes: boolean }
  | { t: "borrowReturn"; deskId: string }
  // --- agent CLIs ------------------------------------------------------------------
  /** Which agent CLIs are installed. */
  | { t: "agentsGet" }
  /** Install a missing agent CLI with npm (shown in the logs as it goes). */
  | { t: "agentInstall"; agent: AgentKind }
  /** Let agents trust this project's worker folders (answers their trust prompts, now and later). */
  | { t: "trustWorkers" }
  /** Wake the workers remembered from last time (one desk, or everyone): each resumes where it left off. */
  | { t: "wake"; deskId?: string }
  // --- team chat ---------------------------------------------------------------------
  | { t: "chatGet" }
  /** A message to a worker (its desk id) or everyone ("team"); `raw` types it straight into the terminal. */
  | { t: "chatSend"; to: string; text: string; raw?: boolean }
  /** To the people in the office (#people): never to the workers. */
  | { t: "peopleSend"; text: string }
  /** What a worker's screen says right now. */
  | { t: "chatPeek"; deskId: string }
  /** A worker's record: its tasks, commits and changed files. */
  | { t: "chatWork"; deskId: string }
  // --- idea boards -------------------------------------------------------------------
  | { t: "ideasGet" }
  /**
   * Pin an idea (or update one): its words, a thumbnail, and the full sketch
   * as a PNG data URL. `then` hands it straight to a worker or makes it a goal.
   */
  | {
      t: "ideaSave";
      idea: { id?: string; title: string; text: string; kind: GoalKind; thumb: string | null };
      sketch?: string;
      then?: { handoff?: string; goal?: boolean };
    }
  | { t: "ideaDelete"; id: string }
  /** Hand an idea to the worker at a desk: it becomes a task and the worker is briefed. */
  | { t: "ideaHandoff"; id: string; deskId: string; brief?: TaskBrief }
  /** Turn an idea into a goal (its bullet lines become tasks). */
  | { t: "ideaToGoal"; id: string };

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
  | { t: "report"; presentation: Presentation }
  /** A worker talking back during its review (read aloud in its voice). */
  | { t: "said"; deskId: string; from: "agent" | "you"; text: string }
  /** Goals, the focus session, everyone's score and the activity feed. */
  | { t: "progress"; progress: ProgressState }
  /** Someone earned XP (and maybe a level or an achievement). */
  | { t: "award"; who: string; xp: number; reason: string; levelUp?: { level: number; title: string }; unlocked: string[] }
  /** The focus session ended. */
  | { t: "sessionEnd"; summary: SessionSummary }
  | { t: "repoStatus"; status: RepoStatus }
  /** A spoken stand-up turned into a plan ("claude": by a model; "simple": from your sentences). */
  | { t: "standupDraft"; draft: StandupDraft; via: "claude" | "simple" }
  // --- projects and GitHub -------------------------------------------------
  | { t: "project"; info: ProjectInfo; recent: RecentProject[]; account: GithubAccount | null }
  /** The office is switching to another project: the app restarts on it. */
  | { t: "projectSwitching"; path: string; name: string }
  | { t: "githubAccount"; account: GithubAccount | null; error?: string }
  | { t: "githubRepos"; repos: GithubRepo[]; error?: string }
  | { t: "githubIssues"; issues: GithubIssue[]; error?: string }
  /** A goal's pull request was opened or its state changed. */
  | { t: "pr"; goalId: string; pr: PullRequestInfo }
  /** One operation started, grew or finished. */
  | { t: "oplog"; entry: OpLog }
  | { t: "oplogAll"; entries: OpLog[] }
  // --- MCP -------------------------------------------------------------------------
  | { t: "mcpSeen"; seen: McpSeen[] }
  | { t: "mcpHealth"; health: McpHealth[] }
  // --- local multiplayer -----------------------------------------------------------
  /** Whether the office is open to the local network, where, and with which code (only the host sees the code). */
  | { t: "lan"; on: boolean; urls: string[]; code: string | null; role: GuestRole; guests: number }
  | { t: "lanOffices"; offices: LanOffice[] }
  /** You're a guest here: what you may do. */
  | { t: "guest"; role: GuestRole; host: string }
  /** Who has which pod on the team floor, and the agents asked for or lent. */
  | { t: "pods"; state: PodsState }
  /** A borrow you're in moved on (sent to its owner and borrower). */
  | { t: "borrow"; event: BorrowEvent; deskId: string; owner: string; borrower: string; worker: string; text: string }
  /** Everything pinned to the idea boards. */
  | { t: "ideas"; ideas: Idea[] }
  /** Which agent CLIs are installed (and whether one is being installed). */
  | { t: "agents"; state: AgentsState }
  /** The office's history, newest first; and each new event as it happens. */
  | { t: "history"; events: HistoryEvent[] }
  | { t: "skills"; seen: SkillSeen[] }
  | { t: "lessons"; state: LessonsState; syncing: boolean }
  | { t: "voices"; state: VoicesState }
  /** Speech for a "tts" request: MP3 as base64, or why not. */
  | { t: "ttsAudio"; id: string; audio?: string; error?: string }
  | { t: "alumni"; list: Alumnus[] }
  | { t: "historyEvent"; event: HistoryEvent }
  /** Every chat thread, with its history. */
  | { t: "chat"; threads: ChatThread[] }
  | { t: "chatPeek"; peek: ChatPeek }
  | { t: "chatWork"; work: ChatWork }
  // --- the agent loop ------------------------------------------------------
  /**
   * Sent on join (and when it changes): the project folder, the preview URL
   * the laptop's browser opens, and the deploy command "Ship it" runs (null
   * if none is configured — then a worker is asked to ship instead).
   */
  | { t: "config"; project: string; preview: string | null; deploy: string | null; simulate: boolean; check: string | null; git: { base: string | null } | null; localModels: string[] }
  /** Dev servers found running on this machine, in reply to a probe. */
  | { t: "devServers"; urls: string[] }
  /** Output from a running deploy, as it happens. */
  | { t: "deployOutput"; goalId: string; data: string }
  /** The whole log of the current (or last) deploy, sent on join. */
  | { t: "deployLog"; goalId: string; data: string }
  /** Something happened in the loop worth a toast. */
  | { t: "loop"; goalId: string; event: LoopEvent; text: string };

/**
 * planned: a worker's plan landed and its tasks were added; deck: a research
 * deck was updated; deployStarted / deployFailed: the deploy command started
 * or exited non-zero; shipped: a goal shipped or was delivered.
 */
export type LoopEvent = "planned" | "deck" | "deployStarted" | "deployFailed" | "shipped" | "timeUp" | "checkFailed" | "merged" | "mergeFailed" | "warn";

/** An ElevenLabs voice, for the voice pickers. */
export interface VoiceInfo {
  id: string;
  name: string;
  /** e.g. "female, british, calm". */
  about: string;
}

/** Whether ElevenLabs is set up (a working API key), and its voices. */
export interface VoicesState {
  on: boolean;
  voices: VoiceInfo[];
  error?: string;
}

/** Something a worker says back during its review, dropped as a reply file. */
export function coerceReply(raw: unknown): { say: string; at: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const say = typeof o.say === "string" ? o.say.trim().slice(0, 1200) : "";
  if (!say) return null;
  return { say, at: typeof o.at === "number" ? o.at : Date.now() };
}

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
  const status: Report["status"] = o.status === "blocked" ? "blocked" : o.status === "plan" ? "plan" : "ready";

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
