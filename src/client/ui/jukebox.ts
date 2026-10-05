import { TRACKS, type TrackId } from "../music.js";
import { esc, openModal } from "./modal.js";
import "../styles/jukebox.css";

/**
 * The jukebox: pick what the office plays. Each record is a track the
 * office composes live; the one playing bounces. Volume and off are here
 * too (and in Settings).
 */

export interface JukeboxState {
  on: boolean;
  track: TrackId;
  volume: number;
}

export function openJukebox(state: JukeboxState, onChange: (s: JukeboxState) => void): void {
  const s = { ...state };
  const body = document.createElement("div");
  body.className = "jukebox";
  const render = () => {
    body.innerHTML = `
      <div class="jb-records">
        ${TRACKS.map(
          (t) => `<button class="jb-record ${s.on && t.id === s.track ? "playing" : ""}" data-track="${t.id}">
            <span class="jb-disc"><span class="jb-icon">${t.icon}</span></span>
            <b>${esc(t.name)}</b>
            <span class="jb-vibe">${esc(t.vibe)}</span>
            <span class="jb-bpm">${t.bpm} bpm</span>
            ${s.on && t.id === s.track ? `<span class="jb-eq"><i></i><i></i><i></i><i></i></span>` : ""}
          </button>`,
        ).join("")}
      </div>
      <div class="jb-controls">
        <button class="btn ${s.on ? "" : "primary"} jb-power">${s.on ? "⏹ Music off" : "▶ Play"}</button>
        <label class="jb-vol">🔉 <input type="range" min="0" max="1" step="0.05" value="${s.volume}" /> <output>${Math.round(s.volume * 100)}%</output></label>
      </div>
      <p class="jb-note">Made up on the spot by the office — no recordings, nothing downloaded.</p>`;
    body.querySelectorAll<HTMLButtonElement>(".jb-record").forEach((b) =>
      b.addEventListener("click", () => {
        s.track = b.dataset.track as TrackId;
        s.on = true;
        onChange({ ...s });
        render();
      }),
    );
    body.querySelector(".jb-power")!.addEventListener("click", () => {
      s.on = !s.on;
      onChange({ ...s });
      render();
    });
    const vol = body.querySelector<HTMLInputElement>(".jb-vol input")!;
    vol.addEventListener("input", () => {
      s.volume = Number(vol.value);
      body.querySelector(".jb-vol output")!.textContent = `${Math.round(s.volume * 100)}%`;
      onChange({ ...s });
    });
  };
  render();
  openModal({ title: "Jukebox", icon: "🪩", className: "jukebox-modal", body });
}
