import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Progress } from "../src/server/progress.ts";
import { Huddles } from "../src/server/huddle.ts";
import { parsePlan } from "../src/server/loop.ts";
import { captureDemo, demoImage, demoPlan, findBrowser, loadDemoSettings, screenshotArgs, simDemo } from "../src/server/demo.ts";
import { allowed } from "../src/server/permissions.ts";
import { HUDDLE_MAX, coerceDemo, huddleClaims, huddleMarkdown, huddleSpot, matchTake, noteLine, parseHuddleNote, type HuddleNote, type HuddleState } from "../src/shared/huddle.ts";
import { STANDUP } from "../src/shared/layout.ts";
import { coerceGoal, type Goal } from "../src/shared/progress.ts";

// ---------------------------------------------------------------------------
// Notes and claims
// ---------------------------------------------------------------------------

test("a huddle note: concerns, suggestions and the task they'd take", () => {
  const n = parseHuddleNote("# My note\n- Concern: the login flow has no tests\n- **Risk:** migrations\nSuggest: ship behind a flag\n- also add a smoke test\nTake: 2\nTake: 3\n")!;
  assert.deepEqual(n.concerns, ["the login flow has no tests", "migrations"]);
  assert.deepEqual(n.suggestions, ["ship behind a flag", "also add a smoke test"]);
  assert.equal(n.take, "2", "the first Take counts");
  assert.equal(parseHuddleNote("Looks fine to me."), null, "prose alone says nothing");
  assert.match(noteLine(n), /⚠ the login flow has no tests · 💡 ship behind a flag · 🙋 I'll take 2/);
});

test("a Take: is a number or the words of a task", () => {
  const tasks = ["Build the login form", "Add tests for login", "Write the release notes"];
  assert.equal(matchTake("2", tasks), 1);
  assert.equal(matchTake("#3", tasks), 2);
  assert.equal(matchTake("task 1", tasks), 0);
  assert.equal(matchTake("9", tasks), null, "out of range");
  assert.equal(matchTake("the release notes", tasks), 2);
  assert.equal(matchTake("something else entirely", tasks), null);
});

test("claims follow a task through the revision, and each task goes to the first who asked", () => {
  const note = (deskId: string, take: string): HuddleNote => ({ deskId, name: deskId, concerns: [], suggestions: [], take, at: 0 });
  const draft = ["Sketch the approach", "Build the core flow", "Polish"];
  // The planner put a new task first: "2" in the draft is now the third.
  const final = ["Agree what done means", "Sketch the approach", "Build the core flow", "Polish"];
  assert.deepEqual(huddleClaims([note("desk-2", "2"), note("desk-3", "2"), note("desk-4", "polish")], draft, final), [
    { deskId: "desk-2", task: "Build the core flow" },
    { deskId: "desk-4", task: "Polish" },
  ]);
  const md = huddleMarkdown("Launch", draft, [{ ...note("desk-2", "2"), name: "Ada", concerns: ["no tests"], suggestions: ["add one"] }]);
  assert.match(md, /1\. Sketch the approach/);
  assert.match(md, /## Ada\n\n- Concern: no tests\n- Suggest: add one\n- Would take: 2/);
});

test("the huddle gathers round the stand-up circle, inside it", () => {
  for (let i = 0; i < HUDDLE_MAX + 1; i++) {
    const s = huddleSpot(i, HUDDLE_MAX + 1);
    assert.ok(Math.hypot(s.x - STANDUP.circle.x, s.z - STANDUP.circle.z) < STANDUP.circle.r);
  }
});

// ---------------------------------------------------------------------------
// The huddle, start to finish
// ---------------------------------------------------------------------------

function setup(opts: { gatherMs?: number; reviseMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "huddle-"));
  const p = new Progress(null);
  const goal = p.createGoal("Ann", "Launch the beta", "", [])!;
  p.planning("Ann", goal.id, "desk-1");
  const briefs: { deskId: string; text: string; done: () => void }[] = [];
  const landed: { tasks: string[]; claims: { deskId: string; task: string }[] }[] = [];
  const notes: string[] = [];
  const said: string[] = [];
  let now = 1000;
  const dir = (id: string) => {
    const d = join(root, id);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const huddles = new Huddles({
    office: {
      brief: (deskId, text, _activity, sim) => {
        briefs.push({ deskId, text, done: sim!.done });
        return deskId !== "desk-9";
      },
      nameOf: (d) => ({ "desk-1": "Ada", "desk-2": "Grace", "desk-3": "Linus" })[d] ?? d,
    },
    goal: (id) => p.getGoal(id),
    dir,
    planPath: (id) => join(dir(id), "plan.md"),
    set: (id, h) => p.setHuddle(id, h),
    landed: (id, tasks, claims) => {
      landed.push({ tasks, claims });
      p.addPlannedTasks(id, tasks);
    },
    note: (_id, text) => notes.push(text),
    said: (d, text) => said.push(`${d}: ${text}`),
    gatherMs: 60_000,
    reviseMs: 60_000,
    pollMs: 3_600_000,
    now: () => now,
    ...opts,
  });
  return { root, p, goal, huddles, briefs, landed, notes, said, tick: (ms = 0) => ((now += ms), huddles.tick()), plan: () => join(dir(goal.id), "plan.md") };
}

test("a huddle: the team weighs in on the draft, the planner revises it, and claimed tasks are saved for them", () => {
  const { p, goal, huddles, briefs, landed, notes, said, tick, plan } = setup();
  const draft = ["Sketch the approach", "Build the core flow", "Cover it with tests"];
  assert.equal(huddles.onPlan(goal.id, draft, ["desk-1", "desk-2", "desk-3"]), true, "the draft goes to a huddle");
  assert.equal(p.getGoal(goal.id)!.tasks.length, 0, "no tasks yet");
  const h = p.getGoal(goal.id)!.huddle!;
  assert.equal(h.status, "gathering");
  assert.deepEqual(h.deskIds, ["desk-2", "desk-3"], "everyone but the planner");
  assert.equal(h.plannerDesk, "desk-1");
  assert.match(briefs[0].text, /^\[Huddle\] Ada drafted the plan for "Launch the beta".*1\. Sketch the approach; 2\. Build the core flow/);
  assert.match(notes[0], /2 teammates weighing in/);

  // Grace writes her note where she was told; Linus is still thinking.
  const file = /write a short note to (\S+\.md)/.exec(briefs[0].text)![1];
  writeFileSync(file, "Concern: no tests for the edge cases\nSuggest: Agree what done means first\nTake: 2\n");
  tick();
  assert.equal(p.getGoal(goal.id)!.huddle!.notes.length, 1);
  assert.equal(p.getGoal(goal.id)!.huddle!.notes[0].name, "Grace");
  assert.match(said[0], /^desk-2: ⚠ no tests/);
  briefs[1].done(); // Linus is a simulated worker: his note is scripted.
  tick();
  assert.equal(p.getGoal(goal.id)!.huddle!.status, "revising", "everyone's in: the planner revises");
  const revise = briefs[2];
  assert.equal(revise.deskId, "desk-1");
  assert.match(revise.text, /Revise the plan/);
  const summary = /their notes are in (\S+huddle\.md)/.exec(revise.text)![1];
  assert.match(readFileSync(summary, "utf8"), /## Grace\n\n- Concern: no tests for the edge cases/);

  // The planner's revision lands (as GoalFiles would hand it over).
  writeFileSync(plan(), "- [ ] Agree what done means\n- [ ] Sketch the approach\n- [ ] Build the core flow\n- [ ] Cover it with tests\n");
  assert.equal(huddles.onPlan(goal.id, parsePlan(readFileSync(plan(), "utf8")), []), true);
  assert.equal(p.getGoal(goal.id)!.huddle, null, "the huddle's over");
  assert.equal(huddles.get(goal.id), null);
  assert.deepEqual(landed[0].tasks, ["Agree what done means", "Sketch the approach", "Build the core flow", "Cover it with tests"]);
  assert.deepEqual(landed[0].claims[0], { deskId: "desk-2", task: "Build the core flow" });
  assert.match(notes.at(-1)!, /the plan was revised from the huddle · 2 tasks claimed/);
  assert.equal(p.getGoal(goal.id)!.tasks.length, 4);
});

test("a huddle you skip: the draft goes out straight away", () => {
  const { goal, huddles, landed, notes } = setup();
  huddles.onPlan(goal.id, ["One", "Two"], ["desk-2"]);
  assert.equal(huddles.skip(goal.id), true);
  assert.deepEqual(landed[0].tasks, ["One", "Two"]);
  assert.match(notes.at(-1)!, /huddle skipped — the draft stands/);
  assert.equal(huddles.skip(goal.id), false, "nothing left to skip");
});

test("a huddle nobody answers, or whose revision never comes, keeps to its time limits", () => {
  const a = setup();
  a.huddles.onPlan(a.goal.id, ["One", "Two"], ["desk-2"]);
  a.tick(30_000);
  assert.equal(a.landed.length, 0, "still gathering");
  a.tick(31_000);
  assert.deepEqual(a.landed[0].tasks, ["One", "Two"]);
  assert.match(a.notes.at(-1)!, /nobody weighed in/);

  const b = setup();
  b.huddles.onPlan(b.goal.id, ["One", "Two"], ["desk-2"]);
  b.briefs[0].done();
  b.tick();
  assert.equal(b.p.getGoal(b.goal.id)!.huddle!.status, "revising");
  b.tick(61_000);
  assert.deepEqual(b.landed[0].tasks, ["One", "Two"], "the draft stands");
  assert.match(b.notes.at(-1)!, /no revision in time/);
});

test("no huddle without a planner, a draft or anyone else to ask; a new draft mid-huddle replaces the old one", () => {
  const { p, goal, huddles, briefs } = setup();
  assert.equal(huddles.onPlan(goal.id, ["One"], ["desk-1"]), false, "only the planner");
  assert.equal(huddles.onPlan(goal.id, [], ["desk-2"]), false, "an empty plan");
  assert.equal(huddles.onPlan(goal.id, ["One"], ["desk-9"]), false, "nobody could be briefed");
  const other = p.createGoal("Ann", "No planner", "", [])!;
  assert.equal(huddles.onPlan(other.id, ["One"], ["desk-2"]), false);

  assert.equal(huddles.onPlan(goal.id, ["One"], ["desk-2", "desk-3", "desk-4", "desk-5", "desk-6", "desk-7"]), true);
  assert.equal(p.getGoal(goal.id)!.huddle!.deskIds.length, HUDDLE_MAX, "at most four are asked");
  assert.equal(huddles.onPlan(goal.id, ["One", "Two"], []), true);
  assert.deepEqual(p.getGoal(goal.id)!.huddle!.draft, ["One", "Two"]);
  assert.ok(briefs.length >= HUDDLE_MAX);
  huddles.stop();
});

test("a simulated huddle runs itself: scripted notes, then a revised plan", () => {
  const { goal, huddles, briefs, tick, plan, landed } = setup();
  huddles.onPlan(goal.id, ["Sketch the approach", "Build the core flow", "Polish"], ["desk-2", "desk-3"]);
  for (const b of briefs.slice()) b.done();
  tick();
  briefs.at(-1)!.done();
  assert.ok(existsSync(plan()));
  huddles.onPlan(goal.id, parsePlan(readFileSync(plan(), "utf8")), []);
  assert.ok(landed[0].tasks.includes("Add a quick end-to-end check"), "a teammate's suggestion made it in");
  assert.ok(landed[0].claims.length >= 1);
});

test("huddles and running demos don't survive a restart", () => {
  const h: HuddleState = { status: "gathering", plannerDesk: "desk-1", deskIds: ["desk-2"], draft: ["One"], notes: [], startedAt: 0, endsAt: 1 };
  const g = coerceGoal({ id: "g", title: "x", why: "", kind: "build", createdBy: "Ann", createdAt: 0, doneAt: null, tasks: [], planningDesk: null, ship: null, shippedAt: null, deck: null, huddle: h, demo: { ...simDemo("x"), status: "running" } } as Goal);
  assert.equal(g.huddle, null);
  assert.equal(g.demo, null);
  assert.equal(coerceDemo(simDemo("x"))?.status, "ready");
});

// ---------------------------------------------------------------------------
// The demo
// ---------------------------------------------------------------------------

test("what the demo shows: the configured demo, the preview, a dev server, then the check", () => {
  const none = { demo: null, preview: null, check: null };
  assert.deepEqual(demoPlan({ ...none, demo: "http://localhost:5173/app", preview: "http://localhost:3000" }), { kind: "screenshot", url: "http://localhost:5173/app" });
  assert.deepEqual(demoPlan({ ...none, demo: "npm run demo", check: "npm test" }), { kind: "terminal", command: "npm run demo" });
  assert.deepEqual(demoPlan({ ...none, preview: "http://localhost:3000", check: "npm test" }), { kind: "screenshot", url: "http://localhost:3000" });
  assert.deepEqual(demoPlan({ ...none, check: "npm test" }, ["http://localhost:4173"]), { kind: "screenshot", url: "http://localhost:4173" });
  assert.deepEqual(demoPlan({ ...none, check: "npm test" }), { kind: "terminal", command: "npm test" });
  assert.equal(demoPlan(none), null);
});

test("demo and huddle settings come from domain.config.json, with env overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "demo-cfg-"));
  writeFileSync(join(dir, "domain.config.json"), JSON.stringify({ demo: "npm run demo", preview: "not a url", check: "npm test", huddle: false }));
  assert.deepEqual(loadDemoSettings(dir, {}), { demo: "npm run demo", preview: null, check: "npm test", huddle: false });
  assert.equal(loadDemoSettings(dir, { DOMAIN_DEMO: "http://localhost:1" }).demo, "http://localhost:1");
  assert.equal(loadDemoSettings(join(dir, "nope"), {}).huddle, true, "on unless turned off");
  assert.equal(loadDemoSettings(join(dir, "nope"), { DOMAIN_HUDDLE: "0" }).huddle, false);
});

test("a browser for screenshots: DOMAIN_BROWSER first, then Chrome or Edge where they install", () => {
  assert.equal(findBrowser({ DOMAIN_BROWSER: "/opt/my-chrome" }, (p) => p === "/opt/my-chrome", "linux"), "/opt/my-chrome");
  assert.equal(findBrowser({ PATH: "/usr/bin" }, (p) => p === join("/usr/bin", "chromium"), "linux"), join("/usr/bin", "chromium"));
  const edge = findBrowser({ PROGRAMFILES: "C:/Program Files" }, (p) => /msedge\.exe$/.test(p), "win32");
  assert.match(edge!, /Microsoft[\\/]Edge[\\/]Application[\\/]msedge\.exe$/);
  assert.equal(findBrowser({}, () => false, "darwin"), null);
  const args = screenshotArgs("http://localhost:3000", "/tmp/demo.png", "/tmp/profile");
  assert.ok(args.includes("--headless=new") && args.includes("--screenshot=/tmp/demo.png") && args.at(-1) === "http://localhost:3000");
});

test("a terminal demo captures the command's output; a screenshot with no browser says why", async () => {
  const dir = mkdtempSync(join(tmpdir(), "demo-run-"));
  const ok = await captureDemo({ kind: "terminal", command: `node -e "console.log('it works: ' + (40 + 2))"` }, { cwd: dir, png: join(dir, "demo.png") });
  assert.equal(ok.status, "ready");
  assert.equal(ok.exitCode, 0);
  assert.match(ok.output, /it works: 42/);
  const bad = await captureDemo({ kind: "terminal", command: `node -e "process.exit(3)"` }, { cwd: dir, png: join(dir, "demo.png") });
  assert.equal(bad.status, "failed");
  assert.equal(bad.exitCode, 3);
  const shot = await captureDemo({ kind: "screenshot", url: "http://localhost:1" }, { cwd: dir, png: join(dir, "demo.png"), browser: null });
  assert.equal(shot.status, "failed");
  assert.match(shot.output, /No Chrome, Edge or Chromium found/);
  assert.equal(demoImage(join(dir, "demo.png")), null);
  writeFileSync(join(dir, "demo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.equal(demoImage(join(dir, "demo.png")), "data:image/png;base64,iVBORw==");
});

test("everyone can watch the demo; only those who run the work can skip a huddle or capture one", () => {
  assert.equal(allowed("visitor", "demoGet"), true);
  assert.equal(allowed("visitor", "huddleSkip"), false);
  assert.equal(allowed("visitor", "demo"), false);
  assert.equal(allowed("teammate", "huddleSkip"), true);
  assert.equal(allowed("teammate", "demo"), true);
});
