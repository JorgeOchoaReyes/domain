import type { HistoryEvent, HistoryKind } from "../../shared/history.js";
import type { ServerMessage } from "../../shared/protocol.js";
import { esc, openModal } from "./modal.js";
import "../styles/history.css";

/**
 * The office's history on the client: kept up to date from the server, shown
 * as a timeline (by day, filterable by worker), and read by a worker's Work
 * tab ("done before") and the phone.
 */

let events: HistoryEvent[] = [];
const listeners = new Set<() => void>();

export function ingestHistory(msg: ServerMessage): void {
  if (msg.t === "history") events = msg.events;
  else if (msg.t === "historyEvent") events = [msg.event, ...events].slice(0, 2000);
  else return;
  for (const l of listeners) l();
}

export function historyEvents(): HistoryEvent[] {
  return events;
}

export function onHistory(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Everything about one worker (by character, else by desk), newest first. */
export function historyOf(worker: { deskId: string; characterId?: string }): HistoryEvent[] {
  return events.filter((e) => e.worker && (worker.characterId ? e.worker.characterId === worker.characterId : e.worker.deskId === worker.deskId));
}

export const KIND_ICON: Record<HistoryKind, string> = {
  hired: "🪑",
  left: "👋",
  assigned: "🎯",
  reported: "📋",
  approved: "✅",
  changes: "✏️",
  audit: "🔍",
  shipped: "🚀",
  goal: "🧭",
  session: "🔥",
  group: "👥",
  deadline: "📅",
  sync: "🌙",
};

function dayTitle(t: number): string {
  const d = new Date(t);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

/** A timeline of events, grouped by day. */
export function timelineHtml(list: HistoryEvent[], limit = 300): string {
  if (!list.length) return `<p class="hi-empty">Nothing yet — it fills up as you and your workers get things done.</p>`;
  let html = "";
  let day = "";
  for (const e of list.slice(0, limit)) {
    const d = dayTitle(e.at);
    if (d !== day) {
      day = d;
      html += `<h4 class="hi-day">${esc(d)}</h4>`;
    }
    html += `<div class="hi-row k-${e.kind}"><span class="hi-icon">${KIND_ICON[e.kind] ?? "•"}</span><span class="hi-text">${esc(e.text)}</span><span class="hi-time">${new Date(e.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span></div>`;
  }
  return html;
}

/** The History window: everything, or one worker's. */
export function openHistory(send: (m: { t: "historyGet" }) => void, worker?: { deskId: string; characterId?: string; name: string }): void {
  send({ t: "historyGet" });
  const body = document.createElement("div");
  body.className = "history";
  let who: string | null = worker ? (worker.characterId ?? worker.deskId) : null;
  const render = () => {
    const names = new Map<string, string>();
    for (const e of events) if (e.worker) names.set(e.worker.characterId ?? e.worker.deskId, e.worker.name);
    const list = who ? events.filter((e) => e.worker && (e.worker.characterId ?? e.worker.deskId) === who) : events;
    const done = list.filter((e) => e.kind === "approved").length;
    const shipped = list.filter((e) => e.kind === "shipped").length;
    body.innerHTML = `
      <div class="hi-filters">
        <button class="${who ? "" : "on"}" data-who="">Everything</button>
        ${[...names].map(([k, n]) => `<button class="${who === k ? "on" : ""}" data-who="${esc(k)}">${esc(n)}</button>`).join("")}
      </div>
      <div class="hi-stats"><span>📜 ${list.length} events</span><span>✅ ${done} approved</span><span>🚀 ${shipped} shipped</span></div>
      <div class="hi-list">${timelineHtml(list)}</div>`;
    body.querySelectorAll<HTMLButtonElement>(".hi-filters button").forEach((b) =>
      b.addEventListener("click", () => {
        who = b.dataset.who || null;
        render();
      }),
    );
  };
  render();
  const off = onHistory(render);
  openModal({ title: worker ? `History · ${worker.name}` : "History", icon: "📜", className: "history-modal", body, onClose: off });
}
