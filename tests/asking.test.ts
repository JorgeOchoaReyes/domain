import { test } from "node:test";
import assert from "node:assert/strict";
import { askedQuestion, needsAnswer } from "../src/shared/asking.ts";

test("a question it ends on, at Claude Code's prompt, is found — past the input box and its status lines", () => {
  const screen = [
    "If you want me to go ahead, I'll:",
    "- Read .domain/LESSONS.md",
    "- Ask you before each command or edit, and ask again before pushing or opening a PR.",
    "",
    "Where's the covers app, and is it OK to work and commit in a covers clone rather",
    "than this repo?",
    "",
    "✻ Baked for 8s · done 8:47 PM",
    "",
    "────────────────────────────────────────",
    "> yes, it should be on github, work in the clone",
    "────────────────────────────────────────",
    "  ⏵⏵ auto mode on (shift+tab to cycle) · install gh for PR status · ← for agents",
  ];
  assert.equal(askedQuestion(screen), "Where's the covers app, and is it OK to work and commit in a covers clone rather than this repo?");
});

test("just the asking sentence of the paragraph", () => {
  assert.equal(askedQuestion(["I checked the repo. Two tests fail on main already. Should I fix those first?", "", "> "]), "Should I fix those first?");
});

test("not a question: it's done, or telling you something", () => {
  assert.equal(askedQuestion(["All three tests pass and the PR is open.", "", "> "]), null);
  assert.equal(askedQuestion(["What's next? I'll start on the README now.", "> "]), null);
  assert.equal(askedQuestion([]), null);
});

test("needing your answer: a menu on its screen, or a question in words", () => {
  assert.equal(needsAnswer({ status: "waiting" }), true);
  assert.equal(needsAnswer({ status: "idle", asking: "Where is it?" }), true);
  assert.equal(needsAnswer({ status: "idle" }), false);
  assert.equal(needsAnswer(null), false);
});
