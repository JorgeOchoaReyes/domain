import type { AgentKind, Desk, Presentation } from "../shared/protocol.js";
import type { Goal } from "../shared/progress.js";
import type { Leash, TaskBrief, TeamPolicy } from "../shared/policy.js";

/**
 * Autopilot: the office runs itself. Goals without tasks get planned; free
 * workers pick up the next tasks (deadlines first), each paired with an
 * auditor when there's someone to audit; work that passed its check and its
 * audit is approved without you; when a goal's tasks are all done, its lead
 * runs a final review of the whole thing and presents that — the one thing
 * you need to see. Workers can ask for interns for the independent pieces of
 * their task; the interns sit in the bay, the worker audits their work, and
 * they go home when there's nothing left for them. Questions, plans and
 * anything an audit couldn't settle still come to you. At the end of the day
 * it runs the sync.
 */

export const FINAL_REVIEW = "Final review:";
export const MAX_INTERNS_PER_ASK = 3;
/** An intern with nothing to do this long goes home. */
export const INTERN_IDLE_MS = 10 * 60_000;

export interface AutopilotDeps {
  policy(): TeamPolicy;
  goals(): Goal[];
  desks(): Desk[];
  line(): Presentation[];
  /** Is this desk auditing someone right now? */
  isAuditing(deskId: string): boolean;
  assign(goalId: string, taskId: string, deskId: string, brief: Partial<TaskBrief>): void;
  plan(goalId: string, deskId: string): void;
  approve(deskId: string): void;
  addTask(goalId: string, title: string): string | null;
  /** Hire an intern at this desk (same agent, model and leash as its mentor). */
  hire(deskId: string, agent: AgentKind, model: string, leash: Leash, mentor: string): boolean;
  fire(deskId: string): void;
  /** Interns asked for since last time (each worker's request file, read and cleared). */
  requests(): { deskId: string; pieces: string[] }[];
  /** Desks interns may use, in order (the bay first). */
  internDesks(): string[];
  eod(): void;
  note(text: string, deskId?: string): void;
  now?(): number;
}

export class Autopilot {
  /** Intern → its mentor. */
  readonly interns = new Map<string, string>();
  private idleSince = new Map<string, number>();
  private lastEodDay = "";

  constructor(private d: AutopilotDeps) {}

  private get now(): number {
    return this.d.now?.() ?? Date.now();
  }

  /** Workers with nothing on: idle, not presenting, no open task, not auditing. */
  free(): string[] {
    const open = new Set(this.d.goals().flatMap((g) => g.tasks.filter((t) => t.deskId && t.status !== "done").map((t) => t.deskId!)));
    const planning = new Set(this.d.goals().map((g) => g.planningDesk).filter(Boolean) as string[]);
    return this.d
      .desks()
      .filter((d) => d.worker && d.worker.status === "idle" && !d.worker.report && !open.has(d.id) && !planning.has(d.id) && !this.d.isAuditing(d.id))
      .map((d) => d.id);
  }

  /** One look round the office (every 20 seconds or so). */
  tick(): void {
    const policy = this.d.policy();
    // Interns can be asked for whether or not autopilot's on (the policy says whether they're allowed).
    this.takeInternRequests(policy);
    this.sendInternsHome();
    if (!policy.autopilot.on) return;
    this.approveAudited(policy);
    this.handOut();
    this.wrapUp();
    this.endOfDay(policy);
  }

  private staffed(): string[] {
    return this.d.desks().filter((d) => d.worker && d.worker.status !== "asleep" && d.worker.status !== "done").map((d) => d.id);
  }

  /** Someone to audit a builder's work: another worker, the least busy first. */
  private auditorFor(builder: string, free: string[]): string | undefined {
    const others = this.staffed().filter((d) => d !== builder && !this.interns.has(d));
    return others.find((d) => free.includes(d) && !this.d.isAuditing(d)) ?? others.find((d) => !this.d.isAuditing(d)) ?? others[0];
  }

  private openGoals(): Goal[] {
    return this.d
      .goals()
      .filter((g) => !g.shippedAt && !g.doneAt)
      .sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.createdAt - b.createdAt);
  }

  private handOut(): void {
    const free = this.free().filter((d) => !this.interns.has(d));
    for (const g of this.openGoals()) {
      if (!free.length) return;
      // A group's goal goes to its members only.
      const pool = g.group?.length ? free.filter((d) => g.group!.includes(d)) : free;
      if (!pool.length) continue;
      if (!g.tasks.length) {
        if (!g.planningDesk) {
          const who = pool[0];
          free.splice(free.indexOf(who), 1);
          this.d.plan(g.id, who);
          this.d.note(`Autopilot: planning “${g.title}”`, who);
        }
        continue;
      }
      for (const t of g.tasks.filter((t) => t.status === "todo" && !t.deskId)) {
        const who = pool.find((d) => free.includes(d));
        if (!who) break;
        free.splice(free.indexOf(who), 1);
        const auditor = this.auditorFor(who, free);
        this.d.assign(g.id, t.id, who, auditor ? { auditor, auditWhen: "end" } : {});
        this.d.note(`Autopilot: “${t.title}” to ${who}${auditor ? `, audited by ${auditor}` : ""}`, who);
      }
    }
  }

  /** Work that passed its check and its audit needs no more from you. */
  private approveAudited(policy: TeamPolicy): void {
    if (!policy.autopilot.approveAudited) return;
    for (const p of this.d.line()) {
      const r = p.report;
      if (!r || r.status !== "ready") continue;
      if (r.check && r.check.status !== "pass") continue;
      if (/^\s*Final review/i.test(r.title) || this.isFinalReview(p.deskId)) continue;
      const audited = r.slides.some((s) => /🔍 Audited by .+: approved/.test(s));
      if (!audited) continue;
      this.d.approve(p.deskId);
      this.d.note(`Autopilot approved “${r.title}” (checks passed, audit approved)`, p.deskId);
    }
  }

  private isFinalReview(deskId: string): boolean {
    return this.d.goals().some((g) => g.tasks.some((t) => t.deskId === deskId && t.status !== "done" && t.title.startsWith(FINAL_REVIEW)));
  }

  /** A goal whose tasks are all done: its lead pulls it together and presents the whole. */
  private wrapUp(): void {
    // A goal whose tasks are all done counts as done — but not shipped: that's when it's pulled together.
    for (const g of this.d.goals().filter((g) => !g.shippedAt)) {
      if (!g.tasks.length || g.tasks.some((t) => t.status !== "done") || g.tasks.some((t) => t.title.startsWith(FINAL_REVIEW))) continue;
      const free = this.free().filter((d) => !this.interns.has(d));
      const lead = (g.group ?? []).find((d) => free.includes(d)) ?? free[0];
      if (!lead) return;
      const id = this.d.addTask(g.id, `${FINAL_REVIEW} make “${g.title}” work as a whole, fix any gaps, and present the result`);
      if (!id) continue;
      const auditor = this.auditorFor(lead, free.filter((d) => d !== lead));
      this.d.assign(g.id, id, lead, { planFirst: false, ...(auditor ? { auditor, auditWhen: "end" as const } : {}) });
      this.d.note(`Autopilot: every task in “${g.title}” is done — ${lead} is pulling it together for you`, lead);
    }
  }

  private takeInternRequests(policy: TeamPolicy): void {
    for (const req of this.d.requests()) {
      const mentorDesk = this.d.desks().find((d) => d.id === req.deskId);
      const mentor = mentorDesk?.worker;
      if (!mentor) continue;
      if (!policy.autopilot.interns) {
        this.d.note(`${req.deskId} asked for interns, but interns are off in Team policy`, req.deskId);
        continue;
      }
      const goal = this.d.goals().find((g) => g.tasks.some((t) => t.deskId === req.deskId && t.status !== "done"));
      if (!goal) continue;
      const taken = new Set(this.d.desks().filter((d) => d.worker).map((d) => d.id));
      const seats = this.d.internDesks().filter((d) => !taken.has(d));
      let n = 0;
      for (const piece of req.pieces.slice(0, MAX_INTERNS_PER_ASK)) {
        const seat = seats[n];
        if (!seat) break;
        if (!this.d.hire(seat, mentor.agent, mentor.model, mentor.leash, req.deskId)) continue;
        const taskId = this.d.addTask(goal.id, piece);
        if (!taskId) continue;
        this.interns.set(seat, req.deskId);
        this.idleSince.delete(seat);
        // The mentor audits its interns' work before it goes anywhere.
        this.d.assign(goal.id, taskId, seat, { auditor: req.deskId, auditWhen: "end", rounds: 2 });
        n++;
      }
      if (n) this.d.note(`${req.deskId} brought in ${n} intern${n === 1 ? "" : "s"} for “${goal.title}”`, req.deskId);
      else this.d.note(`${req.deskId} asked for interns, but the bay is full`, req.deskId);
    }
  }

  private sendInternsHome(): void {
    const free = new Set(this.free());
    for (const intern of [...this.interns.keys()]) {
      const there = this.d.desks().find((d) => d.id === intern)?.worker;
      if (!there) {
        this.interns.delete(intern);
        continue;
      }
      if (!free.has(intern)) {
        this.idleSince.delete(intern);
        continue;
      }
      const since = this.idleSince.get(intern) ?? this.now;
      this.idleSince.set(intern, since);
      if (this.now - since >= INTERN_IDLE_MS) {
        this.d.fire(intern);
        this.interns.delete(intern);
        this.idleSince.delete(intern);
        this.d.note(`An intern at ${intern} went home — nothing left for them`, intern);
      }
    }
  }

  private endOfDay(policy: TeamPolicy): void {
    const at = /^(\d{1,2}):(\d{2})$/.exec(policy.autopilot.eodAt);
    if (!at) return;
    const now = new Date(this.now);
    const day = now.toDateString();
    if (this.lastEodDay === day) return;
    // Within three hours after its time (switched on late at night, it waits for tomorrow).
    const mins = now.getHours() * 60 + now.getMinutes();
    const due = Number(at[1]) * 60 + Number(at[2]);
    if (mins < due || mins > due + 180) return;
    this.lastEodDay = day;
    if (this.staffed().length) this.d.eod();
  }
}
