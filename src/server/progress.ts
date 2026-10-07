import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_POLICY, coercePolicy, type TaskBrief, type TeamPolicy } from "../shared/policy.js";
import { MAX_TEAM, coerceCharacter, type Character } from "../shared/team.js";
import { SECRET_MASK, coerceMcpServer, type McpServer } from "../shared/mcp.js";
import type { PullRequestInfo } from "../shared/project.js";
import {
  ACHIEVEMENTS,
  XP,
  coerceGoal,
  dayKey,
  goalProgress,
  levelFor,
  type DeckSlide,
  type FeedItem,
  type Goal,
  type GoalKind,
  type GoalTask,
  type ShipState,
  type ToneId,
  type LastPlan,
  type PlayerStats,
  type ProgressState,
  type Session,
  type SessionSummary, MAX_SESSION_MINUTES, sessionLength } from "../shared/progress.js";

/** Something worth telling the person who earned it (and the office). */
export interface Award {
  who: string;
  xp: number;
  reason: string;
  /** Set when this award took them up a level. */
  levelUp?: { level: number; title: string };
  /** Achievements this award unlocked. */
  unlocked: string[];
}

const MAX_GOALS = 50;
const MAX_TASKS = 40;
const FEED_LEN = 40;

/**
 * Keeps score: the goals and their tasks, the focus session, and everyone's
 * XP, streaks and achievements. Saved to a JSON file so progress survives
 * restarts. It knows nothing of sockets — the server calls it and broadcasts
 * what changed.
 */
export class Progress {
  private state: ProgressState = { goals: [], session: null, players: [], feed: [], policy: DEFAULT_POLICY, team: [], mcp: [] };
  private saveTimer: NodeJS.Timeout | null = null;

  /** Called when anything visible changed. */
  onChange: (() => void) | null = null;
  /** Called for each award, so the earner can be congratulated. */
  onAward: ((award: Award) => void) | null = null;
  /** Called when a focus session ends, with its summary. */
  onSessionEnd: ((summary: SessionSummary) => void) | null = null;

  /** How many workers are in the office now (for "Full house"). */
  workers: () => number = () => 0;
  /** Who is in the office now (they all share a session's reward). */
  present: () => string[] = () => [];

  constructor(private file: string | null) {
    this.load();
  }

  /** What clients see. MCP secrets (env values, headers) never leave the server: they show as SECRET_MASK. */
  /** A worker offered to take this task (null: the offer's settled): it waits for your answer. */
  setOffered(goalId: string, taskId: string, deskId: string | null): boolean {
    const t = this.goal(goalId)?.tasks.find((x) => x.id === taskId);
    if (!t) return false;
    t.offered = deskId;
    this.changed();
    return true;
  }

  /** Save a waiting task for one worker (null: anyone). */
  reserve(goalId: string, taskId: string, deskId: string | null): boolean {
    const t = this.goal(goalId)?.tasks.find((x) => x.id === taskId);
    if (!t || t.status === "done") return false;
    t.for = deskId;
    this.changed();
    return true;
  }

  /** The last stand-up's plan, its goal dropped if that's gone or finished. */
  get lastPlan(): LastPlan | null {
    const p = this.state.lastPlan;
    if (!p) return null;
    const g = p.goalId ? this.goal(p.goalId) : undefined;
    return { ...p, goalId: g && !g.doneAt && !g.shippedAt ? g.id : null };
  }

  snapshot(): ProgressState {
    const s = structuredClone(this.state);
    for (const m of s.mcp) for (const k of Object.keys(m.env)) m.env[k] = SECRET_MASK;
    return s;
  }

  // --- goals --------------------------------------------------------------------

  createGoal(who: string, title: string, why: string, tasks: string[], kind: GoalKind = "build", dueAt: number | null = null): Goal | null {
    const t = clean(title, 120);
    if (!t || this.state.goals.length >= MAX_GOALS) return null;
    const goal: Goal = {
      id: randomUUID().slice(0, 8),
      title: t,
      why: clean(why, 240),
      kind: kind === "research" ? "research" : "build",
      createdBy: who,
      createdAt: Date.now(),
      doneAt: null,
      tasks: [],
      planningDesk: null,
      ship: null,
      shippedAt: null,
      deck: null,
      dueAt: dueAt && Number.isFinite(dueAt) ? dueAt : null,
      group: null,
    };
    for (const line of tasks.slice(0, MAX_TASKS)) {
      const tt = clean(line, 160);
      if (tt) goal.tasks.push({ id: randomUUID().slice(0, 8), title: tt, status: "todo", deskId: null, doneAt: null });
    }
    this.state.goals.unshift(goal);
    this.feed(who, `set a new goal: ${goal.title}`, XP.createGoal);
    this.award(who, XP.createGoal, `New goal: ${goal.title}`);
    this.changed();
    return goal;
  }

  /** Add a task to a goal; returns its id, or null if the goal is missing or full. */
  addTask(goalId: string, title: string): string | null {
    const g = this.goal(goalId);
    const t = clean(title, 160);
    if (!g || !t || g.tasks.length >= MAX_TASKS) return null;
    const id = randomUUID().slice(0, 8);
    g.tasks.push({ id, title: t, status: "todo", deskId: null, doneAt: null });
    g.doneAt = null;
    this.changed();
    return id;
  }

  /** When a goal is due (null: no deadline). */
  setDue(goalId: string, dueAt: number | null): boolean {
    const g = this.goal(goalId);
    if (!g) return false;
    g.dueAt = dueAt && Number.isFinite(dueAt) ? dueAt : null;
    this.changed();
    return true;
  }

  /** The desks working a goal as a group (empty: no group). */
  setGroup(goalId: string, deskIds: string[]): boolean {
    const g = this.goal(goalId);
    if (!g) return false;
    g.group = deskIds.length ? [...new Set(deskIds)].slice(0, 12) : null;
    this.changed();
    return true;
  }

  /** Every goal's id (for watching their folders). */
  goalIds(): string[] {
    return this.state.goals.map((g) => g.id);
  }

  /** Look a goal up. */
  getGoal(goalId: string): Goal | undefined {
    return this.goal(goalId);
  }

  // --- the agent loop ----------------------------------------------------------------

  /** A worker was asked to plan a goal. */
  planning(who: string, goalId: string, deskId: string): boolean {
    const g = this.goal(goalId);
    if (!g) return false;
    g.planningDesk = deskId;
    this.stats(who);
    this.feed(who, `asked a worker to plan “${g.title}”`, XP.plan);
    this.award(who, XP.plan, `Planning: ${g.title}`);
    this.changed();
    return true;
  }

  /**
   * A plan landed: add the tasks it lists that the goal doesn't have yet.
   * Returns how many were added.
   */
  addPlannedTasks(goalId: string, titles: string[]): number {
    const g = this.goal(goalId);
    if (!g) return 0;
    const have = new Set(g.tasks.map((t) => norm(t.title)));
    let added = 0;
    for (const raw of titles) {
      const t = clean(raw, 160);
      if (!t || have.has(norm(t)) || g.tasks.length >= MAX_TASKS) continue;
      have.add(norm(t));
      g.tasks.push({ id: randomUUID().slice(0, 8), title: t, status: "todo", deskId: null, doneAt: null });
      added++;
    }
    const planner = g.planningDesk;
    g.planningDesk = null;
    if (added) {
      g.doneAt = null;
      this.feed("A worker", `planned “${g.title}”: ${added} task${added === 1 ? "" : "s"}`, 0);
    }
    if (added || planner) this.changed();
    return added;
  }

  /** The research deck for a goal was (re)written. Returns false if nothing changed. */
  setDeck(goalId: string, slides: DeckSlide[], path: string): boolean {
    const g = this.goal(goalId);
    if (!g) return false;
    if (JSON.stringify(g.deck?.slides ?? null) === JSON.stringify(slides)) return false;
    g.deck = { slides, path, updatedAt: Date.now() };
    this.changed();
    return true;
  }

  /** Shipping started: the deploy command is running, or a worker was asked to ship. */
  shipStarted(who: string, goalId: string, mode: ShipState["mode"], command: string | null, deskId: string | null): boolean {
    const g = this.goal(goalId);
    if (!g || g.shippedAt) return false;
    g.ship = { status: "running", mode, command, deskId, startedAt: Date.now(), finishedAt: null, exitCode: null, logTail: "", url: null, note: "", by: who };
    this.feed(who, mode === "deploy" ? `started deploying “${g.title}”` : `asked a worker to ship “${g.title}”`, 0);
    this.changed();
    return true;
  }

  /** The deploy command failed. */
  shipFailed(goalId: string, exitCode: number | null, logTail: string): void {
    const g = this.goal(goalId);
    if (!g?.ship) return;
    Object.assign(g.ship, { status: "failed", exitCode, logTail: logTail.slice(-4000), finishedAt: Date.now() });
    this.feed(g.ship.by, `hit a failed deploy on “${g.title}”`, 0);
    this.changed();
  }

  /** A running ship was stopped: back to ready-to-ship. */
  shipCancelled(goalId: string): void {
    const g = this.goal(goalId);
    if (!g?.ship || g.ship.status !== "running") return;
    g.ship = null;
    this.changed();
  }

  /**
   * The goal shipped (or its deck was delivered): XP for whoever shipped it.
   * The award reason starts with "Shipped:" or "Delivered:".
   */
  shipped(who: string, goalId: string, opts: { mode?: ShipState["mode"]; url?: string | null; note?: string; exitCode?: number | null } = {}): boolean {
    const g = this.goal(goalId);
    if (!g || g.shippedAt) return false;
    const now = Date.now();
    const prev = g.ship;
    const credit = prev?.by ?? who;
    g.ship = {
      status: "shipped",
      mode: opts.mode ?? prev?.mode ?? "manual",
      command: prev?.command ?? null,
      deskId: prev?.deskId ?? null,
      startedAt: prev?.startedAt ?? now,
      finishedAt: now,
      exitCode: opts.exitCode ?? prev?.exitCode ?? null,
      logTail: "",
      url: cleanUrl(opts.url) ?? prev?.url ?? null,
      note: clean(opts.note ?? "", 300),
      by: credit,
    };
    g.shippedAt = now;
    if (!g.doneAt) {
      g.doneAt = now;
      this.stats(credit).goalsDone++;
    }
    const verb = g.kind === "research" ? "Delivered" : "Shipped";
    this.feed(credit, g.kind === "research" ? `delivered “${g.title}” 📊` : `shipped “${g.title}” 🚢`, XP.ship);
    this.award(credit, XP.ship, `${verb}: ${g.title}`);
    this.changed();
    return true;
  }

  /**
   * The stand-up: set the goal (making it if it's new), the tone and the
   * intention, and start the focus session on it unless one is running.
   */
  standup(
    who: string,
    opts: {
      goalId: string | null;
      newGoal?: { title: string; why: string; tasks: string[]; kind: GoalKind; dueAt?: number | null };
      tone: ToneId;
      intention: string;
      minutes: number;
      summary?: string;
      eod?: string[];
    },
  ): { goal: Goal | null; started: boolean } {
    let goal: Goal | null = opts.goalId ? (this.goal(opts.goalId) ?? null) : null;
    if (opts.newGoal) goal = this.createGoal(who, opts.newGoal.title, opts.newGoal.why, opts.newGoal.tasks, opts.newGoal.kind, opts.newGoal.dueAt ?? null) ?? goal;
    const intention = clean(opts.intention, 200);
    const summary = clean(opts.summary, 600);
    const eod = (opts.eod ?? []).map((e) => clean(e, 200)).filter(Boolean).slice(0, 6);
    const started = this.startSession(who, opts.minutes, goal?.id ?? null, opts.tone, intention);
    if (started && this.state.session) {
      if (summary) this.state.session.summary = summary;
      if (eod.length) this.state.session.eod = eod;
    }
    this.state.lastPlan = { goalId: goal?.id ?? null, tone: opts.tone, minutes: opts.minutes, intention, summary, eod, at: Date.now() };
    const what = goal ? goal.title : "no particular goal";
    this.feed(who, `held the stand-up: ${what}${intention ? ` — “${intention}”` : ""}`, XP.standup);
    this.award(who, XP.standup, "Held the stand-up");
    this.changed();
    return { goal, started };
  }

  deleteGoal(goalId: string): boolean {
    const i = this.state.goals.findIndex((g) => g.id === goalId);
    if (i === -1) return false;
    this.state.goals.splice(i, 1);
    if (this.state.session?.goalId === goalId) this.state.session.goalId = null;
    this.changed();
    return true;
  }

  /**
   * Put a worker on a task. Returns the task's goal and title so the server
   * can brief the worker, or null if it can't be assigned.
   */
  assign(who: string, goalId: string, taskId: string, deskId: string, brief?: TaskBrief): { goal: Goal; title: string } | null {
    const g = this.goal(goalId);
    const task = g?.tasks.find((t) => t.id === taskId);
    if (!g || !task || task.status === "done") return null;
    // A worker works one task at a time: free whatever it was on.
    this.unlinkDesk(deskId, false);
    task.deskId = deskId;
    task.status = "doing";
    const now = Date.now();
    task.brief = brief ?? null;
    task.run = {
      startedAt: now,
      deadline: brief?.minutes ? now + brief.minutes * 60_000 : null,
      timeUp: false,
      planApproved: !brief?.planFirst,
    };
    this.feed(who, `put a worker on “${task.title}”`, XP.assign);
    this.award(who, XP.assign, `Assigned: ${task.title}`);
    this.changed();
    return { goal: g, title: task.title };
  }

  /** Tick a task off by hand (or untick it). */
  setDone(who: string, goalId: string, taskId: string, done: boolean): boolean {
    const g = this.goal(goalId);
    const task = g?.tasks.find((t) => t.id === taskId);
    if (!g || !task) return false;
    if (done && task.status !== "done") this.completeTask(who, g, task.id);
    else if (!done && task.status === "done") {
      task.status = "todo";
      task.doneAt = null;
      g.doneAt = null;
      this.changed();
    }
    return true;
  }

  /** The task a desk's worker is on, if any. */
  taskAt(deskId: string): { goal: Goal; taskId: string; title: string } | null {
    for (const goal of this.state.goals) {
      const t = goal.tasks.find((x) => x.deskId === deskId && x.status !== "done");
      if (t) return { goal, taskId: t.id, title: t.title };
    }
    return null;
  }

  /** The worker at a desk was sent home: its task goes back on the pile. */
  unlinkDesk(deskId: string, notify = true): void {
    let changed = false;
    for (const g of this.state.goals) {
      if (notify && g.planningDesk === deskId) {
        g.planningDesk = null;
        changed = true;
      }
      if (notify && g.ship?.status === "running" && g.ship.mode === "agent" && g.ship.deskId === deskId) {
        g.ship = null;
        changed = true;
      }
      for (const t of g.tasks) {
        if (t.deskId === deskId && t.status !== "done") {
          t.deskId = null;
          t.status = "todo";
          t.run = null;
          changed = true;
        }
      }
    }
    if (changed && notify) this.changed();
  }

  // --- hooks from the office -------------------------------------------------------

  hired(who: string): void {
    this.stats(who).hires++;
    this.feed(who, "hired a worker", XP.hire);
    this.award(who, XP.hire, "Hired a worker");
    this.changed();
  }

  /** A worker presented: its task is up for review. */
  reported(deskId: string): void {
    const at = this.taskAt(deskId);
    if (!at) return;
    const t = at.goal.tasks.find((x) => x.id === at.taskId)!;
    if (t.status === "doing") {
      t.status = "review";
      this.changed();
    }
  }

  /** You reviewed a worker's presentation (`plan`: it was a plan, not finished work). */
  reviewed(who: string, deskId: string, approve: boolean, plan = false): void {
    const s = this.stats(who);
    s.reviews++;
    if (!approve) s.changes++;
    if (this.state.session) this.state.session.reviews++;
    const at = this.taskAt(deskId);
    if (plan) {
      // A plan review: the task carries on either way — built if approved, re-planned if not.
      const t = at?.goal.tasks.find((x) => x.id === at.taskId);
      if (t) {
        t.status = "doing";
        if (approve && t.run) t.run.planApproved = true;
      }
      this.award(who, approve ? XP.review : XP.changes, approve ? "Approved a plan" : "Coached a plan");
      this.feed(who, at ? `${approve ? "approved the plan for" : "sent back the plan for"} “${at.title}”` : `${approve ? "approved" : "sent back"} a plan`, approve ? XP.review : XP.changes);
      this.changed();
      return;
    }
    if (approve) {
      this.award(who, XP.review, "Reviewed a presentation");
      if (at) this.completeTask(who, at.goal, at.taskId);
      else this.feed(who, "approved a worker's progress", XP.review);
    } else {
      this.award(who, XP.changes, "Coached a worker");
      this.feed(who, at ? `sent “${at.title}” back with changes` : "sent a worker back with changes", XP.changes);
      if (at) at.goal.tasks.find((x) => x.id === at.taskId)!.status = "doing";
    }
    this.changed();
  }

  // --- your team, MCP servers, pull requests ----------------------------------------------

  get team(): Character[] {
    return this.state.team;
  }

  character(id: string): Character | null {
    return this.state.team.find((c) => c.id === id) ?? null;
  }

  /** Add a character, or update the one with its id. False when the team is full. */
  saveCharacter(c: Character): boolean {
    const i = this.state.team.findIndex((x) => x.id === c.id);
    if (i >= 0) this.state.team[i] = { ...c, createdAt: this.state.team[i].createdAt, hires: this.state.team[i].hires };
    else if (this.state.team.length >= MAX_TEAM) return false;
    else this.state.team.push(c);
    this.changed();
    return true;
  }

  deleteCharacter(id: string): void {
    const n = this.state.team.length;
    this.state.team = this.state.team.filter((c) => c.id !== id);
    if (this.state.team.length !== n) this.changed();
  }

  characterHired(id: string): void {
    const c = this.character(id);
    if (!c) return;
    c.hires++;
    this.changed();
  }

  get mcp(): McpServer[] {
    return this.state.mcp;
  }

  /** Add or update an MCP server. An env value still showing SECRET_MASK keeps the stored secret. */
  saveMcp(s: McpServer): void {
    const old = this.state.mcp.find((x) => x.id === s.id);
    for (const [k, v] of Object.entries(s.env)) if (v === SECRET_MASK) s.env[k] = old?.env[k] ?? "";
    const i = this.state.mcp.findIndex((x) => x.id === s.id);
    if (i >= 0) this.state.mcp[i] = s;
    else this.state.mcp.push(s);
    this.changed();
  }

  deleteMcp(id: string): void {
    this.state.mcp = this.state.mcp.filter((s) => s.id !== id);
    for (const c of this.state.team) c.mcp = c.mcp.filter((x) => x !== id);
    this.changed();
  }

  /** A goal's pull request was opened, or its state changed. */
  setPr(goalId: string, pr: PullRequestInfo): void {
    const g = this.goal(goalId);
    if (!g) return;
    g.pr = pr;
    this.changed();
  }

  // --- the team's policy and task clocks -------------------------------------------------

  /** Whether the policy came from saved progress (so a config file shouldn't override it). */
  private policySaved = false;

  get policy(): TeamPolicy {
    return this.state.policy;
  }

  setPolicy(who: string, p: TeamPolicy): void {
    this.state.policy = p;
    this.policySaved = true;
    this.feed(who, "updated the team policy", 0);
    this.changed();
  }

  /** Defaults from domain.config.json, used until someone sets the policy in game. */
  seedPolicy(p: TeamPolicy): void {
    if (this.policySaved) return;
    this.state.policy = p;
    this.changed();
  }

  /**
   * Tasks whose time budget just ran out (still being worked on). Each is
   * returned once; the caller nudges the worker or calls it in.
   */
  timeUps(now = Date.now()): { goal: Goal; task: GoalTask }[] {
    const out: { goal: Goal; task: GoalTask }[] = [];
    for (const goal of this.state.goals) {
      for (const task of goal.tasks) {
        const r = task.run;
        if (task.status !== "doing" || !task.deskId || !r?.deadline || r.timeUp || now < r.deadline) continue;
        r.timeUp = true;
        out.push({ goal, task });
      }
    }
    if (out.length) this.changed();
    return out;
  }

  // --- sessions ------------------------------------------------------------------------

  startSession(who: string, minutes: number, goalId: string | null, tone: ToneId | null = null, intention = ""): boolean {
    if (this.state.session) return false;
    const m = Math.max(1, Math.min(MAX_SESSION_MINUTES, Math.round(minutes)));
    const now = Date.now();
    this.state.session = {
      id: randomUUID().slice(0, 8),
      goalId: goalId && this.goal(goalId) ? goalId : null,
      startedBy: who,
      startedAt: now,
      endsAt: now + m * 60_000,
      minutes: m,
      tasksDone: 0,
      reviews: 0,
      xp: 0,
      tone,
      intention: clean(intention, 200),
    };
    const goal = this.state.session.goalId ? this.goal(this.state.session.goalId) : null;
    this.feed(who, `started a ${sessionLength(m)} focus session${goal ? ` on ${goal.title}` : ""}`, 0);
    this.changed();
    return true;
  }

  /** End the session: early (stopped) or because its time ran out. */
  endSession(completed: boolean): void {
    const s = this.state.session;
    if (!s) return;
    this.state.session = null;
    const goal = s.goalId ? this.goal(s.goalId) : null;
    let xp = s.xp;
    if (completed) {
      // Everyone in the office shares the reward for finishing.
      const bonus = s.minutes * XP.sessionMinute;
      const who = new Set([s.startedBy, ...this.present()]);
      const today = dayKey(Date.now());
      const yesterday = dayKey(Date.now() - 86_400_000);
      for (const name of who) {
        const st = this.stats(name);
        st.sessions++;
        if (st.lastDay === today) st.today++;
        else {
          st.streak = st.lastDay === yesterday ? st.streak + 1 : 1;
          st.today = 1;
          st.lastDay = today;
        }
        this.award(name, bonus, `Finished a ${sessionLength(s.minutes)} focus session`);
      }
      xp += bonus;
      this.feed(s.startedBy, `finished a ${sessionLength(s.minutes)} focus session 🎉`, bonus);
    } else {
      this.feed(s.startedBy, "ended the focus session early", 0);
    }
    // The end-of-day recap: the stand-up's goals, and the session goal's tasks done and still open.
    const tasks = (goal?.tasks ?? []).filter((t) => !t.title.startsWith("Final review:"));
    this.onSessionEnd?.({
      minutes: s.minutes,
      goalTitle: goal?.title ?? null,
      tasksDone: s.tasksDone,
      reviews: s.reviews,
      xp,
      completed,
      eod: s.eod ?? [],
      done: tasks.filter((t) => t.status === "done").map((t) => t.title),
      open: tasks.filter((t) => t.status !== "done").map((t) => t.title),
    });
    this.changed();
  }

  /** Called every second or so: ends a session whose time is up. */
  tick(now = Date.now()): void {
    if (this.state.session && now >= this.state.session.endsAt) this.endSession(true);
  }

  /** Re-check achievements that depend on the office (e.g. a full house). */
  recheck(who: string): void {
    this.unlock(who);
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.save();
    }
  }

  // --- internals --------------------------------------------------------------------------

  private goal(id: string): Goal | undefined {
    return this.state.goals.find((g) => g.id === id);
  }

  private completeTask(who: string, g: Goal, taskId: string): void {
    const t = g.tasks.find((x) => x.id === taskId);
    if (!t || t.status === "done") return;
    t.status = "done";
    t.doneAt = Date.now();
    t.deskId = null;
    this.stats(who).tasksDone++;
    if (this.state.session) this.state.session.tasksDone++;
    this.feed(who, `finished “${t.title}”`, XP.taskDone);
    this.award(who, XP.taskDone, `Task done: ${t.title}`);
    const p = goalProgress(g);
    if (p.done === p.total && !g.doneAt) {
      g.doneAt = Date.now();
      this.stats(who).goalsDone++;
      this.feed(who, `completed the goal “${g.title}” 🚀`, XP.goalDone);
      this.award(who, XP.goalDone, `Goal complete: ${g.title}`);
    }
    this.changed();
  }

  private stats(name: string): PlayerStats {
    let s = this.state.players.find((p) => p.name === name);
    if (!s) {
      s = { name, xp: 0, tasksDone: 0, reviews: 0, changes: 0, sessions: 0, goalsDone: 0, hires: 0, streak: 0, lastDay: null, today: 0, achievements: [] };
      this.state.players.push(s);
    }
    return s;
  }

  private award(who: string, xp: number, reason: string): void {
    const s = this.stats(who);
    const before = levelFor(s.xp).level;
    s.xp += xp;
    if (this.state.session) this.state.session.xp += xp;
    const after = levelFor(s.xp);
    const unlocked = this.unlock(who, false);
    this.onAward?.({
      who,
      xp,
      reason,
      levelUp: after.level > before ? { level: after.level, title: after.title } : undefined,
      unlocked,
    });
  }

  /** Unlock any achievements now earned; returns the new ones. */
  private unlock(who: string, notify = true): string[] {
    const s = this.stats(who);
    const ctx = { workers: this.workers() };
    const fresh = ACHIEVEMENTS.filter((a) => !s.achievements.includes(a.id) && a.earned(s, ctx)).map((a) => a.id);
    if (!fresh.length) return [];
    s.achievements.push(...fresh);
    for (const id of fresh) {
      const a = ACHIEVEMENTS.find((x) => x.id === id)!;
      this.feed(who, `unlocked ${a.icon} ${a.title}`, 0);
    }
    if (notify) {
      this.onAward?.({ who, xp: 0, reason: "Achievement unlocked", unlocked: fresh });
      this.changed();
    }
    return fresh;
  }

  private feed(who: string, text: string, xp: number): void {
    const item: FeedItem = { at: Date.now(), who, text, xp };
    this.state.feed.unshift(item);
    this.state.feed.length = Math.min(this.state.feed.length, FEED_LEN);
  }

  private changed(): void {
    this.onChange?.();
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 500);
    this.saveTimer.unref?.();
  }

  private load(): void {
    if (!this.file) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<ProgressState>;
      this.policySaved = !!raw.policy;
      this.state = {
        policy: coercePolicy(raw.policy),
        team: Array.isArray(raw.team) ? raw.team.map(coerceCharacter).filter((c): c is Character => c !== null).slice(0, MAX_TEAM) : [],
        mcp: Array.isArray(raw.mcp) ? raw.mcp.map(coerceMcpServer).filter((m): m is McpServer => m !== null) : [],
        goals: Array.isArray(raw.goals) ? raw.goals.map(coerceGoal) : [],
        session:
          raw.session && typeof raw.session.endsAt === "number"
            ? { ...(raw.session as Session), tone: raw.session.tone ?? null, intention: raw.session.intention ?? "" }
            : null,
        players: Array.isArray(raw.players) ? raw.players : [],
        feed: Array.isArray(raw.feed) ? raw.feed.slice(0, FEED_LEN) : [],
        lastPlan: raw.lastPlan && typeof raw.lastPlan === "object" && typeof raw.lastPlan.minutes === "number" ? raw.lastPlan : null,
      };
      // Workers don't survive a restart, so nobody is on a task any more.
      for (const g of this.state.goals) for (const t of g.tasks) if (t.status !== "done") Object.assign(t, { deskId: null, status: "todo", run: null });
    } catch {
      /* first run, or unreadable: start fresh */
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      renameSync(tmp, this.file);
    } catch {
      /* best effort */
    }
  }
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function cleanUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const u = v.trim().slice(0, 500);
  return /^https?:\/\/\S+$/.test(u) ? u : null;
}

function clean(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}
