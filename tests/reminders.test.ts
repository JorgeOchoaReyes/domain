import { test } from "node:test";
import assert from "node:assert/strict";
import { Reminders, type Reminder } from "../src/client/ui/reminders.ts";
import { EMPTY_PROGRESS, type ProgressState } from "../src/shared/progress.ts";
import type { OfficeState } from "../src/shared/protocol.ts";

const MIN = 60_000;
const worker = (status: string, activity = "") => ({ agent: "claude", status, activity, identity: { name: "Ada" } });

function setup(office: Partial<OfficeState>, progress: Partial<ProgressState>) {
  const said: { r: Reminder; chime: boolean }[] = [];
  const r = new Reminders({
    office: () => ({ desks: [], peers: [], presentations: [], ...office }) as OfficeState,
    progress: () => ({ ...EMPTY_PROGRESS, ...progress }) as ProgressState,
    goToDesk: () => {},
    officeHours: () => {},
    openGoal: () => {},
    notify: (rem, chime) => said.push({ r: rem, chime }),
  });
  return { r, said };
}

const goal = (dueAt: number, tasks: unknown[] = []) => ({ id: "g1", title: "Launch", tasks, dueAt, shippedAt: null, doneAt: null }) as never;

test("deadlines: an hour out, fifteen minutes out, and overdue", () => {
  const now = Date.now();
  for (const [left, urgency, re] of [
    [45 * MIN, 2, /due in 45m/],
    [10 * MIN, 3, /due in 10m/],
    [-20 * MIN, 3, /overdue by 20m/],
  ] as const) {
    const { r, said } = setup({}, { goals: [goal(now + left)] });
    const [rem] = r.update(now);
    assert.equal(rem.urgency, urgency);
    assert.match(rem.text, re);
    assert.equal(said.length, 1, "said once");
    assert.equal(said[0].chime, urgency === 3, "urgent ones chime");
  }
});

test("a worker waiting on you: after a minute and a half, and again every few minutes until it's handled", () => {
  const desks = [{ id: "desk-1", label: "Desk 1", worker: worker("waiting", "Claude Code is asking you something — answer in its terminal") }] as never;
  const { r, said } = setup({ desks }, {});
  const t0 = Date.now();
  assert.equal(r.update(t0).length, 0, "not straight away");
  const [rem] = r.update(t0 + 2 * MIN);
  assert.match(rem.text, /Ada has been waiting on you for 2 min — Claude Code is asking you something/);
  assert.equal(said.length, 1);
  r.update(t0 + 3 * MIN);
  assert.equal(said.length, 1, "not every few seconds");
  r.update(t0 + 6 * MIN);
  assert.equal(said.length, 2, "but it comes back");
});

test("work waiting: the line after five minutes, and free workers while tasks sit unassigned", () => {
  const t0 = Date.now();
  const desks = [
    { id: "desk-1", label: "Desk 1", worker: worker("presenting") },
    { id: "desk-2", label: "Desk 2", worker: worker("idle") },
  ] as never;
  const presentations = [{ deskId: "desk-1", report: { title: "Done", check: null } }] as never;
  const { r } = setup({ desks, presentations }, { goals: [goal(0, [{ id: "t1", title: "Polish", status: "todo", deskId: null }])] });
  r.update(t0);
  const later = r.update(t0 + 6 * MIN).map((x) => x.id);
  assert.ok(later.includes("line"));
  assert.ok(later.some((id) => id.startsWith("idle-")));
});
