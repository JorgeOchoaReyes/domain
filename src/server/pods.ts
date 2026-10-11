import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WebSocket } from "ws";
import { AGENT_LABELS, SHARED_HIRERS, type ServerMessage, type Worker } from "../shared/protocol.js";
import { ASK_TTL_MS, assignPods, podOwnerBlocking, podSeats, type BorrowEvent, type Loan, type PodsState } from "../shared/pods.js";
import type { ClientRec, Routes, ServerCtx } from "./ctx.js";

/**
 * Pods for people, on the server. Everyone in the office gets a pod on the
 * team floor, remembered by name in .domain/pods.json so they come back to
 * the same one; a desk in someone's pod is theirs to hire at while they're
 * here. And borrowing, like an agent's "I'll take it" the other way round: a
 * teammate asks for someone's agent, the owner gets a yes/no, and on yes the
 * worker is lent (Worker.lentTo, which mayDirect honours) until the borrower
 * gives it back, the owner calls it back, the task the borrower gave it is
 * done, the worker leaves its desk, or either of them leaves the office.
 */

interface LoanRec extends Loan {
  /** Tasks already on its desk when it was lent: the borrower's is the next one. */
  before: string[];
}

const workerName = (w: Pick<Worker, "agent" | "identity">) => w.identity?.name ?? AGENT_LABELS[w.agent];

export class Pods {
  private assigned: Record<string, string> = {};
  private loans = new Map<string, LoanRec>();
  private last = "";

  constructor(
    private ctx: ServerCtx,
    private file: string | null,
    private now: () => number = Date.now,
  ) {
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { assigned?: Record<string, unknown> };
      for (const [k, v] of Object.entries(raw.assigned ?? {})) if (typeof v === "string" && k.length <= 24) this.assigned[k] = v;
    } catch {
      /* none yet */
    }
  }

  /** The people in the office now, by name (a command line on this computer counts; a connection that hasn't said who it is doesn't). */
  present(): string[] {
    const out = new Set<string>();
    for (const c of this.ctx.clients().values()) if (c.joined || (c.role === "host" && c.name !== "Guest")) out.add(c.name);
    return [...out];
  }

  state(): PodsState {
    return {
      pods: podSeats(this.assigned, this.present()),
      loans: [...this.loans.values()].map(({ before: _b, ...l }) => l),
    };
  }

  /** Hand out pods, end loans that should end, and tell everyone if anything changed. */
  refresh(): void {
    const present = this.present();
    const { assigned } = assignPods(present, this.assigned);
    if (JSON.stringify(assigned) !== JSON.stringify(this.assigned)) {
      this.assigned = assigned;
      this.save();
    }
    for (const loan of [...this.loans.values()]) this.checkLoan(loan, present);
    const state = this.state();
    const key = JSON.stringify(state);
    if (key !== this.last) {
      this.last = key;
      this.ctx.broadcast({ t: "pods", state });
    }
  }

  send(ws: WebSocket): void {
    this.ctx.send(ws, { t: "pods", state: this.state() });
  }

  /** Why someone may not hire at a desk (null: they may). */
  hireRefusal(client: ClientRec, deskId: string): string | null {
    const owner = podOwnerBlocking(deskId, client.name, podSeats(this.assigned, this.present()));
    return owner ? `🪑 That desk is in ${owner}'s pod — hire in your own pod, or anywhere downstairs` : null;
  }

  /** A teammate asks to borrow the agent at a desk. */
  ask(client: ClientRec, deskId: string): void {
    const refuse = (text: string) => this.tell([client.name], { event: "refused", deskId, owner: "", borrower: client.name, worker: "", text });
    const w = this.ctx.office.workerAt(deskId);
    if (!w) return refuse("There's nobody at that desk to borrow");
    const name = workerName(w);
    const owner = w.hiredBy;
    if (owner === client.name) return refuse(`${name} is already yours`);
    if (SHARED_HIRERS.includes(owner)) return refuse(`${name} is everyone's — give it a task`);
    if (!this.present().includes(owner)) return refuse(`${owner} isn't here, so ${name} is free for anyone to direct`);
    const open = this.loans.get(deskId);
    if (open?.state === "lent") return refuse(open.borrower === client.name ? `${name} is already working for you` : `${name} is lent to ${open.borrower} right now`);
    if (open) return refuse(open.borrower === client.name ? `You've asked already — waiting for ${owner}` : `${open.borrower} has asked for ${name} already`);
    const loan: LoanRec = { deskId, workerId: w.id, worker: name, owner, borrower: client.name, state: "asked", at: this.now(), taskId: null, before: [] };
    this.loans.set(deskId, loan);
    this.notify(loan, "asked", `🤝 ${client.name} asks to borrow ${name}`);
    this.refresh();
  }

  /** The owner says yes or no. */
  answer(client: ClientRec, deskId: string, yes: boolean): void {
    const loan = this.loans.get(deskId);
    if (!loan || loan.state !== "asked" || loan.owner !== client.name) return;
    const w = this.ctx.office.workerAt(deskId);
    if (!w || w.id !== loan.workerId) return this.end(loan, "returned", `${loan.worker} isn't at its desk any more`);
    if (!yes) return this.end(loan, "declined", `🙅 ${loan.owner} said no — ${loan.worker} stays with ${loan.owner}`);
    loan.state = "lent";
    loan.at = this.now();
    loan.before = this.openTasks(deskId);
    this.ctx.office.lend(deskId, loan.borrower);
    this.notify(loan, "lent", `🤝 ${loan.owner} lent ${loan.worker} to ${loan.borrower} — it works for ${loan.borrower} until it's given back or its task is done`);
    this.refresh();
  }

  /** The borrower gives it back, the owner calls it back (or the borrower drops an ask). */
  giveBack(client: ClientRec, deskId: string): void {
    const loan = this.loans.get(deskId);
    if (!loan || (client.name !== loan.borrower && client.name !== loan.owner)) return;
    if (loan.state === "asked") return this.end(loan, "returned", client.name === loan.borrower ? `${loan.borrower} doesn't need ${loan.worker} after all` : `🙅 ${loan.owner} said no — ${loan.worker} stays with ${loan.owner}`);
    this.end(loan, "returned", client.name === loan.borrower ? `↩ ${loan.borrower} gave ${loan.worker} back to ${loan.owner}` : `↩ ${loan.owner} called ${loan.worker} back`);
  }

  private checkLoan(loan: LoanRec, present: string[]): void {
    if (this.loans.get(loan.deskId) !== loan) return; // ended meanwhile
    const w = this.ctx.office.workerAt(loan.deskId);
    if (!w || w.id !== loan.workerId) return this.end(loan, "returned", `${loan.worker} left its desk — the loan's over`);
    if (!present.includes(loan.borrower)) return this.end(loan, "returned", `${loan.borrower} left — ${loan.worker} is back with ${loan.owner}`);
    if (!present.includes(loan.owner)) return this.end(loan, "returned", `${loan.owner} left — ${loan.worker} is free for anyone to direct`);
    if (loan.state === "asked") {
      if (this.now() - loan.at > ASK_TTL_MS) this.end(loan, "declined", `⌛ ${loan.owner} didn't answer — ${loan.worker} stays with ${loan.owner}`);
      return;
    }
    // The task the borrower gave it: once it's done, it goes back.
    if (!loan.taskId) loan.taskId = this.openTasks(loan.deskId).find((id) => !loan.before.includes(id)) ?? null;
    if (loan.taskId) {
      const task = this.task(loan.taskId);
      if (!task || task.status === "done" || task.deskId !== loan.deskId) this.end(loan, "returned", `✅ ${loan.worker} finished ${loan.borrower}'s task and went back to ${loan.owner}`);
    }
  }

  private end(loan: LoanRec, event: BorrowEvent, text: string): void {
    this.loans.delete(loan.deskId);
    const w = this.ctx.office.workerAt(loan.deskId);
    if (w && w.id === loan.workerId && w.lentTo === loan.borrower) this.ctx.office.lend(loan.deskId, null);
    this.notify(loan, event, text);
    this.refresh();
  }

  private openTasks(deskId: string): string[] {
    const out: string[] = [];
    for (const id of this.ctx.progress.goalIds()) for (const t of this.ctx.progress.getGoal(id)?.tasks ?? []) if (t.deskId === deskId && t.status !== "done") out.push(t.id);
    return out;
  }

  private task(taskId: string) {
    for (const id of this.ctx.progress.goalIds()) {
      const t = this.ctx.progress.getGoal(id)?.tasks.find((x) => x.id === taskId);
      if (t) return t;
    }
    return null;
  }

  private notify(loan: Loan, event: BorrowEvent, text: string): void {
    this.tell([loan.owner, loan.borrower], { event, deskId: loan.deskId, owner: loan.owner, borrower: loan.borrower, worker: loan.worker, text });
  }

  private tell(names: string[], m: Omit<Extract<ServerMessage, { t: "borrow" }>, "t">): void {
    for (const [ws, c] of this.ctx.clients()) if (names.includes(c.name)) this.ctx.send(ws, { t: "borrow", ...m });
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ assigned: this.assigned }, null, 1));
    } catch {
      /* best effort */
    }
  }
}

/** The module: pods handed out as people come and go, and borrowing agents. */
export function podsModule(ctx: ServerCtx, pods = new Pods(ctx, join(ctx.cwd, ".domain", "pods.json"))): Routes {
  ctx.hireRefusal = (client, deskId) => pods.hireRefusal(client, deskId);
  // People come and go (and tasks finish): look again every second.
  const timer = setInterval(() => pods.refresh(), 1000);
  timer.unref?.();
  ctx.wss?.on("connection", (ws: WebSocket) => ws.on("close", () => setImmediate(() => pods.refresh())));
  const deskOf = (msg: Record<string, unknown>) => (typeof msg.deskId === "string" && msg.deskId.length <= 64 ? msg.deskId : null);
  return {
    podsGet: (_msg, _client, ws) => {
      pods.refresh();
      pods.send(ws);
    },
    borrowAsk: (msg, client) => {
      const d = deskOf(msg);
      if (d) pods.ask(client, d);
    },
    borrowAnswer: (msg, client) => {
      const d = deskOf(msg);
      if (d) pods.answer(client, d, msg.yes === true);
    },
    borrowReturn: (msg, client) => {
      const d = deskOf(msg);
      if (d) pods.giveBack(client, d);
    },
  };
}
