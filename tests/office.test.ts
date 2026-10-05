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
  assert.equal(snap.presentations[0].order, 0, "and first in line");
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

test("a round-up lines workers up to prepare reports, then they present", async () => {
  const office = new Office(sim);
  const [a, b, c] = office.snapshot().desks.map((d) => d.id);
  office.hire(a, "claude", "Jorge");
  office.hire(b, "codex", "Jorge");
  office.hire(c, "gemini", "Jorge");
  await new Promise((r) => setTimeout(r, 900));

  // Round up just two of them.
  assert.equal(office.roundup([a, b]), 2);
  let snap = office.snapshot();
  assert.deepEqual(snap.presentations.map((p) => p.deskId), [a, b], "both line up in order");
  assert.ok(snap.presentations.every((p) => p.report === null), "still preparing their reports");
  assert.equal(snap.desks.find((d) => d.id === c)!.worker?.status, "idle", "the third keeps working");
  // Rounding up again doesn't line anyone up twice.
  assert.equal(office.roundup([]), 1, "only the one not already in line");

  await new Promise((r) => setTimeout(r, 2600));
  snap = office.snapshot();
  assert.ok(snap.presentations.every((p) => p.report), "everyone has a report to present");
  assert.match(snap.presentations[0].report!.title, /Progress update/);
  office.dispose();
});

test("talking to a worker in its review gets an answer back", async () => {
  const office = new Office(sim);
  const deskId = office.snapshot().desks[0].id;
  const said: [string, string][] = [];
  office.onSaid = (_desk, from, text) => said.push([from, text]);
  office.hire(deskId, "claude", "Jorge");
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(office.say(deskId, "Why did you do it that way?"), true);
  assert.equal(office.say(deskId, "   "), false, "nothing to say");
  await new Promise((r) => setTimeout(r, 1600));
  assert.deepEqual(said[0], ["you", "Why did you do it that way?"]);
  assert.equal(said[1]?.[0], "agent", "the worker answers");
  office.dispose();
});

test("a review with a whiteboard sketch saves it for the worker", async () => {
  const { mkdtempSync, readdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "domain-test-"));
  const office = new Office({ simulate: true, cwd: dir });
  const deskId = office.snapshot().desks[0].id;
  office.hire(deskId, "claude", "Jorge");
  await new Promise((r) => setTimeout(r, 900));
  office.roundup([deskId]);
  await new Promise((r) => setTimeout(r, 2600));
  // A 1x1 transparent PNG.
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  assert.equal(office.review(deskId, false, "Rename the button", png), true);
  const saved = readdirSync(join(dir, ".domain", "reviews"));
  assert.equal(saved.length, 1, "the sketch is saved");
  assert.equal(office.snapshot().presentations.length, 0);
  office.dispose();
  rmSync(dir, { recursive: true, force: true });
});
