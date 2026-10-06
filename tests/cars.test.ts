import { test } from "node:test";
import assert from "node:assert/strict";
import { blocked, drive, exitSpot, type Car } from "../src/client/scene/cars.ts";

function car(x = 0, z = 0, heading = 0): Car {
  return {
    root: { position: { set() {} }, rotation: { y: 0 } } as never,
    x,
    z,
    heading,
    v: 0,
    steer: 0,
    collider: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
    wheels: [],
    front: [],
  };
}
const go = (c: Car, input: { throttle: number; steer: number; handbrake: boolean }, seconds: number, walls: { minX: number; maxX: number; minZ: number; maxZ: number }[] = []) => {
  let hit = 0;
  for (let t = 0; t < seconds; t += 1 / 60) hit = Math.max(hit, drive(c, input, 1 / 60, walls));
  return hit;
};

test("gas takes it forward along its heading, up to a top speed, and its footprint follows", () => {
  const c = car();
  go(c, { throttle: 1, steer: 0, handbrake: false }, 3);
  assert.ok(c.x > 15 && Math.abs(c.z) < 1e-9, `went +x (${c.x}, ${c.z})`);
  assert.ok(c.v <= 15);
  assert.ok(c.collider.minX < c.x && c.collider.maxX > c.x);
  go(c, { throttle: 0, steer: 0, handbrake: true }, 2);
  assert.equal(c.v, 0, "the handbrake stops it");
});

test("steering left turns it left; holding brake from a stop reverses", () => {
  const c = car();
  go(c, { throttle: 1, steer: 1, handbrake: false }, 1.5);
  assert.ok(c.heading > 0.3, "turned");
  assert.ok(c.z < 0, "left of +x is -z");
  const r = car();
  go(r, { throttle: -1, steer: 0, handbrake: false }, 2);
  assert.ok(r.v < 0 && r.x < 0, "backing up");
});

test("a wall stops it with a bump, and the hit is reported", () => {
  const c = car();
  const wall = { minX: 8, maxX: 9, minZ: -5, maxZ: 5 };
  const hit = go(c, { throttle: 1, steer: 0, handbrake: false }, 3, [wall]);
  assert.ok(hit > 2, "it hit hard");
  assert.ok(c.x + 1.15 + 0.9 <= 8 + 1e-6, "never inside the wall");
  assert.ok(blocked(8.5, 0, 0, [wall]));
});

test("you get out beside the driver's door first", () => {
  const [door] = exitSpot(car(0, 0, 0));
  assert.ok(Math.abs(door.x) < 1e-9 && door.z < -1.5, "left of a car facing +x is -z");
});
