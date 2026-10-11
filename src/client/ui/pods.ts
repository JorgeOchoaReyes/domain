import type { ClientMessage, Desk, ServerMessage } from "../../shared/protocol.js";
import type { PodsState } from "../../shared/pods.js";
import { esc } from "./modal.js";

/**
 * Pods for people and borrowing agents, in the browser. Keeps who has which
 * pod and the open borrows; asks you (through Arnold, like an agent's "I'll
 * take it") when a teammate wants one of your agents; and gives the monitor
 * its 🤝 buttons: ask to borrow, give back, call back.
 */

export interface PodsDeps {
  send(m: ClientMessage): void;
  me(): string;
  toast(text: string, kind?: "" | "warn" | "error"): void;
  /** Ask a yes/no question (Arnold, with buttons). */
  ask(id: string, text: string, yes: { label: string; run: () => void }, no: { label: string; run: () => void }): void;
  /** Something changed (pods or borrows). */
  changed(state: PodsState): void;
}

let deps: PodsDeps | null = null;
let state: PodsState = { pods: [], loans: [] };
let toldPod = "";

export function initPods(d: PodsDeps): void {
  deps = d;
}

export function podsState(): PodsState {
  return state;
}

export function ingestPods(msg: ServerMessage): void {
  if (!deps) return;
  const me = deps.me();
  if (msg.t === "pods") {
    state = msg.state;
    const mine = state.pods.find((p) => p.person === me && p.here);
    // Once you have a pod (and others are here to share the floor with), say where.
    if (mine && mine.pod !== toldPod && state.pods.filter((p) => p.here).length > 1) {
      toldPod = mine.pod;
      deps.toast(`🪑 Your pod: Pod ${mine.pod}, on the team floor (3) — its desks are yours to hire at`);
    }
    deps.changed(state);
  } else if (msg.t === "borrow") {
    const d = deps;
    if (msg.event === "asked" && msg.owner === me) {
      const answer = (yes: boolean) => () => d.send({ t: "borrowAnswer", deskId: msg.deskId, yes });
      d.ask(`borrow-${msg.deskId}-${msg.borrower}`, `${msg.text}. Lend it? It works for ${msg.borrower} until it's given back or the task's done.`, { label: `✅ Lend ${msg.worker}`, run: answer(true) }, { label: "🙅 Not now", run: answer(false) });
    } else if (msg.event === "asked") {
      d.toast(`🤝 Asked ${msg.owner} if you can borrow ${msg.worker}…`);
    } else {
      d.toast(msg.text, msg.event === "refused" || msg.event === "declined" ? "warn" : "");
    }
  }
}

/** The 🤝 bit of a worker's tile: who it's lent to, and the button you get. `theirs`: you may not direct it. */
export function borrowHtml(d: Desk, me: string, theirs: boolean, canAsk: boolean): string {
  const w = d.worker;
  if (!w) return "";
  const loan = state.loans.find((l) => l.deskId === d.id);
  if (w.lentTo) {
    if (w.lentTo === me) return `<span class="mon-lent">🤝 ${esc(w.hiredBy)}'s, lent to you</span> <button class="btn small" data-borrow="return" title="Give it back to ${esc(w.hiredBy)}">↩ Give back</button>`;
    if (w.hiredBy === me) return `<span class="mon-lent">🤝 Lent to ${esc(w.lentTo)}</span> <button class="btn small" data-borrow="return" title="Call it back from ${esc(w.lentTo)}">↩ Call back</button>`;
    return `<span class="mon-lent">🤝 Lent to ${esc(w.lentTo)}</span>`;
  }
  if (loan?.state === "asked" && loan.borrower === me) return `<span class="mon-lent">⏳ Asked ${esc(loan.owner)}</span> <button class="btn small" data-borrow="return" title="Never mind">✕</button>`;
  if (loan?.state === "asked" && loan.owner === me) return `<span class="mon-lent">🤝 ${esc(loan.borrower)} asks to borrow it</span> <button class="btn small primary" data-borrow="yes">✅ Lend</button> <button class="btn small" data-borrow="no">🙅</button>`;
  if (theirs && canAsk && !loan) return `<button class="btn small" data-borrow="ask" title="Ask ${esc(w.hiredBy)} to lend it to you">🤝 Ask to borrow</button>`;
  return "";
}

/** A key for whether the 🤝 bit needs redrawing. */
export function borrowKey(deskId: string): string {
  const l = state.loans.find((x) => x.deskId === deskId);
  return l ? `${l.state}|${l.owner}|${l.borrower}` : "";
}

/** Answer the 🤝 buttons clicked inside this element (a worker's tile). */
export function wireBorrow(el: HTMLElement, deskId: string): void {
  el.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-borrow]");
    if (!b || !deps) return;
    e.stopPropagation();
    const a = b.dataset.borrow;
    if (a === "ask") deps.send({ t: "borrowAsk", deskId });
    else if (a === "return") deps.send({ t: "borrowReturn", deskId });
    else deps.send({ t: "borrowAnswer", deskId, yes: a === "yes" });
    (b as HTMLButtonElement).disabled = true;
  });
}
