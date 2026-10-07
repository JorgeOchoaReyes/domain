import type { Desk } from "../../shared/protocol.js";
import { AGENT_LABELS } from "../../shared/protocol.js";
import {
  SESSION_LENGTHS,
  ALL_DAY,
  DEFAULT_EOD,
  eodLabel,
  minutesUntilEod,
  pastEod,
  TONES,
  XP,
  goalProgress,
  goalStage,
  type GoalKind,
  type LoopStage,
  type ProgressState,
  type ToneId, sessionLength } from "../../shared/progress.js";
import { AGENT_COLOR, STATUS_BULB } from "../scene/characters.js";
import { esc, openModal } from "./modal.js";
import { micButton, wireMic } from "../voice.js";
import { simpleDraft, type StandupDraft, type TeamMember } from "../../shared/standupDraft.js";

/**
 * The stand-up that opens every session. On the left, where things stand:
 * the goals and where each is in the loop, what the workers are up to, what
 * happened since last time. On the right, you set up the session: pick (or
 * set) today's goal, choose its tone, say what would make it a win, and pick
 * a length. "Start the day" kicks off a focus session with all of that. If a
 * session is already on, it shows you the plan and lets you join in.
 *
 * Or just say it: 🎤 at the top takes what you want done, out loud, and
 * Claude outlines the plan like a team lead — the summary (read back to you),
 * end-of-day goals, the tasks, and who on your team should take each one and
 * why. You change any of it (the tasks, who gets them) and start the day:
 * each task goes to its worker — straight away if they're free, as soon as
 * they are if not. "Resume yesterday" skips all of it: same goal, tone and
 * length, team woken.
 */

export interface StandupPlan {
  goalId: string | null;
  newGoal?: { title: string; why: string; tasks: string[]; kind: GoalKind; dueAt?: number | null };
  tone: ToneId;
  intention: string;
  minutes: number;
  summary?: string;
  eod?: string[];
  /** Hand the goal's tasks to free workers as soon as it starts. */
  dispatch?: boolean;
  /** The tasks as planned, and who takes each ("" = whoever's free). */
  assign?: { task: string; deskId: string }[];
}

/** What the stand-up needs for the spoken plan and for resuming. */
export interface StandupVoice {
  /** Turn what you said into a plan (the answer comes back through standupDraftArrived). */
  draft(text: string): void;
  /** Say the summary out loud. */
  speak(text: string): void;
  /** Resume the last stand-up's plan. */
  resume(): void;
}

/** The open stand-up, waiting for its spoken plan. */
let fillDraft: ((draft: StandupDraft, via: "claude" | "simple") => void) | null = null;

/** The plan for a spoken stand-up came back: fill it into the open stand-up. */
export function standupDraftArrived(draft: StandupDraft, via: "claude" | "simple"): void {
  fillDraft?.(draft, via);
}

const STAGE_LABEL: Record<LoopStage, [string, string]> = {
  plan: ["🧠 Plan", "🧠 Plan"],
  build: ["⌨️ Build", "🔎 Research"],
  review: ["🎤 Review", "🎤 Review"],
  ship: ["🚀 Ship", "📊 Present"],
  shipped: ["🏆 Shipped", "🏆 Delivered"],
};

export function stageLabel(stage: LoopStage, kind: GoalKind): string {
  return STAGE_LABEL[stage][kind === "research" ? 1 : 0];
}

const STARTERS: { icon: string; title: string; why: string; kind: GoalKind; tasks: string[] }[] = [
  { icon: "🚀", title: "Ship a feature", why: "Get it in front of users", kind: "build", tasks: ["Write a short spec", "Build the core flow", "Add tests", "Polish the UI"] },
  { icon: "🐛", title: "Bug bash", why: "Clear the annoying bugs", kind: "build", tasks: ["Triage open bugs", "Fix the top crash", "Add regression tests"] },
  { icon: "📊", title: "Research report", why: "Decide with evidence", kind: "research", tasks: ["Frame the question", "Gather sources", "Compare the options", "Write the recommendation"] },
  { icon: "🧭", title: "Competitive scan", why: "Know the landscape", kind: "research", tasks: ["List the main players", "Compare features and pricing", "Summarize the takeaways"] },
];

function greeting(name: string): string {
  const h = new Date().getHours();
  const part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return `${part}${name ? `, ${name}` : ""}`;
}

export function openStandup(
  progress: ProgressState,
  desks: Desk[],
  myName: string,
  onStart: (plan: StandupPlan) => void,
  onSkip: () => void,
  voice?: StandupVoice,
): void {
  const session = progress.session;
  const open = progress.goals.filter((g) => !g.doneAt);
  const staffed = desks.filter((d) => d.worker);

  // --- where we are --------------------------------------------------------------
  const goalsHtml = open.length
    ? open
        .slice(0, 4)
        .map((g) => {
          const pr = goalProgress(g);
          return `<li><span class="name"><b>${esc(g.title)}</b><span class="sub">${pr.done}/${pr.total} tasks · ${g.kind === "research" ? "research" : "build"}</span></span><span class="stage">${stageLabel(goalStage(g), g.kind)}</span></li>`;
        })
        .join("")
    : `<li class="empty">No open goals — set one on the right.</li>`;
  const teamHtml = staffed.length
    ? staffed
        .map((d) => {
          const w = d.worker!;
          return `<li><span class="dot" style="background:${AGENT_COLOR[w.agent]}"></span><span class="name">${esc(AGENT_LABELS[w.agent])}<span class="sub">${esc(w.activity)}</span></span><span class="bulb" style="background:${STATUS_BULB[w.status]}"></span></li>`;
        })
        .join("")
    : `<li class="empty">Nobody hired yet. After stand-up, walk to a desk with a <b>+</b> and press <span class="key">E</span>.</li>`;
  const since = progress.feed.slice(0, 4);
  const sinceHtml = since.length
    ? since.map((f) => `<li><span class="name"><b>${esc(f.who)}</b> ${esc(f.text)}</span></li>`).join("")
    : `<li class="empty">Nothing yet — today's the first day.</li>`;

  const body = document.createElement("div");
  body.className = "standup";

  if (session) {
    // A session is already on: show the plan and join in.
    const tone = TONES.find((t) => t.id === session.tone);
    const goal = session.goalId ? progress.goals.find((g) => g.id === session.goalId) : undefined;
    const left = Math.max(1, Math.ceil((session.endsAt - Date.now()) / 60000));
    body.innerHTML = `
      <section class="su-col su-recap">
        <h3>👥 The team</h3><ul class="su-list">${teamHtml}</ul>
        <h3>📣 Since last time</h3><ul class="su-list">${sinceHtml}</ul>
      </section>
      <section class="su-col su-plan">
        <div class="su-joined" style="--tone:${tone?.color ?? "#ff8a5b"}">
          <div class="su-tone-big">${tone?.icon ?? "🔥"}</div>
          <div>
            <div class="su-kicker">${esc(session.startedBy)} ran the stand-up · ${left} min left</div>
            <h3>${esc(tone?.label ?? "Focus session")}</h3>
            ${session.intention ? `<p class="su-quote">“${esc(session.intention)}”</p>` : ""}
            ${goal ? `<p class="su-goal">🎯 ${esc(goal.title)} · ${stageLabel(goalStage(goal), goal.kind)}</p>` : ""}
            ${session.summary ? `<p class="su-summary">${esc(session.summary)}</p>` : ""}
            ${session.eod?.length ? `<div class="su-eod-list"><b>🌙 Done by end of day</b><ul>${session.eod.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : ""}
          </div>
        </div>
      </section>`;
    const footer = `<span class="grow">Everyone here earns the session's XP when it finishes</span><button class="btn primary join">👊 Join in</button>`;
    const modal = openModal({ title: `${greeting(myName)} — the team's already rolling`, icon: "☀️", className: "standup-modal", body, footer, onClose: onSkip });
    modal.footer!.querySelector(".join")!.addEventListener("click", () => modal.close());
    return;
  }

  let goalChoice: string | "new" = open[0]?.id ?? "new";
  let kind: GoalKind = "build";
  let tone: ToneId = "ship";
  const eodAt = progress.policy.autopilot.eodAt || DEFAULT_EOD;
  let minutes: number = TONES.find((t) => t.id === tone)!.minutes;

  body.innerHTML = `
    <section class="su-col su-recap">
      <h3>🎯 Goals</h3><ul class="su-list">${goalsHtml}</ul>
      <h3>👥 The team</h3><ul class="su-list">${teamHtml}</ul>
      <h3>📣 Since last time</h3><ul class="su-list">${sinceHtml}</ul>
    </section>
    <section class="su-col su-plan">
      ${
        voice
          ? `<div class="su-voice">
        <div class="su-voice-head"><b>🎤 Say your stand-up</b><span>What you want done today and what done looks like by tonight — it fills in everything below.</span></div>
        <div class="su-voice-box"><textarea class="su-said" rows="3" placeholder="e.g. Today I want dark mode shipped and the login bug fixed. By end of day the PR should be open. About three hours."></textarea>${micButton("su-mic")}</div>
        <div class="su-voice-acts"><button class="btn small primary su-make">✨ Make my plan</button><span class="su-voice-status"></span></div>
        <div class="su-drafted hidden">
          <p class="su-summary"></p>
          <label class="su-eod-label">🌙 Done by end of day <span>(one per line)</span></label>
          <textarea class="su-eod" rows="2"></textarea>
          <div class="su-who">
            <label class="su-eod-label">👥 Who does what <span>— Claude's picks; change any</span></label>
            <div class="su-rows"></div>
            <button type="button" class="btn small su-add">＋ Add a task</button>
          </div>
        </div>
      </div>`
          : ""
      }
      <div class="su-step"><span class="su-n">1</span><h3>Today's goal</h3></div>
      <div class="su-goals">
        ${open.map((g) => `<button class="su-goal-pick" data-g="${g.id}"><b>${esc(g.title)}</b><span>${stageLabel(goalStage(g), g.kind)}</span></button>`).join("")}
        <button class="su-goal-pick" data-g="new"><b>＋ Something new</b><span>Set a fresh goal</span></button>
      </div>
      <div class="su-new hidden">
        <div class="seg su-kind">
          <button data-k="build" class="on">🛠 Build something</button>
          <button data-k="research">📚 Research / report</button>
        </div>
        <div class="templates">${STARTERS.map((t, i) => `<button class="btn chip" data-t="${i}">${t.icon} ${esc(t.title)}</button>`).join("")}</div>
        <input type="text" class="su-title" maxlength="120" placeholder="What are we going after? e.g. Launch the public beta" />
        <textarea class="su-tasks" rows="3" placeholder="Tasks, one per line (optional — a worker can plan it for you)"></textarea>
        <label class="su-due-row">📅 Due <input type="datetime-local" class="su-due" /> <span class="su-due-hint">optional — I'll remind you as it gets close</span></label>
      </div>

      <div class="su-step"><span class="su-n">2</span><h3>Set the tone</h3></div>
      <div class="su-tones">
        ${TONES.map((t) => `<button class="su-tone ${t.id === tone ? "on" : ""}" data-tone="${t.id}" style="--tone:${t.color}"><span class="ti">${t.icon}</span><b>${esc(t.label)}</b><span>${esc(t.blurb)}</span></button>`).join("")}
      </div>

      <div class="su-step"><span class="su-n">3</span><h3>What would make this session a win?</h3></div>
      <input type="text" class="su-intent" maxlength="140" placeholder="e.g. Checkout works end to end and is deployed" />

      <div class="su-step"><span class="su-n">4</span><h3>How long?</h3></div>
      <div class="seg su-len">${SESSION_LENGTHS.map((m) => `<button data-m="${m}" class="${m === minutes ? "on" : ""}">${sessionLength(m)}</button>`).join("")}<button data-m="eod" title="Ends at ${esc(eodLabel(eodAt))} — the end-of-day time in Team policy (past it, an hour)">🌙 ${pastEod(eodAt) ? "One more hour" : `Until ${esc(eodLabel(eodAt))}`} <small>(${sessionLength(minutesUntilEod(eodAt))})</small></button></div>
    </section>`;

  const footer = document.createElement("div");
  footer.style.display = "contents";
  const last = progress.lastPlan;
  const lastGoal = last?.goalId ? progress.goals.find((g) => g.id === last.goalId && !g.doneAt && !g.shippedAt) : undefined;
  const canResume = !!voice && !!last && (!!lastGoal || !!last.intention || !!last.eod.length);
  footer.innerHTML = `<button class="btn skip">Skip stand-up</button>${
    canResume ? `<button class="btn su-resume" title="Same goal, tone and length as last time; the team wakes and the open tasks go out">↺ Resume yesterday${lastGoal ? `: ${esc(lastGoal.title.slice(0, 40))}` : ""}</button>` : ""
  }<label class="su-dispatch" title="The goal's tasks go to free workers the moment the day starts (a goal without tasks gets planned first)"><input type="checkbox" class="su-dispatch-on" checked /> 🚀 Hand out tasks</label><span class="grow">+${XP.standup} XP for the stand-up · the session pays ${XP.sessionMinute} XP a minute</span><button class="btn primary go">🔔 Start the day</button>`;

  let started = false;
  const modal = openModal({
    title: `${greeting(myName)} — time for stand-up`,
    icon: "☀️",
    className: "standup-modal",
    body,
    footer,
    onClose: () => {
      fillDraft = null;
      if (!started) onSkip();
    },
  });

  const $ = <T extends HTMLElement>(sel: string) => body.querySelector<T>(sel)!;
  // The length may be "until end of day" (worked out again as the day starts).
  let untilEod = false;
  const newBox = $(".su-new");
  const title = $<HTMLInputElement>(".su-title");
  const tasks = $<HTMLTextAreaElement>(".su-tasks");
  const intent = $<HTMLInputElement>(".su-intent");
  for (const el of [title, tasks, intent]) {
    el.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key !== "Escape") e.stopPropagation();
    });
  }

  const syncGoal = () => {
    body.querySelectorAll<HTMLElement>(".su-goal-pick").forEach((b) => b.classList.toggle("on", b.dataset.g === goalChoice));
    newBox.classList.toggle("hidden", goalChoice !== "new");
  };
  body.querySelectorAll<HTMLElement>(".su-goal-pick").forEach((b) =>
    b.addEventListener("click", () => {
      goalChoice = b.dataset.g!;
      syncGoal();
      if (goalChoice === "new") title.focus();
    }),
  );
  syncGoal();

  body.querySelectorAll<HTMLButtonElement>(".su-kind button").forEach((b) =>
    b.addEventListener("click", () => {
      kind = b.dataset.k as GoalKind;
      body.querySelectorAll(".su-kind button").forEach((x) => x.classList.toggle("on", x === b));
    }),
  );
  body.querySelectorAll<HTMLButtonElement>("[data-t]").forEach((b) =>
    b.addEventListener("click", () => {
      const t = STARTERS[Number(b.dataset.t)];
      title.value = t.title;
      tasks.value = t.tasks.join("\n");
      kind = t.kind;
      body.querySelectorAll<HTMLElement>(".su-kind button").forEach((x) => x.classList.toggle("on", x.dataset.k === kind));
    }),
  );
  const syncLen = () => body.querySelectorAll<HTMLElement>(".su-len button").forEach((x) => x.classList.toggle("on", x.dataset.m === "eod" ? untilEod : !untilEod && Number(x.dataset.m) === minutes));
  body.querySelectorAll<HTMLButtonElement>(".su-tone").forEach((b) =>
    b.addEventListener("click", () => {
      tone = b.dataset.tone as ToneId;
      body.querySelectorAll(".su-tone").forEach((x) => x.classList.toggle("on", x === b));
      if (!untilEod) minutes = TONES.find((t) => t.id === tone)!.minutes;
      syncLen();
    }),
  );
  body.querySelectorAll<HTMLButtonElement>(".su-len button").forEach((b) =>
    b.addEventListener("click", () => {
      untilEod = b.dataset.m === "eod";
      minutes = untilEod ? minutesUntilEod(eodAt) : Number(b.dataset.m);
      syncLen();
    }),
  );

  // --- the spoken stand-up -------------------------------------------------------
  let drafted: { summary: string } | null = null;
  const eodBox = body.querySelector<HTMLTextAreaElement>(".su-eod");
  const eodLines = () => (eodBox?.value ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
  // The team as the quick plan sees it (Claude's plan gets more from the server).
  const teamNow = (): TeamMember[] =>
    staffed.map((d) => {
      const w = d.worker!;
      const on = progress.goals.flatMap((g) => g.tasks).find((t) => t.deskId === d.id && t.status !== "done");
      return { deskId: d.id, name: w.identity?.name ?? AGENT_LABELS[w.agent], agent: AGENT_LABELS[w.agent], model: w.model, status: w.status, doing: on?.title ?? "", persona: "", done: [] };
    });
  // Who does what: a row per task, with who takes it and why.
  const rowsEl = body.querySelector<HTMLElement>(".su-rows");
  const people = staffed.map((d) => {
    const w = d.worker!;
    return { id: d.id, label: `${w.identity?.name ?? AGENT_LABELS[w.agent]} · ${d.label}${w.status === "idle" ? "" : w.status === "asleep" ? " (asleep)" : " (busy)"}` };
  });
  const rowHtml = (task: string, deskId: string | null, why: string) => `
    <div class="su-row">
      <input type="text" class="su-row-task" maxlength="200" value="${esc(task)}" placeholder="A task" />
      <select class="su-row-who">
        <option value="">🙋 Whoever's free</option>
        ${people.map((p) => `<option value="${p.id}" ${p.id === deskId ? "selected" : ""}>${esc(p.label)}</option>`).join("")}
      </select>
      <button type="button" class="su-row-x" title="Drop this task">✕</button>
      ${why ? `<span class="su-row-why">${esc(why)}</span>` : ""}
    </div>`;
  const readRows = () =>
    [...(rowsEl?.querySelectorAll<HTMLElement>(".su-row") ?? [])]
      .map((r) => ({ task: r.querySelector<HTMLInputElement>(".su-row-task")!.value.trim(), deskId: r.querySelector<HTMLSelectElement>(".su-row-who")!.value }))
      .filter((r) => r.task);
  rowsEl?.addEventListener("click", (e) => (e.target as HTMLElement).closest(".su-row-x")?.closest(".su-row")?.remove());
  rowsEl?.addEventListener("keydown", (e) => e.key !== "Escape" && e.stopPropagation());
  // Changing who does what by hand drops Claude's reason for it.
  rowsEl?.addEventListener("change", (e) => (e.target as HTMLElement).closest(".su-row")?.querySelector(".su-row-why")?.remove());
  body.querySelector(".su-add")?.addEventListener("click", () => {
    rowsEl!.insertAdjacentHTML("beforeend", rowHtml("", null, ""));
    rowsEl!.querySelector<HTMLInputElement>(".su-row:last-child .su-row-task")?.focus();
  });
  if (voice) {
    const said = $<HTMLTextAreaElement>(".su-said");
    const status = $(".su-voice-status");
    const make = $<HTMLButtonElement>(".su-make");
    for (const el of [said, eodBox!]) el.addEventListener("keydown", (e) => (e as KeyboardEvent).key !== "Escape" && e.stopPropagation());
    wireMic(body.querySelector<HTMLButtonElement>(".su-mic"), said);
    // The plan from your own sentences shows at once; Claude's (a better one) replaces it when it
    // arrives — unless you've started changing things, then it waits for you to take it.
    let asked = 0;
    let touched = false;
    const apply = (d: StandupDraft) => {
      drafted = { summary: d.summary };
      $(".su-drafted").classList.remove("hidden");
      $(".su-summary").textContent = d.summary;
      eodBox!.value = d.eod.join("\n");
      // The list below is the task list now (no second one to keep in step).
      tasks.classList.add("hidden");
      rowsEl!.innerHTML = (d.assign.length ? d.assign : d.goal.tasks.map((task) => ({ task, deskId: null, why: "" }))).map((a) => rowHtml(a.task, a.deskId, a.why)).join("");
      // The plan goes into the form: a new goal with its tasks (or the open one it's about), the tone, the length, the win.
      const existing = open.find((g) => g.title.toLowerCase() === d.goal.title.toLowerCase());
      if (existing) goalChoice = existing.id;
      else {
        goalChoice = "new";
        title.value = d.goal.title;
        tasks.value = d.goal.tasks.join("\n");
        kind = d.goal.kind;
        body.querySelectorAll<HTMLElement>(".su-kind button").forEach((x) => x.classList.toggle("on", x.dataset.k === kind));
      }
      syncGoal();
      tone = d.tone;
      body.querySelectorAll<HTMLElement>(".su-tone").forEach((x) => x.classList.toggle("on", x.dataset.tone === tone));
      // "All day" / "until end of day" means just that.
      untilEod = ALL_DAY.test(said.value);
      minutes = untilEod ? minutesUntilEod(eodAt) : d.minutes;
      syncLen();
      intent.value = d.intention;
      touched = false;
    };
    for (const el of [title, tasks, intent, eodBox!, rowsEl!]) {
      el.addEventListener("input", () => (touched = true));
      el.addEventListener("change", () => (touched = true));
    }
    make.addEventListener("click", () => {
      const text = said.value.trim();
      if (!text) {
        said.focus();
        status.textContent = "Say (or type) what you want done today first";
        return;
      }
      asked++;
      apply(simpleDraft(text, teamNow()));
      status.textContent = "⚡ Quick plan ready — ✨ Claude is making it better (you can start now)…";
      voice.draft(text);
    });
    fillDraft = (d, via) => {
      if (!asked) return;
      if (via === "simple") {
        status.textContent = "✅ Planned from your sentences (Claude Code wasn't available) — change anything you like";
        voice.speak(d.summary);
        return;
      }
      if (!touched) {
        apply(d);
        status.textContent = "✅ Claude's plan — change anything you like";
        voice.speak(d.summary);
        return;
      }
      // You've been editing: don't overwrite it.
      status.innerHTML = `✨ Claude's plan is ready <button class="btn small su-take">Use it</button>`;
      status.querySelector(".su-take")!.addEventListener("click", () => {
        apply(d);
        status.textContent = "✅ Claude's plan — change anything you like";
        voice.speak(d.summary);
      });
    };
    footer.querySelector(".su-resume")?.addEventListener("click", () => {
      started = true;
      modal.close();
      voice.resume();
    });
  }
  const dispatchOn = () => footer.querySelector<HTMLInputElement>(".su-dispatch-on")!.checked;

  footer.querySelector(".skip")!.addEventListener("click", () => modal.close());
  const go = footer.querySelector<HTMLButtonElement>(".go")!;
  go.addEventListener("click", () => {
    let plan: StandupPlan;
    if (goalChoice === "new") {
      const t = title.value.trim();
      if (!t) {
        title.focus();
        title.classList.add("nudge");
        return;
      }
      plan = {
        goalId: null,
        newGoal: {
          title: t,
          why: "",
          tasks: tasks.value.split("\n").map((x) => x.trim()).filter(Boolean),
          kind,
          dueAt: (() => {
            const v = $<HTMLInputElement>(".su-due").value;
            const at = v ? new Date(v).getTime() : NaN;
            return Number.isFinite(at) ? at : null;
          })(),
        },
        tone,
        intention: intent.value.trim(),
        minutes,
      };
    } else {
      plan = { goalId: goalChoice, tone, intention: intent.value.trim(), minutes };
    }
    if (untilEod) plan.minutes = minutesUntilEod(eodAt);
    plan.dispatch = dispatchOn();
    if (drafted) {
      plan.summary = drafted.summary;
      // Who does what is the plan's task list.
      const rows = readRows();
      if (rows.length) {
        plan.assign = rows;
        if (plan.newGoal) plan.newGoal.tasks = rows.map((r) => r.task);
      }
    }
    if (eodLines().length) plan.eod = eodLines();
    started = true;
    modal.close();
    onStart(plan);
  });
  if (goalChoice === "new") setTimeout(() => title.focus(), 0);
  else setTimeout(() => intent.focus(), 0);
}
