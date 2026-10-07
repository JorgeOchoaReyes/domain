import { test } from "node:test";
import assert from "node:assert/strict";
import { MONITOR_WALL, MY_OFFICE, OFFICE_DOOR, PODIUM, REVIEW_SPOT, cameraOccluders, inMyOffice, lineSpot, myOfficeWalls, route } from "../src/shared/layout.ts";

type Pt = { x: number; z: number };
type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };

/** Whether the straight walk from a to b passes through the rect (sampled finely). */
function crosses(a: Pt, b: Pt, r: Rect): boolean {
  const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.02) + 1;
  for (let i = 0; i <= n; i++) {
    const x = a.x + ((b.x - a.x) * i) / n;
    const z = a.z + ((b.z - a.z) * i) / n;
    if (x > r.minX && x < r.maxX && z > r.minZ && z < r.maxZ) return true;
  }
  return false;
}

test("your office has solid walls, with the doorway left open", () => {
  const walls = myOfficeWalls();
  assert.equal(walls.length, 3, "the north wall either side of the door, and the west wall");
  const doorMid = { x: (OFFICE_DOOR.x0 + OFFICE_DOOR.x1) / 2, z: MY_OFFICE.minZ };
  for (const w of walls) {
    assert.ok(!(doorMid.x > w.minX && doorMid.x < w.maxX && doorMid.z >= w.minZ && doorMid.z <= w.maxZ), "nothing in the doorway");
  }
  // The camera keeps on your side of them, like any wall.
  const occ = cameraOccluders();
  for (const w of walls) assert.ok(occ.some((o) => o.minX === w.minX && o.maxX === w.maxX && o.minZ === w.minZ && o.maxZ === w.maxZ && o.maxY === MY_OFFICE.height));
});

test("workers still walk in through the door, never through a wall", () => {
  const walls = myOfficeWalls();
  for (const to of [PODIUM, lineSpot(1), lineSpot(3), REVIEW_SPOT]) {
    const path = [{ x: 7.6, z: 0.6 }, ...route({ x: 7.6, z: 0.6 }, to)];
    for (let i = 1; i < path.length; i++) for (const w of walls) assert.ok(!crosses(path[i - 1], path[i], w), `${JSON.stringify(path[i - 1])} → ${JSON.stringify(path[i])} goes through a wall`);
  }
});

test("the monitor wall hangs inside your office, and you stand in front of it to use it", () => {
  assert.ok(inMyOffice(MONITOR_WALL.spot));
  assert.ok(MONITOR_WALL.z - MONITOR_WALL.width / 2 > MY_OFFICE.minZ && MONITOR_WALL.z + MONITOR_WALL.width / 2 < MY_OFFICE.maxZ);
  assert.ok(MONITOR_WALL.y + MONITOR_WALL.height / 2 < MY_OFFICE.height, "below the top of the wall");
  // Away from your desk, so E there still starts office hours.
  assert.ok(Math.hypot(REVIEW_SPOT.x - MONITOR_WALL.spot.x, REVIEW_SPOT.z - MONITOR_WALL.spot.z) > MONITOR_WALL.r + 2.2);
});
