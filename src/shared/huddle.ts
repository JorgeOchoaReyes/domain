import { STANDUP } from "./layout.js";

/**
 * The team huddle at the start of a goal, and the demo at the end of it.
 *
 * Huddle: once a worker has drafted the plan, everyone else on the team reads
 * it and weighs in — a concern or two, a suggestion, which task they'd take —
 * and the planner revises the plan from what they said before it's split into
 * tasks. Each teammate writes a short note; the whole thing has a time limit
 * and you can skip it. Shared by the server (which runs it) and the client
 * (which shows it, and gathers the team round the stand-up circle).
 *
 * Demo: when every task of a build goal is approved, the office captures what
 * was built — a screenshot of the running app, or the output of a command —
 * and shows it to everyone before it ships.
 */

/** What one teammate said in the huddle. */
export interface HuddleNote {
  deskId: string;
  name: string;
  concerns: string[];
  suggestions: string[];
  /** The task they'd take, in their words (a number or a title). */
  take: string | null;
  at: number;
}

export interface HuddleState {
  /** gathering: teammates are reading the draft; revising: the planner is folding their notes in. */
  status: "gathering" | "revising";
  /** The worker who drafted the plan (and revises it). */
  plannerDesk: string;
  /** The teammates asked to weigh in. */
  deskIds: string[];
  /** The draft plan's tasks. */
  draft: string[];
  notes: HuddleNote[];
  startedAt: number;
  /** When this step gives up waiting. */
  endsAt: number;
}

/** At most this many teammates are asked (each one is a short brief). */
export const HUDDLE_MAX = 4;

const clip = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

/**
 * A teammate's note, from the markdown it wrote: lines starting "Concern:",
 * "Suggest:" (or "Suggestion:") and "Take:"; other bullets count as
 * suggestions. Null when there's nothing in it.
 */
export function parseHuddleNote(md: string): Pick<HuddleNote, "concerns" | "suggestions" | "take"> | null {
  const concerns: string[] = [];
  const suggestions: string[] = [];
  let take: string | null = null;
  for (const raw of md.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/\*\*|__/g, "")
      .trim();
    if (!line || /^#/.test(line)) continue;
    const m = /^(concerns?|risks?|worr(?:y|ies)|suggest(?:ions?|s)?|ideas?|take|i'?d take|i will take|i'll take)\s*:\s*(.*)$/i.exec(line);
    if (m) {
      const what = clip(m[2], 240);
      if (!what) continue;
      const k = m[1].toLowerCase();
      if (/^(concern|risk|worr)/.test(k)) concerns.push(what);
      else if (/take/.test(k)) take ??= clip(what, 160);
      else suggestions.push(what);
    } else if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(raw)) suggestions.push(clip(line, 240));
  }
  if (!concerns.length && !suggestions.length && !take) return null;
  return { concerns: concerns.slice(0, 4), suggestions: suggestions.slice(0, 4), take };
}

/**
 * Which task (an index into `tasks`) a "Take:" line means: a number ("2",
 * "#2", "task 2"), or the task whose words it shares most. Null if none fits.
 */
export function matchTake(take: string, tasks: string[]): number | null {
  const n = /^(?:task\s*)?#?(\d{1,2})\b/i.exec(take.trim());
  if (n) {
    const i = Number(n[1]) - 1;
    return i >= 0 && i < tasks.length ? i : null;
  }
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const want = words(take);
  let best: number | null = null;
  let score = 0;
  tasks.forEach((t, i) => {
    const have = words(t);
    let s = 0;
    for (const w of want) if (have.has(w)) s++;
    const frac = have.size ? s / have.size : 0;
    if (s > 0 && frac >= 0.34 && frac > score) {
      score = frac;
      best = i;
    }
  });
  return best;
}

/**
 * Who takes what, from the notes: each task goes to the first teammate who
 * asked for it. A "Take:" names a task of the draft (by number or words);
 * it's found again in the final plan, which may have moved things round.
 */
export function huddleClaims(notes: HuddleNote[], draft: string[], tasks: string[]): { deskId: string; task: string }[] {
  const out: { deskId: string; task: string }[] = [];
  const taken = new Set<number>();
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const n of notes) {
    if (!n.take) continue;
    const d = matchTake(n.take, draft);
    const was = d === null ? null : draft[d];
    let i = was === null ? -1 : tasks.findIndex((t) => norm(t) === norm(was));
    if (i < 0) i = matchTake(was ?? n.take, tasks) ?? -1;
    if (i < 0 || taken.has(i)) continue;
    taken.add(i);
    out.push({ deskId: n.deskId, task: tasks[i] });
  }
  return out;
}

/** The draft and everyone's notes, as markdown for the planner to revise from. */
export function huddleMarkdown(goalTitle: string, draft: string[], notes: HuddleNote[]): string {
  const lines = [`# Huddle: ${goalTitle}`, "", "## The draft plan", "", ...draft.map((t, i) => `${i + 1}. ${t}`), ""];
  for (const n of notes) {
    lines.push(`## ${n.name}`, "");
    for (const c of n.concerns) lines.push(`- Concern: ${c}`);
    for (const s of n.suggestions) lines.push(`- Suggest: ${s}`);
    if (n.take) lines.push(`- Would take: ${n.take}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** One line on a note, for a speech bubble or a list. */
export function noteLine(n: Pick<HuddleNote, "concerns" | "suggestions" | "take">): string {
  const parts: string[] = [];
  if (n.concerns[0]) parts.push(`⚠ ${n.concerns[0]}`);
  if (n.suggestions[0]) parts.push(`💡 ${n.suggestions[0]}`);
  if (n.take) parts.push(`🙋 I'll take ${n.take}`);
  return parts.join(" · ");
}

/** Where the i-th of n people stands in a huddle: a tight ring in the stand-up circle, facing in. */
export function huddleSpot(i: number, n: number): { x: number; z: number; facing: number } {
  const theta = (i / Math.max(1, n)) * Math.PI * 2 + Math.PI / 5;
  const r = Math.min(STANDUP.circle.r - 0.4, 0.9 + n * 0.12);
  return { x: STANDUP.circle.x + Math.sin(theta) * r, z: STANDUP.circle.z + Math.cos(theta) * r, facing: theta + Math.PI };
}

// ---------------------------------------------------------------------------
// The demo
// ---------------------------------------------------------------------------

export interface GoalDemo {
  /** screenshot: a headless browser's picture of a URL; terminal: a command's output. */
  kind: "screenshot" | "terminal";
  status: "running" | "ready" | "failed";
  /** The URL or the command. */
  source: string;
  /** A terminal demo's output (the end of it), or why it failed. */
  output: string;
  /** Whether there's a picture to fetch (with "demoGet"). */
  image: boolean;
  exitCode: number | null;
  at: number;
}

/** A saved demo, cleaned (one that was running when the office stopped didn't finish). */
export function coerceDemo(raw: unknown): GoalDemo | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.kind !== "screenshot" && o.kind !== "terminal") return null;
  if (o.status !== "ready" && o.status !== "failed") return null;
  return {
    kind: o.kind,
    status: o.status,
    source: typeof o.source === "string" ? o.source.slice(0, 1000) : "",
    output: typeof o.output === "string" ? o.output.slice(-8000) : "",
    image: o.image === true,
    exitCode: typeof o.exitCode === "number" ? o.exitCode : null,
    at: typeof o.at === "number" ? o.at : 0,
  };
}
