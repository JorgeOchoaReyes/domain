import { test } from "node:test";
import assert from "node:assert/strict";
import { troubleFrom } from "../src/shared/trouble.ts";
import { PtyWorker, ptyAvailable } from "../src/server/ptyWorker.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a stuck agent's screen says why, in its own words", () => {
  const kind = (...lines: string[]) => troubleFrom(["╭───────╮", ...lines, "", ">"])?.kind ?? null;
  assert.equal(kind("Invalid API key · Please run /login"), "signin");
  assert.equal(kind("  ⎿  API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\"}}"), "signin");
  assert.equal(kind("You're not logged in. Run `codex login` to continue."), "signin");
  assert.equal(kind("Select login method:"), "signin");
  assert.equal(kind("■ stream error: error sending request: getaddrinfo ENOTFOUND api.openai.com"), "offline");
  assert.equal(kind("  ⎿  API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}"), "error");
  assert.equal(kind("■ You've hit your usage limit reached for this period"), "error");
  assert.equal(kind("This version is no longer supported. Please upgrade to continue."), "update");
  // The CLI's own words, tidied.
  assert.deepEqual(troubleFrom(["│ Invalid API key · Please run /login │"]), { kind: "signin", detail: "Invalid API key · Please run /login" });
});

test("work that talks about errors isn't trouble; a retry in progress isn't either", () => {
  const none = (...lines: string[]) => assert.equal(troubleFrom(lines), null, lines.join(" / "));
  none("I added rate limiting to the login endpoint and tests for the 401 path.");
  none("Fixed the error handling in checkout.ts");
  none("  ⎿  API Error (529 overloaded_error) · Retrying in 5 seconds… (attempt 2/10)");
  none("All 42 tests pass.");
  // An old error scrolled well up the screen is no longer what it's saying.
  none("API Error: 529 overloaded_error", ...Array.from({ length: 14 }, (_, i) => `line ${i}`));
});

test("a real terminal: an agent that stops on an error needs you, with what it said", { skip: !ptyAvailable }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-trouble-"));
  const script = "console.log('x'.repeat(900)); console.log('API Error: 529 overloaded_error'); setInterval(() => {}, 1000)";
  const w = new PtyWorker("claude", {
    cwd: dir,
    launch: `node -e "${script}"`,
    missingLabel: null,
    deskId: "desk-1",
    reportsDir: dir,
    repliesDir: dir,
  });
  try {
    for (let i = 0; i < 40 && !w.trouble(); i++) await new Promise((r) => setTimeout(r, 250));
    assert.equal(w.trouble()?.kind, "error");
    assert.equal(w.getStatus(), "waiting");
    assert.match(w.getActivity(), /API Error: 529/);
  } finally {
    w.dispose();
  }
});
