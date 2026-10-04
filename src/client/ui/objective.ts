import type { Desk, Presentation } from "../../shared/protocol.js";
import { LOOP_STAGES, goalProgress, goalStage, stageLabel, type Goal, type ProgressState } from "../../shared/progress.js";
import { esc } from "./modal.js";

/**
 * The quest tracker under the top bar: the one thing to do next to move the
 * work forward, worked out from where the goal is in the loop — stand-up,
 * hire, plan, assign, review, ship. Click it to do it.
 */

export type ObjectiveAction = "standup" | "hire" | "goals" | "roundup" | "hours" | "travel-game" | "laptop";

export interface Objective {
  icon: string;
  text: string;
  key?: string;
  action: ObjectiveAction;
  goal?: Goal;
}

export function nextObjective(p: ProgressState, desks: Desk[], line: Presentation[]): Objective {
  const staffed = desks.filter((d) => d.worker);
  const goal = (p.session?.goalId && p.goals.find((g) => g.id === p.session!.goalId)) || p.goals.find((g) => !g.doneAt);
  const ready = line.filter((l) => l.report).length;

  if (ready) return { icon: "🎤", text: `${ready} ready to present — hold office hours`, key: "O", action: "hours", goal };
  if (!goal) {
    const shipped = p.goals.find((g) => g.doneAt);
    return shipped
      ? { icon: "🏆", text: "Goal shipped! Hold a stand-up to pick the next one", key: "U", action: "standup" }
      : { icon: "☀️", text: "Hold the stand-up: pick a goal and set the tone", key: "U", action: "standup" };
  }
  if (!staffed.length) return { icon: "🪑", text: "Hire a worker at a desk with a +", key: "T", action: "hire", goal };
  const stage = goalStage(goal);
  const research = goal.kind === "research";
  if (stage === "plan") {
    return goal.tasks.length
      ? { icon: "📋", text: `Assign “${goal.tasks.find((t) => t.status === "todo")?.title ?? "a task"}” to a worker`, key: "G", action: "goals", goal }
      : { icon: "🧠", text: "Plan the goal: let a worker break it into tasks", key: "G", action: "goals", goal };
  }
  if (stage === "ship") {
    return research
      ? { icon: "📊", text: "The deck is ready — open it and present it", key: "G", action: "goals", goal }
      : { icon: "🚀", text: "Every task's done — ship it!", key: "G", action: "goals", goal };
  }
  if (stage === "shipped") return { icon: "🏆", text: "Shipped! Hold a stand-up to pick the next goal", key: "U", action: "standup", goal };
  const todo = goal.tasks.filter((t) => t.status === "todo");
  const idle = staffed.filter((d) => d.worker!.status === "idle" && !goal.tasks.some((t) => t.deskId === d.id && t.status !== "done"));
  if (todo.length && idle.length) return { icon: "📋", text: `${todo.length} task${todo.length === 1 ? "" : "s"} to hand out · ${idle.length} worker${idle.length === 1 ? "" : "s"} free`, key: "G", action: "goals", goal };
  const reviewable = goal.tasks.some((t) => t.status === "doing");
  if (reviewable) {
    return line.length
      ? { icon: "📝", text: `${line.length} preparing their report${line.length === 1 ? "" : "s"} — grab a coffee or play a round`, action: "travel-game", goal }
      : { icon: "📣", text: research ? "Researching… round them up when you want a look" : "Building… round them up when you want a review", key: "R", action: "roundup", goal };
  }
  return { icon: "👀", text: "Check the work on your laptop", key: "L", action: "laptop", goal };
}

export class ObjectiveTracker {
  readonly el: HTMLButtonElement;
  private html = "";
  current: Objective | null = null;

  constructor(parent: HTMLElement, onClick: (o: Objective) => void) {
    this.el = document.createElement("button");
    this.el.className = "objective panel";
    this.el.title = "What to do next";
    this.el.addEventListener("click", () => this.current && onClick(this.current));
    parent.appendChild(this.el);
  }

  update(o: Objective): void {
    this.current = o;
    const g = o.goal;
    const pr = g ? goalProgress(g) : null;
    // The goal itself, big; its progress and where it is in the loop; then the one next step.
    const head = g
      ? `<div class="ob-goal"><span class="ob-label">🎯 Goal</span><b class="ob-title">${esc(g.title)}</b><span class="ob-count">${pr!.done}/${pr!.total}</span></div>
         <div class="ob-bar"><span style="width:${Math.round(pr!.pct * 100)}%"></span></div>
         <div class="ob-stages">${LOOP_STAGES.filter((st) => st !== "shipped")
           .map((st) => {
             const at = LOOP_STAGES.indexOf(goalStage(g));
             const i = LOOP_STAGES.indexOf(st);
             return `<span class="ob-stage ${i < at ? "done" : i === at ? "now" : ""}">${i < at ? "✓ " : ""}${stageLabel(st, g.kind)}</span>`;
           })
           .join('<span class="ob-sep">›</span>')}</div>`
      : `<div class="ob-goal"><span class="ob-label">🎯 Goal</span><b class="ob-title muted">No goal yet</b></div>`;
    const html = `${head}<div class="ob-next"><span class="ob-icon">${o.icon}</span><span class="ob-text">${esc(o.text)}</span>${o.key ? `<span class="key">${o.key}</span>` : ""}</div>`;
    if (html === this.html) return;
    const changed = this.html !== "";
    this.html = html;
    this.el.innerHTML = html;
    if (changed) {
      this.el.classList.remove("bump");
      void this.el.offsetWidth;
      this.el.classList.add("bump");
    }
  }
}
