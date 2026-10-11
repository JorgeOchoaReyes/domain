import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOARD_SIZE, MAX_SCORE, addScore, coerceBoards, coerceScore, topScore, type ArcadeBoards } from "../src/shared/arcade.ts";
import { ArcadeStore, arcadeModule } from "../src/server/arcade.ts";
import { allowed } from "../src/server/permissions.ts";
import type { ServerCtx } from "../src/server/ctx.ts";
import type { ServerMessage } from "../src/shared/protocol.ts";

const ws = {} as never;
const who = (id: string, name: string) => ({ id, name, alive: true, joined: true, role: "host" as const });

function fakeCtx() {
  const dir = mkdtempSync(join(tmpdir(), "domain-arcade-"));
  const broadcast: ServerMessage[] = [];
  const sent: ServerMessage[] = [];
  const ctx = { cwd: dir, send: (_ws: unknown, m: ServerMessage) => sent.push(m), broadcast: (m: ServerMessage) => broadcast.push(m) } as unknown as ServerCtx;
  const store = new ArcadeStore(join(dir, ".domain", "arcade.json"));
  return { dir, ctx, store, broadcast, sent, routes: arcadeModule(ctx, store) };
}

test("a board keeps each person's best, highest first, five deep", () => {
  const b: ArcadeBoards = {};
  assert.equal(addScore(b, "snake", "Ann", 40, 1), 0);
  assert.equal(addScore(b, "snake", "Bo", 90, 2), 0, "a new top score");
  assert.equal(addScore(b, "snake", "Ann", 30, 3), null, "not better than Ann's own");
  assert.equal(addScore(b, "snake", "Ann", 95, 4), 0, "Ann takes the top");
  assert.deepEqual(b.snake!.map((e) => [e.name, e.score]), [["Ann", 95], ["Bo", 90]], "once each");
  for (const [i, n] of ["Cy", "Di", "Ed", "Flo"].entries()) addScore(b, "snake", n, 50 - i, 10 + i);
  assert.equal(b.snake!.length, BOARD_SIZE);
  assert.equal(addScore(b, "snake", "Gus", 1, 20), null, "too low to make it");
  assert.equal(addScore(b, "snake", "Gus", 48, 21), null, "a tie with the last place doesn't push it off");
  assert.equal(addScore(b, "snake", "Gus", 49, 21), 4, "just makes it, below Di who got 49 first");
  assert.deepEqual(b.snake!.map((e) => e.name), ["Ann", "Bo", "Cy", "Di", "Gus"]);
  assert.equal(addScore(b, "snake", "Hal", 90, 22), 2, "a tie goes below whoever got there first");
  assert.equal(topScore(b, "snake")!.name, "Ann");
  assert.equal(topScore(b, "dash"), null);
});

test("scores and boards from outside are cleaned", () => {
  assert.equal(coerceScore(12.9), 12);
  for (const bad of [0, -5, NaN, Infinity, "10", null, MAX_SCORE + 1]) assert.equal(coerceScore(bad), null);
  const boards = coerceBoards({ snake: [{ name: "  Ann  ", score: 5, at: 1 }, { name: "x", score: "lots" }, { name: "", score: 9 }], nope: [{ name: "Z", score: 1 }] });
  assert.deepEqual(boards.snake, [
    { name: "Guest", score: 9, at: 0 },
    { name: "Ann", score: 5, at: 1 },
  ]);
  assert.equal("nope" in boards, false);
  assert.deepEqual(coerceBoards("garbage"), {});
});

test("a score at a cabinet goes on the office's board, kept on disk and sent to everyone", () => {
  const { routes, store, broadcast, sent, dir } = fakeCtx();
  routes.arcadeScore!({ t: "arcadeScore", game: "breakout", score: 1200 } as never, who("c1", "Ann"), ws);
  assert.equal(broadcast.length, 1);
  const m = broadcast[0] as Extract<ServerMessage, { t: "arcadeScores" }>;
  assert.equal(m.t, "arcadeScores");
  assert.deepEqual(m.news, { game: "breakout", name: "Ann", score: 1200, rank: 0 });
  assert.equal(m.boards.breakout![0].score, 1200);
  // Persisted, and read back by a fresh store (a restart).
  const disk = JSON.parse(readFileSync(join(dir, ".domain", "arcade.json"), "utf8"));
  assert.equal(disk.breakout[0].name, "Ann");
  assert.equal(new ArcadeStore(join(dir, ".domain", "arcade.json")).boards.breakout![0].score, 1200);
  // A guest in a shared office plays too: their name goes up.
  routes.arcadeScore!({ t: "arcadeScore", game: "breakout", score: 800 } as never, who("c2", "Bo"), ws);
  assert.deepEqual(store.boards.breakout!.map((e) => e.name), ["Ann", "Bo"]);
  // A newcomer asks and gets the boards.
  routes.arcadeGet!({ t: "arcadeGet" } as never, who("c3", "Cy"), ws);
  assert.equal(sent.at(-1)!.t, "arcadeScores");
});

test("junk is ignored: unknown games, silly scores, and a flood from one client", () => {
  const { routes, broadcast, store } = fakeCtx();
  routes.arcadeScore!({ t: "arcadeScore", game: "pong", score: 10 } as never, who("c1", "Ann"), ws);
  routes.arcadeScore!({ t: "arcadeScore", game: "snake", score: 1e12 } as never, who("c2", "Bo"), ws);
  routes.arcadeScore!({ t: "arcadeScore", game: "snake", score: -3 } as never, who("c3", "Cy"), ws);
  assert.equal(broadcast.length, 0);
  routes.arcadeScore!({ t: "arcadeScore", game: "snake", score: 10 } as never, who("c4", "Di"), ws);
  routes.arcadeScore!({ t: "arcadeScore", game: "snake", score: 20 } as never, who("c4", "Di"), ws);
  assert.equal(store.boards.snake![0].score, 10, "the second, a moment later, is dropped");
  assert.equal(broadcast.length, 1);
});

test("everyone in a shared office may post a score, visitors too", () => {
  for (const role of ["host", "teammate", "visitor"] as const) {
    assert.ok(allowed(role, "arcadeScore"), `${role} may post`);
    assert.ok(allowed(role, "arcadeGet"), `${role} may read`);
  }
});
