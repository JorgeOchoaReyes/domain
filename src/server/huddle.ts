import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Goal } from "../shared/progress.js";
import { HUDDLE_MAX, huddleClaims, huddleMarkdown, noteLine, parseHuddleNote, type HuddleNote, type HuddleState } from "../shared/huddle.js";

/**
 * The team huddle at the start of a goal. A worker drafts the plan as usual;
 * then, before it's split into tasks, every teammate (up to four) reads the
 * draft and writes a short note — concerns, suggestions, the task they'd
 * take — and the planner revises the plan from those notes. The revised plan
 * becomes the goal's tasks, and each task someone asked for is saved for them.
 *
 * Every step has a time limit and you can skip it at any point: whatever
 * hasn't come in by then is left out, and if the planner doesn't deliver a
 * revision the draft stands. Files, in the goal's folder:
 *   huddle/<deskId>.md  each teammate's note
 *   huddle.md           the draft and all the notes, for the planner
 */

export interface HuddleOffice {
  /** Brief a worker (a simulated one acts it out, then calls `sim.done`). */
  brief(deskId: string, text: string, activity: string, sim?: { steps: string[]; done: () => void }): boolean;
  nameOf(deskId: string): string;
}

export interface HuddleDeps {
  office: HuddleOffice;
  goal(goalId: string): Goal | undefined;
  /** The goal's folder (made if needed). */
  dir(goalId: string): string;
  /** Where the goal's plan.md is. */
  planPath(goalId: string): string;
  /** Show the huddle's state (null: it's over). */
  set(goalId: string, huddle: HuddleState | null): void;
  /** The plan's final tasks, and who asked to take which. */
  landed(goalId: string, tasks: string[], claims: { deskId: string; task: string }[]): void;
  /** A line for the history and a toast. */
  note(goalId: string, text: string): void;
  /** A teammate's note, said out loud (a speech bubble in the office). */
  said?(deskId: string, text: string): void;
  /** Time limits (ms). */
  gatherMs?: number;
  reviseMs?: number;
  pollMs?: number;
  now?: () => number;
}

export class Huddles {
  private live = new Map<string, HuddleState>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private deps: HuddleDeps) {}

  /** The goal's huddle, while it's on. */
  get(goalId: string): HuddleState | null {
    return this.live.get(goalId) ?? null;
  }

  /**
   * A plan landed for a goal. During a huddle it's the planner's revision
   * (the end of it) or an updated draft; otherwise, with a planner and
   * teammates to ask, it's the draft a huddle starts on. Returns true when
   * the huddle took it — the caller adds the tasks only when it didn't.
   */
  onPlan(goalId: string, tasks: string[], teammates: string[]): boolean {
    const h = this.live.get(goalId);
    if (h) {
      if (h.status === "revising") this.finish(goalId, tasks.length ? tasks : h.draft, "revised");
      else if (tasks.length) {
        h.draft = tasks;
        this.deps.set(goalId, h);
      }
      return true;
    }
    const goal = this.deps.goal(goalId);
    const planner = goal?.planningDesk;
    if (!goal || !planner || !tasks.length || goal.tasks.length) return false;
    const team = [...new Set(teammates)].filter((d) => d !== planner).slice(0, HUDDLE_MAX);
    if (!team.length) return false;
    return this.start(goal, planner, tasks, team);
  }

  /** Skip the rest of it: the plan as it stands goes out now. */
  skip(goalId: string): boolean {
    const h = this.live.get(goalId);
    if (!h) return false;
    this.finish(goalId, h.draft, "skipped");
    return true;
  }

  /** Check for notes and time limits (also runs on its own while a huddle is on). */
  tick(): void {
    const now = this.now();
    for (const [goalId, h] of [...this.live]) {
      if (h.status !== "gathering") {
        if (now >= h.endsAt) this.finish(goalId, h.draft, "timeout");
        continue;
      }
      let changed = false;
      for (const deskId of h.deskIds) {
        if (h.notes.some((n) => n.deskId === deskId)) continue;
        const note = this.readNote(goalId, deskId);
        if (!note) continue;
        h.notes.push(note);
        changed = true;
        this.deps.said?.(deskId, noteLine(note));
      }
      if (changed) this.deps.set(goalId, h);
      if (h.notes.length >= h.deskIds.length || now >= h.endsAt) this.revise(goalId, h);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // --- the steps -------------------------------------------------------------------

  private start(goal: Goal, planner: string, draft: string[], team: string[]): boolean {
    const dir = join(this.deps.dir(goal.id), "huddle");
    mkdirSync(dir, { recursive: true });
    const asked: string[] = [];
    const numbered = draft.map((t, i) => `${i + 1}. ${t}`).join("; ");
    team.forEach((deskId, i) => {
      const file = this.notePath(goal.id, deskId);
      rmSync(file, { force: true });
      const briefed = this.deps.office.brief(
        deskId,
        `[Huddle] ${this.deps.office.nameOf(planner)} drafted the plan for "${goal.title}" and the team is huddling on it before it's split up. The draft: ${numbered}. ` +
          `Don't change any project files. Take a quick look, then write a short note to ${file}: up to two lines "Concern: …" (a risk, something missing, the wrong order), ` +
          `up to two "Suggest: …", and one "Take: <number>" for the task you'd do best. Then wait for your task.`,
        `🤝 Huddle: ${goal.title}`,
        {
          steps: ["· reading the draft plan…", "· thinking about the risks…", "· writing a note for the huddle…"],
          done: () => writeQuietly(file, simNote(draft, i)),
        },
      );
      if (briefed) asked.push(deskId);
    });
    if (!asked.length) return false;
    const now = this.now();
    const h: HuddleState = { status: "gathering", plannerDesk: planner, deskIds: asked, draft, notes: [], startedAt: now, endsAt: now + (this.deps.gatherMs ?? 3 * 60_000) };
    this.live.set(goal.id, h);
    this.deps.set(goal.id, h);
    this.deps.note(goal.id, `🤝 Huddle on the plan for “${goal.title}”: ${asked.length} teammate${asked.length === 1 ? "" : "s"} weighing in`);
    this.run();
    return true;
  }

  /** Everyone's in (or time's up): the planner folds the notes in — or, with none, the draft stands. */
  private revise(goalId: string, h: HuddleState): void {
    const goal = this.deps.goal(goalId);
    if (!goal || !h.notes.length) {
      this.finish(goalId, h.draft, "nobody");
      return;
    }
    const summary = join(this.deps.dir(goalId), "huddle.md");
    writeQuietly(summary, huddleMarkdown(goal.title, h.draft, h.notes));
    const plan = this.deps.planPath(goalId);
    const briefed = this.deps.office.brief(
      h.plannerDesk,
      `[Huddle] Your teammates weighed in on your plan for "${goal.title}": the draft and their notes are in ${summary}. ` +
        `Revise the plan with what's worth taking (3-8 tasks, in order, one line each, starting with a verb) and write it again to ${plan} as a markdown checklist, one "- [ ] task" per line. Don't start the work yet.`,
      `🤝 Revising the plan: ${goal.title}`,
      {
        steps: ["· reading the huddle notes…", "· revising the plan…", `· writing ${plan}`],
        done: () => writeQuietly(plan, simRevision(goal.title, h.draft, h.notes)),
      },
    );
    if (!briefed) {
      this.finish(goalId, h.draft, "nobody");
      return;
    }
    h.status = "revising";
    h.endsAt = this.now() + (this.deps.reviseMs ?? 3 * 60_000);
    this.deps.set(goalId, h);
    this.deps.note(goalId, `🤝 ${h.notes.length} of ${h.deskIds.length} weighed in — ${this.deps.office.nameOf(h.plannerDesk)} is revising the plan`);
  }

  private finish(goalId: string, tasks: string[], why: "revised" | "skipped" | "timeout" | "nobody"): void {
    const h = this.live.get(goalId);
    if (!h) return;
    this.live.delete(goalId);
    if (!this.live.size) this.stop();
    this.deps.set(goalId, null);
    const claims = huddleClaims(h.notes, h.draft, tasks);
    const title = this.deps.goal(goalId)?.title ?? "the goal";
    const how =
      why === "revised" ? "the plan was revised from the huddle" : why === "skipped" ? "huddle skipped — the draft stands" : why === "timeout" ? "no revision in time — the draft stands" : "nobody weighed in — the draft stands";
    this.deps.note(goalId, `🤝 Huddle on “${title}” done: ${how}${claims.length ? ` · ${claims.length} task${claims.length === 1 ? "" : "s"} claimed` : ""}`);
    this.deps.landed(goalId, tasks, claims);
  }

  private run(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.deps.pollMs ?? 2000);
    this.timer.unref?.();
  }

  private notePath(goalId: string, deskId: string): string {
    return join(this.deps.dir(goalId), "huddle", `${deskId.replace(/[^A-Za-z0-9_-]/g, "")}.md`);
  }

  private readNote(goalId: string, deskId: string): HuddleNote | null {
    const file = this.notePath(goalId, deskId);
    try {
      if (!existsSync(file)) return null;
      const parsed = parseHuddleNote(readFileSync(file, "utf8").slice(0, 20_000));
      return parsed ? { deskId, name: this.deps.office.nameOf(deskId), ...parsed, at: this.now() } : null;
    } catch {
      return null;
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

function writeQuietly(path: string, text: string): void {
  try {
    writeFileSync(path, text);
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// DOMAIN_SIMULATE: what scripted workers say
// ---------------------------------------------------------------------------

const SIM_CONCERNS = ["the edge cases could slip through", "it touches shared code — keep the change small", "we have no way to check it end to end yet", "the order matters: build before polish"];
const SIM_SUGGEST = ["Add a quick end-to-end check", "Write down what done looks like first", "Keep the first version behind a flag", "Pair the UI work with a screenshot in the review"];

function simNote(draft: string[], i: number): string {
  const take = draft.length ? ((i + 1) % draft.length) + 1 : 1;
  return `Concern: ${SIM_CONCERNS[i % SIM_CONCERNS.length]}\nSuggest: ${SIM_SUGGEST[i % SIM_SUGGEST.length]}\nTake: ${take}\n`;
}

function simRevision(title: string, draft: string[], notes: HuddleNote[]): string {
  const extra = notes[0]?.suggestions[0];
  const items = extra && !draft.some((t) => t.toLowerCase() === extra.toLowerCase()) ? [...draft.slice(0, -1), extra, ...draft.slice(-1)] : draft;
  return `# Plan: ${title} (after the huddle)\n\n${items.map((t) => `- [ ] ${t}`).join("\n")}\n`;
}
