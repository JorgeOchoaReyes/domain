import { test } from "node:test";
import assert from "node:assert/strict";
import { ToastGate, toastKey, toastMs } from "../src/shared/toasts.ts";

test("the same toast again, while it's up, is merged into it with a count", () => {
  const g = new ToastGate();
  assert.equal(g.decide("🔴 Bolt needs you", "warn", 0).action, "show");
  const again = g.decide("🔴 Bolt needs you", "warn", 1000);
  assert.deepEqual([again.action, again.count], ["merge", 2]);
  assert.equal(g.decide("🔴 Bolt needs you", "warn", 2000).count, 3);
  // Numbers, case and spacing don't make it different.
  assert.equal(g.decide("🔴  bolt NEEDS you", "warn", 2500).action, "merge");
  assert.equal(toastKey("Lap: 12.5 s · best 11.2 s"), toastKey("Lap: 13.1 s · best 11.2 s"));
  // Once it's gone (or after the window), it's a new toast.
  assert.equal(g.decide("🔴 Bolt needs you", "warn", 60_000).action, "show");
});

test("routine news never pops up", () => {
  const g = new ToastGate();
  assert.equal(g.decide("✅ Merged into main", "note", 0).action, "log");
  // …and doesn't count against the everyday burst.
  for (let i = 0; i < 3; i++) assert.equal(g.decide(`info ${"abc"[i]}`, "info", i).action, "show");
});

test("a burst of everyday toasts is capped; warnings and errors always get through", () => {
  const g = new ToastGate({ dedupeMs: 8000, burst: 3, burstMs: 10_000 });
  const shown = ["one", "two", "three", "four", "five"].map((t, i) => g.decide(`Everyday ${t}`, "info", i * 100).action);
  assert.deepEqual(shown, ["show", "show", "show", "log", "log"]);
  assert.equal(g.decide("Deploy failed", "error", 600).action, "show");
  assert.equal(g.decide("Checks failed", "warn", 700).action, "show");
  // The window moves on: everyday toasts show again.
  assert.equal(g.decide("Everyday six", "info", 11_000).action, "show");
});

test("toasts are short by default, longer for warnings, errors and long reads", () => {
  assert.equal(toastMs("info", "Swish!"), 2800);
  assert.ok(toastMs("warn", "x") > toastMs("info", "x"));
  assert.ok(toastMs("error", "x") > toastMs("warn", "x"));
  const long = Array.from({ length: 40 }, () => "word").join(" ");
  assert.equal(toastMs("info", long), 2800 + 2000);
  assert.equal(toastMs("info", long + " " + long + " " + long), 2800 + 3000, "capped");
});
