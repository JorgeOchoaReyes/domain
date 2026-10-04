import { test } from "node:test";
import assert from "node:assert/strict";
import { Office } from "../src/server/office.ts";

// Always use the simulated backend in tests so no real shells are spawned.
const sim = { simulate: true };

test("office starts with a grid of empty desks", () => {
  const office = new Office(sim);
  const snap = office.snapshot();
  assert.ok(snap.desks.length >= 4, "expected several desks");
  assert.ok(
    snap.desks.every((d) => d.worker === null),
    "all desks start empty",
  );
  office.dispose();
});

test("hiring staffs a desk and firing frees it", () => {
  const office = new Office(sim);
  const deskId = office.snapshot().desks[0].id;

  assert.equal(office.hire(deskId, "claude", "Jorge"), true);
  let desk = office.snapshot().desks.find((d) => d.id === deskId)!;
  assert.equal(desk.worker?.agent, "claude");
  assert.equal(desk.worker?.hiredBy, "Jorge");

  // Can't double-hire an occupied desk.
  assert.equal(office.hire(deskId, "codex", "Someone"), false);

  assert.equal(office.fire(deskId), true);
  desk = office.snapshot().desks.find((d) => d.id === deskId)!;
  assert.equal(desk.worker, null);
  office.dispose();
});

test("a hired worker produces terminal output", async () => {
  const office = new Office(sim);
  const deskId = office.snapshot().desks[0].id;
  let captured = "";
  office.onOutput = (id, data) => {
    if (id === deskId) captured += data;
  };
  office.hire(deskId, "codex", "Jorge");
  // The boot sequence is scheduled; give it a moment.
  await new Promise((r) => setTimeout(r, 1000));
  assert.ok(captured.length > 0, "worker should emit a boot banner");
  office.dispose();
});

test("a finished worker lines up to present, and review clears it", async () => {
  const office = new Office(sim);
  const deskId = office.snapshot().desks[0].id;
  let presented: string | null = null;
  office.onReport = (p) => {
    presented = p.deskId;
  };
  office.hire(deskId, "claude", "Jorge");
  // Boot, then give it a task; the simulated worker presents a report.
  await new Promise((r) => setTimeout(r, 900));
  office.input(deskId, "build the login page\r");
  await new Promise((r) => setTimeout(r, 3500));

  const snap = office.snapshot();
  assert.equal(presented, deskId, "a report event should have fired");
  assert.equal(snap.presentations.length, 1, "worker should be in the line");
  assert.equal(snap.presentations[0].order, 0, "and at the podium");
  const desk = snap.desks.find((d) => d.id === deskId)!;
  assert.equal(desk.worker?.status, "presenting");
  assert.ok(desk.worker?.report, "the desk carries the report");

  // Approve: the line clears and the worker goes back to work.
  assert.equal(office.review(deskId, true), true);
  const after = office.snapshot();
  assert.equal(after.presentations.length, 0, "line is empty after review");
  assert.equal(after.desks.find((d) => d.id === deskId)!.worker?.report, null);
  office.dispose();
});

test("peers can join, move and leave", () => {
  const office = new Office(sim);
  office.addPeer("p1", "Ann");
  office.movePeer("p1", 3, 4, 1.2);
  let peer = office.snapshot().peers.find((p) => p.id === "p1")!;
  assert.equal(peer.name, "Ann");
  assert.equal(peer.x, 3);
  office.removePeer("p1");
  assert.equal(
    office.snapshot().peers.find((p) => p.id === "p1"),
    undefined,
  );
  office.dispose();
});
