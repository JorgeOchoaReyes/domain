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
  // Claude Code 2.1, read raw: no spaces between the words.
  assert.ok(ASKING.test("Doyouwanttoproceed?\n ❯ 1. Yes\n   2. Yes,andswitchtoautomode"));
  // Codex 0.157's approval prompt.
  assert.ok(
    ASKING.test(
      "Reason: Allow reading the report path and project files outside the failing sandbox to finish the audit?\n$ Get-Content -Raw math.js\n› 1. Yes, proceed (y)\n  2. Yes, and don't ask again for commands that start with `Get-Content` (p)\n  3. No, and tell Codex what to do differently (esc)\nPress enter to confirm or esc to cancel",
    ),
  );
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

test("Claude Code's permission prompt, drawn with cursor moves, reads as a question on the screen", async () => {
  const { Terminal } = await import("@xterm/headless");
  const t = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
  await new Promise<void>((r) => t.write("\u001b[3;2HDo\u001b[1Cyou\u001b[1Cwant\u001b[1Cto\u001b[1Cproceed?\u001b[4;2H❯\u001b[1C1.\u001b[1CYes", r));
  const b = t.buffer.active;
  const screen = Array.from({ length: t.rows }, (_, y) => b.getLine(y)?.translateToString(true) ?? "").join("\n");
  assert.ok(ASKING.test(screen), screen);
  t.dispose();
});

test("Codex's update menu is recognised (so it's skipped, never answered with a typed 1)", async () => {
  const { UPDATE_MENU } = await import("../src/server/ptyWorker.ts");
  const codex = "› Ask Codex to do anything\n  ? for shortcuts\n  Update available · 0.157.1 → 0.160.0\n  Release notes: https://github.com/openai/codex/releases/latest\n› 1. Update now (runs `powershell …`)\n  2. Skip\n  3. Skip until next version\n  enter continue · esc skip";
  assert.ok(UPDATE_MENU.test(codex));
  assert.ok(!UPDATE_MENU.test("› Ask Codex to do anything\n  ? for shortcuts"));
});

test("an agent that quit is told apart from one that's running", async () => {
  const { looksLikeShellPrompt } = await import("../src/server/ptyWorker.ts");
  const cwd = "C:\\Users\\Jorge\\proj\\.domain\\worktrees\\desk-2";
  assert.ok(looksLikeShellPrompt(["", "C:\\Users\\Jorge\\proj\\.domain\\worktrees\\desk-2>", ""], cwd), "cmd");
  assert.ok(looksLikeShellPrompt(["C:\\Users\\Jorge\\AppData\\Local\\Temp\\claude\\C--Users-Jorge-projects-domain\\8d5cc", "9-3c87\\scratchpad\\realproj\\.domain\\worktrees\\desk-2>"], cwd), "cmd, wrapped");
  assert.ok(looksLikeShellPrompt(["PS C:\\Users\\Jorge\\proj\\.domain\\worktrees\\desk-2>"], cwd), "PowerShell");
  assert.ok(looksLikeShellPrompt(["jorge@mac desk-2 %"], "/Users/jorge/proj/.domain/worktrees/desk-2"), "zsh");
  assert.ok(looksLikeShellPrompt(["jorge@box:~/proj/.domain/worktrees/desk-2$"], "/home/jorge/proj/.domain/worktrees/desk-2"), "bash");
  for (const running of [
    ["› Ask Codex to do anything", "  ? for shortcuts"],
    ["╭───╮", "│ > Try \"fix the bug\" │", "╰───╯", "  ⏵⏵ accept edits on (shift+tab to cycle)"],
    ["✻ Brewed for 5s · 100% done"],
  ]) {
    assert.ok(!looksLikeShellPrompt(running, cwd), running.join(" / "));
  }
});

test("an agent still connecting isn't ready (Codex: 'model: loading')", async () => {
  const { STILL_LOADING } = await import("../src/server/ptyWorker.ts");
  assert.ok(STILL_LOADING.test("│ >_ OpenAI Codex (v0.157.1) │\n│ model:     loading   /model to change │"));
  assert.ok(!STILL_LOADING.test("│ model:     gpt-6-sol high   /model to change │"));
});

test("workers don't inherit a Claude Code session's markers", async () => {
  const { workerEnv } = await import("../src/server/ptyWorker.ts");
  const env = workerEnv({ PATH: "/bin", HOME: "/h", CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "x", CLAUDE_CODE_ENTRYPOINT: "cli", ANTHROPIC_API_KEY: "k" });
  assert.deepEqual(Object.keys(env).sort(), ["ANTHROPIC_API_KEY", "HOME", "PATH"]);
});
