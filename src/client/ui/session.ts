import { SESSION_LENGTHS, XP, clock, goalProgress, sessionLength, type ProgressState, type SessionSummary } from "../../shared/progress.js";
import { confetti, sound } from "./fx.js";
import { esc, openModal } from "./modal.js";

/**
 * Focus sessions: the window to start one, the timer pill across the top of
 * the screen while it runs, and the summary when it ends.
 */

export function openStartSession(progress: ProgressState, goalId: string | null, onStart: (minutes: number, goalId: string | null) => void): void {
  const open = progress.goals.filter((g) => !g.doneAt);
  let minutes: number = SESSION_LENGTHS[0];
  let goal: string | null = goalId ?? open[0]?.id ?? null;
  const body = document.createElement("div");
  body.className = "start-session";
  body.innerHTML = `
    <p class="setting-note" style="margin-top:0">A timed sprint for the whole office. Hire, assign and review as usual — when the timer runs out, everyone here earns <b>${XP.sessionMinute} XP a minute</b> and keeps their streak alive.</p>
    <label>How long?</label>
    <div class="lengths">${SESSION_LENGTHS.map((m) => `<button class="len ${m === minutes ? "sel" : ""}" data-m="${m}"><b>${m / 60}</b><span>${m === 60 ? "hour" : "hours"}</span><i>+${m * XP.sessionMinute} XP</i></button>`).join("")}</div>
    <label>Focus on</label>
    <ul class="svc-list pick-goal">
      ${open
        .map((g) => {
          const pr = goalProgress(g);
          return `<li data-g="${g.id}" class="${g.id === goal ? "on" : ""}"><span class="svc-main"><span class="svc-title">🎯 ${esc(g.title)}</span><span class="svc-meta">${pr.done}/${pr.total} tasks done</span></span></li>`;
        })
        .join("")}
      <li data-g="" class="${goal === null ? "on" : ""}"><span class="svc-main"><span class="svc-title">✨ Just focus</span><span class="svc-meta">No particular goal</span></span></li>
    </ul>`;
  const footer = document.createElement("div");
  footer.style.display = "contents";
  footer.innerHTML = `<span class="grow">One session at a time for the whole office</span><button class="btn primary go">⏱ Start focus session</button>`;
  const modal = openModal({ title: "Start a focus session", icon: "⏱", body, footer });
  body.querySelectorAll<HTMLButtonElement>(".len").forEach((b) =>
    b.addEventListener("click", () => {
      minutes = Number(b.dataset.m);
      body.querySelectorAll(".len").forEach((x) => x.classList.toggle("sel", x === b));
    }),
  );
  body.querySelectorAll<HTMLElement>(".pick-goal li").forEach((li) =>
    li.addEventListener("click", () => {
      goal = li.dataset.g || null;
      body.querySelectorAll(".pick-goal li").forEach((x) => x.classList.toggle("on", x === li));
    }),
  );
  footer.querySelector(".go")!.addEventListener("click", () => {
    modal.close();
    onStart(minutes, goal);
  });
}

/** The countdown across the top of the screen while a session runs. */
export class SessionPill {
  readonly el = document.createElement("div");
  private stopArmed = 0;

  constructor(parent: HTMLElement, private onStop: () => void) {
    this.el.className = "session-pill panel hidden";
    parent.appendChild(this.el);
    this.el.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest(".stop");
      if (!b) return;
      if (Date.now() - this.stopArmed < 3000) this.onStop();
      else {
        this.stopArmed = Date.now();
        (b as HTMLElement).textContent = "End early?";
      }
    });
  }

  /** Call often (every frame is fine): it redraws once a second. */
  private last = "";
  update(progress: ProgressState | null): void {
    const s = progress?.session;
    if (!s) {
      if (this.last) {
        this.last = "";
        this.el.classList.add("hidden");
        document.body.classList.remove("in-session");
      }
      return;
    }
    const left = Math.max(0, s.endsAt - Date.now());
    const time = clock(left);
    const goal = s.goalId ? progress!.goals.find((g) => g.id === s.goalId) : null;
    const pr = goal ? goalProgress(goal) : null;
    const pct = 1 - left / (s.minutes * 60000);
    const armed = Date.now() - this.stopArmed < 3000;
    const key = `${time}|${goal?.title}|${pr?.done}|${s.tasksDone}|${s.xp}|${armed}`;
    if (key === this.last) return;
    this.last = key;
    this.el.classList.remove("hidden");
    document.body.classList.add("in-session");
    this.el.innerHTML = `
      <span class="ring" style="--p:${(pct * 100).toFixed(1)}%"><span>🔥</span></span>
      <span class="sp-main">
        <span class="sp-time">${time}</span>
        <span class="sp-goal">${goal ? `🎯 ${esc(goal.title)} · ${pr!.done}/${pr!.total}` : "Focus session"}</span>
      </span>
      <span class="sp-stat" title="Tasks done this session">✅ ${s.tasksDone}</span>
      <span class="sp-stat" title="XP earned this session">⭐ ${s.xp}</span>
      <button class="btn small stop">${armed ? "End early?" : "End"}</button>`;
  }
}

export function showSessionSummary(s: SessionSummary): void {
  sound.bell();
  if (s.completed) {
    confetti(180);
    setTimeout(() => sound.levelUp(), 300);
  }
  openModal({
    title: s.completed ? "Session complete!" : "Session ended",
    icon: s.completed ? "🏁" : "⏹",
    className: "summary-modal",
    body: `
      <div class="summary">
        <div class="big">${s.completed ? "🎉" : "👋"}</div>
        <p class="lead">${s.completed ? `You stayed in the zone for <b>${sessionLength(s.minutes)}</b>${s.goalTitle ? ` on <b>${esc(s.goalTitle)}</b>` : ""}.` : "Stopped early — no session bonus this time, but your progress counts."}</p>
        <div class="stats">
          <div><b>${s.tasksDone}</b><span>tasks done</span></div>
          <div><b>${s.reviews}</b><span>reviews</span></div>
          <div><b>+${s.xp}</b><span>XP earned</span></div>
        </div>
      </div>`,
    footer: `<span class="grow">Take a short break, then go again 💪</span>`,
  });
}
