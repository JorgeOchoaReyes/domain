import type { ClientMessage, Desk } from "../../shared/protocol.js";
import { AGENT_LABELS } from "../../shared/protocol.js";
import type { Goal } from "../../shared/progress.js";
import { matchTake } from "../../shared/huddle.js";
import { esc, openModal, type Modal } from "./modal.js";
import "../styles/huddle.css";

/**
 * The team huddle, as you watch it: the draft plan down one side, and each
 * teammate's card — waiting, or what they said (concerns, suggestions, the
 * task they'd take) — while they gather round the stand-up circle in the
 * office. Then the planner revises the plan, and the tasks go out. Skip it
 * any time: the plan as it stands goes out straight away.
 */

export interface HuddleCtx {
  goal(goalId: string): Goal | undefined;
  desks(): Desk[];
  send(msg: ClientMessage): void;
}

let open: { modal: Modal; timer: number } | null = null;

function who(desks: Desk[], deskId: string): string {
  const d = desks.find((x) => x.id === deskId);
  const w = d?.worker;
  if (!w) return deskId.replace("desk-", "desk ");
  return w.identity?.name ? `${w.identity.name} · ${AGENT_LABELS[w.agent]}` : `${AGENT_LABELS[w.agent]} · ${d!.label}`;
}

/** The huddle as html: the draft, then a card per teammate. */
export function huddleHtml(goal: Goal, desks: Desk[], now = Date.now()): string {
  const h = goal.huddle;
  if (!h) return `<p class="hint-sm">The huddle is over — the plan's tasks are on the goal.</p>`;
  const left = Math.max(0, Math.ceil((h.endsAt - now) / 1000));
  const clockText = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  const status =
    h.status === "gathering"
      ? `🤝 ${h.notes.length} of ${h.deskIds.length} weighed in · ${clockText} left to gather`
      : `✏️ ${esc(who(desks, h.plannerDesk))} is revising the plan from the notes · ${clockText} left`;
  const claimed = new Map<number, string>();
  for (const n of h.notes) {
    const i = n.take ? matchTake(n.take, h.draft) : null;
    if (i !== null && !claimed.has(i)) claimed.set(i, n.name);
  }
  const draft = h.draft
    .map((t, i) => `<li><span>${esc(t)}</span>${claimed.has(i) ? `<em class="hd-claim">🙋 ${esc(claimed.get(i)!)}</em>` : ""}</li>`)
    .join("");
  const cards = h.deskIds
    .map((d) => {
      const n = h.notes.find((x) => x.deskId === d);
      const lines = n
        ? [
            ...n.concerns.map((c) => `<li class="concern">⚠ ${esc(c)}</li>`),
            ...n.suggestions.map((s) => `<li class="suggest">💡 ${esc(s)}</li>`),
            n.take ? `<li class="take">🙋 I'll take ${esc(n.take)}</li>` : "",
          ].join("")
        : `<li class="waiting">💭 reading the draft…</li>`;
      return `<div class="hd-card ${n ? "in" : ""}"><b>${esc(who(desks, d))}</b><ul>${lines}</ul></div>`;
    })
    .join("");
  return `
    <p class="hd-status">${status}</p>
    <div class="hd-grid">
      <section class="hd-draft"><h4>📝 The draft plan · ${esc(who(desks, h.plannerDesk))}</h4><ol>${draft}</ol></section>
      <section class="hd-team"><h4>👥 The team weighs in</h4>${cards}</section>
    </div>`;
}

/** Open the huddle window for a goal; it follows along until the huddle's over. */
export function openHuddle(goalId: string, ctx: HuddleCtx): void {
  closeHuddle();
  const goal = ctx.goal(goalId);
  if (!goal) return;
  const body = document.createElement("div");
  body.className = "huddle";
  const footer = document.createElement("div");
  footer.className = "hd-foot";
  footer.innerHTML = `<span class="grow">Everyone gets a minute to weigh in, then the plan is revised and split into tasks.</span><button class="btn small skip">⏭ Skip — go with the plan</button>`;
  const modal = openModal({ title: `Team huddle · ${goal.title}`, icon: "🤝", className: "huddle-modal", body, footer, onClose: () => stop() });
  let key = "";
  const draw = () => {
    const g = ctx.goal(goalId);
    if (!g) return modal.close();
    const html = huddleHtml(g, ctx.desks());
    if (html !== key) body.innerHTML = key = html;
    footer.querySelector<HTMLButtonElement>(".skip")!.disabled = !g.huddle;
  };
  footer.querySelector(".skip")!.addEventListener("click", () => ctx.send({ t: "huddleSkip", goalId }));
  draw();
  const timer = window.setInterval(draw, 1000);
  const stop = () => {
    window.clearInterval(timer);
    if (open?.modal === modal) open = null;
  };
  open = { modal, timer };
}

export function closeHuddle(): void {
  open?.modal.close();
  open = null;
}
