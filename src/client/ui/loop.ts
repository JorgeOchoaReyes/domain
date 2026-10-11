import type { ClientMessage, Desk, ServerMessage } from "../../shared/protocol.js";
import { AGENT_LABELS } from "../../shared/protocol.js";
import { LOOP_STAGES, STAGE_ICON, goalProgress, goalStage, stageLabel, type Goal } from "../../shared/progress.js";
import { esc } from "./modal.js";
import { icon } from "./icons.js";
import { isGithubProject, projectState } from "./projects.js";
import "../styles/loop.css";

/**
 * The agent loop as the UI sees it: Plan → Build → Review → Ship → Shipped
 * (Plan → Research → Review → Present → Delivered for research goals). This
 * module keeps what the server told us about the loop (the project's preview
 * URL and deploy command, the deploy log, dev servers it found) and works out,
 * for any goal, the one thing to do next — shared by the Goals window and the
 * laptop so both always agree.
 */

export interface LoopConfig {
  project: string;
  preview: string | null;
  deploy: string | null;
  simulate: boolean;
  /** The check run on finished work before review. */
  check: string | null;
  /** Workers' own branches: the branch they merge into, or null outside git. */
  git: { base: string | null } | null;
  /** Models served on this machine, e.g. "ollama/llama3:latest". */
  localModels: string[];
}

/** What the server has told us about the loop. */
export const loopState = {
  config: null as LoopConfig | null,
  devServers: [] as string[],
  /** The current (or last) deploy's goal and its whole output. */
  deploy: { goalId: null as string | null, log: "" },
};

const listeners = new Set<(msg: ServerMessage) => void>();

/** Hear about loop changes (config, deploy output, dev servers). */
export function onLoop(fn: (msg: ServerMessage) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const LOG_MAX = 256 * 1024;

/** Feed every server message through here; it keeps loopState current. */
export function ingestLoop(msg: ServerMessage): void {
  switch (msg.t) {
    case "config":
      loopState.config = { project: msg.project, preview: msg.preview, deploy: msg.deploy, simulate: msg.simulate, check: msg.check, git: msg.git, localModels: msg.localModels ?? [] };
      break;
    case "devServers":
      loopState.devServers = msg.urls;
      break;
    case "deployLog":
      loopState.deploy = { goalId: msg.goalId, log: msg.data };
      break;
    case "deployOutput":
      if (loopState.deploy.goalId !== msg.goalId) loopState.deploy = { goalId: msg.goalId, log: "" };
      loopState.deploy.log = (loopState.deploy.log + msg.data).slice(-LOG_MAX);
      break;
    default:
      return;
  }
  for (const fn of listeners) fn(msg);
}

// ---------------------------------------------------------------------------
// The next action
// ---------------------------------------------------------------------------

/** Things the loop can ask the rest of the app to do. */
export interface LoopHandlers {
  send(msg: ClientMessage): void;
  /** Call workers to your office for a review (opens the round-up window). */
  roundup(): void;
  /** Start office hours: the next worker in line presents. */
  officeHours(): void;
  /** Open a research goal's deck. */
  openDeck(goal: Goal): void;
  /** Open the laptop on an app (the deploy console after a deploy starts). */
  openLaptop?(app: "deploy" | "browser" | "loop"): void;
  /** Go hire one: take the player to the desks. */
  hire?(): void;
  /** Hand a task out on your terms (opens the assignment card); without it, assign on the defaults. */
  assign?(goalId: string, taskId: string, deskId: string): void;
  /** Watch a goal's team huddle on its plan. */
  openHuddle?(goal: Goal): void;
  /** Watch a goal's demo (the screenshot or captured run). */
  openDemo?(goal: Goal): void;
}

export interface LoopButton {
  label: string;
  style: "primary" | "good" | "plain" | "danger";
  run: (() => void) | null;
  /** When set, the first click arms it and shows this; the second runs it. */
  confirm?: string;
  /** Markup for the label (e.g. with an icon); `label` stays the plain-text version. */
  html?: string;
  title?: string;
}

export interface LoopView {
  /** One line on where things stand. */
  status: string;
  main: LoopButton | null;
  more: LoopButton[];
}

function workerName(d: Desk): string {
  return `${AGENT_LABELS[d.worker!.agent]} · ${d.label}`;
}

/** Workers not on a task right now, idle ones first. */
export function freeWorkers(desks: Desk[], goals: Goal[]): Desk[] {
  const busy = new Set<string>();
  for (const g of goals) {
    for (const t of g.tasks) if (t.deskId && t.status !== "done") busy.add(t.deskId);
    if (g.planningDesk) busy.add(g.planningDesk);
    if (g.ship?.status === "running" && g.ship.deskId) busy.add(g.ship.deskId);
  }
  const rank = (d: Desk) => (d.worker!.status === "idle" ? 0 : d.worker!.status === "working" ? 1 : 2);
  return desks.filter((d) => d.worker && !busy.has(d.id) && d.worker.status !== "presenting").sort((a, b) => rank(a) - rank(b));
}

/**
 * Where a goal stands and the obvious thing to do next — there is always one
 * — plus the manual overrides that keep the loop from ever getting stuck.
 */
export function loopView(goal: Goal, desks: Desk[], goals: Goal[], line: { deskId: string; report: unknown }[], h: LoopHandlers): LoopView {
  const stage = goalStage(goal);
  const research = goal.kind === "research";
  const staffed = desks.filter((d) => d.worker);
  const free = freeWorkers(desks, goals);
  const pick = free[0] ?? staffed[0] ?? null;
  const send = h.send;
  const cfg = loopState.config;
  const more: LoopButton[] = [];
  const replan: LoopButton | null = pick
    ? { label: `🧠 ${goal.tasks.length ? "Re-plan" : "Plan"} with ${AGENT_LABELS[pick.worker!.agent]}`, style: "plain", run: () => send({ t: "plan", goalId: goal.id, deskId: pick.id }) }
    : null;
  const deckBtn: LoopButton | null =
    research && goal.deck?.slides.length ? { label: `📊 Open deck (${goal.deck.slides.length})`, style: "plain", run: () => h.openDeck(goal) } : null;

  switch (stage) {
    case "plan": {
      if (goal.huddle) {
        const hd = goal.huddle;
        return {
          status:
            hd.status === "gathering"
              ? `🤝 Team huddle on the draft plan (${hd.draft.length} tasks): ${hd.notes.length} of ${hd.deskIds.length} teammates have weighed in.`
              : "🤝 The team has weighed in — the plan is being revised; its tasks appear here on their own.",
          main: { label: "🤝 Watch the huddle", style: "primary", run: h.openHuddle ? () => h.openHuddle!(goal) : null },
          more: [{ label: "⏭ Skip the huddle", style: "plain", run: () => send({ t: "huddleSkip", goalId: goal.id }) }],
        };
      }
      if (goal.planningDesk) {
        const d = desks.find((x) => x.id === goal.planningDesk);
        return {
          status: `🧠 ${d?.worker ? workerName(d) : "A worker"} is breaking it into tasks — they'll appear here on their own.`,
          main: { label: "🧠 Planning…", style: "plain", run: null },
          more: replan ? [{ ...replan, label: replan.label.replace("Plan", "Ask again") }] : [],
        };
      }
      if (!pick) return { status: "No tasks yet. Hire a worker at a desk with a + to plan it, or add tasks yourself below.", main: { label: "🪑 Hire a worker first", style: "primary", run: h.hire ?? null }, more: [] };
      return {
        status: `No tasks yet. Have ${workerName(pick)} plan it — or add tasks yourself below.`,
        main: { ...replan!, style: "primary" },
        more: [],
      };
    }
    case "build":
    case "review": {
      const p = goalProgress(goal);
      const todo = goal.tasks.find((t) => t.status === "todo");
      const ready = line.filter((l) => l.report).length;
      const inReview = goal.tasks.filter((t) => t.status === "review").length;
      const doing = goal.tasks.filter((t) => t.status === "doing").length;
      const status = `${p.done}/${p.total} done · ${doing} in progress · ${inReview} waiting for review`;
      if (deckBtn) more.push(deckBtn);
      if (replan) more.push(replan);
      if (ready) {
        return { status, main: { label: `🎤 Hold office hours · ${ready} ready`, style: "primary", run: () => h.officeHours() }, more };
      }
      if (todo && free.length) {
        const d = free[0];
        return {
          status,
          main: {
            label: `👉 Put ${AGENT_LABELS[d.worker!.agent]} on “${todo.title.length > 34 ? todo.title.slice(0, 33) + "…" : todo.title}”`,
            style: "primary",
            run: () => (h.assign ? h.assign(goal.id, todo.id, d.id) : send({ t: "taskAssign", goalId: goal.id, taskId: todo.id, deskId: d.id })),
          },
          more,
        };
      }
      if (doing || inReview) {
        return { status, main: { label: "📣 Round up for a review", style: "primary", run: () => h.roundup() }, more };
      }
      return { status: `${status} · hire another worker to take the next task`, main: { label: "🪑 Hire a worker", style: "primary", run: h.hire ?? null }, more };
    }
    case "ship": {
      const ship = goal.ship;
      const markDone: LoopButton = {
        label: research ? "✅ Mark delivered" : "✅ Mark shipped",
        style: "plain",
        run: () => send({ t: "shipDone", goalId: goal.id }),
      };
      if (research) {
        if (!goal.deck?.slides.length) {
          return {
            status: "Every task is done, but there's no deck yet — ask a worker to write it up, or mark it delivered.",
            main: pick
              ? {
                  label: `📝 Ask ${AGENT_LABELS[pick.worker!.agent]} to write the deck`,
                  style: "primary",
                  run: () => send({ t: "ship", goalId: goal.id, deskId: pick.id }),
                }
              : null,
            more: [markDone],
          };
        }
        return {
          status: `The deck is ready: ${goal.deck.slides.length} slides. Present it, download it as PowerPoint, then mark it delivered.`,
          main: { label: "📊 Present the deck", style: "primary", run: () => h.openDeck(goal) },
          more: [{ ...markDone, style: "good" }],
        };
      }
      // The demo of what was built: shown to everyone before it ships.
      const demo = goal.demo;
      const demoBtn: LoopButton | null = !h.openDemo
        ? null
        : demo
          ? { label: demo.status === "running" ? "🎬 Capturing the demo…" : "🎬 Watch the demo", style: demo.status === "ready" ? "good" : "plain", run: () => h.openDemo!(goal) }
          : { label: "🎬 Capture a demo", style: "plain", run: () => send({ t: "demo", goalId: goal.id }) };
      const withDemo = (v: LoopView): LoopView =>
        demoBtn ? { ...v, status: `${demo?.status === "ready" ? "🎬 The demo is ready. " : ""}${v.status}`, more: [demoBtn, ...v.more] } : v;
      if (ship?.status === "running") {
        const stop: LoopButton = { label: "⏹ Stop", style: "plain", run: () => send({ t: "shipCancel", goalId: goal.id }) };
        if (ship.mode === "deploy") {
          return withDemo({
            status: `🚀 Running \`${ship.command}\`…`,
            main: { label: "🖥 Watch the deploy", style: "primary", run: () => h.openLaptop?.("deploy") },
            more: [stop, markDone],
          });
        }
        const d = desks.find((x) => x.id === ship.deskId);
        return withDemo({
          status: `🚢 ${d?.worker ? workerName(d) : "A worker"} is shipping it — it lands here when they write shipped.md.`,
          main: { label: "🚢 Shipping…", style: "plain", run: null },
          more: [stop, markDone],
        });
      }
      if (ship?.status === "failed") {
        const fix: LoopButton | null = pick
          ? { label: `🔧 Ask ${AGENT_LABELS[pick.worker!.agent]} to fix it`, style: "primary", run: () => send({ t: "ship", goalId: goal.id, deskId: pick.id }) }
          : null;
        return withDemo({
          status: `💥 \`${ship.command}\` failed (exit ${ship.exitCode ?? "?"}). ${pick ? "One click hands the log to a worker." : "Hire a worker to fix it."}`,
          main: fix ?? { label: "🖥 See the log", style: "primary", run: () => h.openLaptop?.("deploy") },
          more: [
            { label: "↻ Retry deploy", style: "plain", run: () => send({ t: "ship", goalId: goal.id }), confirm: `Run \`${ship.command}\`?` },
            { label: "🖥 Log", style: "plain", run: () => h.openLaptop?.("deploy") },
            markDone,
          ],
        });
      }
      if (isGithubProject() && !ship) {
        const gh = projectState.info!.github!;
        const others: LoopButton[] = [];
        if (cfg?.deploy) others.push({ label: "🚀 Run the deploy instead", style: "plain", run: () => send({ t: "ship", goalId: goal.id }), confirm: `▶ Run \`${cfg.deploy}\`` });
        if (pick) others.push({ label: `🚢 Ask ${AGENT_LABELS[pick.worker!.agent]} to ship it`, style: "plain", run: () => send({ t: "ship", goalId: goal.id, deskId: pick.id }) });
        return withDemo({
          status: `Every task is approved. Open a pull request on ${gh.owner}/${gh.repo}: your branch is pushed as domain/…, and its checks show up here.`,
          main: {
            label: "Open a pull request on GitHub",
            html: `${icon("github", 16)} Open a pull request on GitHub`,
            style: "primary",
            run: () => send({ t: "shipPR", goalId: goal.id }),
          },
          more: [...others, markDone],
        });
      }
      if (cfg?.deploy) {
        const viaWorker: LoopButton[] = pick
          ? [{ label: `🚢 Ask ${AGENT_LABELS[pick.worker!.agent]} to open a PR instead`, style: "plain", run: () => send({ t: "ship", goalId: goal.id, deskId: pick.id }) }]
          : [];
        return withDemo({
          status: `Every task is approved. Ship it runs \`${cfg.deploy}\` in ${cfg.project}.`,
          main: { label: "🚀 Ship it", style: "primary", run: () => send({ t: "ship", goalId: goal.id }), confirm: `▶ Run \`${cfg.deploy}\`` },
          more: [...viaWorker, markDone],
        });
      }
      return withDemo({
        status: pick
          ? "Every task is approved. No deploy command is set (add \"deploy\" to domain.config.json), so a worker can ship it as a pull request."
          : "Every task is approved. Hire a worker to open a PR, or mark it shipped.",
        main: pick ? { label: `🚢 Ask ${AGENT_LABELS[pick.worker!.agent]} to ship it`, style: "primary", run: () => send({ t: "ship", goalId: goal.id, deskId: pick.id }) } : null,
        more: [markDone],
      });
    }
    case "shipped": {
      const url = goal.ship?.url;
      const pr = goal.pr;
      const main: LoopButton | null = research
        ? deckBtn
          ? { ...deckBtn, style: "primary" }
          : null
        : pr
          ? { label: `Pull request #${pr.number}`, html: `${icon("pr", 16)} Pull request #${pr.number}`, style: "primary", run: () => window.open(pr.url, "_blank", "noopener") }
          : url
            ? { label: "🔗 Open what shipped", style: "primary", run: () => window.open(url, "_blank", "noopener") }
            : null;
      const when = goal.shippedAt ? new Date(goal.shippedAt).toLocaleString() : "";
      return {
        status: `${research ? "📊 Delivered" : "🏁 Shipped"} ${when}${goal.ship?.note ? ` — ${goal.ship.note}` : ""}`,
        main,
        more: goal.demo && h.openDemo ? [{ label: "🎬 The demo", style: "plain", run: () => h.openDemo!(goal) }] : [],
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** The stage track: five steps with the current one lit. */
export function stageTrackHtml(goal: Goal): string {
  const now = LOOP_STAGES.indexOf(goalStage(goal));
  return `<ol class="loop-track ${goal.kind}">${LOOP_STAGES.map((s, i) => {
    const cls = i < now ? "past" : i === now ? "now" : "";
    return `<li class="${cls}"><span class="lt-icon">${i < now ? "✓" : STAGE_ICON[s]}</span><span class="lt-label">${stageLabel(s, goal.kind)}</span></li>`;
  }).join("")}</ol>`;
}

function buttonEl(b: LoopButton, big: boolean): HTMLButtonElement {
  const el = document.createElement("button");
  el.className = `btn ${b.style === "plain" ? "" : b.style} ${big ? "loop-main" : "small"}`;
  const show = () => (b.html ? (el.innerHTML = b.html) : (el.textContent = b.label));
  show();
  if (b.title) el.title = b.title;
  if (!b.run) {
    el.disabled = true;
    return el;
  }
  el.addEventListener("click", () => {
    if (b.confirm && !el.dataset.armed) {
      el.dataset.armed = "1";
      el.textContent = b.confirm;
      el.classList.add("armed");
      setTimeout(() => {
        delete el.dataset.armed;
        el.classList.remove("armed");
        show();
      }, 4000);
      return;
    }
    b.run!();
    el.disabled = true;
    setTimeout(() => (el.disabled = false), 1200);
  });
  return el;
}

/** Draw the loop for a goal into `el`: the track, a status line and its buttons. */
export function renderLoop(el: HTMLElement, goal: Goal, desks: Desk[], goals: Goal[], line: { deskId: string; report: unknown }[], h: LoopHandlers): void {
  const v = loopView(goal, desks, goals, line, h);
  el.classList.add("loop");
  el.innerHTML = `${stageTrackHtml(goal)}<p class="loop-status">${esc(v.status).replace(/`([^`]+)`/g, "<code>$1</code>")}</p><div class="loop-actions"></div>`;
  const actions = el.querySelector<HTMLElement>(".loop-actions")!;
  if (v.main) actions.appendChild(buttonEl(v.main, true));
  for (const b of v.more) actions.appendChild(buttonEl(b, false));
}
