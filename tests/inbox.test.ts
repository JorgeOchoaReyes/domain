import { test } from "node:test";
import assert from "node:assert/strict";
import { bareTitle, buildInbox, inboxBadge, NOTE_TTL, pruneNotes, type InboxInput, type InboxItem } from "../src/shared/inbox.ts";
import type { Desk, Presentation, Worker } from "../src/shared/protocol.ts";

function worker(over: Partial<Worker> = {}): Worker {
  return { id: "w", agent: "claude", hiredBy: "Jorge", status: "working", activity: "Coding", report: null, model: "", leash: "normal" as Worker["leash"], branch: null, identity: null, ...over };
}
function desk(id: string, w: Worker | null): Desk {
  return { id, label: id.replace("desk-", "Desk "), x: 0, z: 0, rotY: 0, worker: w };
}
function input(over: Partial<InboxInput> = {}): InboxInput {
  return { desks: [], presentations: [], threads: [], loans: [], me: "Jorge", host: true, mayDirect: () => true, reminders: [], notes: [], dismissed: new Set(), now: 1_000_000, ...over };
}
const report = (over: Partial<NonNullable<Presentation["report"]>> = {}) =>
  ({ status: "ready", title: "Finished: Add a toggle", summary: "", slides: [], at: 500, ...over }) as NonNullable<Presentation["report"]>;

test("questions, stuck agents and the trust prompt come first, each with its buttons", () => {
  const items = buildInbox(
    input({
      desks: [
        desk("desk-1", worker({ status: "waiting", activity: "Allow edits to app.js? — answer in its terminal", identity: { name: "Bolt" } as Worker["identity"] })),
        desk("desk-2", worker({ status: "waiting", activity: "Do you trust this folder?" })),
        desk("desk-3", worker({ trouble: { kind: "signin", detail: "Please run /login" } })),
        desk("desk-4", worker({ status: "working" })),
        desk("desk-5", null),
      ],
    }),
  );
  assert.deepEqual(items.map((x) => x.kind), ["question", "trust", "stuck"]);
  const q = items[0];
  assert.equal(q.title, "Bolt needs your answer");
  assert.equal(q.detail, "Allow edits to app.js?", "the terminal hint is trimmed");
  assert.deepEqual(q.actions.map((a) => a.id), ["answer", "go"]);
  assert.deepEqual(items[1].actions.map((a) => a.id), ["trust", "answer", "go"], "the host can trust the project in one click");
  assert.equal(items[2].urgency, 3);
  assert.match(items[2].title, /stuck — it needs signing in/);
  // A guest can't trust the project for everyone.
  const guest = buildInbox(input({ host: false, desks: [desk("desk-2", worker({ status: "waiting", activity: "Do you trust this folder?" }))] }));
  assert.deepEqual(guest[0].actions.map((a) => a.id), ["answer", "go"]);
});

test("finished work waits for review — not while its checks still run, and only yours", () => {
  const presentations: Presentation[] = [
    { deskId: "desk-1", workerId: "w1", agent: "claude", hiredBy: "Jorge", report: report({ check: { status: "pass" } as never }), order: 0 },
    { deskId: "desk-2", workerId: "w2", agent: "codex", hiredBy: "Jorge", report: report({ title: "Plan: Dark mode", status: "plan", at: 600 }), order: 1 },
    { deskId: "desk-3", workerId: "w3", agent: "gemini", hiredBy: "Jorge", report: report({ check: { status: "running" } as never }), order: 2 },
    { deskId: "desk-4", workerId: "w4", agent: "gemini", hiredBy: "Jorge", report: null, order: 3 },
    { deskId: "desk-5", workerId: "w5", agent: "claude", hiredBy: "Ana", report: report({ status: "blocked", title: "Need a decision: Which DB" }), order: 4 },
  ];
  const desks = ["desk-1", "desk-2", "desk-3", "desk-4", "desk-5"].map((id) => desk(id, worker({ status: "presenting" })));
  const items = buildInbox(input({ desks, presentations, mayDirect: (id) => id !== "desk-5" }));
  assert.deepEqual(items.map((x) => x.deskId), ["desk-2", "desk-1"], "newest first; checking, preparing and someone else's are left out");
  assert.equal(items[0].title, "Claude Code has a plan for “Dark mode”");
  assert.equal(items[1].title, "Claude Code finished “Add a toggle”");
  assert.equal(items[1].detail, "Checks pass · ready to review");
  assert.deepEqual(items[1].actions.map((a) => a.id), ["review", "hours"]);
  // Yours, blocked: it needs a decision, now.
  const blocked = buildInbox(input({ desks, presentations: [presentations[4]] }));
  assert.equal(blocked[0].urgency, 3);
  assert.equal(blocked[0].title, "Claude Code needs a decision on “Which DB”");
});

test("offers and borrow requests: only the open ones, and only yours to lend", () => {
  const offer = (state: "open" | "taken", taskId: string) => ({ goalId: "g", taskId, title: "Update the README", deskId: "desk-2", free: true, state, asked: [] });
  const items = buildInbox(
    input({
      threads: [
        {
          id: "team",
          title: "#team",
          messages: [
            { from: "agent", who: "Grace (Claude Code)", text: "I'll take it", at: 10, offer: offer("taken", "t1") },
            { from: "agent", who: "Grace (Claude Code)", text: "I'll take it", at: 20, offer: offer("open", "t2") },
          ],
        },
      ],
      loans: [
        { deskId: "desk-1", workerId: "w1", worker: "Bolt", owner: "Jorge", borrower: "Ana", state: "asked", at: 30, taskId: null },
        { deskId: "desk-3", workerId: "w3", worker: "Ada", owner: "Ana", borrower: "Jorge", state: "asked", at: 40, taskId: null },
        { deskId: "desk-4", workerId: "w4", worker: "Max", owner: "Jorge", borrower: "Ana", state: "lent", at: 50, taskId: null },
      ],
    }),
  );
  assert.deepEqual(items.map((x) => x.kind), ["borrow", "offer"]);
  assert.equal(items[0].title, "Ana asks to borrow Bolt");
  assert.deepEqual(items[0].actions.map((a) => a.id), ["lend", "refuse"]);
  assert.equal(items[1].ref, "t2");
  assert.equal(items[1].actions[0].label, "✅ Let Grace take it");
});

test("reminders and notes join in, deduplicated, dismissable and sorted by urgency", () => {
  const note: InboxItem = { id: "demo-g1", kind: "demo", urgency: 1, icon: "🎬", title: "Demo ready", ref: "g1", at: 999_000, actions: [{ id: "watch", label: "Watch" }] };
  const items = buildInbox(
    input({
      desks: [desk("desk-1", worker({ status: "waiting" }))],
      reminders: [
        { id: "waiting-desk-1", urgency: 3, icon: "🙋", text: "Waiting 3 min", action: "Go there" },
        { id: "line", urgency: 2, icon: "🎤", text: "Waiting to present", action: "Hold office hours" },
        { id: "due-g1-15", urgency: 3, icon: "⏰", text: "“Dark mode” is due in 10 min", action: "Open the goal" },
        { id: "session-1", urgency: 2, icon: "🔥", text: "Ends in 4 min" },
      ],
      notes: [note, { ...note }],
    }),
  );
  assert.deepEqual(items.map((x) => x.id), ["question-desk-1", "rem-due-g1-15", "rem-session-1", "demo-g1"], "waiting and the line are already questions and reviews; the note shows once");
  assert.ok(items.find((x) => x.id === "rem-session-1")!.actions.length === 0);
  assert.ok(items.find((x) => x.id === "demo-g1")!.dismissable);
  assert.ok(!items[0].dismissable, "live things go away by being dealt with");
  const after = buildInbox(input({ notes: [note], dismissed: new Set(["demo-g1"]) }));
  assert.equal(after.length, 0);
});

test("old notes drop out, the newest few stay; the badge says how many and if any is urgent", () => {
  const n = (id: string, at: number): InboxItem => ({ id, kind: "answer", urgency: 1, icon: "💬", title: id, at, actions: [] });
  const now = 10 * NOTE_TTL;
  assert.deepEqual(pruneNotes([n("old", now - NOTE_TTL - 1), n("a", now - 5), n("b", now - 1)], now).map((x) => x.id), ["b", "a"]);
  assert.equal(pruneNotes(Array.from({ length: 30 }, (_, i) => n(`n${i}`, now - i)), now, 20).length, 20);
  assert.deepEqual(inboxBadge([]), { count: 0, urgent: false });
  assert.deepEqual(inboxBadge([n("a", 1), { ...n("b", 2), urgency: 3 }]), { count: 2, urgent: true });
  assert.equal(bareTitle("Finished: Add a toggle"), "Add a toggle");
  assert.equal(bareTitle("Need a decision:  Which DB"), "Which DB");
});
