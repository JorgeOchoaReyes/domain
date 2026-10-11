import { micButton, wireMic } from "../voice.js";
import type { Desk, Presentation } from "../../shared/protocol.js";
import { AGENT_LABELS } from "../../shared/protocol.js";
import { STAGE_ICON, XP, briefLine, goalProgress, goalStage, stageLabel, type Goal, type GoalKind, type ProgressState, type TaskStatus, dueLabel, toLocalInput } from "../../shared/progress.js";
import { taskEstimateLine } from "../../shared/estimate.js";
import { AGENT_COLOR } from "../scene/characters.js";
import { esc, openModal, type Modal } from "./modal.js";
import { onLoop, renderLoop, type LoopHandlers } from "./loop.js";
import { icon } from "./icons.js";
import { isGithubProject } from "./projects.js";
import { openIssuesImport, prChipHtml } from "./github.js";

/**
 * The Goals window: your goals and where each is in the loop on the left; on
 * the right the picked goal's loop — Plan → Build → Review → Ship → Shipped
 * (Research → Present → Delivered for research goals) with the one thing to
 * do next — and its tasks, where you put a worker on a task, tick it off, add
 * more, or focus a session on it. "New goal" sets one up (build or research),
 * with a few templates to start from.
 */

export interface GoalActions {
  create(title: string, why: string, tasks: string[], kind: GoalKind, dueAt?: number | null): void;
  /** When a goal is due (null: no deadline). */
  due?(goalId: string, dueAt: number | null): void;
  /** Give a goal to a group of workers (empty: none). */
  group?(goalId: string, deskIds: string[]): void;
  /** The loop's actions (plan, ship, round up…). Without it the window shows no loop controls. */
  loop?: LoopHandlers;
  remove(goalId: string): void;
  addTask(goalId: string, title: string): void;
  assign(goalId: string, taskId: string, deskId: string): void;
  done(goalId: string, taskId: string, done: boolean): void;
  focus(goalId: string): void;
  /** Open the team policy (defaults for hires and assignments). */
  policy?(): void;
}

const STATUS: Record<TaskStatus, [string, string]> = {
  todo: ["To do", "#e9ecef"],
  doing: ["⌨️ In progress", "#ffd166"],
  review: ["🎤 In review", "#e0c3fc"],
  done: ["✅ Done", "#06d6a0"],
};

const TEMPLATES: { icon: string; title: string; why: string; tasks: string[]; kind?: GoalKind }[] = [
  {
    icon: "🚀",
    title: "Ship a feature",
    why: "Get it in front of users this week",
    tasks: ["Write a short spec", "Build the core flow", "Add tests", "Polish the UI", "Write the release notes"],
  },
  {
    icon: "🐛",
    title: "Bug bash",
    why: "Clear the backlog of annoying bugs",
    tasks: ["Triage open bugs", "Fix the top crash", "Fix flaky tests", "Add regression tests"],
  },
  {
    icon: "📚",
    title: "Docs day",
    why: "Make the project easy to pick up",
    tasks: ["Update the README", "Document the API", "Add a getting-started guide"],
  },
  {
    icon: "🧹",
    title: "Clean-up sprint",
    why: "Pay down tech debt",
    tasks: ["Remove dead code", "Upgrade dependencies", "Speed up the build"],
  },
  {
    icon: "📊",
    title: "Research report",
    why: "Get to a clear recommendation, as a deck",
    tasks: ["Frame the question", "Survey the options", "Compare them side by side", "Recommend a direction"],
    kind: "research",
  },
];

export class GoalsWindow {
  private modal: Modal | null = null;
  private selected: string | "new" | null = null;
  private progress: ProgressState | null = null;
  private desks: Desk[] = [];
  private line: Presentation[] = [];
  private listEl!: HTMLElement;
  private detailEl!: HTMLElement;
  private detailKey = "";

  constructor(private actions: GoalActions) {
    // The project's config or a deploy changed what "next" means.
    onLoop((msg) => {
      if (msg.t !== "config" || !this.modal) return;
      this.detailKey = "";
      this.render();
    });
  }

  get isOpen(): boolean {
    return this.modal !== null;
  }

  open(progress: ProgressState, desks: Desk[], select?: string | "new"): void {
    this.progress = progress;
    this.desks = desks;
    this.selected = select ?? (progress.goals.find((g) => !g.doneAt)?.id ?? progress.goals[0]?.id ?? "new");
    const body = document.createElement("div");
    body.className = "goals";
    body.innerHTML = `
      <aside class="goal-list"></aside>
      <section class="goal-detail"></section>`;
    this.listEl = body.querySelector(".goal-list")!;
    this.detailEl = body.querySelector(".goal-detail")!;
    // A fresh window: draw the goal into it even if nothing's changed since last time.
    this.detailKey = "";
    this.modal = openModal({
      title: "Goals",
      icon: "🎯",
      className: "goals-modal",
      body,
      footer: `<span class="grow">Assign tasks to workers · approve their work in a review to check it off · +${XP.taskDone} XP a task, +${XP.goalDone} a goal</span><button class="btn small team-policy">🛠 Team policy</button>`,
      onClose: () => {
        this.modal = null;
      },
    });
    this.modal.footer?.querySelector(".team-policy")?.addEventListener("click", () => this.actions.policy?.());
    this.listEl.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-goal]");
      if (!el) return;
      this.selected = el.dataset.goal!;
      this.detailKey = "";
      this.render();
    });
    this.render();
  }

  /** New state from the server: re-render what changed. */
  update(progress: ProgressState, desks: Desk[], line?: Presentation[]): void {
    this.progress = progress;
    this.desks = desks;
    if (line) this.line = line;
    if (!this.modal) return;
    // A goal that was just created gets picked.
    if (this.selected === "new" && this.pendingTitle) {
      const made = progress.goals.find((g) => g.title === this.pendingTitle);
      if (made) {
        this.selected = made.id;
        this.pendingTitle = null;
        this.detailKey = "";
      }
    }
    if (this.selected && this.selected !== "new" && !progress.goals.some((g) => g.id === this.selected)) {
      this.selected = progress.goals[0]?.id ?? "new";
      this.detailKey = "";
    }
    this.render();
  }

  close(): void {
    this.modal?.close();
  }

  private pendingTitle: string | null = null;

  private render(): void {
    const p = this.progress!;
    this.listEl.innerHTML =
      p.goals
        .map((g) => {
          const pr = goalProgress(g);
          const st = goalStage(g);
          return `<button class="goal-card ${g.id === this.selected ? "sel" : ""} ${g.shippedAt ? "done" : ""}" data-goal="${g.id}">
            <span class="gc-title">${g.shippedAt ? "🏁 " : g.kind === "research" ? "📊 " : ""}${esc(g.title)}</span>
            <span class="gc-meta">${STAGE_ICON[st]} ${stageLabel(st, g.kind)} · ${pr.done}/${pr.total} tasks${g.dueAt && !g.shippedAt ? ` · <b class="${g.dueAt < Date.now() ? "overdue" : ""}">${esc(dueLabel(g.dueAt))}</b>` : ""}${g.group?.length ? ` · 👥 ${g.group.length}` : ""}</span>
            <span class="bar"><span style="width:${Math.round(pr.pct * 100)}%"></span></span>
          </button>`;
        })
        .join("") +
      `<button class="goal-card new ${this.selected === "new" ? "sel" : ""}" data-goal="new"><span class="gc-title">＋ New goal</span></button>`;

    if (this.selected === "new") {
      if (this.detailKey !== "new") {
        this.detailKey = "new";
        this.renderNew();
      }
      return;
    }
    const goal = p.goals.find((g) => g.id === this.selected);
    if (!goal) return;
    const key = JSON.stringify([goal, this.progress!.goals.map((g) => [g.id, g.planningDesk, g.tasks.map((t) => t.deskId)]), this.desks.map((d) => [d.id, d.worker?.agent, d.worker?.status]), this.line.map((l) => [l.deskId, !!l.report])]);
    if (key === this.detailKey) return;
    this.detailKey = key;
    this.renderGoal(goal);
  }

  private renderGoal(goal: Goal): void {
    const pr = goalProgress(goal);
    const staffed = this.desks.filter((d) => d.worker);
    const busy = new Map<string, string>();
    for (const g of this.progress!.goals) for (const t of g.tasks) if (t.deskId && t.status !== "done") busy.set(t.deskId, t.title);
    const draft = this.detailEl.querySelector<HTMLInputElement>(".add-task input")?.value ?? "";
    const hadFocus = document.activeElement?.closest(".add-task") != null;

    this.detailEl.innerHTML = `
      <div class="gd-head">
        <div>
          <h3>${goal.shippedAt ? "🏁 " : goal.kind === "research" ? "📊 " : ""}${esc(goal.title)}</h3>
          ${goal.why ? `<p class="why">${esc(goal.why)}</p>` : ""}
          ${goal.pr ? `<div class="gd-pr">${prChipHtml(goal.pr)}</div>` : ""}
          ${goal.agentPrs?.length ? `<div class="gd-pr">${goal.agentPrs.map((p) => `<span class="gd-agent-pr">${esc(p.name)} ${prChipHtml(p)}</span>`).join(" ")}</div>` : ""}
        </div>
        <div class="gd-pct ${goal.doneAt ? "done" : ""}">${Math.round(pr.pct * 100)}%</div>
      </div>
      <div class="bar big"><span style="width:${Math.round(pr.pct * 100)}%"></span></div>
      ${
        this.actions.due
          ? `<div class="gd-due"><span>📅 Due</span><input type="datetime-local" class="g-due" value="${goal.dueAt ? toLocalInput(goal.dueAt) : ""}" />${goal.dueAt ? `<b class="${goal.dueAt < Date.now() ? "overdue" : ""}">${esc(dueLabel(goal.dueAt))}</b><button class="btn small g-due-clear">No deadline</button>` : `<span class="hint-sm">I'll remind you as it gets close</span>`}</div>`
          : ""
      }
      ${
        this.actions.group && staffed.length > 1
          ? `<div class="gd-group"><span>👥 Group</span>${staffed
              .map((d) => `<label class="g-member"><input type="checkbox" value="${d.id}" ${goal.group?.includes(d.id) ? "checked" : ""} /> ${esc(AGENT_LABELS[d.worker!.agent])} · ${esc(d.label)}</label>`)
              .join("")}<button class="btn small g-group-go">${goal.group?.length ? "Update the group" : "Give it to them"}</button><span class="hint-sm">One plans it, then tasks go out across them as each finishes.</span></div>`
          : ""
      }
      <div class="gd-loop"></div>
      <ul class="tasks">
        ${goal.tasks
          .map((t) => {
            const [label, bg] = STATUS[t.status];
            const desk = t.deskId ? this.desks.find((d) => d.id === t.deskId) : undefined;
            const who = desk?.worker
              ? `<span class="who"><span class="dot" style="background:${AGENT_COLOR[desk.worker.agent]}"></span>${esc(AGENT_LABELS[desk.worker.agent])} · ${esc(desk.label)}${briefLine(t) ? ` <span class="brief-line">${esc(briefLine(t))}</span>` : ""}</span>`
              : "";
            const options = staffed
              .map((d) => {
                const w = d.worker!;
                const on = busy.get(d.id);
                return `<option value="${d.id}">${esc(AGENT_LABELS[w.agent])} · ${esc(d.label)}${on ? ` (on: ${esc(on.slice(0, 24))})` : ""}</option>`;
              })
              .join("");
            const assign =
              t.status === "done"
                ? ""
                : staffed.length
                  ? `<select class="assign" data-task="${t.id}"><option value="">${t.deskId ? "Reassign…" : "Assign to…"}</option>${options}</select>`
                  : `<span class="hint-sm">hire a worker to assign</span>`;
            return `<li class="task ${t.status}">
              <label class="tick"><input type="checkbox" data-task="${t.id}" ${t.status === "done" ? "checked" : ""} /></label>
              <span class="t-title">${esc(t.title)}${taskEstimateLine(t, this.progress!.estimates) ? `<small class="est-line">${esc(taskEstimateLine(t, this.progress!.estimates))}</small>` : ""}</span>
              ${who}
              <span class="pill" style="background:${bg}">${label}</span>
              ${assign}
            </li>`;
          })
          .join("")}
      </ul>
      <div class="add-task webhook"><input type="text" maxlength="160" placeholder="Add a task — or press 🎤 and say it…" />${micButton("small g-mic")}<button class="btn small add">Add</button></div>
      <div class="gd-actions">
        <button class="btn small danger del">🗑 Delete goal</button>
        ${isGithubProject() && this.actions.loop ? `<button class="btn small gh-import">${icon("github", 14)} Import issues</button>` : ""}
        <span class="grow"></span>
        <button class="btn primary focus">⏱ Focus session on this goal</button>
      </div>`;

    const loopEl = this.detailEl.querySelector<HTMLElement>(".gd-loop")!;
    if (this.actions.loop) renderLoop(loopEl, goal, this.desks, this.progress!.goals, this.line, this.actions.loop);
    else loopEl.remove();

    const input = this.detailEl.querySelector<HTMLInputElement>(".add-task input")!;
    wireMic(this.detailEl.querySelector<HTMLButtonElement>(".g-mic"), input);
    input.value = draft;
    if (hadFocus) input.focus();
    const add = () => {
      const v = input.value.trim();
      if (!v) return;
      input.value = "";
      this.actions.addTask(goal.id, v);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") e.stopPropagation();
      if (e.key === "Enter") add();
    });
    this.detailEl.querySelector(".add")!.addEventListener("click", add);
    this.detailEl.querySelectorAll<HTMLInputElement>(".tick input").forEach((cb) =>
      cb.addEventListener("change", () => this.actions.done(goal.id, cb.dataset.task!, cb.checked)),
    );
    this.detailEl.querySelectorAll<HTMLSelectElement>("select.assign").forEach((sel) =>
      sel.addEventListener("change", () => {
        if (sel.value) this.actions.assign(goal.id, sel.dataset.task!, sel.value);
      }),
    );
    const del = this.detailEl.querySelector<HTMLButtonElement>(".del")!;
    del.addEventListener("click", () => {
      // A second click confirms.
      if (del.dataset.armed) this.actions.remove(goal.id);
      else {
        del.dataset.armed = "1";
        del.textContent = "Click again to delete";
        setTimeout(() => {
          delete del.dataset.armed;
          del.textContent = "🗑 Delete goal";
        }, 3000);
      }
    });
    this.detailEl.querySelector(".focus")!.addEventListener("click", () => this.actions.focus(goal.id));
    const dueEl = this.detailEl.querySelector<HTMLInputElement>(".g-due");
    dueEl?.addEventListener("change", () => {
      const t = dueEl.value ? new Date(dueEl.value).getTime() : NaN;
      if (Number.isFinite(t)) this.actions.due?.(goal.id, t);
    });
    this.detailEl.querySelector(".g-due-clear")?.addEventListener("click", () => this.actions.due?.(goal.id, null));
    this.detailEl.querySelector(".g-group-go")?.addEventListener("click", () => {
      const ids = [...this.detailEl.querySelectorAll<HTMLInputElement>(".g-member input:checked")].map((c) => c.value);
      this.actions.group?.(goal.id, ids);
    });
    this.detailEl.querySelector(".gh-import")?.addEventListener("click", () => openIssuesImport(goal.id, (m) => this.actions.loop!.send(m)));
  }

  private renderNew(): void {
    this.detailEl.innerHTML = `
      <h3>Set a new goal</h3>
      <p class="why">Pick something real you want done. Break it into tasks your workers can take on.</p>
      <div class="templates">${TEMPLATES.map((t, i) => `<button class="btn chip" data-t="${i}">${t.icon} ${esc(t.title)}</button>`).join("")}</div>
      <label>Kind</label>
      <div class="kind-pick">
        <button class="kind on" data-kind="build"><b>🛠 Build</b><span>Code that ships — ends in a deploy or a PR</span></button>
        <button class="kind" data-kind="research"><b>📊 Research</b><span>Findings as a slide deck — ends in a presentation</span></button>
      </div>
      <label>Goal</label>
      <input type="text" class="g-title" maxlength="120" placeholder="e.g. Launch the public beta" />
      <label>Why it matters <span class="opt">(optional)</span></label>
      <input type="text" class="g-why" maxlength="240" placeholder="e.g. So the first 100 users can try it" />
      <label>Tasks <span class="opt">(one per line — or leave empty and have a worker plan it)</span></label>
      <textarea class="g-tasks" rows="6" placeholder="Build the sign-up flow&#10;Add analytics&#10;Write the launch post"></textarea>
      <label>Due <span class="opt">(optional — reminders as it gets close)</span></label>
      <input type="datetime-local" class="g-new-due" />
      <div class="gd-actions"><span class="grow">+${XP.createGoal} XP for setting it</span><button class="btn primary create">🎯 Set goal</button></div>`;
    const title = this.detailEl.querySelector<HTMLInputElement>(".g-title")!;
    const why = this.detailEl.querySelector<HTMLInputElement>(".g-why")!;
    const tasks = this.detailEl.querySelector<HTMLTextAreaElement>(".g-tasks")!;
    let kind: GoalKind = "build";
    const setKind = (k: GoalKind) => {
      kind = k;
      this.detailEl.querySelectorAll<HTMLElement>(".kind").forEach((b) => b.classList.toggle("on", b.dataset.kind === k));
    };
    this.detailEl.querySelectorAll<HTMLElement>(".kind").forEach((b) => b.addEventListener("click", () => setKind(b.dataset.kind as GoalKind)));
    for (const el of [title, why, tasks]) {
      el.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key !== "Escape") e.stopPropagation();
      });
    }
    this.detailEl.querySelectorAll<HTMLButtonElement>("[data-t]").forEach((b) =>
      b.addEventListener("click", () => {
        const t = TEMPLATES[Number(b.dataset.t)];
        title.value = t.title;
        why.value = t.why;
        tasks.value = t.tasks.join("\n");
        setKind(t.kind ?? "build");
      }),
    );
    const create = this.detailEl.querySelector<HTMLButtonElement>(".create")!;
    create.addEventListener("click", () => {
      const t = title.value.trim();
      if (!t) {
        title.focus();
        title.classList.add("nudge");
        return;
      }
      this.pendingTitle = t.replace(/\s+/g, " ").slice(0, 120);
      const dueVal = this.detailEl.querySelector<HTMLInputElement>(".g-new-due")?.value;
      const dueAt = dueVal ? new Date(dueVal).getTime() : null;
      this.actions.create(t, why.value.trim(), tasks.value.split("\n").map((x) => x.trim()).filter(Boolean), kind, Number.isFinite(dueAt) ? dueAt : null);
      create.disabled = true;
      create.textContent = "Setting…";
    });
    setTimeout(() => title.focus(), 0);
  }
}
