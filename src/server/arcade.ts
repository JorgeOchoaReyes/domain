import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { addScore, coerceBoards, coerceScore, isArcadeGame, type ArcadeBoards, type ArcadeNews } from "../shared/arcade.js";
import type { Routes, ServerCtx } from "./ctx.js";

/**
 * The office's arcade high scores. Whoever plays a cabinet — you, or a guest
 * in a shared office — sends each finished game's score; the best per person
 * go on that game's board, kept in .domain/arcade.json, and every client gets
 * the boards (and who just made one) to show on the cabinets.
 */

export class ArcadeStore {
  boards: ArcadeBoards = {};

  constructor(readonly file: string) {
    try {
      this.boards = coerceBoards(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      /* none yet */
    }
  }

  /** Record a score; returns the news if it made a board. */
  submit(game: unknown, score: unknown, name: string): ArcadeNews | null {
    const s = coerceScore(score);
    if (!isArcadeGame(game) || s === null) return null;
    const rank = addScore(this.boards, game, name, s);
    if (rank === null) return null;
    this.persist();
    return { game, name: this.boards[game]![rank].name, score: s, rank };
  }

  persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.boards, null, 2));
    } catch {
      /* read-only folder: keep them in memory */
    }
  }
}

export function arcadeModule(ctx: ServerCtx, store = new ArcadeStore(join(ctx.cwd, ".domain", "arcade.json"))): Routes {
  /** When each client last sent a score: one a second is plenty. */
  const lastAt = new Map<string, number>();
  return {
    arcadeGet: (_msg, _client, ws) => ctx.send(ws, { t: "arcadeScores", boards: store.boards }),
    arcadeScore: (msg, client) => {
      const now = Date.now();
      if (now - (lastAt.get(client.id) ?? 0) < 1000) return;
      lastAt.set(client.id, now);
      const news = store.submit(msg.game, msg.score, client.name);
      if (news) ctx.broadcast({ t: "arcadeScores", boards: store.boards, news });
    },
  };
}
