import { ACHIEVEMENTS, levelFor, type PlayerStats, type ProgressState } from "../../shared/progress.js";
import { esc, openModal } from "./modal.js";

/**
 * Your player card in the top bar — level, title, XP bar and streak — and the
 * profile window behind it: your stats, the achievements (locked ones greyed
 * out) and the office leaderboard.
 */

export function blankStats(name: string): PlayerStats {
  return { name, xp: 0, tasksDone: 0, reviews: 0, changes: 0, sessions: 0, goalsDone: 0, hires: 0, streak: 0, lastDay: null, today: 0, achievements: [] };
}

export class PlayerCard {
  readonly el = document.createElement("button");
  private last = "";

  constructor(parent: HTMLElement, onOpen: () => void) {
    this.el.className = "panel player-card";
    this.el.title = "Your profile";
    this.el.addEventListener("click", onOpen);
    parent.appendChild(this.el);
  }

  update(s: PlayerStats): void {
    const lv = levelFor(s.xp);
    const key = `${s.name}|${s.xp}|${s.streak}`;
    if (key === this.last) return;
    this.last = key;
    this.el.innerHTML = `
      <span class="lv" title="Level ${lv.level}">${lv.level}</span>
      <span class="pc-main">
        <span class="pc-name">${esc(s.name)} <span class="pc-title">${esc(lv.title)}</span></span>
        <span class="bar xp"><span style="width:${Math.round((lv.into / lv.need) * 100)}%"></span></span>
        <span class="pc-xp">${lv.into} / ${lv.need} XP</span>
      </span>
      <span class="streak ${s.streak ? "on" : ""}" title="Day streak: finish a focus session every day">🔥${s.streak}</span>`;
  }
}

export function openProfile(me: PlayerStats, progress: ProgressState): void {
  const lv = levelFor(me.xp);
  const board = [...progress.players].sort((a, b) => b.xp - a.xp).slice(0, 8);
  openModal({
    title: me.name,
    icon: "🏅",
    className: "profile-modal",
    body: `
      <div class="profile">
        <div class="pr-head">
          <span class="lv big">${lv.level}</span>
          <div>
            <div class="pr-title">${esc(lv.title)}</div>
            <div class="bar xp"><span style="width:${Math.round((lv.into / lv.need) * 100)}%"></span></div>
            <div class="pc-xp">${me.xp} XP total · ${lv.need - lv.into} to level ${lv.level + 1}</div>
          </div>
        </div>
        <div class="stats">
          <div><b>${me.tasksDone}</b><span>tasks done</span></div>
          <div><b>${me.goalsDone}</b><span>goals done</span></div>
          <div><b>${me.reviews}</b><span>reviews</span></div>
          <div><b>${me.sessions}</b><span>focus sessions</span></div>
          <div><b>🔥 ${me.streak}</b><span>day streak</span></div>
          <div><b>${me.hires}</b><span>workers hired</span></div>
        </div>
        <h4>Achievements · ${me.achievements.length}/${ACHIEVEMENTS.length}</h4>
        <div class="badges">
          ${ACHIEVEMENTS.map((a) => {
            const got = me.achievements.includes(a.id);
            return `<div class="badge ${got ? "got" : ""}" title="${esc(a.text)}"><span class="b-icon">${got ? a.icon : "🔒"}</span><b>${esc(a.title)}</b><span>${esc(a.text)}</span></div>`;
          }).join("")}
        </div>
        <h4>Leaderboard</h4>
        <ol class="leaders">
          ${
            board.length
              ? board
                  .map((p, i) => {
                    const l = levelFor(p.xp);
                    return `<li class="${p.name === me.name ? "me" : ""}"><span class="rank">${["🥇", "🥈", "🥉"][i] ?? i + 1}</span><span class="ln">${esc(p.name)} <span class="sub">Lv ${l.level} · ${esc(l.title)}</span></span><b>${p.xp} XP</b></li>`;
                  })
                  .join("")
              : `<li class="empty">No scores yet — go make some progress!</li>`
          }
        </ol>
      </div>`,
  });
}

