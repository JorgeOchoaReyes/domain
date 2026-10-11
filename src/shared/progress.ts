/**
 * The game layer: goals broken into tasks, focus sessions, and the XP, levels,
 * streaks and achievements you earn by making real progress. Shared by the
 * server (which keeps score) and the client (which shows it).
 */

import { DEFAULT_POLICY, type TaskBrief, type TaskRun, type TeamPolicy } from "./policy.js";
import type { AgentPullRequest, PullRequestInfo } from "./project.js";
import type { Character } from "./team.js";
import type { McpServer } from "./mcp.js";
import type { Estimate, EstimateSample, Took } from "./estimate.js";

export type TaskStatus = "todo" | "doing" | "review" | "done";

export interface GoalTask {
  id: string;
  title: string;
  status: TaskStatus;
  /** The desk whose worker is on it, while it's being done or reviewed. */
  deskId: string | null;
  doneAt: number | null;
  /** The desk whose worker finished it (kept after `deskId` is cleared): per-agent pull requests use it. */
  doneBy?: string | null;
  /** The terms it was handed out on (model, time budget, plan first, definition of done). */
  brief?: TaskBrief | null;
  /** How it's going against them (the clock, whether the plan was approved). */
  run?: TaskRun | null;
  /** Saved for this desk's worker (picked at the stand-up): it waits for them rather than going to whoever's free. */
  for?: string | null;
  /** Offered to this desk's worker ("I'll take it"): nobody else takes it while you decide. */
  offered?: string | null;
  /** How long it'll likely take and cost, worked out when it was handed out. */
  estimate?: Estimate | null;
  /** What it really took, once done (checked against the estimate). */
  took?: Took | null;
}

/** What a goal produces: working software, or a research deck. */
export type GoalKind = "build" | "research";

/**
 * Where a goal is in the agent loop. Build goals go Plan → Build → Review →
 * Ship → Shipped; research goals use the same stages, shown as Plan →
 * Research → Review → Present → Delivered.
 */
export type LoopStage = "plan" | "build" | "review" | "ship" | "shipped";

/** How the goal is going out the door. */
export interface ShipState {
  /** running: the deploy command (or a worker) is on it; failed: the command exited non-zero. */
  status: "running" | "failed" | "shipped";
  /** deploy: the configured command; agent: a worker was asked to ship; manual: marked by hand. */
  mode: "deploy" | "agent" | "manual";
  /** The exact command run, for deploys. */
  command: string | null;
  /** The desk of the worker asked to ship (or fix), for agent mode. */
  deskId: string | null;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  /** The end of the deploy's output, kept when it fails. */
  logTail: string;
  /** A PR or deploy URL, when one was reported. */
  url: string | null;
  /** The worker's one-line summary of what shipped. */
  note: string;
  by: string;
}

/** One slide of a research deck. */
export interface DeckSlide {
  title: string;
  bullets: string[];
  /** Speaker notes. */
  notes: string;
  /** An image URL, if the slide has one. */
  image: string | null;
}

export interface Deck {
  slides: DeckSlide[];
  /** The markdown file it was read from (absolute path on the server's machine). */
  path: string;
  updatedAt: number;
}

export interface Goal {
  id: string;
  title: string;
  /** Why it matters — shown under the title. */
  why: string;
  kind: GoalKind;
  createdBy: string;
  createdAt: number;
  /** When every task was done. */
  doneAt: number | null;
  tasks: GoalTask[];
  /** The desk a worker is planning this goal at, until its plan lands. */
  planningDesk: string | null;
  ship: ShipState | null;
  /** When it shipped (build) or was delivered (research). */
  shippedAt: number | null;
  /** The research deck its workers are writing (research goals). */
  deck: Deck | null;
  /** Its pull request on GitHub, once shipped that way. */
  pr?: PullRequestInfo | null;
  /** Pull requests opened per agent (each from that agent's own branch). */
  agentPrs?: AgentPullRequest[] | null;
  /** When it's due (epoch ms), or null: reminders come as it nears. */
  dueAt?: number | null;
  /** The desks working it as a group: tasks go out across them as each finishes. */
  group?: string[] | null;
}

/** A timed focus session the whole office works in. */
export interface Session {
  id: string;
  goalId: string | null;
  startedBy: string;
  startedAt: number;
  endsAt: number;
  minutes: number;
  tasksDone: number;
  reviews: number;
  xp: number;
  /** The tone set at the stand-up, and the line the team works toward. */
  tone: ToneId | null;
  intention: string;
  /** The stand-up in a few lines (said aloud when it starts), and what done looks like by the end of the day. */
  summary?: string;
  eod?: string[];
}

/** The last stand-up's plan, so tomorrow can pick up where today left off ("Resume yesterday"). */
export interface LastPlan {
  goalId: string | null;
  tone: ToneId | null;
  minutes: number;
  intention: string;
  summary: string;
  eod: string[];
  at: number;
}

/** The tone you set for a session at the stand-up. */
export type ToneId = "ship" | "focus" | "explore" | "bughunt";

export const TONES: readonly { id: ToneId; icon: string; label: string; blurb: string; minutes: number; color: string }[] = [
  { id: "ship", icon: "🚀", label: "Ship it", blurb: "Energetic — get things out the door", minutes: 120, color: "#ff8a5b" },
  { id: "focus", icon: "🧘", label: "Deep focus", blurb: "Quiet — heads down, no distractions", minutes: 180, color: "#5b7cfa" },
  { id: "explore", icon: "🧪", label: "Explore", blurb: "Playful — try ideas, spike, learn", minutes: 60, color: "#06d6a0" },
  { id: "bughunt", icon: "🐛", label: "Bug hunt", blurb: "Methodical — fix and harden", minutes: 120, color: "#ef476f" },
];

export function isTone(v: unknown): v is ToneId {
  return TONES.some((t) => t.id === v);
}

export interface SessionSummary {
  minutes: number;
  goalTitle: string | null;
  tasksDone: number;
  reviews: number;
  xp: number;
  /** True when it ran to the end (not stopped early). */
  completed: boolean;
  /** The end-of-day goals set at the stand-up, and the session goal's tasks: done, and still open (they carry over). */
  eod?: string[];
  done?: string[];
  open?: string[];
}

/** One person's score. Keyed by name, so it follows you between visits. */
export interface PlayerStats {
  name: string;
  xp: number;
  tasksDone: number;
  reviews: number;
  changes: number;
  sessions: number;
  goalsDone: number;
  hires: number;
  /** Consecutive days with a finished focus session. */
  streak: number;
  /** The last day (YYYY-MM-DD) a session finished, and how many that day. */
  lastDay: string | null;
  today: number;
  achievements: string[];
}

export interface FeedItem {
  at: number;
  who: string;
  text: string;
  xp: number;
}

export interface ProgressState {
  goals: Goal[];
  session: Session | null;
  players: PlayerStats[];
  feed: FeedItem[];
  /** The team's defaults for hiring and handing out tasks. */
  policy: TeamPolicy;
  /** Your team: characters you hire again and again. */
  team: Character[];
  /** The MCP servers the office gives its workers. */
  mcp: McpServer[];
  /** The last stand-up's plan (for "Resume yesterday"). */
  lastPlan?: LastPlan | null;
  /** Finished tasks, estimate vs. what they took: what the estimates learn from. */
  estimates?: EstimateSample[];
}

export const EMPTY_PROGRESS: ProgressState = { goals: [], session: null, players: [], feed: [], policy: DEFAULT_POLICY, team: [], mcp: [] };

/** What each kind of progress is worth. */
export const XP = {
  hire: 5,
  createGoal: 15,
  assign: 10,
  review: 20,
  changes: 15,
  taskDone: 50,
  goalDone: 250,
  /** Per minute of a finished focus session. */
  sessionMinute: 4,
  standup: 10,
  plan: 10,
  /** Shipping a build goal, or delivering a research deck. */
  ship: 150,
} as const;

/** Focus sessions run for hours, like a real block of work. */
export const SESSION_LENGTHS = [60, 120, 180, 240] as const;
/** The longest a session may be (a full working day). */
/** Long enough for a whole day ("until end of day" from early morning). */
export const MAX_SESSION_MINUTES = 720;

/** When the day ends when the policy doesn't say. */
export const DEFAULT_EOD = "17:30";

/**
 * A session "until end of day": the minutes from now to the end-of-day time
 * ("17:30"). Already past it (or nearly), an hour; never more than a session can run.
 */
export function minutesUntilEod(eodAt: string, now = new Date()): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(eodAt) ?? /^(\d{1,2}):(\d{2})$/.exec(DEFAULT_EOD)!;
  const end = new Date(now);
  end.setHours(Number(m[1]), Number(m[2]), 0, 0);
  const mins = Math.round((end.getTime() - now.getTime()) / 60_000);
  return mins < 15 ? 60 : Math.min(MAX_SESSION_MINUTES, mins);
}

/** Whether it's already (nearly) the end of the day. */
export function pastEod(eodAt: string, now = new Date()): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(eodAt) ?? /^(\d{1,2}):(\d{2})$/.exec(DEFAULT_EOD)!;
  return now.getHours() * 60 + now.getMinutes() > Number(m[1]) * 60 + Number(m[2]) - 15;
}

/** "5:30 PM": the end-of-day time, as people read it. */
export function eodLabel(eodAt: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(eodAt) ?? /^(\d{1,2}):(\d{2})$/.exec(DEFAULT_EOD)!;
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Said "all day" or "until end of day"? */
export const ALL_DAY = /\b(?:all day|rest of the day|(?:until|till|til|through) (?:the )?(?:end of (?:the )?day|eod|tonight)|full day)\b/i;

/** A session's length in words: "45 min", "2 h", "1 h 30 min". */
export function sessionLength(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Time left on a clock: "2:05:09", or "45:09" under an hour. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Level titles, from your first day to running the place. */
export const TITLES = [
  "Intern",
  "Junior Dev",
  "Developer",
  "Senior Dev",
  "Tech Lead",
  "Staff Engineer",
  "Principal",
  "Director",
  "VP Engineering",
  "CTO",
  "Founder",
];

/** XP needed to go from `level` to `level + 1`. */
export function xpForNext(level: number): number {
  return 100 + (level - 1) * 75;
}

export interface LevelInfo {
  level: number;
  title: string;
  /** XP into the current level, and how much the level takes. */
  into: number;
  need: number;
}

export function levelFor(xp: number): LevelInfo {
  let level = 1;
  let left = Math.max(0, Math.floor(xp));
  while (left >= xpForNext(level) && level < 99) {
    left -= xpForNext(level);
    level++;
  }
  return { level, title: TITLES[Math.min(level - 1, TITLES.length - 1)], into: left, need: xpForNext(level) };
}

export interface AchievementDef {
  id: string;
  icon: string;
  title: string;
  text: string;
  /** Whether these stats (and the office right now) earn it. */
  earned(s: PlayerStats, ctx: { workers: number }): boolean;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: "first-hire", icon: "🪑", title: "Welcome aboard", text: "Hire your first worker", earned: (s) => s.hires >= 1 },
  { id: "full-house", icon: "🏢", title: "Full house", text: "Have 6 workers at once", earned: (_s, c) => c.workers >= 6 },
  { id: "first-review", icon: "🎤", title: "Office hours", text: "Review your first presentation", earned: (s) => s.reviews >= 1 },
  { id: "coach", icon: "🧑‍🏫", title: "Coach", text: "Send changes back 5 times", earned: (s) => s.changes >= 5 },
  { id: "first-task", icon: "✅", title: "Checked off", text: "Finish your first task", earned: (s) => s.tasksDone >= 1 },
  { id: "task-master", icon: "🏅", title: "Task master", text: "Finish 10 tasks", earned: (s) => s.tasksDone >= 10 },
  { id: "shipper", icon: "🚀", title: "Shipped it", text: "Complete a goal", earned: (s) => s.goalsDone >= 1 },
  { id: "focus", icon: "🎧", title: "In the zone", text: "Finish a focus session", earned: (s) => s.sessions >= 1 },
  { id: "marathon", icon: "🏃", title: "Marathon", text: "Finish 3 focus sessions in a day", earned: (s) => s.today >= 3 },
  { id: "on-fire", icon: "🔥", title: "On fire", text: "Keep a 3-day streak", earned: (s) => s.streak >= 3 },
  { id: "level-5", icon: "⭐", title: "Tech Lead", text: "Reach level 5", earned: (s) => levelFor(s.xp).level >= 5 },
];

/** Where a goal is in the loop. */
export function goalStage(g: Goal): LoopStage {
  if (g.shippedAt) return "shipped";
  if (g.tasks.length === 0) return "plan";
  if (g.tasks.every((t) => t.status === "done")) return "ship";
  if (g.tasks.some((t) => t.status === "review")) return "review";
  return "build";
}

export const LOOP_STAGES: readonly LoopStage[] = ["plan", "build", "review", "ship", "shipped"];

/** What each stage is called for a kind of goal. */
export function stageLabel(stage: LoopStage, kind: GoalKind): string {
  const build = { plan: "Plan", build: "Build", review: "Review", ship: "Ship", shipped: "Shipped" };
  const research = { plan: "Plan", build: "Research", review: "Review", ship: "Present", shipped: "Delivered" };
  return (kind === "research" ? research : build)[stage];
}

export const STAGE_ICON: Record<LoopStage, string> = { plan: "🧠", build: "⌨️", review: "🎤", ship: "🚀", shipped: "🏁" };

/** Fill in fields added since a goal was saved (older progress files). */
export function coerceGoal(raw: Goal): Goal {
  return {
    ...raw,
    kind: raw.kind === "research" ? "research" : "build",
    tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
    planningDesk: null,
    ship: raw.ship && raw.ship.status !== "running" ? raw.ship : null,
    shippedAt: typeof raw.shippedAt === "number" ? raw.shippedAt : null,
    deck: raw.deck && Array.isArray(raw.deck.slides) ? raw.deck : null,
    dueAt: typeof raw.dueAt === "number" ? raw.dueAt : null,
    group: Array.isArray(raw.group) ? raw.group.filter((d): d is string => typeof d === "string").slice(0, 12) : null,
  };
}

export function goalProgress(g: Goal): { done: number; total: number; pct: number } {
  const total = g.tasks.length;
  const done = g.tasks.filter((t) => t.status === "done").length;
  return { done, total, pct: total ? done / total : 0 };
}

/** Today as YYYY-MM-DD in local time. */
export function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** One line on how a task is going against its brief, for lists: "⏱ 12m left · opus · plan first". */
export function briefLine(task: GoalTask, now = Date.now()): string {
  const b = task.brief;
  if (!b || task.status === "done" || !task.deskId) return "";
  const parts: string[] = [];
  const r = task.run;
  if (r?.deadline) {
    const left = r.deadline - now;
    parts.push(left > 0 ? `⏱ ${Math.ceil(left / 60000)}m left` : "⏱ time's up");
  }
  if (b.model) parts.push(b.model);
  if (b.planFirst) parts.push(r?.planApproved ? "plan ✓" : "plan first");
  return parts.join(" · ");
}

/** How a deadline reads: "due in 45m", "due in 3h", "due Tue 5 PM", "overdue by 20m". */
export function dueLabel(dueAt: number, now = Date.now()): string {
  const left = dueAt - now;
  const span = (ms: number) => {
    const m = Math.round(Math.abs(ms) / 60000);
    if (m < 60) return `${m}m`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
  };
  if (left < 0) return `overdue by ${span(left)}`;
  if (left < 24 * 3600_000) return `due in ${span(left)}`;
  return `due ${new Date(dueAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
}

/** A datetime-local input's value for an epoch ms (local time). */
export function toLocalInput(t: number): string {
  const d = new Date(t - new Date(t).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}
