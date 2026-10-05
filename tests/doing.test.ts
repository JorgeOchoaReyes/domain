import { test } from "node:test";
import assert from "node:assert/strict";
import { doingFrom, stepOf } from "../src/server/doing.ts";

test("what an agent is doing, in a word or three, from its screen", () => {
  const cases: [string, string][] = [
    // Claude Code
    ["● Read(src/client/ui/phone.ts)", "Reading phone.ts"],
    ["● Update(math.js)", "Editing math.js"],
    ["● Write(tests/math.test.js)", "Editing math.test.js"],
    ["● Bash(npm test)", "Running tests"],
    ["● Bash(git commit -q -m 'Add clamp')", "Committing"],
    ["● Bash(npm install zod)", "Installing"],
    ["● Search(pattern: \"clamp\")", "Searching"],
    ["● github - create_issue (MCP)(title: \"Bug\")", "Using github"],
    ["● Update Todos", "Planning"],
    // Codex
    ["• Ran git cat-file -t 268e920; git branch --all; npm test", "Running tests"],
    ["• Ran git diff main...HEAD", "Checking git"],
    ["• Running npm test", "Running tests"],
    ["• Edited math.js (+4 -0)", "Editing math.js"],
    ["• Exploring", "Exploring"],
    ["  └ Read audit-desk-1-round1.md", "Reading audit-desk-1-roun…"],
    // Gemini CLI
    ["✓ ReadFile math.js", "Reading math.js"],
    ["✓ Shell npm run build", "Building"],
  ];
  for (const [line, want] of cases) assert.equal(stepOf(line), want, line);
  for (const words of cases.map(([, w]) => w)) assert.ok(words.split(" ").length <= 3, words);
  assert.equal(stepOf("I'll add the function and a test."), null, "prose isn't a step");
});

test("the latest step wins; busy with none on screen is thinking", () => {
  assert.equal(doingFrom(["● Read(math.js)", "  ⎿  Read 9 lines", "● Update(math.js)", "  ⎿  Added 4 lines", "✻ Honking… (12s)"]), "Editing math.js");
  assert.equal(doingFrom(["✻ Clauding… (3s · esc to interrupt)"]), "Thinking");
});
