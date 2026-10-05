import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Office } from "../src/server/office.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

test("a worker in its own folder reports from inside it — nothing outside it to ask permission for", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-drops-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "app.txt"), "hi\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  // No agent CLIs on the PATH: the desk gets a plain shell, which is all this needs.
  const path = process.env.PATH;
  // (git stays: the worker's folder is a git worktree.)
  const gitDir = execFileSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" })
    .split(/\r?\n/)[0]
    .replace(/[\\/][^\\/]+$/, "");
  process.env.PATH = [gitDir, process.platform === "win32" ? `${process.env.SystemRoot}\\System32` : "/usr/bin:/bin"].join(process.platform === "win32" ? ";" : ":");
  const office = new Office({ cwd: dir, simulate: false });
  try {
    assert.ok(office.hire("desk-1", "claude", "Ann", "", "ask", true));
    const workdir = office.workdir("desk-1");
    assert.notEqual(workdir, dir, "it has its own folder");
    assert.ok(existsSync(join(workdir, ".domain", "BRIEF.md")), "its own copy of the brief");
    // The report lands in its own .domain/reports — and the office sees it.
    mkdirSync(join(workdir, ".domain", "reports"), { recursive: true });
    writeFileSync(join(workdir, ".domain", "reports", "desk-1.json"), JSON.stringify({ title: "Done", summary: "Added the form", slides: ["Form"], at: Date.now() }));
    let report = null;
    for (let i = 0; i < 40 && !report; i++) {
      await new Promise((r) => setTimeout(r, 150));
      report = office.snapshot().desks.find((d) => d.id === "desk-1")?.worker?.report ?? null;
    }
    assert.equal(report?.title, "Done");
    assert.equal(git(workdir, "status", "--porcelain"), "", "and none of it shows up as a change to commit");
  } finally {
    process.env.PATH = path;
    office.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("closing the office remembers the team; reopened, they're asleep at their desks until woken", async () => {
  const { launchCommand } = await import("../src/server/workerSession.ts");
  assert.equal(launchCommand("claude", "", "ask", [], true), "claude --continue");
  assert.equal(launchCommand("codex", "", "auto", [], true), "codex resume --last --sandbox workspace-write --ask-for-approval on-request");
  assert.equal(launchCommand("gemini", "", "ask", [], true), "gemini --resume latest");
  assert.equal(launchCommand("opencode", "", "ask", [], true), "opencode --continue");

  const dir = mkdtempSync(join(tmpdir(), "domain-sleep-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "app.txt"), "hi\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  const path = process.env.PATH;
  const gitDir = execFileSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" })
    .split(/\r?\n/)[0]
    .replace(/[\\/][^\\/]+$/, "");
  process.env.PATH = [gitDir, process.platform === "win32" ? `${process.env.SystemRoot}\\System32` : "/usr/bin:/bin"].join(process.platform === "win32" ? ";" : ":");
  const memory = join(dir, ".domain", "office.json");
  const first = new Office({ cwd: dir, simulate: false, memory });
  let second: Office | null = null;
  try {
    first.hire("desk-2", "codex", "Ann", "gpt-5", "auto", true, { characterId: "ada", name: "Ada", look: undefined as never, voice: "" });
    const folder = first.workdir("desk-2");
    await new Promise((r) => setTimeout(r, 700));
    first.dispose();

    second = new Office({ cwd: dir, simulate: false, memory });
    const w = second.snapshot().desks.find((d) => d.id === "desk-2")!.worker!;
    assert.equal(w.status, "asleep");
    assert.equal(w.identity?.name, "Ada", "the same character");
    assert.equal(w.model, "gpt-5");
    assert.equal(second.workdir("desk-2"), folder, "its own folder (and branch) kept");
    assert.equal(second.sleeping, 1);
    assert.equal(second.wake(), 1, "the gong wakes it");
    assert.notEqual(second.snapshot().desks.find((d) => d.id === "desk-2")!.worker!.status, "asleep");
    assert.equal(second.sleeping, 0);
  } finally {
    process.env.PATH = path;
    second?.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
