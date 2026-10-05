import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Progress, type Award } from "../src/server/progress.ts";
import { XP, levelFor, xpForNext } from "../src/shared/progress.ts";

test("levels climb as XP adds up", () => {
  assert.deepEqual(levelFor(0), { level: 1, title: "Intern", into: 0, need: xpForNext(1) });
  assert.equal(levelFor(xpForNext(1)).level, 2);
  assert.equal(levelFor(xpForNext(1) + xpForNext(2) - 1).level, 2);
  assert.equal(levelFor(xpForNext(1) + xpForNext(2)).title, "Developer");
});

test("a goal's task goes from assigned, to review, to done when approved", () => {
  const p = new Progress(null);
  const awards: Award[] = [];
  p.onAward = (a) => awards.push(a);

  const goal = p.createGoal("Ann", "Launch the beta", "So users can try it", ["Login page", "  ", "Billing"])!;
  assert.equal(goal.tasks.length, 2, "blank tasks are dropped");
  const [login, billing] = goal.tasks;

  assert.ok(p.assign("Ann", goal.id, login.id, "desk-1"));
  assert.equal(p.snapshot().goals[0].tasks[0].status, "doing");
  assert.equal(p.taskAt("desk-1")?.title, "Login page");

  p.reported("desk-1");
  assert.equal(p.snapshot().goals[0].tasks[0].status, "review");

  // Sending it back keeps it in progress; approving finishes it.
  p.reviewed("Ann", "desk-1", false);
  assert.equal(p.snapshot().goals[0].tasks[0].status, "doing");
  p.reviewed("Ann", "desk-1", true);
  assert.equal(p.snapshot().goals[0].tasks[0].status, "done");

  // Ticking off the last task completes the goal.
  p.setDone("Ann", goal.id, billing.id, true);
  const after = p.snapshot();
  assert.ok(after.goals[0].doneAt, "goal is complete");
  const ann = after.players.find((x) => x.name === "Ann")!;
  assert.equal(ann.tasksDone, 2);
  assert.equal(ann.goalsDone, 1);
  assert.equal(ann.xp, XP.createGoal + XP.assign + XP.changes + XP.review + XP.taskDone * 2 + XP.goalDone);
  assert.ok(ann.achievements.includes("shipper"));
  assert.ok(awards.some((a) => a.levelUp), "that much XP is a level up");
  assert.ok(after.feed.length > 0);
});

test("sending a worker home puts its task back on the pile", () => {
  const p = new Progress(null);
  const g = p.createGoal("Ann", "Goal", "", ["Task"])!;
  p.assign("Ann", g.id, g.tasks[0].id, "desk-3");
  p.unlinkDesk("desk-3");
  const t = p.snapshot().goals[0].tasks[0];
  assert.equal(t.status, "todo");
  assert.equal(t.deskId, null);
});

test("a finished focus session rewards everyone present and starts a streak", () => {
  const p = new Progress(null);
  p.present = () => ["Ann", "Bob"];
  let summary: unknown = null;
  p.onSessionEnd = (s) => (summary = s);
  assert.equal(p.startSession("Ann", 25, null), true);
  assert.equal(p.startSession("Bob", 25, null), false, "one session at a time");
  p.tick(Date.now() + 26 * 60_000);
  assert.equal(p.snapshot().session, null);
  assert.ok(summary && (summary as { completed: boolean }).completed);
  for (const name of ["Ann", "Bob"]) {
    const s = p.snapshot().players.find((x) => x.name === name)!;
    assert.equal(s.sessions, 1);
    assert.equal(s.streak, 1);
    assert.equal(s.xp, 25 * XP.sessionMinute);
    assert.ok(s.achievements.includes("focus"));
  }
});

test("progress is saved and loaded back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-progress-"));
  const file = join(dir, "progress.json");
  const p = new Progress(file);
  const g = p.createGoal("Ann", "Persist me", "", ["One"])!;
  p.assign("Ann", g.id, g.tasks[0].id, "desk-1");
  p.dispose();
  const q = new Progress(file);
  const snap = q.snapshot();
  assert.equal(snap.goals[0].title, "Persist me");
  assert.equal(snap.goals[0].tasks[0].status, "todo", "nobody is on a task after a restart");
  assert.equal(snap.players[0].name, "Ann");
  rmSync(dir, { recursive: true, force: true });
});
