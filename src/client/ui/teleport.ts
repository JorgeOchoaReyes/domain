import { PLACES, type RoomId } from "../../shared/layout.js";
import { esc, openModal } from "./modal.js";

/**
 * Fast travel (T): a grid of places — the work floor, your office, the
 * stand-up room, the kitchen, the game room, the lobby, outside — plus any
 * worker that needs you right now. Number keys pick. Arrival plays a quick
 * flash so the jump reads as a teleport, not a glitch.
 */

export interface Destination {
  label: string;
  icon: string;
  x: number;
  z: number;
  facing: number;
  /** A short line under the label. */
  sub?: string;
  urgent?: boolean;
  /** Something to do on arrival (e.g. start office hours). */
  then?: () => void;
}

export function placeDestinations(here: RoomId | "desks"): Destination[] {
  return PLACES.map((p) => ({ label: p.label, icon: p.icon, x: p.x, z: p.z, facing: p.facing, sub: p.id === here ? "You're here" : undefined }));
}

export function openTeleport(dests: Destination[], onGo: (d: Destination) => void): void {
  const body = document.createElement("div");
  body.className = "tp-grid";
  body.innerHTML = dests
    .map(
      (d, i) => `<button class="tp-dest ${d.urgent ? "urgent" : ""}" data-i="${i}">
        <span class="tp-key">${i < 9 ? i + 1 : ""}</span>
        <span class="tp-icon">${d.icon}</span>
        <b>${esc(d.label)}</b>
        ${d.sub ? `<span class="tp-sub">${esc(d.sub)}</span>` : ""}
      </button>`,
    )
    .join("");
  let picked = false;
  const onKey = (e: KeyboardEvent) => {
    const n = Number(e.key);
    if (n >= 1 && n <= Math.min(9, dests.length)) {
      e.preventDefault();
      e.stopPropagation();
      go(dests[n - 1]);
    }
  };
  const modal = openModal({
    title: "Fast travel",
    icon: "🌀",
    className: "tp-modal",
    body,
    footer: `<span class="grow">Press a number, or click · T opens this anywhere</span>`,
    onClose: () => window.removeEventListener("keydown", onKey, true),
  });
  const go = (d: Destination) => {
    if (picked) return;
    picked = true;
    modal.close();
    onGo(d);
  };
  window.addEventListener("keydown", onKey, true);
  body.querySelectorAll<HTMLElement>(".tp-dest").forEach((b) => b.addEventListener("click", () => go(dests[Number(b.dataset.i)])));
}

/** A quick swirl of light over the screen as you arrive. */
export function teleportFlash(): void {
  const el = document.createElement("div");
  el.className = "tp-flash";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 700);
}
