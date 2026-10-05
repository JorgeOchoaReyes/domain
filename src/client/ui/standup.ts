import type { Desk } from "../../shared/protocol.js";
import { AGENT_LABELS } from "../../shared/protocol.js";
import {
  SESSION_LENGTHS,
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

/**
 * The stand-up that opens every session. On the left, where things stand:
 * the goals and where each is in the loop, what the workers are up to, what
 * happened since last time. On the right, you set up the session: pick (or
 * set) today's goal, choose its tone, say what would make it a win, and pick
 * a length. "Start the day" kicks off a focus session with all of that. If a
 * session is already on, it shows you the plan and lets you join in.
 */

export interface StandupPlan {
  goalId: string | null;
  newGoal?: { title: string; why: string; tasks: string[]; kind: GoalKind };
  tone: ToneId;
  intention: string;
  minutes: number;
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
  let minutes: number = TONES.find((t) => t.id === tone)!.minutes;

  body.innerHTML = `
    <section class="su-col su-recap">
      <h3>🎯 Goals</h3><ul class="su-list">${goalsHtml}</ul>
      <h3>👥 The team</h3><ul class="su-list">${teamHtml}</ul>
      <h3>📣 Since last time</h3><ul class="su-list">${sinceHtml}</ul>
    </section>
    <section class="su-col su-plan">
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
      </div>

      <div class="su-step"><span class="su-n">2</span><h3>Set the tone</h3></div>
      <div class="su-tones">
        ${TONES.map((t) => `<button class="su-tone ${t.id === tone ? "on" : ""}" data-tone="${t.id}" style="--tone:${t.color}"><span class="ti">${t.icon}</span><b>${esc(t.label)}</b><span>${esc(t.blurb)}</span></button>`).join("")}
      </div>

      <div class="su-step"><span class="su-n">3</span><h3>What would make this session a win?</h3></div>
      <input type="text" class="su-intent" maxlength="140" placeholder="e.g. Checkout works end to end and is deployed" />

      <div class="su-step"><span class="su-n">4</span><h3>How long?</h3></div>
      <div class="seg su-len">${SESSION_LENGTHS.map((m) => `<button data-m="${m}" class="${m === minutes ? "on" : ""}">${sessionLength(m)}</button>`).join("")}</div>
    </section>`;

  const footer = document.createElement("div");
  footer.style.display = "contents";
  footer.innerHTML = `<button class="btn skip">Skip stand-up</button><span class="grow">+${XP.standup} XP for the stand-up · the session pays ${XP.sessionMinute} XP a minute when it finishes</span><button class="btn primary go">🔔 Start the day</button>`;

  let started = false;
  const modal = openModal({
    title: `${greeting(myName)} — time for stand-up`,
    icon: "☀️",
    className: "standup-modal",
    body,
    footer,
    onClose: () => {
      if (!started) onSkip();
    },
  });

  const $ = <T extends HTMLElement>(sel: string) => body.querySelector<T>(sel)!;
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
  const syncLen = () => body.querySelectorAll<HTMLElement>(".su-len button").forEach((x) => x.classList.toggle("on", Number(x.dataset.m) === minutes));
  body.querySelectorAll<HTMLButtonElement>(".su-tone").forEach((b) =>
    b.addEventListener("click", () => {
      tone = b.dataset.tone as ToneId;
      body.querySelectorAll(".su-tone").forEach((x) => x.classList.toggle("on", x === b));
      minutes = TONES.find((t) => t.id === tone)!.minutes;
      syncLen();
    }),
  );
  body.querySelectorAll<HTMLButtonElement>(".su-len button").forEach((b) =>
    b.addEventListener("click", () => {
      minutes = Number(b.dataset.m);
      syncLen();
    }),
  );

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
        newGoal: { title: t, why: "", tasks: tasks.value.split("\n").map((x) => x.trim()).filter(Boolean), kind },
        tone,
        intention: intent.value.trim(),
        minutes,
      };
    } else {
      plan = { goalId: goalChoice, tone, intention: intent.value.trim(), minutes };
    }
    started = true;
    modal.close();
    onStart(plan);
  });
  if (goalChoice === "new") setTimeout(() => title.focus(), 0);
  else setTimeout(() => intent.focus(), 0);
}
