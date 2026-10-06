import { test } from "node:test";
import assert from "node:assert/strict";
import { STANDUP, route, waitSpot } from "../src/shared/layout.ts";

test("free workers wait round the stand-up circle, facing the middle, never in front of the screen", () => {
  const spots = Array.from({ length: 10 }, (_, i) => waitSpot(i));
  const keys = new Set(spots.map((s) => `${s.x.toFixed(2)},${s.z.toFixed(2)}`));
  assert.equal(keys.size, spots.length, "everyone has a place of their own");
  for (const s of spots.slice(0, 8)) {
    assert.ok(Math.abs(Math.hypot(s.x - STANDUP.circle.x, s.z - STANDUP.circle.z) - STANDUP.circle.r) < 1e-9);
    // Facing (sin f, cos f) points at the middle.
    const dx = STANDUP.circle.x - s.x;
    const dz = STANDUP.circle.z - s.z;
    assert.ok(Math.sin(s.facing) * dx + Math.cos(s.facing) * dz > 0.99 * Math.hypot(dx, dz));
    assert.ok(s.z < STANDUP.circle.z + STANDUP.circle.r * 0.6, "not between the circle and the screen");
  }
});

test("the way to the stand-up and back goes through the doors and the hallway", () => {
  const there = route({ x: 7.6, z: 0.6 }, waitSpot(0));
  assert.deepEqual(there.slice(-5, -1), [
    { x: 3, z: 11.6 },
    { x: 3, z: 14.7 },
    { x: -4.5, z: 14.7 },
    { x: -4.5, z: 17.6 },
  ]);
  const back = route(waitSpot(0), { x: 12, z: -2 });
  assert.deepEqual(back.slice(0, 4), [
    { x: -4.5, z: 17.6 },
    { x: -4.5, z: 14.7 },
    { x: 3, z: 14.7 },
    { x: 3, z: 11.6 },
  ]);
  assert.equal(route(waitSpot(0), waitSpot(1)).length, 1, "moving round the circle is just a step");
});

test("however many are waiting, they all stay inside the stand-up room", () => {
  for (let i = 0; i < 60; i++) {
    const s = waitSpot(i);
    assert.ok(s.x > -8.6 && s.x < -0.4 && s.z > 17 && s.z < 28.6, `spot ${i} at ${s.x.toFixed(2)}, ${s.z.toFixed(2)}`);
  }
});
