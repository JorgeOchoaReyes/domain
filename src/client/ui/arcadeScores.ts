import { ARCADE_GAMES, type ArcadeBoards, type ArcadeScore } from "../../shared/arcade.js";
import { ALL_ARCADES, type ArcadeId } from "../../shared/layout.js";
import type { ServerMessage } from "../../shared/protocol.js";

/**
 * The office's arcade high scores, as the host last sent them: the cabinets
 * show them (setBoard), the game's window lists them, and a new one is
 * shouted out to everyone here.
 */

let boards: ArcadeBoards = {};

/** A game's board, best first. */
export function officeBoard(id: ArcadeId): readonly ArcadeScore[] {
  return boards[id] ?? [];
}

export interface ArcadeSink {
  setBoard(id: ArcadeId, board: readonly { name: string; score: number }[]): void;
}

/** Take the scores from a server message (anything else is ignored). */
export function ingestArcade(msg: ServerMessage, cabinets: ArcadeSink, toast: (text: string) => void, me: string): void {
  if (msg.t !== "arcadeScores") return;
  boards = msg.boards ?? {};
  for (const id of ARCADE_GAMES) cabinets.setBoard(id, officeBoard(id));
  const n = msg.news;
  if (!n) return;
  const game = ALL_ARCADES.find((a) => a.id === n.game)?.name ?? n.game;
  const who = n.name === me ? "You" : n.name;
  if (n.rank === 0) toast(`🏆 ${who} set the office's ${game} high score: ${n.score.toLocaleString()}`);
  else if (n.name === me) toast(`🕹 You're #${n.rank + 1} on the office's ${game} board (${n.score.toLocaleString()})`);
}
