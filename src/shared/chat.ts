/**
 * Team chat: a thread with each worker (and #team, to everyone), kept between
 * visits. Your messages reach a worker as an instruction in its terminal; it
 * answers through its reply file, and the answer lands in the thread.
 */

export interface ChatMessage {
  from: "you" | "agent";
  /** Who said it: your name, or the worker's ("Ada", "Claude Code"). */
  who: string;
  text: string;
  at: number;
  /** Typed straight into the terminal rather than said as a message. */
  raw?: boolean;
  /** A worker offering to take a task given to "whoever's free": yours to accept, pass on, or leave. */
  offer?: TaskOffer;
}

/** "I'll take it": a task given to everyone, and the worker who'd take it, waiting for your OK. */
export interface TaskOffer {
  goalId: string;
  taskId: string;
  title: string;
  deskId: string;
  /** Free now, or taking it after what it's on. */
  free: boolean;
  /** open: waiting for you; taken: you said yes; passed: you asked someone else; anyone: left for whoever's free. */
  state: "open" | "taken" | "passed" | "anyone";
  /** Who's been asked already (so "someone else" moves on). */
  asked: string[];
}

/** Who'd take a task: someone free, else whoever's closest to done — work waiting for review, then working. */
export function pickVolunteer(
  desks: { id: string; worker: { status: string } | null }[],
  onTask: Map<string, string>,
  skip: readonly string[] = [],
): { deskId: string; free: boolean; after: string } | null {
  const staffed = desks.filter((d) => d.worker && d.worker.status !== "asleep" && d.worker.status !== "booting" && !skip.includes(d.id));
  const rank = (d: (typeof staffed)[number]) => {
    const busy = onTask.has(d.id);
    const st = d.worker!.status;
    if (!busy && (st === "idle" || st === "done")) return 0;
    if (st === "presenting") return 1;
    if (st === "working") return 2;
    return 3;
  };
  const best = [...staffed].sort((a, b) => rank(a) - rank(b))[0];
  if (!best) return null;
  return { deskId: best.id, free: rank(best) === 0, after: onTask.get(best.id) ?? "what it's on" };
}

export interface ChatThread {
  /** "team", "people", or the desk the worker sits at. */
  id: string;
  /** What the thread is about: "#team", "Ada (Claude Code)". */
  title: string;
  messages: ChatMessage[];
}

/** What a worker is doing right now, read off its terminal. */
export interface ChatPeek {
  deskId: string;
  status: string;
  activity: string;
  /** The last few meaningful lines on its screen. */
  lines: string[];
}

/** A worker's record: what it's on, and what it has committed on its branch. */
export interface ChatWork {
  deskId: string;
  branch: string | null;
  /** Tasks it's on (or presenting), with their goal. */
  tasks: { title: string; goal: string; status: string }[];
  /** Its commits, newest first: on its own branch since it left yours, or the project's latest. */
  commits: { hash: string; subject: string; at: number }[];
  /** Files changed on its branch so far (vs yours). */
  changed: string[];
}

export const TEAM_THREAD = "team";
/** The people in the office (you and anyone on your network) talking among yourselves — workers never see it. */
export const PEOPLE_THREAD = "people";
export const MAX_CHAT_MESSAGES = 200;
