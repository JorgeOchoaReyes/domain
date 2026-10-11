import { test } from "node:test";
import assert from "node:assert/strict";
import { HEAD_SPOT, OBJECT_BALLS, POOL_TABLE, PoolGame, type PoolEvent } from "../src/shared/pool.ts";

/** A repeatable "random". */
function seeded(seed = 7): () => number {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

const onTable = (g: PoolGame) =>
  g.balls.every((b) => b.potted || (Math.abs(b.x) <= POOL_TABLE.length / 2 - POOL_TABLE.ballR + 1e-9 && Math.abs(b.z) <= POOL_TABLE.width / 2 - POOL_TABLE.ballR + 1e-9));

test("a fresh rack: the cue ball on its spot, nine balls in a diamond, none touching through another", () => {
  const g = new PoolGame();
  assert.equal(g.balls.length, OBJECT_BALLS + 1);
  assert.deepEqual([g.cue.x, g.cue.z], [HEAD_SPOT.x, HEAD_SPOT.z]);
  assert.equal(g.left, 9);
  assert.ok(!g.moving && !g.cleared);
  for (const a of g.balls)
    for (const b of g.balls) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= 2 * POOL_TABLE.ballR, `${a.n} and ${b.n} don't overlap`);
});

test("a straight shot: the cue ball stops dead and the object ball carries on (equal masses)", () => {
  const g = new PoolGame();
  // Just the cue ball and the 1, in a line along x.
  for (const b of g.balls) if (b.n > 1) b.potted = true;
  const one = g.balls[1];
  Object.assign(g.cue, { x: -0.5, z: 0 });
  Object.assign(one, { x: 0, z: 0 });
  assert.ok(g.shoot(0, 0.3));
  let hit = false;
  for (let i = 0; i < 400 && !hit; i++) hit = g.step(1 / 120).some((e) => e.kind === "hit");
  assert.ok(hit, "they meet");
  assert.ok(Math.abs(g.cue.vx) < 0.1 * Math.abs(one.vx), "the cue ball nearly stops");
  assert.ok(one.vx > 0 && Math.abs(one.vz) < 1e-6, "the 1 goes straight on");
  g.settleAll();
  assert.ok(!g.moving && onTable(g));
});

test("a ball rolled at a corner pocket drops; the cue ball in a pocket is a scratch and comes back", () => {
  const g = new PoolGame();
  for (const b of g.balls) if (b.n > 1) b.potted = true;
  Object.assign(g.balls[1], { x: 0.8, z: 0.3 });
  Object.assign(g.cue, { x: 0.6, z: 0.1 });
  // Straight at the 1, which is in line with the corner pocket at (1, 0.5).
  g.shoot(Math.PI / 4, 0.5);
  const events = g.settleAll();
  assert.ok(events.some((e) => e.kind === "pot" && e.n === 1), "the 1 drops");
  assert.ok(events.some((e) => e.kind === "cleared"), "and that clears this table");
  // Now scratch: the cue ball straight into the middle pocket.
  const s = new PoolGame();
  Object.assign(s.cue, { x: 0, z: 0.2 });
  const shots = s.shots;
  s.shoot(Math.PI / 2, 0.4);
  const ev: PoolEvent[] = s.settleAll();
  assert.ok(ev.some((e) => e.kind === "scratch"));
  assert.ok(!s.cue.potted, "back on the table");
  assert.deepEqual([s.cue.x, s.cue.z], [HEAD_SPOT.x, HEAD_SPOT.z]);
  assert.equal(s.shots, shots + 2, "the shot, and one for the scratch");
  assert.equal(s.scratches, 1);
});

test("no shooting while the balls roll, and nothing ever leaves the table", () => {
  const g = new PoolGame();
  assert.ok(g.shoot(0, 1), "the break");
  assert.equal(g.shoot(0, 1), false, "not while they're moving");
  for (let i = 0; i < 2000 && g.moving; i++) {
    g.step(1 / 60);
    assert.ok(onTable(g));
  }
  assert.ok(!g.moving, "and they come to rest");
});

test("the workers' shot picker clears the table in a sensible number of shots", () => {
  const rand = seeded(11);
  for (let game = 0; game < 4; game++) {
    const g = new PoolGame();
    let events: PoolEvent[] = [];
    for (let i = 0; i < 120 && !g.cleared; i++) {
      const s = g.pickShot(rand, 0.85);
      assert.ok(Number.isFinite(s.angle) && s.power > 0 && s.power <= 1);
      assert.ok(g.shoot(s.angle, s.power));
      events = events.concat(g.settleAll());
      assert.ok(onTable(g));
    }
    assert.ok(g.cleared, `game ${game} cleared`);
    assert.ok(g.shots < 60, `in ${g.shots} shots`);
    const potted = events.filter((e) => e.kind === "pot").map((e) => (e as { n: number }).n);
    assert.deepEqual([...potted].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9], "each ball drops once");
    assert.equal(events.filter((e) => e.kind === "cleared").length, 1);
  }
});
