import type { ServerMessage } from "../../shared/protocol.js";
import type { OpLog, OpTool } from "../../shared/project.js";
import { icon, type IconName } from "./icons.js";
import { esc, openModal } from "./modal.js";

/**
 * The operations log on the client: every git, GitHub, MCP, check and deploy
 * step the office ran, with its icon, status, command and output. A Logs
 * window shows them all; logView(topic) embeds a live list of just one
 * thing's steps (a clone, a ship, an MCP check) wherever it happens.
 */

const entries = new Map<string, OpLog>();
const order: string[] = [];
const views = new Set<{ el: HTMLElement; match: (e: OpLog) => boolean; limit: number }>();

const TOOL_ICON: Record<OpTool, IconName> = {
  git: "git",
  github: "github",
  mcp: "mcp",
  check: "check",
  deploy: "terminal",
  agent: "terminal",
};
const TOOL_LABEL: Record<OpTool, string> = { git: "git", github: "GitHub", mcp: "MCP", check: "Check", deploy: "Deploy", agent: "Agent" };

/** Feed every server message through here. */
export function ingestLogs(msg: ServerMessage): void {
  if (msg.t === "oplogAll") {
    entries.clear();
    order.length = 0;
    for (const e of [...msg.entries].reverse()) upsert(e);
  } else if (msg.t === "oplog") upsert(msg.entry);
  else return;
  for (const v of views) {
    if (!v.el.isConnected) views.delete(v);
    else render(v);
  }
}

function upsert(e: OpLog): void {
  if (!entries.has(e.id)) order.unshift(e.id);
  entries.set(e.id, e);
  if (order.length > 300) entries.delete(order.pop()!);
}

/** All entries, newest first. */
export function logEntries(match: (e: OpLog) => boolean = () => true): OpLog[] {
  return order.map((id) => entries.get(id)!).filter((e) => e && match(e));
}

/** One entry as markup: icon, title, status, when; the command and output fold open. */
export function entryHtml(e: OpLog, open = false): string {
  const status = e.status === "running" ? icon("spinner", 14) : e.status === "ok" ? icon("check", 14) : icon("x", 14);
  const when = new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const body =
    (e.command ? `<div class="lg-cmd">${icon("terminal", 12)} <code>${esc(e.command)}</code></div>` : "") +
    (e.output ? `<pre class="lg-out">${esc(e.output.slice(-6000))}</pre>` : "") +
    (e.url ? `<a class="lg-link" href="${esc(e.url)}" target="_blank" rel="noopener">${icon("link", 12)} ${esc(e.url)}</a>` : "");
  return `<details class="lg-entry ${e.status}" ${open || e.status === "error" ? "open" : ""}>
    <summary><span class="lg-tool" title="${TOOL_LABEL[e.tool]}">${icon(TOOL_ICON[e.tool], 16)}</span><span class="lg-title">${esc(e.title)}</span><span class="lg-status">${status}</span><span class="lg-when">${when}</span></summary>
    ${body || `<div class="lg-empty">No output.</div>`}
  </details>`;
}

function render(v: { el: HTMLElement; match: (e: OpLog) => boolean; limit: number }): void {
  const list = logEntries(v.match).slice(0, v.limit);
  // Keep the open/closed state of entries the reader expanded.
  const open = new Set([...v.el.querySelectorAll<HTMLDetailsElement>("details[open]")].map((d) => d.dataset.id));
  v.el.innerHTML = list.length
    ? list.map((e) => entryHtml(e, open.has(e.id)).replace("<details ", `<details data-id="${e.id}" `)).join("")
    : `<div class="lg-empty">Nothing yet.</div>`;
}

/**
 * A live list of the steps for one thing — a topic ("clone", "ship:<goalId>",
 * "mcp:<id>") or any test — to put in a window. It updates itself.
 */
export function logView(topic: string | ((e: OpLog) => boolean), limit = 8): HTMLElement {
  const el = document.createElement("div");
  el.className = "lg-view";
  const match = typeof topic === "string" ? (e: OpLog) => e.topic === topic || e.topic?.startsWith(topic + ":") === true : topic;
  const v = { el, match, limit };
  views.add(v);
  render(v);
  return el;
}

/** The Logs window: everything, filterable by tool. */
export function openLogs(tool?: OpTool): void {
  const body = document.createElement("div");
  body.className = "logs";
  const tools: (OpTool | "all")[] = ["all", "git", "github", "mcp", "check", "deploy"];
  let current: OpTool | "all" = tool ?? "all";
  body.innerHTML = `<div class="seg lg-filter">${tools
    .map((t) => `<button data-t="${t}">${t === "all" ? "All" : `${icon(TOOL_ICON[t], 14)} ${TOOL_LABEL[t]}`}</button>`)
    .join("")}</div>`;
  let view = logView((e) => current === "all" || e.tool === current, 80);
  body.appendChild(view);
  const sync = () => body.querySelectorAll<HTMLElement>(".lg-filter button").forEach((b) => b.classList.toggle("on", b.dataset.t === current));
  body.querySelectorAll<HTMLElement>(".lg-filter button").forEach((b) =>
    b.addEventListener("click", () => {
      current = b.dataset.t as OpTool | "all";
      sync();
      const next = logView((e) => current === "all" || e.tool === current, 80);
      view.replaceWith(next);
      view = next;
    }),
  );
  sync();
  openModal({
    title: "Logs",
    icon: icon("log", 20),
    className: "logs-modal",
    body,
    footer: `<span class="grow">Every git, GitHub, MCP, check and deploy step the office ran for you, with its command and output</span>`,
  });
}
