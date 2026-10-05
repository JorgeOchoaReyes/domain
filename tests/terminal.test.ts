import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Office } from "../src/server/office.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
const until = async (what: string, ok: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

/**
 * A fake "claude" on the PATH, run by the office in a real terminal: what's
 * typed while it shows a permission menu must wait for the answer (it could
 * pick an option), the menu shows as "needs you", and quitting is noticed.
 */
test("a worker's terminal: questions show as needing you, nothing is typed into them, and quitting is noticed", { timeout: 90_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-term-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "app.txt"), "hi\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  const bin = mkdtempSync(join(tmpdir(), "domain-bin-"));
  const agent = resolve("tests/fixtures/fake-agent.mjs");
  if (process.platform === "win32") writeFileSync(join(bin, "claude.cmd"), `@"${process.execPath}" "${agent}" %*\r\n`);
  else {
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${agent}" "$@"\n`);
    chmodSync(join(bin, "claude"), 0o755);
  }
  const path = process.env.PATH;
  process.env.PATH = `${bin}${process.platform === "win32" ? ";" : ":"}${path}`;
  const office = new Office({ cwd: dir, simulate: false });
  const worker = () => office.snapshot().desks.find((d) => d.id === "desk-1")!.worker!;
  try {
    assert.ok(office.hire("desk-1", "claude", "Ann", "", "ask", true));
    const typed = () => {
      const f = join(office.workdir("desk-1"), "typed.log");
      return existsSync(f) ? readFileSync(f, "utf8") : "";
    };
    await until("the agent is up", () => /ready/i.test(worker().activity) || worker().status === "idle");

    // It asks something: that's "needs you".
    office.say("desk-1", "Please ASK me first", "chat");
    await until("needs you", () => worker().status === "waiting");

    // A message now waits — typed into the menu, it could answer it.
    office.say("desk-1", "hello while you wait", "chat");
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(!typed().includes("hello while you wait"), "held while it's asking");
    assert.ok(!typed().includes("TYPED INTO MENU"), "nothing typed into the menu");

    // You answer: the question's gone, and the message goes through.
    office.input("desk-1", "\r");
    await until("back to work", () => worker().status !== "waiting");
    await until("the held message arrives", () => typed().includes("hello while you wait"));
    assert.ok(!typed().includes("TYPED INTO MENU"));
    assert.ok(!/asking you something/.test(worker().activity), "the desk doesn't still say it's asking");
    // What it's told names its own files outright (a long-lived helper process can hold stale variables).
    assert.ok(!typed().includes("$DOMAIN_"), "no variables in what's typed");
    assert.ok(typed().includes(join(".domain", "replies", "desk-1.json")), "its reply file, in full");

    // It quits: the desk says so, and nothing more is typed into the bare shell.
    office.say("desk-1", "QUIT now", "chat");
    await until("it noticed the agent quit", () => worker().status === "done", 30_000);
    assert.match(worker().activity, /quit/);
    assert.equal(office.isStaffed("desk-1"), false, "a quit worker isn't handed work");
  } finally {
    process.env.PATH = path;
    office.dispose();
    try {
      rmSync(dir, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    } catch {
      /* Windows may still hold a file */
    }
  }
});
