import type { Desk } from "../../shared/protocol.js";
import { AGENT_LABELS, doingLabel } from "../../shared/protocol.js";
import type { ProgressState } from "../../shared/progress.js";
import { STATUS_BULB } from "./characters.js";

/**
 * The monitor wall in your office: every worker's terminal on one big
 * screen, like a CCTV wall. Each agent is a camera with a fixed number (by
 * desk). It shows them all in a grid — whoever needs you first, framed in
 * red — or one camera big with the rest in a strip along the bottom. Sit in
 * the chair in front of it to switch cameras, flip between all and one, or
 * let it cycle through them. The terminals themselves are painted by
 * whoever owns them (the laptops).
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

/** How the wall is showing: all the cameras, or one; which; whether it cycles. */
export interface WallView {
  mode: "grid" | "single";
  /** The camera picked (a desk id), or null for the first. */
  cam: string | null;
  cycle: boolean;
  /** You're in the chair (the picked camera is framed in the grid, and the controls show). */
  seated: boolean;
}

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

/** The cameras, in a fixed order (by desk number), so CAM 3 is always the same agent. */
export function cameras(desks: Desk[]): Desk[] {
  const n = (d: Desk) => Number(d.id.replace(/\D+/g, "")) || 0;
  return desks.filter((d) => d.worker).sort((a, b) => n(a) - n(b));
}

/** The camera after (or before) this one, round the wall. */
export function stepCamera(desks: Desk[], cam: string | null, by: number): string | null {
  const cams = cameras(desks);
  if (!cams.length) return null;
  const i = Math.max(0, cams.findIndex((d) => d.id === cam));
  return cams[(((i + by) % cams.length) + cams.length) % cams.length].id;
}

/** The task a worker is on right now, if any. */
export function currentTask(progress: ProgressState | null, deskId: string): string | null {
  for (const g of progress?.goals ?? []) for (const t of g.tasks) if (t.deskId === deskId && t.status !== "done") return t.title;
  return null;
}

type PaintTerm = (deskId: string, g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => void;

export function paintMonitorWall(canvas: HTMLCanvasElement, desks: Desk[], progress: ProgressState | null, paintTerminal: PaintTerm, view: WallView = { mode: "grid", cam: null, cycle: false, seated: false }): void {
  const g = canvas.getContext("2d")!;
  const W = canvas.width;
  const H = canvas.height;
  g.fillStyle = "#0b0c12";
  g.fillRect(0, 0, W, H);

  const cams = cameras(desks);
  const camNo = new Map(cams.map((d, i) => [d.id, i + 1]));
  const waiting = cams.filter((d) => d.worker!.status === "waiting").length;
  const working = cams.filter((d) => d.worker!.status === "working").length;
  const picked = cams.find((d) => d.id === view.cam) ?? cams[0] ?? null;

  // The title strip: what this is, a live dot and the clock, the counts.
  const TOP = 64;
  g.fillStyle = "#1e1f2e";
  g.fillRect(0, 0, W, TOP);
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.fillStyle = "#cdd6f4";
  g.font = `800 34px ${FONT}`;
  g.fillText("📺 Agent CCTV", 24, TOP / 2);
  g.fillStyle = "#ef476f";
  g.beginPath();
  g.arc(330, TOP / 2, 10, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#f38ba8";
  g.font = `800 26px ui-monospace, Consolas, monospace`;
  g.fillText(`LIVE ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`, 352, TOP / 2);
  g.textAlign = "right";
  g.font = `700 26px ${FONT}`;
  const counts = [`${cams.length} cam${cams.length === 1 ? "" : "s"}`, `${working} working`];
  if (waiting) counts.push(`🔴 ${waiting} need${waiting === 1 ? "s" : ""} you`);
  const how = view.seated ? "← → switch · ↑ ↓ all / one · C cycle · E full monitor" : view.mode === "single" ? (view.cycle ? "cycling" : "one camera") : "sit in the chair to switch";
  g.fillStyle = waiting ? "#ff8fa3" : "#a6adc8";
  g.fillText(`${counts.join(" · ")}   ·   ${how}`, W - 24, TOP / 2);

  if (!cams.length) {
    g.textAlign = "center";
    g.fillStyle = "#6c7086";
    g.font = `700 54px ${FONT}`;
    g.fillText("No cameras — no agents yet", W / 2, H / 2 - 20);
    g.font = `600 32px ${FONT}`;
    g.fillText("Hire one at a desk with a green + and its terminal shows up here", W / 2, H / 2 + 40);
    return;
  }

  if (view.mode === "single" && picked) {
    // One camera big, the rest in a strip along the bottom.
    const GAP = 12;
    const stripH = cams.length > 1 ? Math.round((H - TOP) * 0.2) : 0;
    tile(g, picked, GAP, TOP + GAP, W - GAP * 2, H - TOP - stripH - GAP * (stripH ? 3 : 2), camNo.get(picked.id)!, progress, paintTerminal, false);
    if (stripH) {
      const others = cams.slice(0, 10);
      const tw = (W - GAP * (others.length + 1)) / others.length;
      others.forEach((d, i) => {
        const x = GAP + i * (tw + GAP);
        const y = H - stripH - GAP;
        tile(g, d, x, y, tw, stripH, camNo.get(d.id)!, progress, paintTerminal, d.id === picked.id, true);
      });
    }
    return;
  }

  // All of them: whoever needs you first.
  const MAX = 16;
  const shown = monitorOrder(desks).slice(0, MAX);
  const cols = wallColumns(shown.length);
  const rows = Math.ceil(shown.length / cols);
  const GAP = 14;
  const tw = (W - GAP * (cols + 1)) / cols;
  const th = (H - TOP - GAP * (rows + 1)) / rows;
  shown.forEach((d, i) => {
    const x = GAP + (i % cols) * (tw + GAP);
    const y = TOP + GAP + Math.floor(i / cols) * (th + GAP);
    tile(g, d, x, y, tw, th, camNo.get(d.id)!, progress, paintTerminal, view.seated && d.id === picked?.id);
  });
  if (cams.length > MAX) {
    g.textAlign = "right";
    g.fillStyle = "#a6adc8";
    g.font = `700 26px ${FONT}`;
    g.fillText(`+${cams.length - MAX} more — open the monitor (E)`, W - 24, H - 18);
  }
}

/** One camera: its bar (CAM number, who, status), what it's on, and its terminal. */
function tile(g: CanvasRenderingContext2D, d: Desk, x: number, y: number, tw: number, th: number, no: number, progress: ProgressState | null, paintTerminal: PaintTerm, picked: boolean, small = false): void {
  const w = d.worker!;
  const color = STATUS_BULB[w.status];
  // A red frame round whoever needs you; a white one round the camera you've picked.
  if (w.status === "waiting" || picked) {
    g.fillStyle = picked ? "#ffffff" : "#ef476f";
    g.fillRect(x - 6, y - 6, tw + 12, th + 12);
  }
  const bar = small ? Math.max(22, Math.min(32, th * 0.2)) : Math.max(30, Math.min(56, th * 0.13));
  g.fillStyle = color;
  g.fillRect(x, y, tw, bar);
  g.fillStyle = "#1d1d1d";
  g.textAlign = "left";
  g.textBaseline = "middle";
  const name = w.identity?.name ?? AGENT_LABELS[w.agent];
  g.font = `800 ${Math.round(bar * 0.5)}px ui-monospace, Consolas, monospace`;
  const cam = `CAM ${String(no).padStart(2, "0")}`;
  g.fillText(cam, x + 10, y + bar / 2);
  const camW = g.measureText(cam).width + 18;
  g.font = `800 ${Math.round(bar * 0.5)}px ${FONT}`;
  g.fillText(name, x + 10 + camW, y + bar / 2, tw * 0.5 - camW);
  if (!small) {
    g.textAlign = "right";
    g.font = `700 ${Math.round(bar * 0.42)}px ${FONT}`;
    g.fillText(`${WALL_STATUS[w.status] ?? w.status} · ${d.label}`, x + tw - 12, y + bar / 2, tw * 0.45);
  }
  let top = y + bar;
  if (!small) {
    // What it's on.
    const line = bar * 0.8;
    g.fillStyle = "#2a2b3d";
    g.fillRect(x, top, tw, line);
    g.fillStyle = "#cdd6f4";
    g.textAlign = "left";
    g.font = `600 ${Math.round(line * 0.55)}px ${FONT}`;
    const task = currentTask(progress, d.id);
    const doing = w.status === "working" && w.doing ? doingLabel(w.doing) : w.activity;
    g.fillText(task ? `🎯 ${task}  ·  ${doing}` : doing, x + 12, top + line / 2, tw - 24);
    top += line;
  }
  paintTerminal(d.id, g, x, top, tw, y + th - top);
}
