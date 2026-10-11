import type { ClientMessage, ServerMessage } from "../../shared/protocol.js";
import type { Goal } from "../../shared/progress.js";
import { esc, openModal, type Modal } from "./modal.js";
import "../styles/huddle.css";

/**
 * The demo at the end of a goal, shown to everyone: when every task is
 * approved the office captures what was built — a screenshot of the running
 * app, or a captured terminal run — and this window shows it, with a button
 * to capture it again. Screenshots come separately ("demoImage") and are kept
 * here, so the goal itself stays small.
 */

export interface DemoCtx {
  goal(goalId: string): Goal | undefined;
  send(msg: ClientMessage): void;
}

const images = new Map<string, { at: number; data: string | null }>();
let open: { goalId: string; modal: Modal; draw: () => void; timer: number } | null = null;

/** Feed every server message through here: it keeps the screenshots. */
export function ingestDemo(msg: ServerMessage): void {
  if (msg.t !== "demoImage") return;
  images.set(msg.goalId, { at: msg.at, data: msg.data });
  if (open?.goalId === msg.goalId) open.draw();
}

/** The demo as html (the screenshot, the output, or where it stands). */
export function demoHtml(goal: Goal, image: string | null): string {
  const d = goal.demo;
  if (!d) return `<p class="hint-sm">No demo yet — capture one to show the team what was built.</p>`;
  const source = `<code>${esc(d.source)}</code>`;
  if (d.status === "running") return `<p class="dm-status">🎬 Capturing ${d.kind === "screenshot" ? `a screenshot of ${source}` : `a run of ${source}`}…</p>`;
  const when = new Date(d.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const head = `<p class="dm-status">${d.status === "ready" ? "✅" : "⚠️"} ${d.kind === "screenshot" ? `Screenshot of ${source}` : `${source}${d.exitCode !== null ? ` · exit ${d.exitCode}` : ""}`} · ${when}</p>`;
  if (d.kind === "screenshot" && d.image) {
    return head + (image ? `<img class="dm-shot" alt="A screenshot of ${esc(goal.title)}" src="${esc(image)}" />` : `<p class="hint-sm">Loading the screenshot…</p>`);
  }
  return head + (d.output ? `<pre class="dm-term">${esc(d.output)}</pre>` : "");
}

/** Open the demo window for a goal (everyone in the office can). */
export function openDemo(goalId: string, ctx: DemoCtx): void {
  open?.modal.close();
  const goal = ctx.goal(goalId);
  if (!goal) return;
  if (goal.demo?.image && images.get(goalId)?.at !== goal.demo.at) ctx.send({ t: "demoGet", goalId });
  const body = document.createElement("div");
  body.className = "demo";
  const footer = document.createElement("div");
  footer.className = "hd-foot";
  footer.innerHTML = `<span class="grow">What was built, as it runs now — before it ships.</span><button class="btn small again">↻ Capture again</button>`;
  const modal = openModal({ title: `Demo · ${goal.title}`, icon: "🎬", className: "demo-modal", body, footer, onClose: () => stop() });
  let key = "";
  let asked = goal.demo?.at ?? 0;
  const draw = () => {
    const g = ctx.goal(goalId);
    if (!g) return modal.close();
    // A fresh capture: fetch its screenshot.
    if (g.demo?.image && g.demo.at !== asked && images.get(goalId)?.at !== g.demo.at) {
      asked = g.demo.at;
      ctx.send({ t: "demoGet", goalId });
    }
    const img = g.demo?.image && images.get(goalId)?.at === g.demo.at ? images.get(goalId)!.data : null;
    const html = demoHtml(g, img);
    if (html !== key) body.innerHTML = key = html;
    footer.querySelector<HTMLButtonElement>(".again")!.disabled = g.demo?.status === "running";
  };
  footer.querySelector(".again")!.addEventListener("click", () => ctx.send({ t: "demo", goalId }));
  draw();
  const timer = window.setInterval(draw, 1000);
  const stop = () => {
    window.clearInterval(timer);
    if (open?.modal === modal) open = null;
  };
  open = { goalId, modal, draw, timer };
}
