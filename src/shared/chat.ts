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
}

export interface ChatThread {
  /** "team", or the desk the worker sits at. */
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
export const MAX_CHAT_MESSAGES = 200;
