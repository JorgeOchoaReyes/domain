import { test } from "node:test";
import assert from "node:assert/strict";
import { Autopilot, type AutopilotDeps } from "../src/server/autopilot.ts";
import { DEFAULT_POLICY, GREEN_MAX_LINES, coercePolicy, type TeamPolicy } from "../src/shared/policy.ts";
import type { Desk, Presentation } from "../src/shared/protocol.ts";
import type { Goal } from "../src/shared/progress.ts";
import { draftPrompt, eodRecap, parseDraft, simpleDraft, spreadTasks } from "../src/shared/standupDraft.ts";
import { draftStandup } from "../src/server/standupVoice.ts";
import { pickVolunteer } from "../src/shared/chat.ts";

const worker = (status = "idle") => ({ agent: "claude", status, activity: "", report: null, model: "", leash: "auto" });
const desk = (id: string, w: object | null) => ({ id, label: id, worker: w }) as unknown as Desk;
const goal = (id: string, tasks: string[]) =>
  ({ id, title: id, tasks: tasks.map((t) => ({ id: t, title: t, status: "todo", deskId: null })), createdAt: 1, dueAt: null, shippedAt: null, doneAt: null, planningDesk: null, group: null }) as unknown as Goal;

function setup(o: { on?: boolean; keepBusy?: boolean; approveGreen?: boolean; sessionGoal?: string | null; desks?: Desk[]; goals?: Goal[]; line?: Presentation[]; diff?: Record<string, number | null> }) {
  const log: string[] = [];
  const policy: TeamPolicy = { ...DEFAULT_POLICY, autopilot: { ...DEFAULT_POLICY.autopilot, on: o.on ?? false, eodAt: "", keepBusy: o.keepBusy ?? true, approveGreen: o.approveGreen ?? false } };
  const goals = o.goals ?? [];
  const deps: AutopilotDeps = {
    policy: () => policy,
    goals: () => goals,
    desks: () => o.desks ?? [],
    line: () => o.line ?? [],
    isAuditing: () => false,
    assign: (g, t, d) => {
      log.push(`assign ${t} → ${d}`);
      Object.assign(goals.find((x) => x.id === g)!.tasks.find((x) => x.id === t)!, { deskId: d, status: "doing" });
    },
    plan: (g, d) => log.push(`plan ${g} → ${d}`),
    approve: (d) => log.push(`approve ${d}`),
    addTask: () => null,
    hire: () => false,
    fire: () => {},
    requests: () => [],
    internDesks: () => [],
    eod: () => {},
    note: () => {},
    sessionGoal: () => o.sessionGoal ?? null,
    diffLines: (d) => o.diff?.[d] ?? null,
  };
  return { ap: new Autopilot(deps), log };
}

test("with autopilot off, free workers still pick up the stand-up goal's tasks — and only that goal's", () => {
  const { ap, log } = setup({ sessionGoal: "today", desks: [desk("desk-1", worker()), desk("desk-2", worker())], goals: [goal("other", ["x"]), goal("today", ["a", "b"])] });
  ap.tick();
  assert.deepEqual(log, ["assign a → desk-1", "assign b → desk-2"]);
  const off = setup({ keepBusy: false, sessionGoal: "today", desks: [desk("desk-1", worker())], goals: [goal("today", ["a"])] });
  off.ap.tick();
  assert.deepEqual(off.log, []);
  const noSession = setup({ desks: [desk("desk-1", worker())], goals: [goal("today", ["a"])] });
  noSession.ap.tick();
  assert.deepEqual(noSession.log, []);
});

test("starting the day hands the goal's tasks out at once, and says how many went", () => {
  const { ap, log } = setup({ desks: [desk("desk-1", worker()), desk("desk-2", worker("working"))], goals: [goal("today", ["a", "b"])] });
  assert.equal(ap.dispatch("today"), 1);
  assert.deepEqual(log, ["assign a → desk-1"]);
});

test("approve on green: small work whose checks passed merges; big, failing, unchecked or unknown waits for you", () => {
  const rep = (check?: string) => ({ status: "ready", title: "T", summary: "", slides: [], at: 1, ...(check ? { check: { status: check } } : {}) });
  const line = [
    { deskId: "desk-1", report: rep("pass") },
    { deskId: "desk-2", report: rep("pass") },
    { deskId: "desk-3", report: rep("fail") },
    { deskId: "desk-4", report: rep() },
    { deskId: "desk-5", report: rep("pass") },
  ] as unknown as Presentation[];
  const diff = { "desk-1": 40, "desk-2": GREEN_MAX_LINES + 1, "desk-3": 5, "desk-4": 5, "desk-5": null };
  const { ap, log } = setup({ approveGreen: true, line, diff });
  ap.tick();
  assert.deepEqual(log, ["approve desk-1"]);
  const off = setup({ approveGreen: false, line, diff });
  off.ap.tick();
  assert.deepEqual(off.log, []);
});

test("a policy without the new settings gets safe defaults: keep busy on, approve on green off, no starting team", () => {
  const p = coercePolicy({ autopilot: { on: true } });
  assert.equal(p.autopilot.keepBusy, true);
  assert.equal(p.autopilot.approveGreen, false);
  assert.deepEqual(p.startTeam, { agent: "claude", count: 0 });
  assert.deepEqual(coercePolicy({ startTeam: { agent: "codex", count: 99 } }).startTeam, { agent: "codex", count: 8 });
  assert.deepEqual(coercePolicy({ startTeam: { agent: "nope", count: -2 } }).startTeam, { agent: "claude", count: 0 });
});

test("a spoken stand-up becomes tasks, end-of-day goals, a tone and a length — without any model", () => {
  const d = simpleDraft("Okay so today I want to add a dark mode toggle, and fix the login bug. Then write tests for checkout. By end of day the PR should be open. About three hours.");
  assert.deepEqual(d.goal.tasks, ["Add a dark mode toggle", "Fix the login bug", "Write tests for checkout"]);
  assert.deepEqual(d.eod, ["The PR should be open"]);
  assert.equal(d.summary, "Today's plan: add a dark mode toggle, fix the login bug and write tests for checkout. By end of day: the PR should be open.");
  assert.equal(d.tone, "bughunt");
  assert.equal(d.minutes, 180);
  assert.match(d.summary, /dark mode/);
});

test("the model's plan is read even with prose round it, and a bad answer is no plan", () => {
  const out = 'Here you go:\n```json\n{"summary":"Big day.","eod":["PR open"],"goal":{"title":"Dark mode","why":"users asked","kind":"build","tasks":["Add toggle","Persist choice"]},"tone":"ship","minutes":170,"intention":"Dark mode live"}\n```';
  const d = parseDraft(out, "dark mode today")!;
  assert.equal(d.goal.title, "Dark mode");
  assert.deepEqual(d.goal.tasks, ["Add toggle", "Persist choice"]);
  assert.equal(d.minutes, 180, "the nearest length offered");
  assert.equal(d.tone, "ship");
  assert.equal(parseDraft("I can't help with that", "x"), null);
  assert.equal(parseDraft('{"summary":"hi"}', "x"), null);
});

test("no Claude Code (or a broken answer): the stand-up still gets a plan, from your sentences", async () => {
  const failed = await draftStandup("Fix the login bug and add tests", [], { run: () => Promise.reject(new Error("not installed")) });
  assert.equal(failed.via, "simple");
  assert.ok(failed.draft.goal.tasks.length >= 1);
  const ok = await draftStandup("dark mode", [], { run: async () => '{"summary":"s","eod":["e"],"goal":{"title":"Dark mode","tasks":["Add toggle"]},"tone":"focus","minutes":60,"intention":"i"}' });
  assert.equal(ok.via, "claude");
  assert.equal(ok.draft.goal.title, "Dark mode");
});

test("the end-of-day recap says what's done, what carries over, and the goals you set", () => {
  const r = eodRecap(["PR open"], ["Add toggle"], ["Persist choice"]);
  assert.match(r, /Done today: Add toggle/);
  assert.match(r, /carried to tomorrow: Persist choice/);
  assert.match(r, /end-of-day goals were: PR open/);
});

const team = [
  { deskId: "desk-1", name: "Ada", agent: "Claude Code", model: "opus", status: "idle", doing: "", persona: "Frontend and UI polish", done: [] },
  { deskId: "desk-2", name: "Grace", agent: "Codex", model: "", status: "working", doing: "Refactor auth", persona: "", done: ["Fix session expiry"] },
  { deskId: "desk-3", name: "Linus", agent: "Gemini CLI", model: "", status: "idle", doing: "", persona: "", done: [] },
];

test("Claude's plan says who takes each task — only people on the team, with why", () => {
  const out = JSON.stringify({
    summary: "Ada builds dark mode, Grace fixes login after auth.",
    eod: ["PR open"],
    goal: {
      title: "Dark mode and login",
      tasks: [
        { title: "Add dark mode toggle", assignee: "desk-1", why: "UI is her thing" },
        { title: "Fix login bug", assignee: "desk-2", why: "knows auth" },
        { title: "Write docs", assignee: "desk-99", why: "nobody" },
        "Tidy up",
      ],
    },
    tone: "ship",
    minutes: 120,
    intention: "x",
  });
  const d = parseDraft(out, "dark mode and login", team)!;
  assert.deepEqual(d.goal.tasks, ["Add dark mode toggle", "Fix login bug", "Write docs", "Tidy up"]);
  assert.deepEqual(
    d.assign.map((a) => [a.deskId, a.why]),
    [
      ["desk-1", "UI is her thing"],
      ["desk-2", "knows auth"],
      [null, ""],
      [null, ""],
    ],
  );
});

test("the planner is told who's on the team, what they're on and what they're for", () => {
  const p = draftPrompt("dark mode", [], team);
  assert.match(p, /"id":"desk-1"/);
  assert.match(p, /"busyWith":"Refactor auth"/);
  assert.match(p, /"role":"Frontend and UI polish"/);
  assert.match(p, /"recentlyDid":\["Fix session expiry"\]/);
  assert.match(draftPrompt("x", [], []), /every assignee is null/);
});

test("without a model, tasks spread over whoever's free first, then the busy ones", () => {
  const s = spreadTasks(["A", "B", "C", "D"], team);
  assert.deepEqual(s.map((x) => x.deskId), ["desk-1", "desk-3", "desk-2", "desk-1"]);
  assert.equal(s[0].why, "free now");
  assert.match(s[2].why, /after “Refactor auth”/);
  assert.deepEqual(spreadTasks(["A"], []), [{ task: "A", deskId: null, why: "" }]);
});

test("a task saved for someone waits for them; the rest go to whoever's free", () => {
  const g = goal("today", ["a", "b", "c"]);
  g.tasks[0].for = "desk-2"; // busy: waits
  g.tasks[1].for = "desk-3"; // free: goes now
  const { ap, log } = setup({ sessionGoal: "today", desks: [desk("desk-1", worker()), desk("desk-2", worker("working")), desk("desk-3", worker())], goals: [g] });
  ap.tick();
  assert.deepEqual(log, ["assign b → desk-3", "assign c → desk-1"]);
  // Saved for someone who's gone: anyone can have it.
  const g2 = goal("today", ["a"]);
  g2.tasks[0].for = "desk-9";
  const gone = setup({ sessionGoal: "today", desks: [desk("desk-1", worker())], goals: [g2] });
  gone.ap.tick();
  assert.deepEqual(gone.log, ["assign a → desk-1"]);
});

test("who offers to take a task: someone free, else the one closest to done, never someone asleep or already asked", () => {
  const ds = [
    { id: "desk-1", worker: { status: "working" } },
    { id: "desk-2", worker: { status: "presenting" } },
    { id: "desk-3", worker: { status: "asleep" } },
    { id: "desk-4", worker: { status: "idle" } },
  ];
  const on = new Map([["desk-1", "Refactor auth"], ["desk-2", "Dark mode"]]);
  assert.deepEqual(pickVolunteer(ds, on), { deskId: "desk-4", free: true, after: "what it's on" });
  assert.deepEqual(pickVolunteer(ds, on, ["desk-4"]), { deskId: "desk-2", free: false, after: "Dark mode" });
  assert.deepEqual(pickVolunteer(ds, on, ["desk-4", "desk-2"])?.deskId, "desk-1");
  assert.equal(pickVolunteer(ds, on, ["desk-4", "desk-2", "desk-1"]), null);
});

test("a task someone's offered to take waits for your answer: nobody else grabs it", () => {
  const g = goal("today", ["a", "b"]);
  g.tasks[0].offered = "desk-2";
  const { ap, log } = setup({ sessionGoal: "today", desks: [desk("desk-1", worker())], goals: [g] });
  ap.tick();
  assert.deepEqual(log, ["assign b → desk-1"]);
});
