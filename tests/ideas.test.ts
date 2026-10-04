import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coerceIdeaInput, ideaTasks } from "../src/shared/ideas.ts";
import { IdeaStore, ideasModule } from "../src/server/ideas.ts";
import { Progress } from "../src/server/progress.ts";
import { OpLogger } from "../src/server/oplog.ts";
import type { ServerCtx } from "../src/server/ctx.ts";
import type { ServerMessage } from "../src/shared/protocol.ts";

const ws = {} as never;
const client = { id: "c1", name: "Ann", alive: true, joined: true, role: "host" as const };
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const THUMB = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2w==";

/** Just enough of the server for the ideas module: one staffed desk, and a record of assignments. */
function fakeCtx() {
  const dir = mkdtempSync(join(tmpdir(), "domain-ideas-"));
  const progress = new Progress(null);
  const sent: ServerMessage[] = [];
  const assigned: { goalId: string; taskId: string; deskId: string }[] = [];
  const briefNotes: ((g: string, t: string, d: string) => string)[] = [];
  const office = { workdir: () => dir, snapshot: () => ({ desks: [{ id: "desk-1", label: "Desk 1", worker: { agent: "claude", identity: { name: "Ada" } } }, { id: "desk-2", label: "Desk 2", worker: null }] }) };
  const ctx = {
    cwd: dir,
    progress,
    log: new OpLogger(),
    office,
    send: () => {},
    broadcast: (m: ServerMessage) => sent.push(m),
    briefNotes,
    assignTask: (_who: string, goalId: string, taskId: string, deskId: string) => {
      assigned.push({ goalId, taskId, deskId });
      return true;
    },
  } as unknown as ServerCtx;
  const store = new IdeaStore(join(dir, ".domain", "ideas"));
  return { ctx, progress, sent, assigned, briefNotes, store, dir, routes: ideasModule(ctx, store) };
}

test("ideas are cleaned: a title or a sketch is needed, thumbnails must be small JPEGs", () => {
  assert.equal(coerceIdeaInput({ title: "  ", text: "" }), null);
  assert.equal(coerceIdeaInput({ title: "x", thumb: "javascript:alert(1)" })!.thumb, null);
  assert.equal(coerceIdeaInput({ thumb: THUMB })!.title, "Sketch", "a drawing alone is still an idea");
  assert.equal(coerceIdeaInput({ text: "Dark mode\n- a toggle" })!.title, "Dark mode", "no title: the first line of the notes");
  assert.equal(coerceIdeaInput({ title: "x", kind: "nope" })!.kind, "build");
  assert.equal(coerceIdeaInput({ title: "x", id: "../../etc" })!.id, null);
  assert.deepEqual(ideaTasks("Why it matters\n- a toggle\n* remember it\n2. match colors\nplain line"), ["a toggle", "remember it", "match colors"]);
});

test("pinning an idea keeps it, with its sketch on disk for agents", () => {
  const { routes, store, sent } = fakeCtx();
  routes.ideaSave!({ t: "ideaSave", idea: { title: "Dark mode", text: "- a toggle", kind: "build", thumb: THUMB }, sketch: PNG } as never, client, ws);
  assert.equal(store.ideas.length, 1);
  const idea = store.ideas[0];
  assert.equal(idea.by, "Ann");
  assert.equal(idea.status, "open");
  assert.ok(store.sketchPath(idea.id), "the sketch is saved as a PNG");
  assert.equal(sent.at(-1)?.t, "ideas");
  // It survives a restart.
  const again = new IdeaStore(store.dir);
  assert.equal(again.ideas[0].title, "Dark mode");
  // Taking it down removes the sketch too.
  const path = store.sketchPath(idea.id)!;
  routes.ideaDelete!({ t: "ideaDelete", id: idea.id } as never, client, ws);
  assert.equal(store.ideas.length, 0);
  assert.equal(existsSync(path), false);
});

test("handing an idea over makes it a task on the goal in focus and briefs the worker with it", () => {
  const { routes, store, progress, assigned, briefNotes, dir } = fakeCtx();
  const goal = progress.createGoal("Ann", "Ship v2", "", [])!;
  routes.ideaSave!(
    { t: "ideaSave", idea: { title: "Dark mode", text: "Night owls asked\n- a toggle", kind: "build", thumb: THUMB }, sketch: PNG, then: { handoff: "desk-1" } } as never,
    client,
    ws,
  );
  const idea = store.ideas[0];
  assert.equal(idea.status, "handed");
  assert.equal(idea.handedTo?.name, "Ada");
  assert.equal(idea.goalId, goal.id);
  const task = progress.getGoal(goal.id)!.tasks.find((t) => t.id === idea.taskId);
  assert.equal(task?.title, "Dark mode");
  assert.deepEqual(assigned, [{ goalId: goal.id, taskId: idea.taskId, deskId: "desk-1" }]);
  // The brief carries the notes and where the sketch is.
  const notes = briefNotes.map((f) => f(goal.id, idea.taskId!, "desk-1")).join("");
  assert.match(notes, /Night owls asked/);
  // The sketch is copied into the worker's own folder, where it can open it without asking.
  assert.ok(notes.includes(`.domain/sketches/idea-${idea.id}.png`));
  assert.ok(existsSync(join(dir, ".domain", "sketches", `idea-${idea.id}.png`)));
  // Other tasks on that goal aren't briefed with it.
  assert.equal(briefNotes.map((f) => f(goal.id, "other", "desk-1")).join(""), "");
});

test("handing over with no goal yet makes one; an empty desk can't take it", () => {
  const { routes, store, progress, assigned } = fakeCtx();
  routes.ideaSave!({ t: "ideaSave", idea: { title: "Try a cache", text: "", kind: "research", thumb: null } } as never, client, ws);
  const idea = store.ideas[0];
  routes.ideaHandoff!({ t: "ideaHandoff", id: idea.id, deskId: "desk-2" } as never, client, ws);
  assert.equal(idea.status, "open", "nobody at desk-2");
  assert.equal(assigned.length, 0);
  routes.ideaHandoff!({ t: "ideaHandoff", id: idea.id, deskId: "desk-1" } as never, client, ws);
  const goal = progress.getGoal(idea.goalId!)!;
  assert.equal(goal.title, "Try a cache");
  assert.equal(goal.kind, "research");
  assert.equal(assigned.length, 1);
});

test("an idea becomes a goal: its bullet lines are the tasks, and their briefs carry the idea", () => {
  const { routes, store, progress, briefNotes } = fakeCtx();
  routes.ideaSave!({ t: "ideaSave", idea: { title: "Onboarding", text: "First run feels empty\n- a welcome tour\n- sample project", kind: "build", thumb: THUMB }, sketch: PNG } as never, client, ws);
  const idea = store.ideas[0];
  routes.ideaToGoal!({ t: "ideaToGoal", id: idea.id } as never, client, ws);
  assert.equal(idea.status, "goal");
  const goal = progress.getGoal(idea.goalId!)!;
  assert.equal(goal.why, "First run feels empty");
  assert.deepEqual(goal.tasks.map((t) => t.title), ["a welcome tour", "sample project"]);
  assert.match(briefNotes.map((f) => f(goal.id, goal.tasks[0].id, "desk-1")).join(""), /Onboarding/);
  assert.ok(JSON.parse(readFileSync(join(store.dir, "ideas.json"), "utf8"))[0].goalId === goal.id, "saved");
});
