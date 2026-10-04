import { spawn } from "node:child_process";
import type { CheckResult } from "../shared/protocol.js";

/**
 * The gate before a review: your check command (`"check"` in
 * domain.config.json, e.g. `npm test`) run in the worker's own folder when it
 * presents finished work. Only the configured command ever runs. The result —
 * pass or fail, how long it took, the end of its output — rides along with
 * the presentation.
 */

const TAIL = 4000;
const TIMEOUT_MS = 10 * 60_000;

export function runCheck(command: string, cwd: string, done: (r: CheckResult) => void): () => void {
  const started = Date.now();
  let out = "";
  let finished = false;
  const child = spawn(command, { cwd, shell: true, windowsHide: true, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
  const keep = (b: Buffer) => {
    out = (out + b.toString("utf8")).slice(-TAIL * 2);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const finish = (exitCode: number | null, note = "") => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    done({
      status: exitCode === 0 ? "pass" : "fail",
      command,
      exitCode,
      ms: Date.now() - started,
      tail: (out + note).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").slice(-TAIL),
    });
  };
  const timer = setTimeout(() => {
    child.kill();
    finish(null, `\n[timed out after ${TIMEOUT_MS / 60000} minutes]`);
  }, TIMEOUT_MS);
  timer.unref?.();
  child.on("error", (e) => finish(null, `\n${e.message}`));
  child.on("close", (code) => finish(code));
  return () => {
    if (!finished) child.kill();
  };
}

/** A pretend check for simulate mode: usually passes, now and then fails so the fix loop shows. */
export function simulateCheck(done: (r: CheckResult) => void, failChance = 0.3): void {
  const fail = Math.random() < failChance;
  setTimeout(() => {
    done({
      status: fail ? "fail" : "pass",
      command: "npm test (simulated)",
      exitCode: fail ? 1 : 0,
      ms: 1800,
      tail: fail
        ? "FAIL  tests/login.test.ts\n  ✕ rejects a wrong password (12 ms)\n    Expected: 401\n    Received: 500\n\nTests: 1 failed, 23 passed, 24 total"
        : "PASS  tests/login.test.ts\nTests: 24 passed, 24 total",
    });
  }, 1800).unref?.();
}
