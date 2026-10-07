import { test } from "node:test";
import assert from "node:assert/strict";
import { launchCommand } from "../src/server/workerSession.ts";
import { Office, taskBriefText } from "../src/server/office.ts";
import { Progress } from "../src/server/progress.ts";
import { DEFAULT_POLICY, MAX_ATTACH, MAX_ATTACH_BYTES, coerceAttachments, coerceBrief, coercePolicy, isModelName } from "../src/shared/policy.ts";

test("workers launch on their model and leash, with only safe model names", () => {
  assert.equal(launchCommand("claude"), "claude");
  assert.equal(launchCommand("claude", "opus", "auto"), "claude --model opus --permission-mode acceptEdits");
  assert.equal(launchCommand("codex", "", "auto"), "codex --sandbox workspace-write --ask-for-approval on-request");
  assert.equal(launchCommand("gemini", "gemini-pro", "auto"), "gemini --model gemini-pro --approval-mode auto_edit");
  // Local models: Codex runs them through its open-source provider; OpenCode takes provider/model as is.
  assert.equal(launchCommand("codex", "ollama/qwen3.6:latest"), "codex --oss --local-provider ollama --model qwen3.6:latest --sandbox read-only --ask-for-approval on-request");
  assert.equal(launchCommand("codex", "lmstudio/llama-3"), "codex --oss --local-provider lmstudio --model llama-3 --sandbox read-only --ask-for-approval on-request");
  assert.equal(launchCommand("opencode", "ollama/llama3"), "opencode --model ollama/llama3");
  // Anything that could break out of the command line is dropped, not typed.
  assert.equal(launchCommand("claude", "opus; rm -rf /"), "claude");
  assert.equal(isModelName("anthropic/claude-sonnet:latest"), true);
  assert.equal(isModelName("$(whoami)"), false);
});

test("a task's brief falls back to the team's defaults and is clamped", () => {
  const b = coerceBrief({ minutes: 9999, model: "bad model!", done: ["  Ships  ", 3, ""] }, DEFAULT_POLICY);
  assert.equal(b.minutes, 240);
  assert.equal(b.model, "");
  assert.deepEqual(b.done, ["Ships"]);
  assert.equal(b.onTimeUp, DEFAULT_POLICY.onTimeUp);
  const none = coerceBrief({ minutes: 0 }, DEFAULT_POLICY);
  assert.equal(none.minutes, 0, "0 means no time limit");
  assert.deepEqual(none.done, DEFAULT_POLICY.done);
});

test("the team policy keeps only valid models and always offers the default", () => {
  const p = coercePolicy({ models: { codex: ["gpt-x", "no way"] }, defaultModel: { codex: "gpt-x" }, minutes: 20, leash: "auto" });
  assert.deepEqual(p.models.codex, ["", "gpt-x"]);
  assert.equal(p.defaultModel.codex, "gpt-x");
  assert.equal(p.minutes, 20);
  assert.equal(p.leash, "auto");
  assert.deepEqual(p.models.claude, DEFAULT_POLICY.models.claude, "untouched agents keep their defaults");
});

test("the task brief tells the worker what done means, its time, and to plan first", () => {
  const text = taskBriefText("Launch", "Add login", "users need it", {
    model: "",
    minutes: 30,
    onTimeUp: "wrapup",
    planFirst: true,
    done: ["Login works", "Tests pass"],
  });
  assert.match(text, /\(1\) Login works \(2\) Tests pass/);
  assert.match(text, /about 30 minutes/);
  assert.match(text, /status "plan"/);
  assert.doesNotMatch(taskBriefText("Launch", "Add login"), /Time budget|Plan first/);
});

test("a task's clock runs out once, and a plan review doesn't finish the task", () => {
  const p = new Progress(null);
  const goal = p.createGoal("Ann", "Launch", "", ["Add login"])!;
  const task = goal.tasks[0];
  const brief = coerceBrief({ minutes: 15, planFirst: true }, p.policy);
  p.assign("Ann", goal.id, task.id, "desk-1", brief);
  const t0 = p.snapshot().goals[0].tasks[0];
  assert.ok(t0.run?.deadline, "a 15-minute budget sets a deadline");
  assert.equal(t0.run?.planApproved, false);

  assert.equal(p.timeUps(t0.run!.deadline! - 1000).length, 0, "not yet");
  assert.equal(p.timeUps(t0.run!.deadline! + 1000).length, 1, "time's up");
  assert.equal(p.timeUps(t0.run!.deadline! + 5000).length, 0, "only once");

  // The worker presents its plan: approving it sends the task back to work, not to done.
  p.reported("desk-1");
  p.reviewed("Ann", "desk-1", true, true);
  const t1 = p.snapshot().goals[0].tasks[0];
  assert.equal(t1.status, "doing");
  assert.equal(t1.run?.planApproved, true);

  // Then the finished work is approved, and the task is done.
  p.reported("desk-1");
  p.reviewed("Ann", "desk-1", true);
  assert.equal(p.snapshot().goals[0].tasks[0].status, "done");
});

test("hiring on a model and leash, and switching models between tasks", () => {
  const office = new Office({ simulate: true });
  const deskId = office.snapshot().desks[0].id;
  assert.ok(office.hire(deskId, "claude", "Ann", "sonnet", "auto"));
  const w = office.snapshot().desks[0].worker!;
  assert.equal(w.model, "sonnet");
  assert.equal(w.leash, "auto");
  assert.equal(office.switchModel(deskId, "sonnet"), "same");
  assert.equal(office.switchModel(deskId, "opus"), "switched");
  assert.equal(office.snapshot().desks[0].worker!.model, "opus");
  office.dispose();
});

test("attached files: plain names that can't climb out, text only, capped", () => {
  const out = coerceAttachments([
    { name: "../../secrets/../notes.md", text: "hi" },
    { name: "notes.md", text: "again" },
    { name: "bin.dat", text: "a\u0000b" },
    { name: "", text: "no name" },
    { name: "big.txt", text: "x".repeat(MAX_ATTACH_BYTES + 1) },
    "nonsense",
  ]);
  assert.deepEqual(out.map((f) => f.name), ["notes.md", "2-notes.md", "note-3.txt"]);
  assert.equal(coerceAttachments(Array.from({ length: 20 }, (_, i) => ({ name: `f${i}.md`, text: "x" }))).length, MAX_ATTACH);
  assert.deepEqual(coerceBrief({ files: [{ name: "a.md", text: "A" }] }, DEFAULT_POLICY).files, [{ name: "a.md", text: "A" }]);
  assert.equal(coerceBrief({}, DEFAULT_POLICY).files, undefined);
});
