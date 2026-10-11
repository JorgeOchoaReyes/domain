import type { ArcadeId } from "./layout.js";

/**
 * The office's arcade high scores: one board per game, shared by everyone in
 * the office (the host keeps them in .domain/arcade.json and sends them to
 * all), shown on the cabinets and in the game's window. Each person is on a
 * board once, with their best.
 */

export const ARCADE_GAMES: readonly ArcadeId[] = ["snake", "bugsmash", "breakout", "merge", "dash"];
/** How many make a board. */
export const BOARD_SIZE = 5;
/** Anything above this is not a score anyone got. */
export const MAX_SCORE = 10_000_000;

export interface ArcadeScore {
  name: string;
  score: number;
  at: number;
}

export type ArcadeBoards = Partial<Record<ArcadeId, ArcadeScore[]>>;

/** A score that just made a board: who, which game, and where it placed (0: top). */
export interface ArcadeNews {
  game: ArcadeId;
  name: string;
  score: number;
  rank: number;
}

export function isArcadeGame(v: unknown): v is ArcadeId {
  return typeof v === "string" && (ARCADE_GAMES as readonly string[]).includes(v);
}

/** A submitted score, made safe: a whole number from 1 up to MAX_SCORE, or null. */
export function coerceScore(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const s = Math.floor(v);
  return s >= 1 && s <= MAX_SCORE ? s : null;
}

function cleanName(v: unknown): string {
  return (typeof v === "string" ? v : "").replace(/\s+/g, " ").trim().slice(0, 24) || "Guest";
}

/**
 * Put a score on its game's board (in place): a person's best only, highest
 * first, ties to whoever got there first. Returns where it placed, or null
 * if it didn't make the board (or didn't beat their own best).
 */
export function addScore(boards: ArcadeBoards, game: ArcadeId, name: string, score: number, at = Date.now()): number | null {
  const who = cleanName(name);
  const board = (boards[game] ??= []);
  const mine = board.findIndex((e) => e.name === who);
  if (mine >= 0) {
    if (board[mine].score >= score) return null;
    board.splice(mine, 1);
  }
  const entry: ArcadeScore = { name: who, score, at };
  let i = board.findIndex((e) => e.score < score);
  if (i < 0) i = board.length;
  board.splice(i, 0, entry);
  board.length = Math.min(board.length, BOARD_SIZE);
  return i < BOARD_SIZE ? i : null;
}

/** The top score on a game's board, if any. */
export function topScore(boards: ArcadeBoards, game: ArcadeId): ArcadeScore | null {
  return boards[game]?.[0] ?? null;
}

/** Boards read back from disk (or the wire), made safe. */
export function coerceBoards(raw: unknown): ArcadeBoards {
  const out: ArcadeBoards = {};
  if (!raw || typeof raw !== "object") return out;
  for (const game of ARCADE_GAMES) {
    const list = (raw as Record<string, unknown>)[game];
    if (!Array.isArray(list)) continue;
    const board: ArcadeScore[] = [];
    for (const e of list) {
      if (!e || typeof e !== "object") continue;
      const o = e as Record<string, unknown>;
      const score = coerceScore(o.score);
      if (score === null) continue;
      board.push({ name: cleanName(o.name), score, at: typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0 });
    }
    board.sort((a, b) => b.score - a.score || a.at - b.at);
    if (board.length) out[game] = board.slice(0, BOARD_SIZE);
  }
  return out;
}
