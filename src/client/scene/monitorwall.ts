import type { Desk } from "../../shared/protocol.js";
import { AGENT_LABELS, doingLabel } from "../../shared/protocol.js";
import type { ProgressState } from "../../shared/progress.js";
import { STATUS_BULB } from "./characters.js";

/**
 * The monitor wall in your office: every worker's terminal on one big
 * screen, a tile each, like a control room. Each tile's bar says who it is,
 * what it's doing and on which task; one that needs you gets a red frame.
 * The terminals themselves are painted by whoever owns them (the laptops).
 */

export const WALL_STATUS: Record<string, string> = {
  booting: "starting",
  idle: "free",
  working: "working",
  waiting: "needs you",
  presenting: "ready to present",
  done: "done",
  asleep: "asleep",
};

const FONT = "Nunito, ui-rounded, system-ui, sans-serif";

/** How many columns a grid of n tiles gets. */
export function wallColumns(n: number): number {
  return n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
}

/** Waiting on you first, then working, then the rest (by desk). */
export function monitorOrder(desks: Desk[]): Desk[] {
  const rank = (d: Desk) => (d.worker?.status === "waiting" ? 0 : d.worker?.status === "working" ? 1 : d.worker?.status === "presenting" ? 2 : 3);
  return desks.filter((d) => d.worker).sort((a, b) => rank(a) - rank(b));
}

/** The task a worker is on right now, if any. */
export function currentTask(progress: ProgressState | null, deskId: string): string | null {
  for (const g of progress?.goals ?? []) for (const t of g.tasks) if (t.deskId === deskId && t.status !== "done") return t.title;
  return null;
}

export function paintMonitorWall(
  canvas: HTMLCanvasElement,
  desks: Desk[],
  progress: ProgressState | null,
  paintTerminal: (deskId: string, g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => void,
): void {
  const g = canvas.getContext("2d")!;
  const W = canvas.width;
  const H = canvas.height;
  g.fillStyle = "#11121c";
  g.fillRect(0, 0, W, H);

  const staffed = monitorOrder(desks);
  const waiting = staffed.filter((d) => d.worker!.status === "waiting").length;
  const working = staffed.filter((d) => d.worker!.status === "working").length;

  // The title strip.
  const TOP = 64;
  g.fillStyle = "#1e1f2e";
  g.fillRect(0, 0, W, TOP);
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.fillStyle = "#cdd6f4";
  g.font = `800 36px ${FONT}`;
  g.fillText("📺 Agent monitor", 24, TOP / 2);
  g.textAlign = "right";
  g.font = `700 28px ${FONT}`;
  const counts = [`${staffed.length} agent${staffed.length === 1 ? "" : "s"}`, `${working} working`];
  if (waiting) counts.push(`🔴 ${waiting} need${waiting === 1 ? "s" : ""} you`);
  g.fillStyle = waiting ? "#ff8fa3" : "#a6adc8";
  g.fillText(`${counts.join(" · ")}   ·   E to open`, W - 24, TOP / 2);

  if (!staffed.length) {
    g.textAlign = "center";
    g.fillStyle = "#6c7086";
    g.font = `700 54px ${FONT}`;
    g.fillText("No agents yet", W / 2, H / 2 - 20);
    g.font = `600 32px ${FONT}`;
    g.fillText("Hire one at a desk with a green + and its terminal shows up here", W / 2, H / 2 + 40);
    return;
  }

  const MAX = 16;
  const shown = staffed.slice(0, MAX);
  const cols = wallColumns(shown.length);
  const rows = Math.ceil(shown.length / cols);
  const GAP = 14;
  const tw = (W - GAP * (cols + 1)) / cols;
  const th = (H - TOP - GAP * (rows + 1)) / rows;
  const bar = Math.max(30, Math.min(56, th * 0.13));
  shown.forEach((d, i) => {
    const w = d.worker!;
    const x = GAP + (i % cols) * (tw + GAP);
    const y = TOP + GAP + Math.floor(i / cols) * (th + GAP);
    const color = STATUS_BULB[w.status];
    // A red frame round whoever needs you.
    if (w.status === "waiting") {
      g.fillStyle = "#ef476f";
      g.fillRect(x - 6, y - 6, tw + 12, th + 12);
    }
    g.fillStyle = color;
    g.fillRect(x, y, tw, bar);
    g.fillStyle = "#1d1d1d";
    g.textAlign = "left";
    g.textBaseline = "middle";
    const name = w.identity?.name ?? AGENT_LABELS[w.agent];
    g.font = `800 ${Math.round(bar * 0.5)}px ${FONT}`;
    g.fillText(name, x + 12, y + bar / 2, tw * 0.5);
    g.textAlign = "right";
    g.font = `700 ${Math.round(bar * 0.42)}px ${FONT}`;
    g.fillText(`${WALL_STATUS[w.status] ?? w.status} · ${d.label}`, x + tw - 12, y + bar / 2, tw * 0.45);
    // What it's on.
    const line = bar * 0.8;
    g.fillStyle = "#2a2b3d";
    g.fillRect(x, y + bar, tw, line);
    g.fillStyle = "#cdd6f4";
    g.textAlign = "left";
    g.font = `600 ${Math.round(line * 0.55)}px ${FONT}`;
    const task = currentTask(progress, d.id);
    const doing = w.status === "working" && w.doing ? doingLabel(w.doing) : w.activity;
    g.fillText(task ? `🎯 ${task}  ·  ${doing}` : doing, x + 12, y + bar + line / 2, tw - 24);
    paintTerminal(d.id, g, x, y + bar + line, tw, th - bar - line);
  });
  if (staffed.length > MAX) {
    g.textAlign = "right";
    g.fillStyle = "#a6adc8";
    g.font = `700 26px ${FONT}`;
    g.fillText(`+${staffed.length - MAX} more — open the monitor (E)`, W - 24, H - 18);
  }
}
