import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Lessons } from "../src/server/lessons.ts";
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
