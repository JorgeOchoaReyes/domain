import type { AgentKind } from "./protocol.js";

/**
 * The office's history: what happened, when and by whom — workers hired and
 * sent home, tasks handed out, reports, approvals and changes, audits, groups,
 * ships — kept between visits, so you can look back over a day (or a week)
 * and at everything a worker has done.
 */

export type HistoryKind = "hired" | "left" | "assigned" | "reported" | "approved" | "changes" | "audit" | "shipped" | "goal" | "session" | "group" | "deadline";

export interface HistoryEvent {
  at: number;
  kind: HistoryKind;
  /** Who did it: you (your name) or the office. */
  who: string;
  /** One line a person reads. */
  text: string;
  /** The worker it's about, if any. */
  worker?: { deskId: string; name: string; agent: AgentKind; characterId?: string } | null;
  goalId?: string;
  task?: string;
}

export const MAX_HISTORY = 2000;
