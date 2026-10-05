import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Alumni, MAX_ALUMNI } from "../src/server/alumni.ts";

test("former workers are kept (newest first), across restarts, until brought back", () => {
  const file = join(mkdtempSync(join(tmpdir(), "alumni-")), "alumni.json");
  const a = new Alumni(file);
  const ada = a.add({ name: "Ada", agent: "claude", model: "opus", leash: "auto", reason: "Kept skipping tests", desk: "desk-1", tasksDone: 3 });
  a.add({ name: "Codex · Desk 2", agent: "codex", model: "", leash: "ask", desk: "desk-2", tasksDone: 0 });
  const again = new Alumni(file);
  assert.deepEqual(again.all.map((x) => x.name), ["Codex · Desk 2", "Ada"]);
  assert.equal(again.get(ada.id)?.reason, "Kept skipping tests");
  again.remove(ada.id);
  assert.deepEqual(new Alumni(file).all.map((x) => x.name), ["Codex · Desk 2"], "back at a desk: off the list");
});

test("the list doesn't grow forever", () => {
  const a = new Alumni(null);
  for (let i = 0; i < MAX_ALUMNI + 10; i++) a.add({ name: `W${i}`, agent: "claude", model: "", leash: "ask", desk: "desk-1", tasksDone: 0 });
  assert.equal(a.all.length, MAX_ALUMNI);
  assert.equal(a.all[0].name, `W${MAX_ALUMNI + 9}`);
});
