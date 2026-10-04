import { test } from "node:test";
import assert from "node:assert/strict";
import { Office } from "../src/server/office.ts";

test("office starts with a grid of empty desks", () => {
  const office = new Office();
  const snap = office.snapshot();
  assert.ok(snap.desks.length >= 4, "expected several desks");
  assert.ok(
    snap.desks.every((d) => d.worker === null),
    "all desks start empty",
  );
  office.dispose();
});

test("hiring staffs a desk and firing frees it", () => {
  const office = new Office();
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
  const office = new Office();
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

test("peers can join, move and leave", () => {
  const office = new Office();
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
