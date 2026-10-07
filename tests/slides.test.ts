import { test } from "node:test";
import assert from "node:assert/strict";
import { changedSlide, deckOf, parseSlide, slideSpeech } from "../src/shared/slides.ts";
import { ROLES, roleCharacter } from "../src/shared/roles.ts";
import { MAX_PERSONA, coerceCharacter } from "../src/shared/team.ts";

test("a slide has a heading, points and code; a one-liner is one point", () => {
  const s = parseSlide("How it works\n- One new function\n* called from main\n```ts\nconst a = 1;\n```");
  assert.deepEqual(s, { heading: "How it works", bullets: ["One new function", "called from main"], code: "const a = 1;" });
  assert.deepEqual(parseSlide("Done: the toggle"), { heading: "", bullets: ["Done: the toggle"], code: null });
  assert.equal(slideSpeech("How it works\n- One new function\n```ts\nconst a = 1;\n```"), "How it works. One new function");
});

test("the deck ends with the check's result; a running check isn't shown yet", () => {
  const base = { status: "ready" as const, title: "T", summary: "", slides: ["A\n- b"], at: 1 };
  assert.equal(deckOf(base).length, 1);
  assert.equal(deckOf({ ...base, check: { status: "running", command: "npm test", exitCode: null, ms: 0, tail: "" } }).length, 1);
  const d = deckOf({ ...base, check: { status: "pass", command: "npm test", exitCode: 0, ms: 4200, tail: "24 passing" } });
  assert.match(d[1], /^✅ Checks pass/);
  assert.match(d[1], /4\.2 s/);
  assert.equal(parseSlide(d[1]).code, "24 passing");
});

test("what changed: biggest first, totals in the heading", () => {
  const s = changedSlide([
    { file: "a.ts", added: 2, removed: 1 },
    { file: "b.ts", added: 40, removed: 3 },
  ])!;
  const p = parseSlide(s);
  assert.equal(p.heading, "📁 What changed: 2 files, +42 −4");
  assert.deepEqual(p.bullets, ["b.ts  +40 −3", "a.ts  +2 −1"]);
  assert.equal(changedSlide([]), null);
});

test("ready-made agents: detailed methods that fit, unique names, the model only where the agent takes it", () => {
  assert.ok(ROLES.length >= 10);
  for (const r of ROLES) {
    assert.ok(r.persona.length > 400, `${r.id} has a real method`);
    assert.ok(r.persona.length <= MAX_PERSONA, `${r.id} fits`);
    assert.ok(coerceCharacter(roleCharacter(r, [])), `${r.id} is a valid character`);
  }
  const reviewer = ROLES.find((r) => r.id === "reviewer")!;
  assert.equal(roleCharacter(reviewer, ["Grace"]).name, "Grace 2");
  assert.equal(roleCharacter(reviewer, []).model, "opus");
  assert.equal(roleCharacter(reviewer, [], "codex").model, "");
  assert.equal(coerceCharacter(roleCharacter(reviewer, []))!.persona, reviewer.persona, "kept whole, not cut short");
});

test("one-liners in a row become one slide of key points", () => {
  const r = { status: "ready" as const, title: "T", summary: "", at: 1, slides: ["The empty case isn't handled", "A helper is misnamed", "How it works\n- x", "Lone point"] };
  const d = deckOf(r);
  assert.equal(d.length, 3);
  assert.deepEqual(parseSlide(d[0]), { heading: "Key points", bullets: ["The empty case isn't handled", "A helper is misnamed"], code: null });
  assert.equal(d[2], "Lone point");
});
