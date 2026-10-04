import { test } from "node:test";
import assert from "node:assert/strict";
import { ASKING, TRUST_PROMPT, highlighted, plain } from "../src/server/ptyWorker.ts";

test("a startup trust prompt is recognised in raw terminal output", () => {
  // Claude Code 2.1, as captured from a worker's terminal (cursor moves between words).
  const claude =
    "\u001b[38;2;102;102;102m\u001b[17;2HSecurity\u001b[1Cguide\u001b[38;2;51;102;255m\u001b[19;2H❯\u001b[1CNo,\u001b[1Cexit\u001b[m\u001b[20;4HYes,\u001b[1CI\u001b[1Ctrust\u001b[1Cthis\u001b[1Cfolder\u001b[38;2;102;102;102m";
  assert.ok(TRUST_PROMPT.test(plain(claude)));
  assert.ok(TRUST_PROMPT.test("Do you trust the contents of this directory?"));
  assert.ok(!TRUST_PROMPT.test(plain("\u001b[1m> Welcome to Claude Code\u001b[0m  /help for help")));
});

test("an agent asking for permission is told apart from one just talking", () => {
  for (const asking of ["Do you want to proceed?\n❯ 1. Yes", "Do you want to make this edit to README.md?", "Allow command? (y/n)", "Approve this change [y/N]", "Allow execution of: 'npm test'?"]) {
    assert.ok(ASKING.test(asking), asking);
  }
  for (const not of ["I've added the README. Want me to proceed with the next task?", "✻ Brewed for 5s · done", "> "]) {
    assert.ok(!ASKING.test(not), not);
  }
});

test("the trust prompt's highlighted option is read off the screen, before and after moving down", () => {
  // Claude Code 2.1 as first drawn: "No, exit" is highlighted.
  const first =
    "C:\proj\.domain\worktrees\desk-1>claude\r\n\u001b[17;2HSecurity\u001b[1Cguide\u001b[38;2;51;102;255m\u001b[19;2H❯\u001b[1CNo,\u001b[1Cexit\u001b[m\u001b[20;4HYes,\u001b[1CI\u001b[1Ctrust\u001b[1Cthis\u001b[1Cfolder\u001b[22;2HEnter\u001b[1Cto\u001b[1Cconfirm\u001b[>0q";
  assert.equal(highlighted(plain(first)), "No, exit");
  // After ↓ it repaints the two rows: now "Yes" has the marker.
  const repaint = "\u001b[19;2H \u001b[1CNo,\u001b[1Cexit\u001b[20;2H\u001b[38;2;51;102;255m❯\u001b[1CYes,\u001b[1CI\u001b[1Ctrust\u001b[1Cthis\u001b[1Cfolder\u001b[m";
  assert.equal(highlighted(plain(repaint)), "Yes, I trust this folder");
  assert.equal(highlighted("no menu here"), null);
});
