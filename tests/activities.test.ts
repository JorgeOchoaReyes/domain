import { test } from "node:test";
import assert from "node:assert/strict";
import { dartScore } from "../src/shared/darts.ts";
import { dueLabel } from "../src/shared/progress.ts";
import { WORK_SPOTS, inUpstairs, isIndoors, roomAt, UPSTAIRS } from "../src/shared/layout.ts";

test("darts: bull, triple 20 at the top, double 6 on the right, a miss off the board", () => {
  assert.equal(dartScore(0, 0), 50);
  assert.equal(dartScore(0.05, 0), 25);
  assert.equal(dartScore(0, -0.6), 60);
  assert.equal(dartScore(0.97, 0), 12);
  assert.equal(dartScore(0, 1.2), 0);
});

test("floor 2 is its own place: indoors, its own rooms, and somewhere to sit and work", () => {
  const mid = { x: (UPSTAIRS.minX + UPSTAIRS.maxX) / 2, z: 0 };
  assert.ok(inUpstairs(mid.x, mid.z));
  assert.ok(isIndoors(mid.x, mid.z));
  assert.equal(roomAt(66, 0).id, "library");
  assert.equal(roomAt(80, 0).id, "lounge2");
  assert.equal(roomAt(92, 0).id, "gym");
  assert.ok(!inUpstairs(10, 0), "the campus isn't upstairs");
  assert.ok(WORK_SPOTS.some((s) => inUpstairs(s.sit.x)), "a work spot upstairs");
  assert.ok(WORK_SPOTS.every((s) => Math.hypot(s.sit.x - s.laptop.x, s.sit.z - s.laptop.z) < 2), "the laptop's within reach of every seat");
});

test("deadlines read naturally", () => {
  const now = Date.now();
  assert.equal(dueLabel(now + 30 * 60_000, now), "due in 30m");
  assert.equal(dueLabel(now + 5 * 3600_000, now), "due in 5h");
  assert.equal(dueLabel(now - 90 * 60_000, now), "overdue by 2h");
});
