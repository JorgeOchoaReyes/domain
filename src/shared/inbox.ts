import type { Desk, Presentation } from "./protocol.js";
import { AGENT_LABELS } from "./protocol.js";
import type { ChatThread } from "./chat.js";
import { TEAM_THREAD } from "./chat.js";
import type { Loan } from "./pods.js";
import { troubleHint } from "./trouble.js";

/**
 * One place for what needs you: the inbox behind 🔔 Needs you in the dock
 * (and the phone's Alerts). It gathers, from the office as it is right now,
 * every agent's question, stuck agents, finished work waiting for review,
 * "I'll take it" offers and requests to borrow your agents — plus things
 * that happened and are worth a look (a huddle or a demo to watch, an
 * answer from a worker, a deadline coming up). Each item carries its own
 * actions; the client runs them. Pure, so it's tested on its own.
 */

export type InboxKind = "question" | "trust" | "stuck" | "review" | "offer" | "borrow" | "huddle" | "demo" | "answer" | "reminder";

export interface InboxAction {
  /** What to do: answer, go, trust, fix, review, hours, take, next, lend, refuse, watch, reply, do. */
  id: string;
  label: string;
  primary?: boolean;
}

export interface InboxItem {
  /** Stable while it's the same thing (so it can be dismissed or recognised). */
  id: string;
  kind: InboxKind;
  /** 1 = worth a look, 2 = soon, 3 = now. */
  urgency: 1 | 2 | 3;
  icon: string;
  title: string;
  detail?: string;
  deskId?: string;
  /** For offers: the task; for answers: the thread; for huddles and demos: the goal. */
  ref?: string;
  /** When it came up (newest first within an urgency). */
  at: number;
  actions: InboxAction[];
  /** Things that happened (not live state) can be dismissed. */
  dismissable?: boolean;
}

/** A reminder (deadlines, time budgets, idle hands…), as the client keeps them. */
export interface InboxReminder {
  id: string;
  urgency: 1 | 2 | 3;
  icon: string;
  text: string;
  action?: string;
}

export interface InboxInput {
  desks: Desk[];
  presentations: Presentation[];
  threads: ChatThread[];
  loans: Loan[];
  /** Your name (borrow requests are for the agent's owner). */
  me: string;
  /** The host can trust a project's files for every worker. */
  host: boolean;
  /** Whether you may direct this desk's agent (answer it, review its work). */
  mayDirect(deskId: string): boolean;
  reminders: InboxReminder[];
  /** Things that happened: a huddle or demo to watch, an answer from a worker. */
  notes: InboxItem[];
  dismissed: ReadonlySet<string>;
  now: number;
}

function nameOf(d: Desk | undefined): string {
  const w = d?.worker;
  return w ? (w.identity?.name ?? AGENT_LABELS[w.agent]) : (d?.label ?? "A worker");
}

/** The report's title, without the "Finished:" it may start with. */
export function bareTitle(title: string): string {
  return title.replace(/^\s*(?:finished|need a decision|needs a decision|plan|blocked)\s*:\s*/i, "");
}

/** Everything that needs you now, most urgent first (then newest). */
export function buildInbox(i: InboxInput): InboxItem[] {
  const out: InboxItem[] = [];
  const desk = (id: string) => i.desks.find((d) => d.id === id);

  for (const d of i.desks) {
    const w = d.worker;
    if (!w || !i.mayDirect(d.id)) continue;
    const who = nameOf(d);
    if (w.trouble) {
      out.push({
        id: `stuck-${d.id}`,
        kind: "stuck",
        urgency: 3,
        icon: "🧯",
        title: `${who} is stuck — ${troubleHint(w.trouble.kind)}`,
        detail: w.trouble.detail,
        deskId: d.id,
        at: i.now,
        actions: [{ id: "fix", label: "🛠 See the fix", primary: true }],
      });
    } else if (w.status === "waiting") {
      const trust = /trust this folder/i.test(w.activity);
      out.push({
        id: `${trust ? "trust" : "question"}-${d.id}`,
        kind: trust ? "trust" : "question",
        urgency: 3,
        icon: "🙋",
        title: trust ? `${who} asks whether it can trust this project's files` : `${who} needs your answer`,
        detail: w.activity.replace(/ — answer in its terminal$/, ""),
        deskId: d.id,
        at: i.now,
        actions: [
          ...(trust && i.host ? [{ id: "trust", label: "✅ Trust this project", primary: true }] : []),
          { id: "answer", label: "💬 Answer", primary: !(trust && i.host) },
          { id: "go", label: "🚶 Go there" },
        ],
      });
    }
  }

  for (const p of i.presentations) {
    const r = p.report;
    if (!r || r.check?.status === "running" || !i.mayDirect(p.deskId)) continue;
    const who = nameOf(desk(p.deskId));
    const title = bareTitle(r.title);
    out.push({
      id: `review-${p.deskId}-${r.at}`,
      kind: "review",
      urgency: r.status === "blocked" ? 3 : 2,
      icon: r.status === "plan" ? "🗺" : r.status === "blocked" ? "❓" : "🎤",
      title: r.status === "plan" ? `${who} has a plan for “${title}”` : r.status === "blocked" ? `${who} needs a decision on “${title}”` : `${who} finished “${title}”`,
      detail: r.check?.status === "fail" ? "Its checks failed" : r.check?.status === "pass" ? "Checks pass · ready to review" : "Ready to review",
      deskId: p.deskId,
      at: r.at,
      actions: [
        { id: "review", label: "🎤 Review now", primary: true },
        { id: "hours", label: "Office hours" },
      ],
    });
  }

  const team = i.threads.find((t) => t.id === TEAM_THREAD);
  for (const m of team?.messages ?? []) {
    const o = m.offer;
    if (!o || o.state !== "open") continue;
    out.push({
      id: `offer-${o.taskId}-${o.deskId}`,
      kind: "offer",
      urgency: 2,
      icon: "🙋",
      title: `${m.who} offers to take “${o.title}”`,
      detail: o.free ? "Free now" : "After what it's on",
      deskId: o.deskId,
      ref: o.taskId,
      at: m.at,
      actions: [
        { id: "take", label: `✅ Let ${m.who.split(" ")[0]} take it`, primary: true },
        { id: "next", label: "🔁 Someone else" },
      ],
    });
  }

  for (const l of i.loans) {
    if (l.state !== "asked" || l.owner !== i.me) continue;
    out.push({
      id: `borrow-${l.deskId}-${l.borrower}`,
      kind: "borrow",
      urgency: 3,
      icon: "🤝",
      title: `${l.borrower} asks to borrow ${l.worker}`,
      detail: `It works for ${l.borrower} until it's given back or the task's done`,
      deskId: l.deskId,
      at: l.at,
      actions: [
        { id: "lend", label: `✅ Lend ${l.worker}`, primary: true },
        { id: "refuse", label: "🙅 Not now" },
      ],
    });
  }

  // Reminders: the ones about waiting workers and the line are already here, as questions and reviews.
  for (const r of i.reminders) {
    if (/^(waiting-|line$)/.test(r.id)) continue;
    out.push({
      id: `rem-${r.id}`,
      kind: "reminder",
      urgency: r.urgency,
      icon: r.icon,
      title: r.text,
      at: i.now,
      actions: r.action ? [{ id: "do", label: r.action, primary: true }] : [],
      dismissable: true,
    });
  }

  for (const n of i.notes) out.push({ ...n, dismissable: true });

  const seen = new Set<string>();
  return out
    .filter((x) => !i.dismissed.has(x.id) && !seen.has(x.id) && seen.add(x.id))
    .sort((a, b) => b.urgency - a.urgency || b.at - a.at);
}

/** Notes older than this drop out of the inbox by themselves. */
export const NOTE_TTL = 60 * 60_000;

/** Keep the notes that are still worth showing: not too old, the newest few. */
export function pruneNotes(notes: InboxItem[], now: number, max = 20): InboxItem[] {
  return notes.filter((n) => now - n.at < NOTE_TTL).sort((a, b) => b.at - a.at).slice(0, max);
}

/** What the dock's badge says: how many, and whether any is urgent. */
export function inboxBadge(items: InboxItem[]): { count: number; urgent: boolean } {
  return { count: items.length, urgent: items.some((x) => x.urgency >= 3) };
}
