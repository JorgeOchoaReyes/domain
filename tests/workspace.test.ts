import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspaces } from "../src/server/workspace.ts";
import { runCheck } from "../src/server/checks.ts";
import type { CheckResult } from "../src/shared/protocol.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A throwaway repo with one commit on `main`. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "domain-ws-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "app.txt"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

test("each worker gets its own worktree and branch, kept out of git status", () => {
  const dir = repo();
  try {
    const ws = new Workspaces(dir);
    assert.ok(ws.enabled);
    assert.equal(ws.base(), "main");
    const a = ws.create("desk-1", "claude")!;
    const b = ws.create("desk-2", "codex")!;
    assert.ok(existsSync(join(a.path, "app.txt")), "the worktree has the project");
    assert.match(a.branch, /^domain\/claude-desk-1-/);
    assert.notEqual(a.path, b.path);
    assert.equal(git(dir, "status", "--porcelain"), "", ".domain/ is excluded locally, so your status stays clean");
    assert.match(readFileSync(join(dir, ".git", "info", "exclude"), "utf8"), /^\.domain\/$/m, "every .domain folder, at any depth");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approved work is committed and merged into your branch; a conflict is backed out", () => {
  const dir = repo();
  try {
    const ws = new Workspaces(dir);
    const a = ws.create("desk-1", "claude")!;
    writeFileSync(join(a.path, "feature.txt"), "new feature\n");
    assert.ok(ws.commitAll(a.path, "domain: add feature"));
    const m = ws.merge(a.branch, "add feature");
    assert.equal(m.outcome, "merged");
    assert.ok(existsSync(join(dir, "feature.txt")), "the work is on your branch");
    assert.equal(ws.merge(a.branch, "again").outcome, "nothing");

    // Both sides change the same line: the merge is refused and nothing is left half-done.
    const b = ws.create("desk-2", "codex")!;
    writeFileSync(join(b.path, "app.txt"), "from the worker\n");
    ws.commitAll(b.path, "worker change");
    writeFileSync(join(dir, "app.txt"), "from you\n");
    git(dir, "commit", "-q", "-am", "your change");
    const c = ws.merge(b.branch, "conflicting");
    assert.equal(c.outcome, "conflict");
    assert.equal(git(dir, "status", "--porcelain", "--untracked-files=no"), "", "the merge was aborted cleanly");
    assert.equal(readFileSync(join(dir, "app.txt"), "utf8").replace(/\r\n/g, "\n"), "from you\n");

    // Your uncommitted edits block a merge rather than getting mixed in.
    const d = ws.create("desk-3", "gemini")!;
    writeFileSync(join(d.path, "other.txt"), "x\n");
    ws.commitAll(d.path, "other");
    writeFileSync(join(dir, "app.txt"), "editing…\n");
    assert.equal(ws.merge(d.branch, "other").outcome, "dirty");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a leaving worker's folder goes, but a branch with unmerged work is kept", () => {
  const dir = repo();
  try {
    const ws = new Workspaces(dir);
    const idle = ws.create("desk-1", "claude")!;
    assert.equal(ws.remove(idle), "removed");
    assert.ok(!git(dir, "branch", "--list", idle.branch), "an empty branch is deleted");

    const busy = ws.create("desk-2", "claude")!;
    writeFileSync(join(busy.path, "wip.txt"), "wip\n");
    ws.commitAll(busy.path, "wip");
    assert.equal(ws.remove(busy), "kept");
    assert.ok(git(dir, "branch", "--list", busy.branch), "its branch survives");
    assert.ok(!existsSync(busy.path), "its folder is gone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outside a git repo there are no worktrees", () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-nogit-"));
  try {
    const ws = new Workspaces(dir);
    assert.equal(ws.enabled, false);
    assert.equal(ws.create("desk-1", "claude"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the check passes or fails on its exit code and keeps the end of its output", async () => {
  const run = (cmd: string) => new Promise<CheckResult>((done) => runCheck(cmd, tmpdir(), done));
  const ok = await run(`node -e "console.log('all good')"`);
  assert.equal(ok.status, "pass");
  assert.match(ok.tail, /all good/);
  const bad = await run(`node -e "console.error('1 failed'); process.exit(3)"`);
  assert.equal(bad.status, "fail");
  assert.equal(bad.exitCode, 3);
  assert.match(bad.tail, /1 failed/);
});

test("the office's merges and commits are by you, as git knows you — not a made-up account", () => {
  const dir = repo();
  try {
    execFileSync("git", ["config", "user.name", "Ada Lovelace"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "ada@example.com"], { cwd: dir });
    const ws = new Workspaces(dir);
    const w = ws.create("desk-1", "claude")!;
    writeFileSync(join(w.path, "new.txt"), "work\n");
    assert.ok(ws.commitAll(w.path, "Worker's leftovers"));
    assert.equal(ws.merge(w.branch, "Add new.txt").outcome, "merged");
    // The merge (HEAD) and the worker's commit it brought in (HEAD^2) — by name, not by date order.
    const authors = git(dir, "show", "-s", "--format=%an <%ae>|%cn <%ce>", "HEAD", "HEAD^2").split("\n");
    assert.deepEqual(authors, ["Ada Lovelace <ada@example.com>|Ada Lovelace <ada@example.com>", "Ada Lovelace <ada@example.com>|Ada Lovelace <ada@example.com>"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a worker's copy borrows your installed dependencies — never committed, never deleted", () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "ignore deps");
    mkdirSync(join(dir, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    // A .venv git doesn't ignore is left alone (it could end up in a commit).
    mkdirSync(join(dir, ".venv"));
    writeFileSync(join(dir, ".venv", "pyvenv.cfg"), "home = x\n");

    const ws = new Workspaces(dir);
    const w = ws.create("desk-1", "claude")!;
    assert.equal(readFileSync(join(w.path, "node_modules", "left-pad", "index.js"), "utf8"), "module.exports = 1;\n", "the worker sees your node_modules");
    assert.ok(!existsSync(join(w.path, ".venv")), "not ignored, so not linked");
    assert.equal(git(w.path, "status", "--porcelain"), "", "the link doesn't show up as a change");

    assert.equal(ws.remove(w), "removed");
    assert.ok(!existsSync(w.path), "the worker's folder is gone");
    assert.equal(readFileSync(join(dir, "node_modules", "left-pad", "index.js"), "utf8"), "module.exports = 1;\n", "your node_modules is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
