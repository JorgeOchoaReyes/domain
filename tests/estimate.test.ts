import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Progress } from "../src/server/progress.ts";
import {
  BASE_MINUTES,
  costLabel,
  estimateAccuracy,
  estimateLabel,
  estimateTask,
  firstGuess,
  hourlyRate,
  isLocalModel,
  remainingLabel,
  sampleOf,
  taskEstimateLine,
  estimateSize,
  tookLabel,
  type EstimateSample,
} from "../src/shared/estimate.ts";
import { estimateText } from "../src/cli/nou.ts";
import { DEFAULT_POLICY, coerceBrief } from "../src/shared/policy.ts";

test("a task's size comes from its words, notes and terms", () => {
  assert.equal(estimateSize({ title: "Fix the typo in the README" }), "small");
  assert.equal(estimateSize({ title: "Add a settings page with dark mode" }), "medium");
  assert.equal(estimateSize({ title: "Refactor the auth system to use sessions" }), "large");
  // Long notes, files to read and a long definition of done make it bigger.
  assert.equal(estimateSize({ title: "Add a settings page with dark mode", notes: "x ".repeat(150), files: 2 }), "large");
});

test("the first guess grows with plan first, an audit, and a local model", () => {
  const plain = firstGuess({ title: "Add a settings page with dark mode" });
  assert.equal(plain, BASE_MINUTES.medium);
  assert.ok(firstGuess({ title: "Add a settings page with dark mode", planFirst: true }) > plain);
  assert.ok(firstGuess({ title: "Add a settings page with dark mode", audited: true }) > plain);
  assert.ok(firstGuess({ title: "Add a settings page with dark mode", model: "ollama/qwen3-coder" }) > plain);
});

test("local models are free; cloud ones cost by the model", () => {
  assert.ok(isLocalModel("ollama/qwen3-coder"));
  assert.ok(isLocalModel("lmstudio/devstral"));
  assert.ok(!isLocalModel("opus"));
  assert.equal(hourlyRate("claude", "ollama/qwen3-coder"), 0);
  assert.ok(hourlyRate("claude", "opus") > hourlyRate("claude", "sonnet"));
  assert.ok(hourlyRate("claude", "sonnet") > hourlyRate("claude", "haiku"));
  assert.ok(hourlyRate("codex", "") > 0, "the CLI's default model has a rate too");

  const local = estimateTask({ title: "Add a settings page", agent: "codex", model: "ollama/qwen3-coder" });
  assert.equal(local.local, true);
  assert.equal(local.cost, 0);
  assert.ok(local.cloudCost > 0, "it says what it would have cost on cloud");
  assert.match(estimateLabel(local), /free, local/);

  const cloud = estimateTask({ title: "Add a settings page", agent: "claude", model: "opus" });
  assert.equal(cloud.local, false);
  assert.ok(cloud.cost > 0);
  assert.match(estimateLabel(cloud), /^~\d+ min \(\d+–\d+\) · ≈ \$\d+\.\d\d$/);
  assert.ok(cloud.low <= cloud.minutes && cloud.minutes <= cloud.high);
  assert.equal(cloud.history, 0);
});

test("estimates learn from how long similar tasks really took", () => {
  const title = "Add a settings page with dark mode";
  const before = estimateTask({ title, agent: "claude", model: "sonnet" });
  // This team took about twice the guess on settings pages, three times.
  const samples: EstimateSample[] = [1, 2, 3].map((n) => sampleOf({ title: `Add a settings page for ${["billing", "profile", "teams"][n - 1]}`, agent: "claude", model: "sonnet" }, 25, 50, n));
  const after = estimateTask({ title, agent: "claude", model: "sonnet" }, samples);
  assert.ok(after.minutes > before.minutes, `${after.minutes} > ${before.minutes}`);
  assert.ok(after.minutes < 50, "the first guess still counts, so a few tasks don't swing it all the way");
  assert.equal(after.history, 3);
  assert.equal(after.similar, 3);

  // Many consistent tasks: it gets close, and surer (a narrower range).
  const many = Array.from({ length: 30 }, (_, n) => sampleOf({ title: `Add a settings page ${n}`, agent: "claude", model: "sonnet" }, 25, 50, n));
  const learned = estimateTask({ title, agent: "claude", model: "sonnet" }, many);
  assert.ok(learned.minutes >= 40 && learned.minutes <= 50, String(learned.minutes));
  assert.ok(learned.high / learned.low < after.high / after.low, "more history, a narrower range");

  // Unrelated quick tasks pull it less than similar ones would.
  const unrelated = Array.from({ length: 3 }, (_, n) => sampleOf({ title: `Rename variable ${n} in the parser`, agent: "codex", model: "" }, 10, 2, n));
  const pulled = estimateTask({ title, agent: "claude", model: "sonnet" }, unrelated);
  assert.ok(pulled.minutes < before.minutes);
  assert.equal(pulled.similar, 0);
  assert.match(taskEstimateLine({ title, status: "todo" }, samples), /on cloud, or .* free on a local model/);
});

test("labels: cost, what it took, and how good the estimates have been", () => {
  assert.equal(costLabel(0), "free");
  assert.equal(costLabel(0.04), "<$0.10");
  assert.equal(costLabel(1.9), "$1.90");
  assert.equal(costLabel(12.4), "$12");
  const est = estimateTask({ title: "Add a settings page", agent: "claude", model: "sonnet" });
  assert.match(tookLabel({ minutes: 31, cost: 2 }, { ...est, minutes: 25 }), /^took 31 min · \$2\.00 · est ~25 min \(\+24%\)$/);
  assert.match(remainingLabel([{ title: "A", status: "todo" }, { title: "B", status: "done" }]), /^~\d+ min of work left · ≈ \$/);
  assert.equal(remainingLabel([{ title: "B", status: "done" }]), "");

  assert.equal(estimateAccuracy([]).n, 0);
  const s = (est: number, minutes: number, at: number): EstimateSample => ({ ...sampleOf({ title: "x" }, est, minutes, at) });
  const acc = estimateAccuracy([s(10, 30, 1), s(10, 30, 2), s(10, 30, 3), s(30, 33, 4), s(30, 30, 5), s(30, 27, 6)]);
  assert.equal(acc.n, 6);
  assert.ok(acc.before !== null && acc.before > acc.typicalOff, "the older half was further off");
});

test("a finished task is checked against its estimate, and the next estimate learns from it", () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-est-"));
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    const file = join(dir, "progress.json");
    const p = new Progress(file);
    const goal = p.createGoal("Ann", "Settings", "", ["Add a settings page with dark mode", "Add a settings page for billing"])!;
    const [a, b] = goal.tasks;
    const brief = coerceBrief({ model: "sonnet" }, DEFAULT_POLICY);
    assert.ok(p.assign("Ann", goal.id, a.id, "desk-1", brief, { agent: "claude", model: "opus" }));
    const est = p.snapshot().goals[0].tasks[0].estimate!;
    assert.ok(est.minutes > 0);
    assert.equal(est.model, "sonnet", "the task's own model wins over the worker's");
    assert.equal(est.agent, "claude");

    // It presents after 60 minutes; you review it 30 minutes later (that wait doesn't count).
    mock.timers.tick(60 * 60_000);
    p.reported("desk-1");
    mock.timers.tick(30 * 60_000);
    p.reviewed("Ann", "desk-1", true);
    const done = p.snapshot().goals[0].tasks[0];
    assert.equal(done.status, "done");
    assert.equal(done.took?.minutes, 60);
    assert.ok(done.took!.cost > 0);
    assert.equal(p.estimates.length, 1);
    assert.equal(p.estimates[0].est, est.minutes);

    // The next, similar task is estimated longer: this team took longer than guessed.
    p.assign("Ann", goal.id, b.id, "desk-1", brief, { agent: "claude", model: "opus" });
    const next = p.snapshot().goals[0].tasks[1].estimate!;
    const fresh = estimateTask({ title: b.title, agent: "claude", model: "sonnet", done: brief.done.length });
    assert.ok(next.minutes > fresh.minutes, `${next.minutes} > ${fresh.minutes}`);
    assert.equal(next.history, 1);

    // Ticked off by hand while being done: it took until now.
    mock.timers.tick(20 * 60_000);
    p.setDone("Ann", goal.id, b.id, true);
    assert.equal(p.snapshot().goals[0].tasks[1].took?.minutes, 20);

    // A task ticked off without ever going out teaches nothing.
    p.addTask(goal.id, "Write the docs");
    const docs = p.snapshot().goals[0].tasks.find((t) => t.title === "Write the docs")!;
    p.setDone("Ann", goal.id, docs.id, true);
    assert.equal(p.estimates.length, 2);

    // Kept with your progress.
    p.dispose();
    const again = new Progress(file);
    assert.equal(again.estimates.length, 2);
    assert.equal(again.snapshot().estimates?.length, 2);
    assert.match(estimateText(again.snapshot(), "Add a settings page for teams"), /on a cloud model[\s\S]*on a local model[\s\S]*Lately[\s\S]*took 1 h/);
  } finally {
    mock.timers.reset();
    rmSync(dir, { recursive: true, force: true });
  }
});
