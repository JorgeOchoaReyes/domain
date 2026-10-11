import type { InboxItem } from "../../shared/inbox.js";
import type { RecentNote } from "./hud.js";
import { esc } from "./modal.js";

/**
 * 🔔 Needs you (I): the inbox under its dock button. One list of everything
 * waiting on you — agents' questions, stuck agents, work to review, "I'll take
 * it" offers, requests to borrow your agents, huddles and demos to watch,
 * deadlines — each with its buttons. Below it, Recent: the routine news that
 * didn't pop up as a toast. The list itself is built in shared/inbox.ts; the
 * phone's Alerts shows the same one.
 */

export interface InboxDeps {
  items(): InboxItem[];
  recent(): RecentNote[];
  /** Do what one of an item's buttons says. */
  act(item: InboxItem, action: string): void;
  dismiss(id: string): void;
  /** It opened (the More menu puts itself away). */
  opened?(): void;
}

function ago(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/** One item, as the inbox and the phone draw it. */
export function inboxItemHtml(x: InboxItem, i: number): string {
  return `<li class="ib-item u${x.urgency}" data-i="${i}">
    <span class="ib-icon">${x.icon}</span>
    <div class="ib-main">
      <b>${esc(x.title)}</b>
      ${x.detail ? `<small>${esc(x.detail)}</small>` : ""}
      ${x.actions.length ? `<div class="ib-acts">${x.actions.map((a) => `<button class="btn small ${a.primary ? "primary" : ""}" data-do="${esc(a.id)}">${esc(a.label)}</button>`).join("")}</div>` : ""}
    </div>
    ${x.dismissable ? `<button class="ib-x" data-dismiss title="Dismiss" aria-label="Dismiss">✕</button>` : ""}
  </li>`;
}

/** Wire the buttons of a list drawn with inboxItemHtml. */
export function wireInboxList(list: HTMLElement, items: () => InboxItem[], deps: Pick<InboxDeps, "act" | "dismiss">, after?: (action: string) => void): void {
  list.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const li = t.closest<HTMLElement>(".ib-item");
    const item = li ? items()[Number(li.dataset.i)] : undefined;
    if (!item) return;
    if (t.closest("[data-dismiss]")) {
      deps.dismiss(item.id);
      return;
    }
    const b = t.closest<HTMLButtonElement>("[data-do]");
    if (!b) return;
    b.disabled = true;
    deps.act(item, b.dataset.do!);
    after?.(b.dataset.do!);
  });
}

export class InboxPanel {
  readonly el: HTMLElement;
  private shown: InboxItem[] = [];
  private lastKey = "";

  constructor(root: HTMLElement, private button: HTMLElement, private deps: InboxDeps) {
    this.el = document.createElement("div");
    this.el.className = "dock-pop inbox-pop hidden";
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-label", "Needs you");
    this.el.innerHTML = `
      <div class="ib-head"><h3>🔔 Needs you <span class="ib-n"></span></h3><span class="ib-hint"><span class="key">N</span> next · <span class="key">I</span> close</span></div>
      <ul class="ib-list"></ul>
      <details class="ib-recent"><summary>Recent <span class="ib-rn"></span></summary><ul></ul></details>`;
    root.appendChild(this.el);
    // Opening something from the list puts the inbox away (offers and loans answer in place).
    wireInboxList(this.el.querySelector(".ib-list")!, () => this.shown, deps, (a) => {
      if (!["take", "next", "lend", "refuse", "trust"].includes(a)) this.close();
      this.refresh(true);
    });
    document.addEventListener("pointerdown", (e) => {
      const t = e.target as HTMLElement;
      if (this.isOpen && !this.el.contains(t) && !this.button.contains(t)) this.close();
    });
  }

  get isOpen(): boolean {
    return !this.el.classList.contains("hidden");
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    this.deps.opened?.();
    this.el.classList.remove("hidden");
    this.button.classList.add("on");
    this.button.setAttribute("aria-expanded", "true");
    this.refresh(true);
  }

  /** Put it away; true if it was open. */
  close(): boolean {
    if (!this.isOpen) return false;
    this.el.classList.add("hidden");
    this.button.classList.remove("on");
    this.button.setAttribute("aria-expanded", "false");
    return true;
  }

  /** Redraw (only when open, and when something changed unless forced). */
  refresh(force = false): void {
    if (!this.isOpen) return;
    const items = this.deps.items();
    const recent = this.deps.recent();
    const key = JSON.stringify([items.map((x) => [x.id, x.title, x.detail, x.actions.length]), recent.length, recent[0]?.at]);
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    this.shown = items;
    this.el.querySelector(".ib-n")!.textContent = items.length ? String(items.length) : "";
    this.el.querySelector(".ib-list")!.innerHTML = items.length
      ? items.map(inboxItemHtml).join("")
      : `<li class="ib-empty">✨ Nothing needs you right now. Questions, reviews, offers and requests land here — and the 🔔 counts them.</li>`;
    this.el.querySelector(".ib-rn")!.textContent = recent.length ? `· ${recent.length}` : "";
    this.el.querySelector(".ib-recent ul")!.innerHTML = recent.length
      ? recent
          .slice(0, 25)
          .map((r) => `<li class="ib-note ${r.level}"><span>${esc(r.text)}</span><time>${ago(r.at)}</time></li>`)
          .join("")
      : `<li class="ib-empty">Routine news (merges, plans, ideas, scores) collects here instead of popping up.</li>`;
  }
}
