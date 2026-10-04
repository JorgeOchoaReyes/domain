import type { GoalKind } from "./progress.js";

/**
 * Ideas pinned to the office's idea boards: a sketch and a few words, drawn
 * and written at a whiteboard, then handed to a worker as a task or turned
 * into a goal. The sketch itself lives on disk (where agents can look at it);
 * clients get a small thumbnail.
 */

export interface Idea {
  id: string;
  title: string;
  /** Notes: what it is, why, anything a worker should know. */
  text: string;
  kind: GoalKind;
  by: string;
  at: number;
  /** A small JPEG data URL of the sketch, for the boards and the list (none: no sketch). */
  thumb: string | null;
  /** open: on the board; handed: a worker has it; goal: it became a goal. */
  status: "open" | "handed" | "goal";
  /** The worker it went to (desk and who), when handed. */
  handedTo?: { deskId: string; name: string };
  /** The goal (and task, when handed) it became. */
  goalId?: string;
  taskId?: string;
}

export const MAX_IDEAS = 40;
/** A thumbnail is small: roughly 320×180 JPEG. */
export const MAX_THUMB = 60_000;
/** The full sketch, as a PNG data URL. */
export const MAX_SKETCH = 6 * 1024 * 1024;

const THUMB_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;

/** Clean an idea a client sent (new or edited). Null when there's nothing to keep. */
export function coerceIdeaInput(raw: unknown): { id: string | null; title: string; text: string; kind: GoalKind; thumb: string | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const text = typeof o.text === "string" ? o.text.trim().slice(0, 2000) : "";
  let title = typeof o.title === "string" ? o.title.replace(/\s+/g, " ").trim().slice(0, 100) : "";
  const thumb = typeof o.thumb === "string" && o.thumb.length <= MAX_THUMB && THUMB_RE.test(o.thumb) ? o.thumb : null;
  // No title: the first line of the notes, or "Sketch" for a drawing alone.
  if (!title) title = text.split("\n")[0].slice(0, 100).trim() || (thumb ? "Sketch" : "");
  if (!title) return null;
  return {
    id: typeof o.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(o.id) ? o.id : null,
    title,
    text,
    kind: o.kind === "research" ? "research" : "build",
    thumb,
  };
}

/** The tasks an idea's notes spell out: lines starting with -, *, • or a number. */
export function ideaTasks(text: string): string[] {
  return text
    .split("\n")
    .map((l) => /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/.exec(l)?.[1]?.trim() ?? "")
    .filter(Boolean)
    .slice(0, 20);
}
