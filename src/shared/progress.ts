/**
 * The game layer: goals broken into tasks, focus sessions, and the XP, levels,
 * streaks and achievements you earn by making real progress. Shared by the
 * server (which keeps score) and the client (which shows it).
 */

import { DEFAULT_POLICY, type TaskBrief, type TaskRun, type TeamPolicy } from "./policy.js";
import type { PullRequestInfo } from "./project.js";
import type { Character } from "./team.js";
import type { McpServer } from "./mcp.js";

export type TaskStatus = "todo" | "doing" | "review" | "done";

export interface GoalTask {
  id: string;
  title: string;
  status: TaskStatus;
  /** The desk whose worker is on it, while it's being done or reviewed. */
  deskId: string | null;
  doneAt: number | null;
  /** The terms it was handed out on (model, time budget, plan first, definition of done). */
  brief?: TaskBrief | null;
  /** How it's going against them (the clock, whether the plan was approved). */
  run?: TaskRun | null;
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
}

/** The tone you set for a session at the stand-up. */
export type ToneId = "ship" | "focus" | "explore" | "bughunt";

export const TONES: readonly { id: ToneId; icon: string; label: string; blurb: string; minutes: number; color: string }[] = [
  { id: "ship", icon: "🚀", label: "Ship it", blurb: "Energetic — get things out the door", minutes: 50, color: "#ff8a5b" },
  { id: "focus", icon: "🧘", label: "Deep focus", blurb: "Quiet — heads down, no distractions", minutes: 90, color: "#5b7cfa" },
  { id: "explore", icon: "🧪", label: "Explore", blurb: "Playful — try ideas, spike, learn", minutes: 25, color: "#06d6a0" },
  { id: "bughunt", icon: "🐛", label: "Bug hunt", blurb: "Methodical — fix and harden", minutes: 50, color: "#ef476f" },
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

export const SESSION_LENGTHS = [25, 50, 90] as const;

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

