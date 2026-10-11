import type { AgentKind } from "./protocol.js";
import type { PrPer } from "./project.js";

/**
 * How you run your workers: the team's defaults (which model each agent runs,
 * how much rope it gets, how long a task may take, what "done" means), and
 * the brief that goes with each task you hand out. Shared by the server
 * (which launches workers and keeps time) and the client (which edits it).
 */

/** How much a worker may do without asking: "ask" before edits, or "auto"-accept edits. */
/**
 * How much a worker may do without asking you, from most careful to most free.
 * Each agent CLI gets its own flags for it (see launchCommand).
 */
export type Leash = "ask" | "auto" | "safe" | "full";
export const LEASHES: readonly Leash[] = ["ask", "auto", "safe", "full"];

export function isLeash(v: unknown): v is Leash {
  return typeof v === "string" && (LEASHES as readonly string[]).includes(v);
}

export const LEASH_ICON: Record<Leash, string> = { ask: "🙋", auto: "✏️", safe: "🛡", full: "🚀" };

/** What each level lets it do — shown in the windows, and told to the worker in its brief. */
export const LEASH_RULES: Record<Leash, string> = {
  ask: "ask before editing files or running commands",
  auto: "edit files in your folder without asking; ask before running commands",
  safe: "edit and run commands without asking when they're safe — risky ones are checked first (by your CLI's own reviewer)",
  full: "edit files and run commands without asking — stay inside your own folder and don't touch anything outside it",
};
/** What happens when a task's time budget runs out. */
export type OnTimeUp = "nudge" | "wrapup";
/** What approving finished work does with the worker's branch. */
export type MergeMode = "auto" | "manual";
/** What a failed check does: send the work straight back to fix, or just show it in the review. */
export type GateMode = "fix" | "show";

/** The terms a task is handed out on. */
export interface TaskBrief {
  /** The model to run it on; "" keeps whatever the worker is on. */
  model: string;
  /** Time budget in minutes; 0 = no limit. */
  minutes: number;
  onTimeUp: OnTimeUp;
  /** Present a plan for approval before changing anything. */
  planFirst: boolean;
  /** The definition of done, one line each. */
  done: string[];
  /** Another worker (its desk) who audits the work before it comes to you. */
  auditor?: string;
  /** At most this many audit rounds (builder ↔ auditor) before it comes to you anyway. */
  rounds?: number;
  /** Anything else it should know, in your words (typed or dictated). */
  notes?: string;
  /** When its auditor checks: only the finished work, or checkpoints along the way too. */
  auditWhen?: "end" | "along";
  /** Notes and files you attached (text): copied into its folder, under .domain/notes/. */
  files?: Attachment[];
  /** The open repo to do it in (its folder), when not the worker's own: it moves there first. */
  repo?: string;
}

/** A text file you attached to a task. */
export interface Attachment {
  name: string;
  text: string;
}
export const MAX_ATTACH = 8;
export const MAX_ATTACH_BYTES = 200_000;

/** Attached files, cleaned: plain file names, text only, size and count capped. */
export function coerceAttachments(v: unknown): Attachment[] {
  if (!Array.isArray(v)) return [];
  const out: Attachment[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    if (typeof o.text !== "string" || o.text.length > MAX_ATTACH_BYTES || o.text.includes("\u0000")) continue;
    // Just a file name: no folders, nothing that climbs out of the notes folder.
    let name = typeof o.name === "string" ? o.name.split(/[\\/]/).pop()!.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^\.+/, "").trim().slice(0, 80) : "";
    if (!name) name = `note-${out.length + 1}.txt`;
    while (seen.has(name.toLowerCase())) name = `${out.length + 1}-${name}`;
    seen.add(name.toLowerCase());
    out.push({ name, text: o.text });
    if (out.length >= MAX_ATTACH) break;
  }
  return out;
}

/** Audits go back and forth at most this many rounds by default. */
export const DEFAULT_AUDIT_ROUNDS = 3;

/** How a task is going against its brief. */
export interface TaskRun {
  startedAt: number;
  /** When the time budget runs out (epoch ms), or null for no limit. */
  deadline: number | null;
  /** The time-up action has fired. */
  timeUp: boolean;
  /** For plan-first tasks: the plan was approved and building has started. */
  planApproved: boolean;
  /** When it last presented its work (the end of its working time, for estimates). */
  presentedAt?: number;
}

export interface TeamPolicy {
  /** The models offered for each agent ("" = the CLI's own default). */
  models: Record<AgentKind, string[]>;
  /** The model a new hire starts on. */
  defaultModel: Record<AgentKind, string>;
  leash: Leash;
  minutes: number;
  onTimeUp: OnTimeUp;
  planFirst: boolean;
  done: string[];
  /** Give each worker its own git branch and worktree. */
  isolate: boolean;
  merge: MergeMode;
  gate: GateMode;
  autopilot: AutopilotPolicy;
  /** Workers to start (or wake) as soon as the office opens, so they're ready by the end of the stand-up. */
  startTeam: StartTeam;
  /** Shipping to GitHub: one pull request per goal, or one per agent from its own branch. */
  prPer: PrPer;
}

/** The office running itself (see server/autopilot.ts). */
export interface AutopilotPolicy {
  on: boolean;
  /** Approve work that passed its check and its audit, without you. */
  approveAudited: boolean;
  /** Workers may bring in interns for the independent pieces of a task. */
  interns: boolean;
  /** When the end-of-day sync runs ("17:30"; "" = never on its own). */
  eodAt: string;
  /**
   * Keep workers busy, even with autopilot off: a worker that's free picks up
   * the next task of the session's goal (the one you chose at the stand-up).
   */
  keepBusy: boolean;
  /** Approve small work whose checks passed (no audit needed): it merges and you hear about it. */
  approveGreen: boolean;
}

/** "Small" for approveGreen: at most this many lines added and removed. */
export const GREEN_MAX_LINES = 150;

/** The team the office starts on its own when it opens (count 0: none). */
export interface StartTeam {
  agent: AgentKind;
  count: number;
}
export const MAX_START_TEAM = 8;

export const DEFAULT_AUTOPILOT: AutopilotPolicy = { on: false, approveAudited: true, interns: true, eodAt: "17:30", keepBusy: true, approveGreen: false };

export const TIME_BUDGETS = [0, 15, 30, 45, 60, 90] as const;

export const DEFAULT_POLICY: TeamPolicy = {
  models: {
    claude: ["", "opus", "sonnet", "haiku"],
    codex: [""],
    opencode: [""],
    gemini: [""],
  },
  defaultModel: { claude: "", codex: "", opencode: "", gemini: "" },
  leash: "ask",
  minutes: 30,
  onTimeUp: "wrapup",
  planFirst: false,
  done: ["It does what the task says", "The project still builds and its tests pass", "Nothing unrelated changed"],
  isolate: true,
  merge: "auto",
  gate: "fix",
  autopilot: DEFAULT_AUTOPILOT,
  startTeam: { agent: "claude", count: 0 },
  prPer: "goal",
};

/** How many times a failed check sends the same work back before it reaches you anyway. */
export const GATE_RETRIES = 2;

export const LEASH_LABEL: Record<Leash, string> = {
  ask: "Asks first",
  auto: "Edits OK",
  safe: "Safe actions auto",
  full: "Never asks",
};

export const ON_TIME_UP_LABEL: Record<OnTimeUp, string> = {
  nudge: "Nudge it to wrap up",
  wrapup: "Stop and present",
};

/** A model name safe to put on a command line: letters, digits and . _ : / - only. */
export function isModelName(s: string): boolean {
  return s === "" || /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/.test(s);
}

/** A model as people read it: "CLI default", or "🖥 qwen3:8b" for one on this computer. */
export function modelLabel(m: string): string {
  if (/^(?:ollama|lmstudio)\/./.test(m)) return `🖥 ${m.slice(m.indexOf("/") + 1)}`;
  return m || "CLI default";
}

function strList(v: unknown, max: number, len: number): string[] {
  return Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.replace(/\s+/g, " ").trim().slice(0, len))
        .filter(Boolean)
        .slice(0, max)
    : [];
}

/** Clamp a budget to 0 (none) or 5–240 minutes. */
function minutesOf(v: unknown, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
  return n <= 0 ? 0 : Math.min(240, Math.max(5, n));
}

export function coerceBrief(raw: unknown, policy: TeamPolicy): TaskBrief {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const model = typeof o.model === "string" && isModelName(o.model) ? o.model : "";
  const done = strList(o.done, 8, 160);
  return {
    model,
    minutes: minutesOf(o.minutes, policy.minutes),
    onTimeUp: o.onTimeUp === "nudge" || o.onTimeUp === "wrapup" ? o.onTimeUp : policy.onTimeUp,
    planFirst: typeof o.planFirst === "boolean" ? o.planFirst : policy.planFirst,
    done: done.length ? done : [...policy.done],
    ...(typeof o.auditor === "string" && /^desk-\d{1,2}$/.test(o.auditor)
      ? { auditor: o.auditor, rounds: typeof o.rounds === "number" && o.rounds >= 1 ? Math.min(5, Math.round(o.rounds)) : DEFAULT_AUDIT_ROUNDS }
      : {}),
    ...(typeof o.auditor === "string" && o.auditWhen === "along" ? { auditWhen: "along" as const } : {}),
    ...(typeof o.notes === "string" && o.notes.trim() ? { notes: o.notes.trim().replace(/\s+/g, " ").slice(0, 2000) } : {}),
    ...(coerceAttachments(o.files).length ? { files: coerceAttachments(o.files) } : {}),
    ...(typeof o.repo === "string" && o.repo.trim() && o.repo.length <= 1000 ? { repo: o.repo.trim() } : {}),
  };
}

export function coercePolicy(raw: unknown, base: TeamPolicy = DEFAULT_POLICY): TeamPolicy {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const kinds = Object.keys(base.models) as AgentKind[];
  const models = { ...base.models };
  const defaultModel = { ...base.defaultModel };
  const rawModels = o.models && typeof o.models === "object" ? (o.models as Record<string, unknown>) : {};
  const rawDefaults = o.defaultModel && typeof o.defaultModel === "object" ? (o.defaultModel as Record<string, unknown>) : {};
  for (const k of kinds) {
    if (Array.isArray(rawModels[k])) {
      const list = strList(rawModels[k], 12, 64).filter(isModelName);
      models[k] = ["", ...list.filter((m) => m !== "")];
    }
    const d = rawDefaults[k];
    if (typeof d === "string" && isModelName(d)) defaultModel[k] = d;
    if (!models[k].includes(defaultModel[k])) models[k] = [...models[k], defaultModel[k]];
  }
  const done = strList(o.done, 8, 160);
  return {
    models,
    defaultModel,
    leash: isLeash(o.leash) ? o.leash : base.leash,
    minutes: minutesOf(o.minutes, base.minutes),
    onTimeUp: o.onTimeUp === "nudge" || o.onTimeUp === "wrapup" ? o.onTimeUp : base.onTimeUp,
    planFirst: typeof o.planFirst === "boolean" ? o.planFirst : base.planFirst,
    done: done.length ? done : [...base.done],
    isolate: typeof o.isolate === "boolean" ? o.isolate : base.isolate,
    merge: o.merge === "auto" || o.merge === "manual" ? o.merge : base.merge,
    gate: o.gate === "fix" || o.gate === "show" ? o.gate : base.gate,
    autopilot: coerceAutopilot((o as { autopilot?: unknown }).autopilot, base.autopilot ?? DEFAULT_AUTOPILOT),
    startTeam: coerceStartTeam(o.startTeam, base.startTeam ?? DEFAULT_POLICY.startTeam, kinds),
    prPer: o.prPer === "goal" || o.prPer === "agent" ? o.prPer : (base.prPer ?? DEFAULT_POLICY.prPer),
  };
}

function coerceStartTeam(raw: unknown, base: StartTeam, kinds: AgentKind[]): StartTeam {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const agent = typeof o.agent === "string" && (kinds as string[]).includes(o.agent) ? (o.agent as AgentKind) : base.agent;
  const count = typeof o.count === "number" && Number.isFinite(o.count) ? Math.max(0, Math.min(MAX_START_TEAM, Math.round(o.count))) : base.count;
  return { agent, count };
}

export function coerceAutopilot(raw: unknown, base: AutopilotPolicy = DEFAULT_AUTOPILOT): AutopilotPolicy {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    on: typeof o.on === "boolean" ? o.on : base.on,
    approveAudited: typeof o.approveAudited === "boolean" ? o.approveAudited : base.approveAudited,
    interns: typeof o.interns === "boolean" ? o.interns : base.interns,
    eodAt: typeof o.eodAt === "string" && (o.eodAt === "" || /^\d{1,2}:\d{2}$/.test(o.eodAt)) ? o.eodAt : base.eodAt,
    keepBusy: typeof o.keepBusy === "boolean" ? o.keepBusy : (base.keepBusy ?? DEFAULT_AUTOPILOT.keepBusy),
    approveGreen: typeof o.approveGreen === "boolean" ? o.approveGreen : (base.approveGreen ?? DEFAULT_AUTOPILOT.approveGreen),
  };
}
