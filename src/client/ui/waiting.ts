import type { Desk, ClientMessage } from "../../shared/protocol.js";
import type { ProgressState } from "../../shared/progress.js";
import { micButton, wireMic } from "../voice.js";
import { esc, openModal } from "./modal.js";
import { workerName } from "./team.js";

/**
 * A worker waiting at the stand-up: give it a task on the spot — one that's
 * waiting on a goal, or a new one in your own words (tracked and reviewed
 * like any other).
 */
export function openGiveTask(desk: Desk, progress: ProgressState, send: (m: ClientMessage) => void): void {
  if (!desk.worker) return;
  const name = workerName(desk.worker);
  const open = progress.goals
    .filter((g) => !g.shippedAt && !g.doneAt)
    .flatMap((g) => g.tasks.filter((t) => t.status === "todo" && !t.deskId).map((t) => ({ goal: g, task: t })))
    .slice(0, 30);
  const body = document.createElement("div");
  body.className = "give-task";
  body.innerHTML = `
    <p class="ls-intro">🙋 ${esc(name)} is at the stand-up, free. What should it do?</p>
    <form class="gt-new"><input type="text" maxlength="300" placeholder="Something new — e.g. “Fix the flaky login test”" />${micButton()}<button class="btn primary" type="submit">🎯 Work on this</button></form>
    ${
      open.length
        ? `<h4>Or one that's waiting</h4><ul class="gt-list">${open
            .map((o) => `<li><button class="btn small gt-pick" data-g="${esc(o.goal.id)}" data-t="${esc(o.task.id)}">Take it</button> <b>${esc(o.task.title)}</b> <span class="as-hint">${esc(o.goal.title)}</span></li>`)
            .join("")}</ul>`
        : `<p class="ls-none">No tasks waiting on a goal — give it something new.</p>`
    }`;
  const modal = openModal({ title: `A task for ${name}`, icon: "🙋", className: "give-task-modal", body });
  const form = body.querySelector<HTMLFormElement>(".gt-new")!;
  const field = form.querySelector<HTMLInputElement>("input")!;
  wireMic(form.querySelector<HTMLButtonElement>(".mic"), field);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = field.value.trim();
    if (!text) return;
    send({ t: "quickTask", deskId: desk.id, text });
    modal.close();
  });
  body.querySelectorAll<HTMLButtonElement>(".gt-pick").forEach((b) =>
    b.addEventListener("click", () => {
      send({ t: "taskAssign", goalId: b.dataset.g!, taskId: b.dataset.t!, deskId: desk.id });
      modal.close();
    }),
  );
  setTimeout(() => field.focus(), 50);
}
