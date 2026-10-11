import { attachHtml, wireAttach } from "./attach.js";
import type { Desk } from "../../shared/protocol.js";
import { AGENT_LABELS } from "../../shared/protocol.js";
import type { Goal, GoalTask } from "../../shared/progress.js";
import {
  DEFAULT_AUDIT_ROUNDS,
  LEASH_ICON,
  LEASH_LABEL,
  ON_TIME_UP_LABEL,
  TIME_BUDGETS,
  modelLabel,
  type OnTimeUp,
  type TaskBrief,
  type TeamPolicy,
} from "../../shared/policy.js";
import { basisLabel, estimateLabel, estimateTask, type EstimateSample } from "../../shared/estimate.js";
import { AGENT_COLOR } from "../scene/characters.js";
import { esc, openModal } from "./modal.js";
import { workerName } from "./team.js";
import { micButton, wireMic } from "../voice.js";
import { fitsModel, isLocalModel, modelChoices, suggestLocal, taskSize } from "../../shared/localModels.js";
import { loopState } from "./loop.js";
import { openRepos } from "./projects.js";

/**
 * The assignment card: handing a task to a worker on your terms. Who does it,
 * on which model, how long it gets and what happens when time's up, whether
 * it shows you a plan before touching anything, and what "done" means for
 * this task. It opens filled in with the team's defaults, so a plain "Assign"
 * is one click. Up top, an estimate — how long it'll likely take and what
 * it'll cost on the model picked — that follows whatever you change.
 */

export interface AssignOptions {
  goal: Goal;
  task: GoalTask;
  desks: Desk[];
  policy: TeamPolicy;
  /** The worker to start with, if one was picked already. */
  deskId?: string;
  /** Tasks each desk is already on, to show who's free. */
  busy: Map<string, string>;
  /** Finished tasks, estimate vs. what they took (the estimate learns from them). */
  history?: EstimateSample[];
  onAssign(deskId: string, brief: TaskBrief): void;
  onEditPolicy(): void;
  /** "＋ Add a repo": the Add-a-repo chooser, then `then` with the new repo's folder. */
  addRepoThen?(then: (path: string) => void): void;
}

export function openAssignCard(o: AssignOptions): void {
  const staffed = o.desks.filter((d) => d.worker);
  if (!staffed.length) return;
  const free = staffed.filter((d) => !o.busy.has(d.id));
  let deskId = o.deskId && staffed.some((d) => d.id === o.deskId) ? o.deskId : (free[0] ?? staffed[0]).id;
  // The task's last brief (if it was handed out before) or the team's defaults.
  const start = o.task.brief ?? null;
  let model = start?.model ?? "";
  let minutes = start?.minutes ?? o.policy.minutes;
  let onTimeUp: OnTimeUp = start?.onTimeUp ?? o.policy.onTimeUp;
  let planFirst = start?.planFirst ?? o.policy.planFirst;
  const done = [...(start?.done ?? o.policy.done)];
  // Pair workers: another worker audits it before it comes to you.
  let auditor = start?.auditor ?? "";
  let rounds = start?.rounds ?? DEFAULT_AUDIT_ROUNDS;
  let auditWhen: "end" | "along" = start?.auditWhen ?? "end";
  // With other repos open: which one it's done in ("": the worker's own).
  const repos = openRepos();
  let repo = start?.repo ?? "";
  const samePath = (a: string, b: string) => a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();

  const body = document.createElement("div");
  body.className = "assign";
  body.innerHTML = `
    <div class="as-task">
      <span class="as-kicker">🎯 ${esc(o.goal.title)}</span>
      <h3>${esc(o.task.title)}</h3>
      <div class="as-estimate"></div>
    </div>
    <section>
      <h4>Who</h4>
      <div class="as-workers">
        ${staffed
          .map((d) => {
            const w = d.worker!;
            const on = o.busy.get(d.id);
            return `<button class="as-worker" data-desk="${d.id}">
              <span class="dot" style="background:${AGENT_COLOR[w.agent]}"></span>
              <span class="as-w-main"><b>${esc(workerName(w))}</b><span>${esc(d.label)} · ${esc(modelLabel(w.model))} · ${LEASH_ICON[w.leash]} ${esc(LEASH_LABEL[w.leash].toLowerCase())}</span></span>
              <span class="as-w-state ${on ? "busy" : "free"}">${on ? `on: ${esc(on.slice(0, 22))}` : "free"}</span>
            </button>`;
          })
          .join("")}
      </div>
    </section>
    ${
      repos.length > 1
        ? `<section>
      <h4>📂 Repo <span class="as-hint">where it's done — a worker in another repo moves there first</span></h4>
      <div class="seg as-repos"></div>
    </section>`
        : ""
    }
    <section>
      <h4>Model <span class="as-hint">for this task</span></h4>
      <div class="seg as-models"></div>
      <p class="as-note as-model-note"></p>
    </section>
    <section>
      <h4>Time budget</h4>
      <div class="seg as-time">
        ${TIME_BUDGETS.map((m) => `<button data-m="${m}">${m ? `${m} min` : "No limit"}</button>`).join("")}
      </div>
      <div class="seg as-timeup">
        ${(Object.keys(ON_TIME_UP_LABEL) as OnTimeUp[]).map((k) => `<button data-u="${k}">${k === "wrapup" ? "⏹" : "👋"} When time's up: ${esc(ON_TIME_UP_LABEL[k])}</button>`).join("")}
      </div>
    </section>
    <section>
      <label class="as-check"><input type="checkbox" class="as-plan" ${planFirst ? "checked" : ""} />
        <span><b>🧠 Plan first</b> — it presents a plan in your office before touching any code; you approve it, then it builds</span></label>
    </section>
    <section>
      <h4>🔍 Audited by <span class="as-hint">another worker checks it, back and forth, before it reaches you</span></h4>
      <div class="seg as-auditors"></div>
      <div class="seg as-when"><button data-w="end">✅ When it's done</button><button data-w="along">🔁 Along the way — checkpoints too</button></div>
      <div class="seg as-rounds"><span class="as-hint">Send it back at most</span>${[1, 2, 3, 4, 5].map((n) => `<button data-r="${n}">${n}×</button>`).join("")}</div>
    </section>
    <section>
      <h4>Done means <span class="as-hint">one per line — it's held to these in the review</span></h4>
      <textarea class="as-done" rows="3">${esc(done.join("\n"))}</textarea>
    </section>
    <section>
      <h4>🗣 Anything else they should know? <span class="as-hint">optional — type it, or ${micButton("as-mic") ? "press 🎤 and say it" : "jot it down"}</span></h4>
      <div class="as-notes-row"><textarea class="as-notes" rows="2" placeholder="e.g. Keep the old endpoint working, and ask me before adding a dependency">${esc(start?.notes ?? "")}</textarea>${micButton("as-mic")}</div>
      ${attachHtml()}
    </section>`;

  const footer = document.createElement("div");
  footer.style.display = "contents";
  footer.innerHTML = `<button class="btn policy">🛠 Team defaults</button><span class="grow"></span><button class="btn primary go">👉 Assign</button>`;
  const modal = openModal({ title: "Hand out a task", icon: "📋", className: "assign-modal", body, footer });

  const worker = () => staffed.find((d) => d.id === deskId)!.worker!;
  const renderWorkers = () =>
    body.querySelectorAll<HTMLElement>(".as-worker").forEach((b) => b.classList.toggle("on", b.dataset.desk === deskId));
  const renderModels = () => {
    const w = worker();
    const local = loopState.config?.localModels ?? [];
    const choices = modelChoices(w.agent, o.policy.models[w.agent], local, [w.model]).filter((m) => m !== w.model);
    if (!choices.includes(model)) model = "";
    body.querySelector(".as-models")!.innerHTML = [
      ...choices.filter((m) => m === ""),
      ...choices.filter((m) => m !== ""),
    ]
      .map((m) => `<button data-model="${esc(m)}" class="${m === model ? "on" : ""}" ${isLocalModel(m) ? `title="On this computer: free and private"` : ""}>${m === "" ? `Keep ${esc(modelLabel(w.model))}` : esc(modelLabel(m))}</button>`)
      .join("");
    const note = body.querySelector<HTMLElement>(".as-model-note")!;
    const using = model || w.model;
    // A small task about to go to a cloud model: one on this computer could do it, free.
    const size = taskSize(o.task.title, minutes, body.querySelector<HTMLTextAreaElement>(".as-notes")?.value ?? "");
    const try_ = suggestLocal(w.agent, using, size, local);
    if (try_) {
      note.innerHTML = `💡 This looks small — <b>${esc(modelLabel(try_))}</b> on this computer could do it, free and private. <button class="btn small as-use-local" data-model="${esc(try_)}">Use it</button>`;
      note.querySelector<HTMLButtonElement>(".as-use-local")!.addEventListener("click", () => {
        model = try_;
        renderModels();
      });
    } else if (!fitsModel(using, size)) {
      note.textContent = `⚠️ This looks big for ${modelLabel(using)} — a small local model can lose the thread on large tasks. Split it, or pick a cloud model.`;
    } else if (model && model !== w.model) {
      note.textContent =
        w.agent === "claude"
          ? `Claude Code switches to ${modelLabel(model)} in place and keeps its context.`
          : `${AGENT_LABELS[w.agent]} picks its model at launch, so it restarts on ${modelLabel(model)} (a fresh session).`;
    } else note.textContent = "";
    body.querySelectorAll<HTMLButtonElement>(".as-models button").forEach((b) =>
      b.addEventListener("click", () => {
        model = b.dataset.model ?? "";
        renderModels();
      }),
    );
  };
  const renderRepos = () => {
    const el = body.querySelector(".as-repos");
    if (!el) return;
    // The worker's own repo is the default: picking it is the same as not picking.
    const own = repos.find((r) => samePath(r.path, worker().repo ?? repos[0].path)) ?? repos[0];
    if (repo && samePath(repo, own.path)) repo = "";
    el.innerHTML = [
      `<button data-repo="" class="${repo ? "" : "on"}">Its own · ${esc(own.name)}</button>`,
      ...repos.filter((r) => r !== own).map((r) => `<button data-repo="${esc(r.path)}" class="${repo && samePath(repo, r.path) ? "on" : ""}">${esc(r.name)}</button>`),
      ...(o.addRepoThen ? [`<button data-repo="+add" class="as-add-repo" title="Open another repo — from this computer, GitHub, a folder, or a new one">＋ Add a repo</button>`] : []),
    ].join("");
    el.querySelectorAll<HTMLButtonElement>("button").forEach((b) =>
      b.addEventListener("click", () => {
        if (b.dataset.repo === "+add") {
          // Add one, then back to this card with it picked.
          const brief: TaskBrief = { model, minutes, onTimeUp, planFirst, done: [...done], ...(auditor ? { auditor, rounds, auditWhen } : {}) };
          modal.close();
          o.addRepoThen!((path) => openAssignCard({ ...o, deskId, task: { ...o.task, brief: { ...brief, repo: path } } }));
          return;
        }
        repo = b.dataset.repo ?? "";
        renderRepos();
      }),
    );
  };
  // Anyone but the worker doing it can audit it.
  const renderAuditors = () => {
    if (auditor === deskId) auditor = "";
    const others = staffed.filter((d) => d.id !== deskId);
    body.querySelector(".as-auditors")!.innerHTML = [
      `<button data-a="" class="${auditor ? "" : "on"}">Nobody — it comes straight to you</button>`,
      ...others.map((d) => `<button data-a="${esc(d.id)}" class="${auditor === d.id ? "on" : ""}">${esc(workerName(d.worker!))} · ${esc(d.label)}</button>`),
    ].join("");
    body.querySelectorAll<HTMLButtonElement>(".as-auditors button").forEach((b) =>
      b.addEventListener("click", () => {
        auditor = b.dataset.a ?? "";
        renderAuditors();
      }),
    );
    const roundsEl = body.querySelector<HTMLElement>(".as-rounds")!;
    roundsEl.style.display = auditor ? "" : "none";
    const whenEl = body.querySelector<HTMLElement>(".as-when")!;
    whenEl.style.display = auditor ? "" : "none";
    whenEl.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.classList.toggle("on", b.dataset.w === auditWhen));
    roundsEl.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.classList.toggle("on", Number(b.dataset.r) === rounds));
  };
  body.querySelectorAll<HTMLButtonElement>(".as-when button").forEach((b) =>
    b.addEventListener("click", () => {
      auditWhen = b.dataset.w === "along" ? "along" : "end";
      renderAuditors();
    }),
  );
  body.querySelectorAll<HTMLButtonElement>(".as-rounds button").forEach((b) =>
    b.addEventListener("click", () => {
      rounds = Number(b.dataset.r);
      renderAuditors();
    }),
  );
  const renderTime = () => {
    body.querySelectorAll<HTMLElement>(".as-time button").forEach((b) => b.classList.toggle("on", Number(b.dataset.m) === minutes));
    body.querySelectorAll<HTMLElement>(".as-timeup button").forEach((b) => {
      b.classList.toggle("on", b.dataset.u === onTimeUp);
      (b as HTMLButtonElement).disabled = minutes === 0;
    });
  };

  body.querySelectorAll<HTMLElement>(".as-worker").forEach((b) =>
    b.addEventListener("click", () => {
      deskId = b.dataset.desk!;
      renderWorkers();
      renderModels();
      renderRepos();
      renderAuditors();
    }),
  );
  body.querySelectorAll<HTMLElement>(".as-time button").forEach((b) =>
    b.addEventListener("click", () => {
      minutes = Number(b.dataset.m);
      renderTime();
      // The time budget says how big it is: the model note follows.
      renderModels();
    }),
  );
  body.querySelectorAll<HTMLElement>(".as-timeup button").forEach((b) =>
    b.addEventListener("click", () => {
      onTimeUp = b.dataset.u as OnTimeUp;
      renderTime();
    }),
  );
  body.querySelector<HTMLInputElement>(".as-plan")!.addEventListener("change", (e) => (planFirst = (e.target as HTMLInputElement).checked));
  const doneEl = body.querySelector<HTMLTextAreaElement>(".as-done")!;
  doneEl.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") e.stopPropagation();
  });
  const notesEl = body.querySelector<HTMLTextAreaElement>(".as-notes")!;
  notesEl.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") e.stopPropagation();
  });
  wireMic(body.querySelector<HTMLButtonElement>(".as-mic"), notesEl);
  const attached = wireAttach(body);
  footer.querySelector(".policy")!.addEventListener("click", () => {
    modal.close();
    o.onEditPolicy();
  });
  footer.querySelector(".go")!.addEventListener("click", () => {
    const lines = doneEl.value.split("\n").map((x) => x.trim()).filter(Boolean);
    modal.close();
    const notes = notesEl.value.trim();
    const files = attached();
    o.onAssign(deskId, { model, minutes, onTimeUp, planFirst, done: lines.length ? lines : [...o.policy.done], ...(auditor ? { auditor, rounds, auditWhen } : {}), ...(notes ? { notes } : {}), ...(files.length ? { files } : {}), ...(repo ? { repo } : {}) });
  });

  // The estimate follows every choice on the card (worker, model, plan first, audit, notes, files).
  const renderEstimate = () => {
    const w = worker();
    const e = estimateTask(
      {
        title: o.task.title,
        notes: notesEl.value,
        done: doneEl.value.split("\n").filter((x) => x.trim()).length,
        files: attached().length,
        planFirst,
        audited: !!auditor,
        agent: w.agent,
        model: model || w.model,
      },
      o.history ?? [],
    );
    const over = minutes > 0 && e.minutes > minutes;
    body.querySelector(".as-estimate")!.innerHTML =
      `<span class="as-est ${e.local ? "local" : ""}">⏳ ${esc(estimateLabel(e))}</span><span class="as-hint">${esc(basisLabel(e))}</span>` +
      (over ? `<span class="as-est-warn">⚠ more than its ${minutes} min budget</span>` : "");
  };
  for (const ev of ["click", "input", "change"]) body.addEventListener(ev, () => setTimeout(renderEstimate, 0));

  renderWorkers();
  renderModels();
  renderRepos();
  renderTime();
  renderAuditors();
  renderEstimate();
  footer.querySelector<HTMLButtonElement>(".go")!.focus();
}
