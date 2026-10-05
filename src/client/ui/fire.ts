import type { Alumnus } from "../../shared/alumni.js";
import type { ServerMessage } from "../../shared/protocol.js";
import { AGENT_LABELS } from "../../shared/protocol.js";
import { esc, openModal } from "./modal.js";

/**
 * Letting a worker go, in two steps: first why (optional, but the whole team
 * learns from it — and maybe it just needs different work), then a clear
 * "yes, send them home". They're kept among your former workers, so you can
 * bring them back from the hire window.
 */

let former: Alumnus[] = [];
const listeners = new Set<() => void>();

export function ingestAlumni(msg: ServerMessage): void {
  if (msg.t !== "alumni") return;
  former = msg.list;
  for (const l of listeners) l();
}

export function formerWorkers(): Alumnus[] {
  return former;
}

export function onAlumniChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function openFire(o: { name: string; onFire(reason: string): void; onReassign(): void }): void {
  const body = document.createElement("div");
  body.className = "fire";
  const footer = document.createElement("div");
  footer.style.display = "contents";
  const modal = openModal({ title: `Let ${o.name} go?`, icon: "👋", className: "fire-modal", body, footer });
  let reason = "";

  const step1 = () => {
    body.innerHTML = `
      <p class="fi-lead">Before they go — <b>why?</b> It's optional, but the whole team learns from it (it goes into their lessons), so the next one doesn't make the same mistake.</p>
      <textarea class="fi-why" rows="3" placeholder="e.g. Kept skipping the tests · Changed files it wasn't asked to · Too slow for this kind of work">${esc(reason)}</textarea>
      <p class="fi-alt">Not working out on <i>this</i> task? <button class="link fi-reassign">Give them different work instead</button></p>`;
    footer.innerHTML = `<button class="btn fi-cancel">Keep them</button><span class="grow"></span><button class="btn danger fi-next">Next →</button>`;
    const why = body.querySelector<HTMLTextAreaElement>(".fi-why")!;
    why.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") e.stopPropagation();
    });
    setTimeout(() => why.focus(), 0);
    footer.querySelector(".fi-cancel")!.addEventListener("click", () => modal.close());
    body.querySelector(".fi-reassign")!.addEventListener("click", () => {
      modal.close();
      o.onReassign();
    });
    footer.querySelector(".fi-next")!.addEventListener("click", () => {
      reason = why.value.trim();
      step2();
    });
  };

  const step2 = () => {
    body.innerHTML = `
      <p class="fi-lead"><b>${esc(o.name)}</b> stops work now and goes home. Anything not on your branch yet stays on theirs.</p>
      ${reason ? `<blockquote class="fi-quote">“${esc(reason)}” — the team will learn from this.</blockquote>` : `<p class="fi-nudge">💡 You didn't say why. A line helps the team learn — <button class="link fi-back">add one</button>?</p>`}
      <p class="fi-note">You can bring them back any time: <b>Hire</b> at any free desk → <b>Former workers</b>.</p>`;
    footer.innerHTML = `<button class="btn fi-back2">← Back</button><span class="grow"></span><button class="btn danger fi-go">👋 Yes, send ${esc(o.name)} home</button>`;
    body.querySelector(".fi-back")?.addEventListener("click", step1);
    footer.querySelector(".fi-back2")!.addEventListener("click", step1);
    footer.querySelector(".fi-go")!.addEventListener("click", () => {
      modal.close();
      o.onFire(reason);
    });
  };

  step1();
}

/** A former worker's line in the hire window. */
export function alumnusHtml(a: Alumnus): string {
  const when = new Date(a.at).toLocaleDateString([], { month: "short", day: "numeric" });
  return `<li class="fw-row" data-alum="${esc(a.id)}"><div><b>${esc(a.name)}</b> <span class="tm-sub">${esc(AGENT_LABELS[a.agent])}${a.model ? ` · ${esc(a.model)}` : ""} · left ${esc(when)}${a.tasksDone ? ` · ${a.tasksDone} task${a.tasksDone === 1 ? "" : "s"} done` : ""}</span>${a.reason ? `<div class="fw-why">“${esc(a.reason)}”</div>` : ""}</div><button class="btn small fw-back">↩ Bring back</button></li>`;
}
