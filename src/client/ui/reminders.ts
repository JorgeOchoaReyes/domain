import type { OfficeState } from "../../shared/protocol.js";
import { AGENT_LABELS } from "../../shared/protocol.js";
import { dueLabel, type ProgressState } from "../../shared/progress.js";

/**
 * Keeping you on top of things while you're off playing: what needs you (a
 * worker waiting on an answer, work waiting to be reviewed), what's coming up
 * (a goal's deadline, a task's time budget, the session's end) and what's
 * going to waste (a free worker while there's work). Urgent ones chime and
 * pop up, and come back until they're dealt with; the rest wait in Arnold and on
 * the phone.
 */

export interface Reminder {
  id: string;
  /** 1 = worth knowing, 2 = soon, 3 = now. */
  urgency: 1 | 2 | 3;
  icon: string;
  text: string;
  action?: { label: string; run: () => void };
}

export interface ReminderActions {
  office(): OfficeState;
  progress(): ProgressState;
  goToDesk(deskId: string): void;
  officeHours(): void;
  openGoal(goalId: string): void;
  /** Say it out loud: a toast (with a chime when it's urgent). */
  notify(r: Reminder, chime: boolean): void;
}

/** How often an unhandled reminder comes back, by urgency. */
const REPEAT: Record<number, number> = { 3: 3 * 60_000, 2: 10 * 60_000, 1: Infinity };

export class Reminders {
  private since = new Map<string, { status: string; at: number }>();
  private said = new Map<string, number>();
  private current: Reminder[] = [];

  constructor(private a: ReminderActions) {}

  /** What needs you, most urgent first. */
  list(): Reminder[] {
    return this.current;
  }

  /** Look again (call every few seconds): new or unhandled ones are said again. */
  update(now = Date.now()): Reminder[] {
    const office = this.a.office();
    const progress = this.a.progress();
    const out: Reminder[] = [];
    const name = (deskId: string) => {
      const w = office.desks.find((d) => d.id === deskId)?.worker;
      return w ? (w.identity?.name ?? AGENT_LABELS[w.agent]) : deskId;
    };

    // How long each worker has been in its status.
    for (const d of office.desks) {
      const st = d.worker?.status ?? "";
      const prev = this.since.get(d.id);
      if (!prev || prev.status !== st) this.since.set(d.id, { status: st, at: now });
    }
    const forHow = (deskId: string) => now - (this.since.get(deskId)?.at ?? now);

    for (const d of office.desks) {
      const w = d.worker;
      if (!w) continue;
      if (w.status === "waiting" && forHow(d.id) > 90_000) {
        out.push({
          id: `waiting-${d.id}`,
          urgency: 3,
          icon: "🙋",
          text: `${name(d.id)} has been waiting on you for ${Math.round(forHow(d.id) / 60000) || 1} min — ${w.activity.replace(/ — answer in its terminal$/, "")}`,
          action: { label: "Go there", run: () => this.a.goToDesk(d.id) },
        });
      }
    }
    const ready = office.presentations.filter((p) => p.report && p.report.check?.status !== "running");
    if (ready.length) {
      const oldest = Math.max(...ready.map((p) => forHow(p.deskId)));
      if (oldest > 5 * 60_000) {
        out.push({
          id: "line",
          urgency: 2,
          icon: "🎤",
          text: `${ready.length === 1 ? `${name(ready[0].deskId)} has` : `${ready.length} workers have`} been waiting to present for ${Math.round(oldest / 60000)} min`,
          action: { label: "Hold office hours", run: () => this.a.officeHours() },
        });
      }
    }

    for (const g of progress.goals) {
      if (g.shippedAt || g.doneAt || !g.dueAt) continue;
      const left = g.dueAt - now;
      if (left < 0) {
        out.push({ id: `due-${g.id}-over`, urgency: 3, icon: "⏰", text: `“${g.title}” is ${dueLabel(g.dueAt, now)}`, action: { label: "Open the goal", run: () => this.a.openGoal(g.id) } });
      } else if (left < 15 * 60_000) {
        out.push({ id: `due-${g.id}-15`, urgency: 3, icon: "⏰", text: `“${g.title}” is ${dueLabel(g.dueAt, now)}`, action: { label: "Open the goal", run: () => this.a.openGoal(g.id) } });
      } else if (left < 60 * 60_000) {
        out.push({ id: `due-${g.id}-60`, urgency: 2, icon: "📅", text: `“${g.title}” is ${dueLabel(g.dueAt, now)}`, action: { label: "Open the goal", run: () => this.a.openGoal(g.id) } });
      }
      for (const t of g.tasks) {
        const end = t.run?.deadline;
        if (t.status === "doing" && end && end > now && end - now < 5 * 60_000 && t.deskId) {
          out.push({ id: `budget-${t.id}`, urgency: 2, icon: "⏱", text: `${name(t.deskId)}'s time on “${t.title}” runs out in ${Math.ceil((end - now) / 60000)} min`, action: { label: "Go there", run: () => this.a.goToDesk(t.deskId!) } });
        }
      }
    }

    // A free worker while there's work nobody has.
    const waitingWork = progress.goals.some((g) => !g.shippedAt && g.tasks.some((t) => t.status === "todo" && !t.deskId));
    if (waitingWork) {
      const idle = office.desks.filter((d) => d.worker?.status === "idle" && forHow(d.id) > 3 * 60_000);
      if (idle.length) {
        const g = progress.goals.find((x) => !x.shippedAt && x.tasks.some((t) => t.status === "todo" && !t.deskId))!;
        out.push({
          id: `idle-${idle.map((d) => d.id).join(",")}`,
          urgency: 1,
          icon: "🪑",
          text: `${idle.length === 1 ? `${name(idle[0].id)} is` : `${idle.length} workers are`} free and “${g.title}” has tasks nobody's on`,
          action: { label: "Hand one out", run: () => this.a.openGoal(g.id) },
        });
      }
    }

    const s = progress.session;
    if (s) {
      const left = s.endsAt - now;
      if (left > 0 && left < 5 * 60_000) out.push({ id: `session-${s.id}`, urgency: 2, icon: "🔥", text: `The focus session ends in ${Math.ceil(left / 60000)} min` });
    }

    out.sort((x, y) => y.urgency - x.urgency);
    this.current = out;
    // Say what's new, and bring back what's still not dealt with.
    for (const r of out) {
      const last = this.said.get(r.id);
      if (r.urgency < 2) continue;
      if (last === undefined || now - last > REPEAT[r.urgency]) {
        this.said.set(r.id, now);
        this.a.notify(r, r.urgency === 3);
      }
    }
    return out;
  }
}
