import { test } from "node:test";
import assert from "node:assert/strict";
import { DESKS, DESK_BY_ID, TEAM_DESK_IDS, BAY_DESK_IDS, TEAM_ARRIVE, deskSeat, floorOf, lineSpot, route, waitSpot, type WalkPt } from "../src/shared/layout.ts";

test("the team floor adds sixteen desks in four pods, apart from the bay", () => {
  assert.equal(TEAM_DESK_IDS.length, 16);
  assert.equal(BAY_DESK_IDS.length, 8, "the bay is still eight");
  assert.equal(DESKS.length, 40);
  assert.deepEqual(TEAM_DESK_IDS.map((id) => DESK_BY_ID.get(id)!.label).slice(0, 4), ["Pod A1", "Pod A2", "Pod A3", "Pod A4"]);
  for (const id of TEAM_DESK_IDS) assert.equal(floorOf(DESK_BY_ID.get(id)!.x), 3);
  assert.equal(floorOf(DESK_BY_ID.get("desk-1")!.x), 1);
});

test("from a team-floor desk to your office: down the elevator, once, and on through the door", () => {
  const seat = deskSeat(DESK_BY_ID.get("desk-25")!, 0.93);
  const path = route(seat, lineSpot(0)) as WalkPt[];
  const lifts = path.filter((p) => p.lift);
  assert.equal(lifts.length, 1, "one ride");
  const i = path.findIndex((p) => p.lift);
  assert.ok(path.slice(0, i).every((p) => floorOf(p.x) === 3), "walks floor 3 to the elevator");
  assert.ok(path.slice(i).every((p) => floorOf(p.x) === 1), "and floor 1 from it");
  assert.deepEqual(path.at(-1), lineSpot(0));
  // And back up again.
  const back = route(lineSpot(0), seat) as WalkPt[];
  assert.equal(back.filter((p) => p.lift).length, 1);
  assert.ok(floorOf(back.find((p) => p.lift)!.x) === 3 && back.find((p) => p.lift)!.z === TEAM_ARRIVE.z);
});

test("on the team floor, the far row goes round its pod rather than through the desks", () => {
  // Pod A's north row sits on the far side from the aisle.
  const far = deskSeat(DESK_BY_ID.get("desk-25")!, 0.93);
  const path = route(far, deskSeat(DESK_BY_ID.get("desk-31")!, 0.93));
  assert.ok(path.every((p) => floorOf(p.x) === 3) && !path.some((p) => (p as WalkPt).lift), "no elevator within a floor");
  assert.ok(Math.abs(path[0].z - far.z) < 0.01 && Math.abs(path[0].x - far.x) > 1, "first sideways, past the pod's end");
});

test("the stand-up on floor 1 from floor 3, too", () => {
  const path = route(deskSeat(DESK_BY_ID.get("desk-40")!, 0.93), waitSpot(0)) as WalkPt[];
  assert.equal(path.filter((p) => p.lift).length, 1);
  assert.equal(floorOf(path.at(-1)!.x), 1);
});
