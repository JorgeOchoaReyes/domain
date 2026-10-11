import { test } from "node:test";
import assert from "node:assert/strict";
import { Autopilot, FINAL_REVIEW, INTERN_IDLE_MS, type AutopilotDeps } from "../src/server/autopilot.ts";
import { DEFAULT_POLICY, type TeamPolicy } from "../src/shared/policy.ts";
import type { Desk, Presentation } from "../src/shared/protocol.ts";
import type { Goal } from "../src/shared/progress.ts";

const worker = (status = "idle", extra: object = {}) => ({ agent: "claude", status, activity: "", report: null, model: "", leash: "auto", ...extra });
const desk = (id: string, w: object | null) => ({ id, label: id, worker: w }) as unknown as Desk;
const goal = (id: string, tasks: { id: string; title: string; status?: string; deskId?: string | null }[], extra: object = {}) =>
  ({ id, title: id, tasks: tasks.map((t) => ({ status: "todo", deskId: null, ...t })), createdAt: 1, dueAt: null, shippedAt: null, doneAt: null, planningDesk: null, group: null, ...extra }) as unknown as Goal;

function setup(over: Partial<{ desks: Desk[]; goals: Goal[]; line: Presentation[]; on: boolean; requests: { deskId: string; pieces: string[] }[]; now: number }> = {}) {
  const log: string[] = [];
  const state = { desks: over.desks ?? [], goals: over.goals ?? [], line: over.line ?? [], requests: over.requests ?? [], now: over.now ?? Date.now() };
  const policy: TeamPolicy = { ...DEFAULT_POLICY, autopilot: { ...DEFAULT_POLICY.autopilot, on: over.on ?? true, eodAt: "" } };
  let n = 0;
  const deps: AutopilotDeps = {
    policy: () => policy,
    goals: () => state.goals,
    desks: () => state.desks,
    line: () => state.line,
    isAuditing: () => false,
    assign: (g, t, d, b) => {
      log.push(`assign ${t} → ${d}${b.auditor ? ` (audit ${b.auditor})` : ""}`);
      const task = state.goals.find((x) => x.id === g)!.tasks.find((x) => x.id === t)!;
      Object.assign(task, { deskId: d, status: "doing" });
    },
    plan: (g, d) => log.push(`plan ${g} → ${d}`),
    approve: (d) => log.push(`approve ${d}`),
    addTask: (g, title) => {
      const id = `new${++n}`;
      state.goals.find((x) => x.id === g)!.tasks.push({ id, title, status: "todo", deskId: null } as never);
      return id;
    },
    hire: (d, _a, _m, _l, mentor) => {
      state.desks.push(desk(d, worker("working")));
      log.push(`hire ${d} for ${mentor}`);
      return true;
    },
    fire: (d) => {
      state.desks = state.desks.filter((x) => x.id !== d);
      log.push(`fire ${d}`);
    },
    requests: () => state.requests.splice(0),
    internDesks: () => ["desk-17", "desk-18", "desk-19"],
    eod: () => log.push("eod"),
    note: () => {},
    now: () => state.now,
  };
  return { ap: new Autopilot(deps), log, state, policy };
}

test("free workers get the next tasks, deadlines first, each with an auditor", () => {
  const { ap, log } = setup({
    desks: [desk("desk-1", worker()), desk("desk-2", worker())],
    goals: [goal("later", [{ id: "a", title: "A" }]), goal("soon", [{ id: "b", title: "B" }], { dueAt: Date.now() + 3600_000 })],
  });
  ap.tick();
  assert.deepEqual(log, ["assign b → desk-1 (audit desk-2)", "assign a → desk-2 (audit desk-1)"]);
});

test("a goal with no tasks is planned; autopilot off does nothing", () => {
  const off = setup({ on: false, desks: [desk("desk-1", worker())], goals: [goal("g", [])] });
  off.ap.tick();
  assert.deepEqual(off.log, []);
  const on = setup({ desks: [desk("desk-1", worker())], goals: [goal("g", [])] });
  on.ap.tick();
  assert.deepEqual(on.log, ["plan g → desk-1"]);
});

test("audited work that passed its check is approved without you; anything else waits for you", () => {
  const rep = (title: string, slides: string[], check = "pass") => ({ status: "ready", title, summary: "", slides, at: 1, check: { status: check } });
  const { ap, log } = setup({
    desks: [desk("desk-1", worker("presenting")), desk("desk-2", worker("presenting")), desk("desk-3", worker("presenting"))],
    line: [
      { deskId: "desk-1", report: rep("Login", ["🔍 Audited by Grace: approved after 1 round"]) },
      { deskId: "desk-2", report: rep("Signup", ["Done"]) },
      { deskId: "desk-3", report: rep("Export", ["🔍 Audited by Ada: approved after 2 rounds"], "fail") },
    ] as never,
  });
  ap.tick();
  assert.deepEqual(log, ["approve desk-1"]);
});

test("when every task is done, the lead pulls the goal together and presents the whole", () => {
  const { ap, log, state } = setup({
    desks: [desk("desk-1", worker()), desk("desk-2", worker())],
    goals: [goal("g", [{ id: "a", title: "A", status: "done" }, { id: "b", title: "B", status: "done" }], { group: ["desk-2", "desk-1"], doneAt: Date.now() })],
  });
  ap.tick();
  const final = state.goals[0].tasks.find((t) => t.title.startsWith(FINAL_REVIEW))!;
  assert.ok(final, "a final review task");
  assert.deepEqual(log, [`assign ${final.id} → desk-2 (audit desk-1)`]);
  ap.tick();
  assert.equal(state.goals[0].tasks.filter((t) => t.title.startsWith(FINAL_REVIEW)).length, 1, "only once");
});

test("interns: a worker asks, they're hired at the bay, it audits their work, and they go home when idle", () => {
  const { ap, log, state } = setup({
    desks: [desk("desk-1", worker("working"))],
    goals: [goal("g", [{ id: "a", title: "Big task", status: "doing", deskId: "desk-1" }])],
    requests: [{ deskId: "desk-1", pieces: ["Write the docs", "Add the tests"] }],
  });
  ap.tick();
  assert.deepEqual(log, ["hire desk-17 for desk-1", "assign new1 → desk-17 (audit desk-1)", "hire desk-18 for desk-1", "assign new2 → desk-18 (audit desk-1)"]);
  assert.equal(ap.interns.get("desk-17"), "desk-1");
  // Their work is done and they're idle: after a while, home.
  for (const t of state.goals[0].tasks) if (t.deskId !== "desk-1") t.status = "done";
  for (const d of state.desks) if (d.id !== "desk-1") (d.worker as { status: string }).status = "idle";
  ap.tick();
  state.now += INTERN_IDLE_MS + 1000;
  ap.tick();
  assert.ok(log.includes("fire desk-17") && log.includes("fire desk-18"));
});

test("the end-of-day sync runs once a day, after its time", () => {
  const morning = new Date();
  morning.setHours(9, 0, 0, 0);
  const s = setup({ desks: [desk("desk-1", worker("working"))], now: morning.getTime() });
  s.policy.autopilot.eodAt = "17:30";
  s.ap.tick();
  assert.ok(!s.log.includes("eod"));
  s.state.now = morning.getTime() + 9 * 3600_000;
  s.ap.tick();
  s.ap.tick();
  assert.equal(s.log.filter((l) => l === "eod").length, 1);
});

test("switched on late at night, the sync waits for tomorrow's time", () => {
  const late = new Date();
  late.setHours(23, 40, 0, 0);
  const s = setup({ desks: [desk("desk-1", worker("working"))], now: late.getTime() });
  s.policy.autopilot.eodAt = "17:30";
  s.ap.tick();
  assert.ok(!s.log.includes("eod"));
});

test("local models first: a small task goes to the worker on a local model; a big one waits for a cloud worker", () => {
  const { ap, log, state } = setup({
    desks: [desk("desk-1", worker("idle", { model: "ollama/qwen3:8b" })), desk("desk-2", worker("working"))],
    goals: [goal("g", [{ id: "big", title: "Migrate auth to the new database" }, { id: "typo", title: "Fix the typo in the README" }])],
  });
  ap.tick();
  // The big one skips the local model (desk-2 is on the cloud and busy); the small one takes it.
  assert.deepEqual(log, ["assign typo → desk-1 (audit desk-2)"]);
  // With the cloud worker free, the big one goes there.
  state.desks[1] = desk("desk-2", worker());
  state.desks[0] = desk("desk-1", worker("working", { model: "ollama/qwen3:8b" }));
  ap.tick();
  assert.match(log.at(-1)!, /^assign big → desk-2/);
});

test("a team of only local models still gets its big tasks", () => {
  const { ap, log } = setup({
    desks: [desk("desk-1", worker("idle", { model: "ollama/qwen3:8b" }))],
    goals: [goal("g", [{ id: "big", title: "Refactor the whole API" }])],
  });
  ap.tick();
  assert.deepEqual(log, ["assign big → desk-1"]);
});
