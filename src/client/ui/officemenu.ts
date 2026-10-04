import { icon, type IconName } from "./icons.js";
import { esc, openModal } from "./modal.js";

/**
 * The Office menu (🏢): one place for running the office itself — which
 * project it's on and GitHub, your team of characters, the MCP tools workers
 * get, inviting people on your Wi-Fi, and the logs of everything it ran.
 */

export interface OfficeTile {
  key: string;
  icon: IconName | string;
  title: string;
  text: string;
  /** Hidden for guests (only the host runs these). */
  hostOnly?: boolean;
  run(): void;
}

export function openOfficeMenu(tiles: OfficeTile[], isGuest: boolean): void {
  const list = tiles.filter((t) => !(t.hostOnly && isGuest));
  const body = document.createElement("div");
  body.className = "om-grid";
  body.innerHTML = list
    .map(
      (t, i) => `<button class="om-tile" data-i="${i}">
        <span class="om-icon">${t.icon.length > 2 && /^[a-z]+$/.test(t.icon) ? icon(t.icon as IconName, 28) : esc(t.icon)}</span>
        <b>${esc(t.title)}</b>
        <span>${esc(t.text)}</span>
      </button>`,
    )
    .join("");
  const modal = openModal({ title: "Office", icon: "🏢", className: "om-modal", body });
  body.querySelectorAll<HTMLButtonElement>(".om-tile").forEach((b) =>
    b.addEventListener("click", () => {
      modal.close();
      list[Number(b.dataset.i)].run();
    }),
  );
}
