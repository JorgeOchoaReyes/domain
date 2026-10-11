import { test } from "node:test";
import assert from "node:assert/strict";
import { fitsModel, localFor, modelChoices, suggestLocal, taskSize } from "../src/shared/localModels.ts";
import { modelLabel } from "../src/shared/policy.ts";

const LOCAL = ["ollama/qwen3:8b", "lmstudio/gemma-3"];

test("which local models each agent can run", () => {
  assert.deepEqual(localFor("codex", LOCAL), LOCAL);
  assert.deepEqual(localFor("claude", LOCAL), ["ollama/qwen3:8b"]);
  assert.deepEqual(localFor("gemini", LOCAL), []);
});

test("model pickers list the ones on this computer first", () => {
  assert.deepEqual(modelChoices("codex", ["", "gpt-5"], LOCAL), ["ollama/qwen3:8b", "lmstudio/gemma-3", "", "gpt-5"]);
  assert.deepEqual(modelChoices("claude", ["opus"], LOCAL, ["sonnet"]), ["ollama/qwen3:8b", "", "opus", "sonnet"]);
  assert.equal(modelLabel("ollama/qwen3:8b"), "🖥 qwen3:8b");
  assert.equal(modelLabel(""), "CLI default");
});

test("how big a task looks", () => {
  assert.equal(taskSize("Fix the typo in the README"), "small");
  assert.equal(taskSize("Migrate auth to the new database"), "large");
  assert.equal(taskSize("Add a dark mode toggle"), "medium");
  assert.equal(taskSize("Add a dark mode toggle", 15), "small");
  assert.equal(taskSize("Fix the typo", 90), "large");
  assert.equal(taskSize("Rename the button label", 0, "and refactor every page that uses it"), "large");
});

test("a small task headed for the cloud gets a local suggestion; a big one doesn't fit a local model", () => {
  assert.equal(suggestLocal("codex", "gpt-5", "small", LOCAL), "ollama/qwen3:8b");
  assert.equal(suggestLocal("codex", "gpt-5", "medium", LOCAL), null);
  assert.equal(suggestLocal("codex", "ollama/qwen3:8b", "small", LOCAL), null);
  assert.equal(suggestLocal("gemini", "", "small", LOCAL), null);
  assert.equal(fitsModel("ollama/qwen3:8b", "large"), false);
  assert.equal(fitsModel("gpt-5", "large"), true);
});
