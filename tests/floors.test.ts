import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DESKS,
  DESK_BY_ID,
  TEAM_DESK_IDS,
  BAY_DESK_IDS,
  TEAM_ARRIVE,
  TEAM_FLOORS,
  MORE_TEAM_DESK_IDS,
  MORE_PLACES,
  POOL,
  ROOMS,
  deskSeat,
  floorOf,
  inTeamFloor,
  isIndoors,
  lineSpot,
  openTeamFloors,
  roomAt,
  route,
  teamArrive,
  teamElevatorX,
  teamFloorDeskIds,
  teamFloorIndex,
  waitSpot,
  type WalkPt,
} from "../src/shared/layout.ts";

test("the team floor adds sixteen desks in four pods, apart from the bay", () => {
  assert.equal(TEAM_DESK_IDS.length, 16);
  assert.equal(BAY_DESK_IDS.length, 8, "the bay is still eight");
  assert.equal(DESKS.length, 24 + 16 * TEAM_FLOORS, "floors 4 and up have sixteen each, too");
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

// --- more team floors, as the team grows -----------------------------------------------

test("floors 4 and 5 are floor 3 again, further east, with pods of their own", () => {
  assert.equal(TEAM_FLOORS, 3);
  assert.equal(MORE_TEAM_DESK_IDS.length, 32);
  assert.deepEqual(teamFloorDeskIds(1).map((id) => DESK_BY_ID.get(id)!.label).slice(0, 5), ["Pod E1", "Pod E2", "Pod E3", "Pod E4", "Pod F1"]);
  assert.equal(DESK_BY_ID.get(teamFloorDeskIds(2).at(-1)!)!.label, "Pod L4");
  for (let k = 0; k < TEAM_FLOORS; k++) {
    for (const id of teamFloorDeskIds(k)) {
      const d = DESK_BY_ID.get(id)!;
      assert.equal(floorOf(d.x), 3 + k, `${id} is on floor ${3 + k}`);
      assert.equal(teamFloorIndex(d.x), k);
      assert.ok(inTeamFloor(d.x, d.z) && isIndoors(d.x, d.z));
      assert.equal(roomAt(d.x, d.z).name, `Floor ${3 + k} · Team floor`);
    }
    const a = teamArrive(k);
    assert.equal(floorOf(a.x), 3 + k);
    assert.equal(teamElevatorX(a.x), a.x, "the elevator is right behind where it lets you out");
  }
  // Every label's still unique.
  assert.equal(new Set(DESKS.map((d) => d.label)).size, DESKS.length);
  assert.equal(teamFloorIndex(DESK_BY_ID.get("desk-1")!.x), -1);
  assert.equal(ROOMS.filter((r) => r.id === "team").length, TEAM_FLOORS);
});

test("a floor opens once the one below is full, or someone's already up there", () => {
  const taken = new Set<string>();
  const open = () => openTeamFloors((id) => taken.has(id));
  assert.equal(open(), 1, "just floor 3 to start");
  for (const id of teamFloorDeskIds(0).slice(0, 15)) taken.add(id);
  assert.equal(open(), 1, "fifteen of sixteen: not yet");
  taken.add(teamFloorDeskIds(0)[15]);
  assert.equal(open(), 2, "floor 3 full: floor 4 opens");
  for (const id of teamFloorDeskIds(1)) taken.add(id);
  assert.equal(open(), 3, "and floor 5 after it");
  // A worker already on floor 5 keeps it open, even with room below.
  taken.clear();
  taken.add(teamFloorDeskIds(2)[3]);
  assert.equal(open(), 3);
  // Fast travel can list every floor (it shows the open ones).
  for (let k = 1; k < TEAM_FLOORS; k++) assert.ok(MORE_PLACES.some((p) => teamFloorIndex(p.x) === k), `floor ${3 + k} has a place`);
});

test("from a floor-5 desk to the stand-up: one ride down; from floor 4 to floor 5: one ride up", () => {
  const seat5 = deskSeat(DESK_BY_ID.get(teamFloorDeskIds(2)[0])!, 0.93);
  const down = route(seat5, waitSpot(0)) as WalkPt[];
  assert.equal(down.filter((p) => p.lift).length, 1);
  const i = down.findIndex((p) => p.lift);
  assert.ok(down.slice(0, i).every((p) => floorOf(p.x) === 5), "walks floor 5 to its elevator");
  assert.equal(floorOf(down.at(-1)!.x), 1);
  const seat4 = deskSeat(DESK_BY_ID.get(teamFloorDeskIds(1)[9])!, 0.93);
  const up = route(seat4, seat5) as WalkPt[];
  assert.equal(up.filter((p) => p.lift).length, 1);
  const lift = up.find((p) => p.lift)!;
  assert.deepEqual({ x: lift.x, z: lift.z }, { x: teamArrive(2).x, z: teamArrive(2).z });
  assert.deepEqual(up.at(-1), seat5);
});

test("on floor 4 the far row goes round its pod just as on floor 3", () => {
  // desk-41 is pod E's north row, as desk-25 is pod A's.
  const far = deskSeat(DESK_BY_ID.get("desk-41")!, 0.93);
  const path = route(far, deskSeat(DESK_BY_ID.get("desk-47")!, 0.93));
  assert.ok(path.every((p) => floorOf(p.x) === 4) && !path.some((p) => (p as WalkPt).lift));
  assert.ok(Math.abs(path[0].z - far.z) < 0.01 && Math.abs(path[0].x - far.x) > 1, "first sideways, past the pod's end");
  // The same walk as floor 3's, 40 m east.
  const f3 = route(deskSeat(DESK_BY_ID.get("desk-25")!, 0.93), deskSeat(DESK_BY_ID.get("desk-31")!, 0.93));
  const r = (v: number) => Math.round(v * 100) / 100;
  assert.deepEqual(
    path.map((p) => [r(p.x - 40), r(p.z)]),
    f3.map((p) => [r(p.x), r(p.z)]),
  );
});

test("to the pool table on a break: out the office's south door and in at the game room's", () => {
  const seat = deskSeat(DESK_BY_ID.get("desk-1")!, 0.93);
  for (const spot of POOL.spots) {
    const path = route(seat, spot);
    assert.deepEqual(path.at(-1), spot);
    assert.equal(roomAt(spot.x, spot.z).id, "game");
    // Along the hallway, and in at the game room's door (x 10.8–13.2): never through a wall.
    assert.ok(path.filter((p) => p.z > 13.3 && p.z < 16.3).length >= 2, "along the hallway");
    const entry = path.find((p) => p.z > 16.6)!;
    assert.ok(entry.x > 10.8 && entry.x < 13.2, "in at the game room's door");
    // And back.
    const back = route(spot, seat);
    assert.ok(back.some((p) => p.z > 13.3 && p.z < 16.3));
    assert.deepEqual(back.at(-1), seat);
  }
});
