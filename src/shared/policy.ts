import type { AgentKind } from "./protocol.js";

/**
 * How you run your workers: the team's defaults (which model each agent runs,
 * how much rope it gets, how long a task may take, what "done" means), and
 * the brief that goes with each task you hand out. Shared by the server
 * (which launches workers and keeps time) and the client (which edits it).
 */

/** How much a worker may do without asking: "ask" before edits, or "auto"-accept edits. */
export type Leash = "ask" | "auto";
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
}

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
};

/** How many times a failed check sends the same work back before it reaches you anyway. */
export const GATE_RETRIES = 2;

export const LEASH_LABEL: Record<Leash, string> = {
  ask: "Ask before edits",
  auto: "Go ahead (auto-accept edits)",
};

export const ON_TIME_UP_LABEL: Record<OnTimeUp, string> = {
  nudge: "Nudge it to wrap up",
  wrapup: "Stop and present",
};

/** A model name safe to put on a command line: letters, digits and . _ : / - only. */
export function isModelName(s: string): boolean {
  return s === "" || /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/.test(s);
}

export function modelLabel(m: string): string {
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
    leash: o.leash === "auto" || o.leash === "ask" ? o.leash : base.leash,
    minutes: minutesOf(o.minutes, base.minutes),
    onTimeUp: o.onTimeUp === "nudge" || o.onTimeUp === "wrapup" ? o.onTimeUp : base.onTimeUp,
    planFirst: typeof o.planFirst === "boolean" ? o.planFirst : base.planFirst,
    done: done.length ? done : [...base.done],
    isolate: typeof o.isolate === "boolean" ? o.isolate : base.isolate,
    merge: o.merge === "auto" || o.merge === "manual" ? o.merge : base.merge,
    gate: o.gate === "fix" || o.gate === "show" ? o.gate : base.gate,
  };
}
