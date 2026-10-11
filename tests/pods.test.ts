import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASK_TTL_MS, assignPods, podDesks, podNames, podOfDesk, podOwnerBlocking, podSeats } from "../src/shared/pods.ts";
import { mayDirect, type ServerMessage, type Worker } from "../src/shared/protocol.ts";
import { MORE_TEAM_DESK_IDS, TEAM_DESK_IDS } from "../src/shared/layout.ts";
import { Pods, podsModule } from "../src/server/pods.ts";
import { allowed } from "../src/server/permissions.ts";
import type { ClientRec, ServerCtx } from "../src/server/ctx.ts";

test("everyone here gets a pod, and keeps it", () => {
  const pods = ["A", "B", "C"];
  const first = assignPods(["Jorge", "Ana"], {}, pods);
  assert.deepEqual(first.assigned, { Jorge: "A", Ana: "B" });
  // Ana comes back after Bob arrived: still B; Bob got a fresh one.
  const second = assignPods(["Bob", "Jorge"], first.assigned, pods);
  assert.deepEqual(second.assigned, { Jorge: "A", Ana: "B", Bob: "C" });
  const third = assignPods(["Ana", "Bob", "Jorge"], second.assigned, pods);
  assert.equal(third.assigned.Ana, "B", "the same pod as before");
  // A fourth person: nobody's is fresh, so they get the pod of someone who isn't here.
  const fourth = assignPods(["Jorge", "Bob", "Dee"], third.assigned, pods);
  assert.equal(fourth.assigned.Dee, "B");
  assert.equal(fourth.assigned.Ana, undefined, "Ana's pod went to someone here");
  // More people here than pods: the last one waits.
  const full = assignPods(["Jorge", "Bob", "Dee", "Eve"], fourth.assigned, pods);
  assert.deepEqual(full.without, ["Eve"]);
  // An old file with two people in a pod, or a pod that's gone.
  assert.deepEqual(assignPods([], { X: "A", Y: "A", Z: "Q" }, pods).assigned, { X: "A" });
});

test("pods are the team floor's desk clusters", () => {
  const names = podNames();
  assert.ok(names.length >= 4);
  const all = names.flatMap((p) => podDesks(p));
  assert.deepEqual([...all].sort(), [...TEAM_DESK_IDS, ...MORE_TEAM_DESK_IDS].sort(), "every team-floor desk, on every team floor, is in exactly one pod");
  assert.deepEqual(names.slice(0, 5), ["A", "B", "C", "D", "E"], "floor 3's pods first, then the floor above");
  assert.equal(podDesks("A").length, 4);
  for (const p of names) for (const d of podDesks(p)) assert.equal(podOfDesk(d), p);
  assert.equal(podOfDesk("desk-1"), null, "downstairs desks are nobody's pod");
});

test("a desk in someone's pod is theirs to hire at while they're here", () => {
  const seats = podSeats({ Ana: "A", Bob: "B" }, ["Ana"]);
  const a1 = podDesks("A")[0];
  const b1 = podDesks("B")[0];
  const c1 = podDesks("C")[0];
  assert.equal(podOwnerBlocking(a1, "Ana", seats), null, "your own pod");
  assert.equal(podOwnerBlocking(a1, "Jorge", seats), "Ana", "someone else's, and they're here");
  assert.equal(podOwnerBlocking(b1, "Jorge", seats), null, "Bob's away");
  assert.equal(podOwnerBlocking(c1, "Jorge", seats), null, "nobody's pod");
  assert.equal(podOwnerBlocking("desk-1", "Jorge", seats), null, "downstairs");
});

test("a lent agent works for its borrower while they're here", () => {
  const w = { hiredBy: "Jorge", lentTo: "Ana" };
  const here = ["Jorge", "Ana", "Bob"];
  assert.ok(mayDirect(w, { name: "Ana", host: false }, here));
  assert.ok(!mayDirect(w, { name: "Jorge", host: false }, here), "the owner calls it back to direct it again");
  assert.ok(!mayDirect(w, { name: "Bob", host: false }, here));
  assert.ok(mayDirect(w, { name: "Bob", host: true }, here), "the host still may (it's their computer)");
  assert.ok(mayDirect(w, { name: "Jorge", host: false }, ["Jorge", "Bob"]), "a borrower who left doesn't hold it");
});

test("visitors see the pods but can't borrow", () => {
  assert.ok(allowed("visitor", "podsGet"));
  assert.ok(!allowed("visitor", "borrowAsk"));
  assert.ok(allowed("teammate", "borrowAsk"));
  assert.ok(allowed("teammate", "borrowAnswer"));
  assert.ok(allowed("teammate", "borrowReturn"));
});

// --- the server side, with a stand-in for the office -------------------------------------------

function fakeServer(dir: string | null = null) {
  let now = 1_000_000;
  const clients = new Map<object, ClientRec>();
  const inbox = new Map<string, ServerMessage[]>();
  const broadcasts: ServerMessage[] = [];
  const desks = new Map<string, Worker>();
  const tasks: { id: string; deskId: string | null; status: string }[] = [];
  const person = (name: string, role: ClientRec["role"] = "teammate") => {
    const ws = { name };
    clients.set(ws, { id: name, name, alive: true, joined: true, role });
    inbox.set(name, []);
    return { ws, client: clients.get(ws)! };
  };
  const leave = (name: string) => {
    for (const [ws, c] of clients) if (c.name === name) clients.delete(ws);
  };
  const ctx = {
    clients: () => clients,
    send: (ws: { name: string }, m: ServerMessage) => inbox.get(ws.name)?.push(m),
    broadcast: (m: ServerMessage) => broadcasts.push(m),
    office: {
      workerAt: (d: string) => desks.get(d) ?? null,
      lend: (d: string, to: string | null) => {
        const w = desks.get(d);
        if (!w) return false;
        if (to) w.lentTo = to;
        else delete w.lentTo;
        return true;
      },
    },
    progress: {
      goalIds: () => ["g1"],
      getGoal: () => ({ tasks }),
    },
  } as unknown as ServerCtx;
  const hire = (deskId: string, hiredBy: string, name = "Rex") =>
    desks.set(deskId, { id: `w-${deskId}`, agent: "claude", hiredBy, status: "idle", activity: "", report: null, model: "", leash: "ask", branch: null, identity: { characterId: "c", name, look: { color: "#ffffff", face: "smile", hat: "none", accessory: "none" }, voice: "" } });
  const pods = new Pods(ctx, dir ? join(dir, "pods.json") : null, () => now);
  const borrows = (name: string) => inbox.get(name)!.filter((m): m is Extract<ServerMessage, { t: "borrow" }> => m.t === "borrow");
  return { ctx, pods, person, leave, hire, desks, tasks, borrows, broadcasts, tick: (ms: number) => (now += ms) };
}

test("pods are handed out as people arrive, remembered, and shown to everyone", () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-pods-"));
  const s = fakeServer(dir);
  s.person("Jorge", "host");
  s.person("Ana");
  s.pods.refresh();
  const last = s.broadcasts.at(-1) as Extract<ServerMessage, { t: "pods" }>;
  assert.deepEqual(last.state.pods, [
    { pod: "A", person: "Jorge", here: true },
    { pod: "B", person: "Ana", here: true },
  ]);
  const n = s.broadcasts.length;
  s.pods.refresh();
  assert.equal(s.broadcasts.length, n, "nothing changed, nothing sent");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "pods.json"), "utf8")).assigned, { Jorge: "A", Ana: "B" });
  // A new run of the office: Ana arrives first and still gets B.
  const again = fakeServer(dir);
  again.person("Ana");
  again.pods.refresh();
  assert.equal(again.pods.state().pods.find((p) => p.person === "Ana")?.pod, "B");
  // Someone else's pod, while they're here: not yours to hire at.
  const bob = again.person("Bob").client;
  again.pods.refresh();
  assert.match(again.pods.hireRefusal(bob, podDesks("B")[0]) ?? "", /Ana's pod/);
  assert.equal(again.pods.hireRefusal(bob, podDesks("A")[0]), null, "Jorge's away");
});

test("asking to borrow: the owner says no, then yes; it works for the borrower and comes back when the task's done", () => {
  const s = fakeServer();
  const jorge = s.person("Jorge").client;
  const ana = s.person("Ana").client;
  s.hire("desk-1", "Jorge");
  s.pods.ask(ana, "desk-1");
  assert.equal(s.borrows("Jorge").at(-1)?.event, "asked", "the owner is asked");
  assert.match(s.borrows("Jorge").at(-1)!.text, /Ana asks to borrow Rex/);
  assert.equal(s.pods.state().loans[0].state, "asked");
  // Asking twice, or answering someone else's agent, does nothing new.
  s.pods.ask(ana, "desk-1");
  assert.equal(s.borrows("Ana").at(-1)?.event, "refused");
  s.pods.answer(ana, "desk-1", true);
  assert.equal(s.desks.get("desk-1")!.lentTo, undefined, "only the owner answers");
  // No.
  s.pods.answer(jorge, "desk-1", false);
  assert.equal(s.borrows("Ana").at(-1)?.event, "declined");
  assert.equal(s.pods.state().loans.length, 0);
  assert.equal(s.desks.get("desk-1")!.lentTo, undefined);
  // Yes.
  s.tasks.push({ id: "old", deskId: "desk-1", status: "doing" });
  s.pods.ask(ana, "desk-1");
  s.pods.answer(jorge, "desk-1", true);
  assert.equal(s.desks.get("desk-1")!.lentTo, "Ana");
  assert.equal(s.borrows("Ana").at(-1)?.event, "lent");
  assert.ok(mayDirect(s.desks.get("desk-1"), { name: "Ana", host: false }, ["Jorge", "Ana"]));
  // Jorge's own task finishing doesn't end it; Ana's does.
  s.tasks[0].status = "done";
  s.pods.refresh();
  assert.equal(s.desks.get("desk-1")!.lentTo, "Ana");
  s.tasks.push({ id: "anas", deskId: "desk-1", status: "doing" });
  s.pods.refresh();
  assert.equal(s.pods.state().loans[0].taskId, "anas");
  s.tasks[1].status = "review";
  s.pods.refresh();
  assert.equal(s.desks.get("desk-1")!.lentTo, "Ana", "still hers while it's in review");
  s.tasks[1].status = "done";
  s.pods.refresh();
  assert.equal(s.desks.get("desk-1")!.lentTo, undefined, "back with its owner");
  assert.match(s.borrows("Jorge").at(-1)!.text, /finished Ana's task/);
});

test("a loan ends when it's given back, called back, or either of them leaves", () => {
  const s = fakeServer();
  const jorge = s.person("Jorge").client;
  const ana = s.person("Ana").client;
  s.hire("desk-1", "Jorge");
  const lend = () => {
    s.pods.ask(ana, "desk-1");
    s.pods.answer(jorge, "desk-1", true);
    assert.equal(s.desks.get("desk-1")!.lentTo, "Ana");
  };
  lend();
  s.pods.giveBack(ana, "desk-1");
  assert.equal(s.desks.get("desk-1")!.lentTo, undefined);
  assert.match(s.borrows("Jorge").at(-1)!.text, /gave Rex back/);
  lend();
  s.pods.giveBack(jorge, "desk-1");
  assert.equal(s.desks.get("desk-1")!.lentTo, undefined);
  assert.match(s.borrows("Ana").at(-1)!.text, /called Rex back/);
  lend();
  s.leave("Ana");
  s.pods.refresh();
  assert.equal(s.desks.get("desk-1")!.lentTo, undefined, "the borrower left");
  assert.match(s.borrows("Jorge").at(-1)!.text, /Ana left/);
  s.person("Ana");
  lend();
  s.leave("Jorge");
  s.pods.refresh();
  assert.equal(s.desks.get("desk-1")!.lentTo, undefined, "the owner left");
  assert.equal(s.pods.state().loans.length, 0);
});

test("asks that can't be, and asks nobody answers", () => {
  const s = fakeServer();
  s.person("Jorge");
  const ana = s.person("Ana").client;
  s.hire("desk-1", "Jorge");
  s.hire("desk-2", "Ana");
  s.hire("desk-3", "Office");
  s.hire("desk-4", "Zed");
  for (const [desk, why] of [
    ["desk-2", /already yours/],
    ["desk-3", /everyone's/],
    ["desk-4", /Zed isn't here/],
    ["desk-9", /nobody at that desk/],
  ] as const) {
    s.pods.ask(ana, desk);
    const m = s.borrows("Ana").at(-1)!;
    assert.equal(m.event, "refused");
    assert.match(m.text, why);
  }
  assert.equal(s.pods.state().loans.length, 0);
  s.pods.ask(ana, "desk-1");
  s.tick(ASK_TTL_MS + 1);
  s.pods.refresh();
  assert.equal(s.pods.state().loans.length, 0, "the ask lapsed");
  assert.match(s.borrows("Ana").at(-1)!.text, /didn't answer/);
  // The worker leaves its desk mid-loan: the loan's over.
  s.pods.ask(ana, "desk-1");
  s.desks.delete("desk-1");
  s.pods.refresh();
  assert.equal(s.pods.state().loans.length, 0);
});

test("the module routes borrow messages and refuses hires in someone else's pod", () => {
  const s = fakeServer();
  const routes = podsModule(s.ctx, s.pods);
  const jorge = s.person("Jorge").client;
  const ana = s.person("Ana").client;
  s.hire("desk-1", "Jorge");
  routes.borrowAsk!({ t: "borrowAsk", deskId: "desk-1" } as never, ana, { name: "Ana" } as never);
  routes.borrowAnswer!({ t: "borrowAnswer", deskId: "desk-1", yes: true } as never, jorge, { name: "Jorge" } as never);
  assert.equal(s.desks.get("desk-1")!.lentTo, "Ana");
  routes.borrowReturn!({ t: "borrowReturn", deskId: "desk-1" } as never, ana, { name: "Ana" } as never);
  assert.equal(s.desks.get("desk-1")!.lentTo, undefined);
  s.pods.refresh();
  assert.match(s.ctx.hireRefusal!(ana, podDesks("A")[0]) ?? "", /Jorge's pod/);
  assert.equal(s.ctx.hireRefusal!(ana, podDesks("B")[0]), null);
});
