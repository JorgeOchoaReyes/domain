import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Lessons, feedbackKind } from "../src/server/lessons.ts";
import { EodSync } from "../src/server/sync.ts";

test("feedback is in every worker's LESSONS.md straight away, and saved", () => {
  const dir = mkdtempSync(join(tmpdir(), "lessons-"));
  const w1 = join(dir, "w1");
  const file = join(dir, "lessons.json");
  const l = new Lessons(file, () => [dir, w1]);
  l.note({ from: "you", text: "Always add a test for the empty case", about: "Login form", kind: "feedback" });
  for (const d of [dir, w1]) assert.match(readFileSync(join(d, "LESSONS.md"), "utf8"), /Your manager on “Login form”: Always add a test for the empty case/);
  const again = new Lessons(file, () => []);
  assert.equal(again.snapshot.notes.length, 1, "kept across restarts");
});

test("the end-of-day sync: each worker's lessons, merged by a lead into the team's", async () => {
  const root = mkdtempSync(join(tmpdir(), "sync-"));
  const dirs: Record<string, string> = { "desk-1": join(root, "a"), "desk-2": join(root, "b") };
  const l = new Lessons(null, () => [root]);
  l.note({ from: "you", text: "Keep PRs small", kind: "feedback" });
  const told: string[] = [];
  const sync = new EodSync({
    lessons: l,
    note: (t) => told.push(t),
    pollMs: 20,
    ownMs: 2000,
    mergeMs: 2000,
    office: {
      staffed: () => ["desk-1", "desk-2"],
      workdir: (d) => dirs[d],
      nameOf: (d) => (d === "desk-1" ? "Ada" : "Grace"),
      // The "workers" do as they're told: write the file named in the instruction.
      instruct: (d, text) => {
        const file = /to (\S+\.json)/.exec(text)![1].replace(/\.$/, "");
        const merging = /running today's sync/.test(text);
        setTimeout(() => writeFileSync(file, JSON.stringify({ lessons: merging ? ["Keep PRs small", "Run the tests before presenting"] : [`${d} learned something`] })), 50);
      },
    },
  });
  assert.equal(await sync.run(), true);
  assert.deepEqual(l.snapshot.lessons, ["Keep PRs small", "Run the tests before presenting"]);
  assert.equal(l.snapshot.notes.length, 0, "today's notes are covered by the sync");
  assert.match(readFileSync(join(root, "LESSONS.md"), "utf8"), /- Run the tests before presenting/);
  assert.ok(told.some((t) => /Ada merged: 2 team lessons/.test(t)));
});

test("a sync whose lead never delivers loses nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "sync2-"));
  const l = new Lessons(null, () => [root]);
  l.note({ from: "you", text: "Name things plainly", kind: "feedback" });
  const sync = new EodSync({
    lessons: l,
    note: () => {},
    pollMs: 20,
    ownMs: 100,
    mergeMs: 100,
    office: { staffed: () => ["desk-1"], workdir: () => join(root, "w"), nameOf: () => "Ada", instruct: () => {} },
  });
  await sync.run();
  assert.deepEqual(l.snapshot.lessons, ["Name things plainly"]);
});

test("what you say is learned from when it's a rule, a correction or praise — not a question or a hello", () => {
  assert.equal(feedbackKind("From now on, run the tests before you present"), "rule");
  assert.equal(feedbackKind("Never push straight to master"), "rule");
  assert.equal(feedbackKind("That's wrong, the button should be on the left"), "fix");
  assert.equal(feedbackKind("Please don't touch the database schema"), "rule");
  assert.equal(feedbackKind("I want you to run the linter before presenting"), "rule");
  assert.equal(feedbackKind("Use pnpm instead of npm"), "rule");
  // Not feedback: questions, asks, "don't worry", praise that leads into the next ask.
  for (const said of ["can you check why the build failed?", "how's the bug hunt going?", "what do you prefer, A or B?", "do not worry about it", "next time we meet let's talk", "great, now add the login page", "Add a missing favicon", "Fix the bad link in the footer"])
    assert.equal(feedbackKind(said), null, said);
  assert.equal(feedbackKind("The login page is broken"), "fix");
  assert.equal(feedbackKind("This needs to change, the colors are confusing"), "fix");
  assert.equal(feedbackKind("Perfect, love it"), "praise");
  assert.equal(feedbackKind("How is it going?"), null);
  assert.equal(feedbackKind("hi there"), null);
  assert.equal(feedbackKind("ok"), null);
});

test("feedback said in chat goes in once, praise as something to keep doing; you can teach and forget", () => {
  const dir = mkdtempSync(join(tmpdir(), "heard-"));
  const l = new Lessons(null, () => [dir]);
  assert.equal(l.heard("Always write a test for the empty case", "Login form"), true);
  assert.equal(l.heard("Always write a test for the empty case"), false, "said to everyone at once: counted once");
  assert.equal(l.heard("What are you working on?"), false);
  assert.equal(l.heard("Great job on the docs"), true);
  const notes = l.snapshot.notes;
  assert.equal(notes.length, 2);
  assert.equal(notes[0].about, "Login form");
  assert.match(notes[1].text, /^Keep doing this — Great job/);
  assert.match(readFileSync(join(dir, "LESSONS.md"), "utf8"), /Always write a test for the empty case/);

  l.teach("Keep PRs under 300 lines");
  assert.deepEqual(l.snapshot.lessons, ["Keep PRs under 300 lines"]);
  l.forget({ lesson: "Keep PRs under 300 lines", noteAt: notes[0].at });
  assert.equal(l.snapshot.lessons.length, 0);
  assert.equal(l.snapshot.notes.length, 1);
});
