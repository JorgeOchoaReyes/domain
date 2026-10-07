import { deckOf, parseSlide } from "../../shared/slides.js";
import type { Desk, Presentation } from "../../shared/protocol.js";
import type { Idea } from "../../shared/ideas.js";
import { AGENT_LABELS } from "../../shared/protocol.js";
import { AGENT_COLOR, STATUS_BULB } from "./characters.js";
import { wrap } from "./toon.js";
import { TONES, goalProgress, goalStage, type LoopStage, type ProgressState, type Session, clock } from "../../shared/progress.js";

/**
 * What the office's live surfaces show, painted onto their canvases: the
 * Workers and Up next boards, the How it works board, the lounge TV, and the
 * presentation screen in your office.
 */

const INK = "#2b2d42";
const MUTED = "#7a6f65";
const F = 'Nunito, ui-rounded, "Segoe UI", system-ui, sans-serif';

const STATUS_TEXT: Record<string, string> = {
  booting: "starting",
  idle: "ready",
  working: "working",
  waiting: "needs you",
  presenting: "in line",
  done: "done",
};

function paper(g: CanvasRenderingContext2D, w: number, h: number, color = "#fffaf3"): void {
  g.fillStyle = color;
  g.fillRect(0, 0, w, h);
}

function pill(g: CanvasRenderingContext2D, x: number, y: number, text: string, bg: string, color = INK, size = 26): number {
  g.font = `900 ${size}px ${F}`;
  const w = g.measureText(text).width + size;
  const h = size * 1.45;
  g.beginPath();
  g.roundRect(x, y - h / 2, w, h, h / 2);
  g.fillStyle = bg;
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = INK;
  g.stroke();
  g.fillStyle = color;
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.fillText(text, x + size / 2, y + 1);
  return w;
}

function dot(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = color;
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = INK;
  g.stroke();
}

function empty(g: CanvasRenderingContext2D, w: number, h: number, title: string, sub: string): void {
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = INK;
  g.font = `900 52px ${F}`;
  g.fillText(title, w / 2, h / 2 - 26);
  g.fillStyle = MUTED;
  g.font = `700 32px ${F}`;
  g.fillText(sub, w / 2, h / 2 + 30);
}

/** Every worker on the floor, its agent, who hired it and how it's doing. */
export function paintWorkersBoard(c: HTMLCanvasElement, desks: Desk[]): void {
  const g = c.getContext("2d")!;
  paper(g, c.width, c.height);
  const staffed = desks.filter((d) => d.worker);
  if (!staffed.length) {
    empty(g, c.width, c.height, "No workers yet", "Walk up to a desk with a + and press E");
    return;
  }
  const rowH = Math.min(64, (c.height - 30) / Math.min(staffed.length, 7));
  staffed.slice(0, 7).forEach((d, i) => {
    const w = d.worker!;
    const y = 30 + rowH * (i + 0.5);
    dot(g, 44, y, 14, AGENT_COLOR[w.agent]);
    g.fillStyle = INK;
    g.font = `900 30px ${F}`;
    g.textAlign = "left";
    g.textBaseline = "middle";
    const name = `${AGENT_LABELS[w.agent]} · ${w.hiredBy}`;
    g.fillText(name, 74, y - 9);
    g.fillStyle = MUTED;
    g.font = `700 22px ${F}`;
    const [act] = wrap(g, `${d.label} — ${w.activity}`, 640, 1);
    g.fillText(act ?? "", 74, y + 17);
    const label = STATUS_TEXT[w.status] ?? w.status;
    g.font = `900 24px ${F}`;
    const pw = g.measureText(label).width + 24;
    pill(g, c.width - 30 - pw, y, label, STATUS_BULB[w.status], w.status === "waiting" || w.status === "presenting" ? "#fff" : INK, 24);
  });
  if (staffed.length > 7) {
    g.fillStyle = MUTED;
    g.font = `800 24px ${F}`;
    g.textAlign = "right";
    g.fillText(`+${staffed.length - 7} more`, c.width - 30, c.height - 18);
  }
}

/** The line outside your office, in order. */
export function paintLineBoard(c: HTMLCanvasElement, line: Presentation[]): void {
  const g = c.getContext("2d")!;
  paper(g, c.width, c.height, "#fbfdff");
  if (!line.length) {
    empty(g, c.width, c.height, "Nobody in line", "📣 Round up workers to review their work");
    return;
  }
  const rowH = Math.min(70, (c.height - 30) / Math.min(line.length, 6));
  line.slice(0, 6).forEach((p, i) => {
    const y = 30 + rowH * (i + 0.5);
    g.fillStyle = INK;
    g.font = `900 40px ${F}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(i + 1), 46, y);
    dot(g, 100, y, 14, AGENT_COLOR[p.agent]);
    g.textAlign = "left";
    g.font = `900 30px ${F}`;
    const [title] = wrap(g, p.report ? p.report.title : `${AGENT_LABELS[p.agent]} · preparing a report…`, 620, 1);
    g.fillText(title ?? "", 130, y - 9);
    g.fillStyle = MUTED;
    g.font = `700 22px ${F}`;
    g.fillText(`${AGENT_LABELS[p.agent]} · hired by ${p.hiredBy}`, 130, y + 17);
    const [text, bg, color] = !p.report
      ? ["📝 preparing", "#e9ecef", INK]
      : p.report.status === "blocked"
        ? ["❓ blocked", "#ffd166", INK]
        : p.report.status === "plan"
          ? ["🧠 plan", "#e0c3fc", INK]
          : p.report.check?.status === "running"
            ? ["🧪 checking", "#cde7ff", INK]
            : p.report.check?.status === "fail"
              ? ["❌ checks failed", "#ef476f", "#fff"]
              : ["✅ ready", "#06d6a0", "#fff"];
    g.font = `900 24px ${F}`;
    const pw = g.measureText(text).width + 24;
    pill(g, c.width - 30 - pw, y, text, bg, color, 24);
  });
}

/** The goal you're working toward: its progress and its tasks. */
export function paintGoalsBoard(c: HTMLCanvasElement, p: ProgressState | null): void {
  const g = c.getContext("2d")!;
  paper(g, c.width, c.height);
  const goal = p ? ((p.session?.goalId && p.goals.find((x) => x.id === p.session!.goalId)) || p.goals.find((x) => !x.doneAt) || p.goals[0]) : undefined;
  if (!goal) {
    empty(g, c.width, c.height, "No goals yet", "Press G to set one and break it into tasks");
    return;
  }
  const pr = goalProgress(goal);
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.fillStyle = INK;
  g.font = `900 44px ${F}`;
  const [title] = wrap(g, `${goal.doneAt ? "🏆 " : ""}${goal.title}`, c.width - 220, 1);
  g.fillText(title ?? "", 36, 56);
  g.textAlign = "right";
  g.fillStyle = goal.doneAt ? "#06d6a0" : "#ff8a5b";
  g.font = `900 54px ${F}`;
  g.fillText(`${Math.round(pr.pct * 100)}%`, c.width - 36, 58);
  // Progress bar.
  const bx = 36;
  const bw = c.width - 72;
  g.beginPath();
  g.roundRect(bx, 100, bw, 34, 17);
  g.fillStyle = "#fff";
  g.fill();
  g.lineWidth = 5;
  g.strokeStyle = INK;
  g.stroke();
  if (pr.pct > 0) {
    g.beginPath();
    g.roundRect(bx + 4, 104, Math.max(26, (bw - 8) * pr.pct), 26, 13);
    g.fillStyle = "#06d6a0";
    g.fill();
  }
  const rows = goal.tasks.slice(0, 6);
  const rowH = Math.min(56, (c.height - 170) / Math.max(rows.length, 1));
  rows.forEach((t, i) => {
    const y = 170 + rowH * (i + 0.5);
    const mark = t.status === "done" ? "✅" : t.status === "review" ? "🎤" : t.status === "doing" ? "⌨️" : "⬜";
    g.textAlign = "left";
    g.font = `800 30px ${F}`;
    g.fillText(mark, 36, y);
    g.fillStyle = t.status === "done" ? MUTED : INK;
    g.font = `${t.status === "done" ? 700 : 800} 28px ${F}`;
    const [line] = wrap(g, t.title, c.width - 140, 1);
    g.fillText(line ?? "", 86, y + 1);
    if (t.status === "done") {
      const w = g.measureText(line ?? "").width;
      g.fillRect(86, y + 2, w, 3);
    }
    g.fillStyle = INK;
  });
  if (goal.tasks.length > rows.length) {
    g.fillStyle = MUTED;
    g.font = `800 22px ${F}`;
    g.textAlign = "right";
    g.fillText(`+${goal.tasks.length - rows.length} more`, c.width - 36, c.height - 22);
  }
}

/** The lounge TV: a big friendly summary of the line. */
export function paintTv(c: HTMLCanvasElement, line: Presentation[], presenting: Presentation | null, session: Session | null = null, goalTitle: string | null = null): void {
  const g = c.getContext("2d")!;
  if (session && !presenting?.report) {
    // A focus session: a big countdown.
    const left = Math.max(0, session.endsAt - Date.now());
    const grad = g.createLinearGradient(0, 0, c.width, c.height);
    grad.addColorStop(0, "#1b1d2e");
    grad.addColorStop(1, "#3a3d7c");
    g.fillStyle = grad;
    g.fillRect(0, 0, c.width, c.height);
    const pct = 1 - left / (session.minutes * 60000);
    g.fillStyle = "#ff8a5b";
    g.fillRect(0, c.height - 22, c.width * pct, 22);
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `800 40px ${F}`;
    g.fillText("🔥 Focus session", c.width / 2, c.height * 0.22);
    g.font = `900 150px ${F}`;
    g.fillText(clock(left), c.width / 2, c.height * 0.52);
    g.font = `800 34px ${F}`;
    g.fillStyle = "#a5b4fc";
    g.fillText(goalTitle ? `🎯 ${goalTitle}` : `✅ ${session.tasksDone} done · ⭐ ${session.xp} XP`, c.width / 2, c.height * 0.8);
    return;
  }
  const grad = g.createLinearGradient(0, 0, c.width, c.height);
  grad.addColorStop(0, "#4361ee");
  grad.addColorStop(1, "#4cc9f0");
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `900 72px ${F}`;
  if (presenting?.report) {
    g.fillText("🎤 Now presenting", c.width / 2, c.height * 0.3);
    g.font = `800 44px ${F}`;
    const lines = wrap(g, presenting.report.title, c.width - 120, 2);
    lines.forEach((l, i) => g.fillText(l, c.width / 2, c.height * 0.52 + i * 54));
    g.font = `700 34px ${F}`;
    g.fillText(`${AGENT_LABELS[presenting.agent]} · in your office`, c.width / 2, c.height * 0.82);
    return;
  }
  const n = line.length;
  g.fillText(n ? `🔔 ${n} in line` : "☕ All quiet", c.width / 2, c.height * 0.38);
  g.font = `700 36px ${F}`;
  g.fillText(n ? "Head to your office and press O to start the review" : "Press R to round up workers for a review", c.width / 2, c.height * 0.6);
}

/**
 * Your office's presentation screen: slide `index` of a presentation (0 is
 * the title slide), or a waiting screen.
 */
export function paintSlide(c: HTMLCanvasElement, p: Presentation | null, index: number, lineCount: number): void {
  const g = c.getContext("2d")!;
  const W = c.width;
  const H = c.height;
  if (!p?.report) {
    g.fillStyle = "#1b1d2e";
    g.fillRect(0, 0, W, H);
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `900 64px ${F}`;
    g.fillText("⭐ Review room", W / 2, H * 0.4);
    g.font = `700 32px ${F}`;
    g.fillStyle = "#a5b4fc";
    g.fillText(lineCount ? `${lineCount} waiting outside — press O to start` : "Round up workers (R) to review their work", W / 2, H * 0.6);
    return;
  }
  const r = p.report;
  const accent = AGENT_COLOR[p.agent];
  g.fillStyle = "#fffaf3";
  g.fillRect(0, 0, W, H);
  g.fillStyle = accent;
  g.fillRect(0, 0, W, 16);
  g.fillRect(0, H - 50, W, 50);
  g.fillStyle = "#fff";
  g.font = `800 24px ${F}`;
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.fillText(`${AGENT_LABELS[p.agent]} · hired by ${p.hiredBy}`, 30, H - 25);
  g.textAlign = "right";
  const slides = deckOf(r);
  const total = slides.length + 1;
  g.fillText(`${Math.min(index, total - 1) + 1} / ${total}`, W - 30, H - 25);
  g.textAlign = "left";
  g.fillStyle = INK;
  if (index <= 0) {
    g.font = `900 58px ${F}`;
    const title = wrap(g, r.title, W - 120, 2);
    title.forEach((l, i) => g.fillText(l, 60, H * 0.3 + i * 66));
    g.font = `700 30px ${F}`;
    g.fillStyle = "#5c5f77";
    const sum = wrap(g, r.summary, W - 120, 4);
    sum.forEach((l, i) => g.fillText(l, 60, H * 0.3 + title.length * 66 + 30 + i * 40));
    if (r.status === "blocked" && r.question) pill(g, 60, H - 100, `❓ ${r.question.slice(0, 60)}`, "#ffd166", INK, 26);
    return;
  }
  const s = parseSlide(slides[Math.min(index - 1, slides.length - 1)] ?? "");
  g.font = `800 28px ${F}`;
  g.fillStyle = accent;
  g.fillText(r.title.slice(0, 70), 60, 70);
  g.fillStyle = INK;
  // A one-liner: one big point in the middle.
  if (!s.heading && s.bullets.length === 1 && !s.code) {
    g.font = `900 54px ${F}`;
    const lines = wrap(g, s.bullets[0], W - 160, 4);
    const top = H / 2 - (lines.length * 66) / 2;
    dot(g, 80, top + 30, 14, accent);
    lines.forEach((l, i) => g.fillText(l, 110, top + 30 + i * 66));
    return;
  }
  // A real slide: its heading, its points, its code.
  let y = 130;
  if (s.heading) {
    g.font = `900 50px ${F}`;
    for (const l of wrap(g, s.heading, W - 120, 2)) {
      g.fillText(l, 60, y);
      y += 60;
    }
    y += 10;
  }
  const bottom = H - 70;
  const codeLines = s.code ? s.code.split("\n").slice(0, 10) : [];
  const codeH = codeLines.length ? codeLines.length * 30 + 30 : 0;
  g.font = `700 32px ${F}`;
  for (const b of s.bullets) {
    const lines = wrap(g, b.replace(/`/g, ""), W - 170, 3);
    if (y + lines.length * 40 > bottom - codeH) break;
    dot(g, 80, y, 9, accent);
    g.fillStyle = INK;
    lines.forEach((l, i) => g.fillText(l, 105, y + i * 40));
    y += lines.length * 40 + 14;
  }
  if (codeLines.length) {
    const top = Math.min(y + 6, bottom - codeH);
    g.fillStyle = "#1e1f2e";
    g.fillRect(60, top - 20, W - 120, codeH);
    g.fillStyle = "#cdd6f4";
    g.font = `24px ui-monospace, Consolas, monospace`;
    codeLines.forEach((l, i) => g.fillText(l.slice(0, 90), 80, top + 6 + i * 30));
  }
}

/** The review whiteboard before anyone writes on it. */
export function paintBlankBoard(c: HTMLCanvasElement): void {
  const g = c.getContext("2d")!;
  g.fillStyle = "#fbfdff";
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#c7cbe0";
  g.font = `800 40px ${F}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("Your review notes show up here", c.width / 2, c.height / 2);
}

const STAGES: { id: LoopStage; build: string; research: string }[] = [
  { id: "plan", build: "Plan", research: "Plan" },
  { id: "build", build: "Build", research: "Research" },
  { id: "review", build: "Review", research: "Review" },
  { id: "ship", build: "Ship", research: "Present" },
  { id: "shipped", build: "Shipped", research: "Delivered" },
];

/**
 * The stand-up room's screen: the session's tone and intention, the goal and
 * where it is in the loop, and every worker at a glance.
 */
export function paintStandupBoard(c: HTMLCanvasElement, p: ProgressState | null, desks: Desk[]): void {
  const g = c.getContext("2d")!;
  const W = c.width;
  const H = c.height;
  const s = p?.session ?? null;
  const tone = TONES.find((t) => t.id === s?.tone) ?? null;
  g.fillStyle = "#1b1d2e";
  g.fillRect(0, 0, W, H);
  // A band in the tone's color across the top.
  g.fillStyle = tone?.color ?? "#ffd166";
  g.fillRect(0, 0, W, 92);
  g.fillStyle = INK;
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.font = `900 46px ${F}`;
  g.fillText(s ? `${tone?.icon ?? "🔥"} ${tone?.label ?? "Focus"} · stand-up done` : "☀️ Stand-up", 32, 48);
  g.textAlign = "right";
  g.font = `800 30px ${F}`;
  if (s) {
    const left = Math.max(0, s.endsAt - Date.now());
    g.fillText(`${clock(left)} left`, W - 32, 48);
  } else {
    g.fillText(new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }), W - 32, 48);
  }

  let y = 140;
  g.textAlign = "left";
  if (s?.intention) {
    g.fillStyle = "#fff";
    g.font = `italic 800 34px ${F}`;
    const [line] = wrap(g, `“${s.intention}”`, W - 64, 1);
    g.fillText(line ?? "", 32, y);
    y += 58;
  } else if (!s) {
    g.fillStyle = "#c9c4ff";
    g.font = `800 30px ${F}`;
    g.fillText("Stand in the circle and press E to start the day", 32, y);
    y += 58;
  }

  const goal = p ? ((s?.goalId && p.goals.find((x) => x.id === s.goalId)) || p.goals.find((x) => !x.doneAt)) : undefined;
  if (goal) {
    const pr = goalProgress(goal);
    g.fillStyle = "#ffd166";
    g.font = `900 36px ${F}`;
    const [title] = wrap(g, `🎯 ${goal.title}`, W - 200, 1);
    g.fillText(title ?? "", 32, y);
    g.textAlign = "right";
    g.fillStyle = "#06d6a0";
    g.fillText(`${pr.done}/${pr.total}`, W - 32, y);
    y += 56;
    // The loop: plan → build → review → ship → shipped.
    const stage = goalStage(goal);
    const at = STAGES.findIndex((x) => x.id === stage);
    const sw = (W - 64) / STAGES.length;
    STAGES.forEach((st, i) => {
      const x = 32 + i * sw;
      g.beginPath();
      g.roundRect(x + 4, y - 24, sw - 8, 48, 24);
      g.fillStyle = i < at ? "#06d6a0" : i === at ? (tone?.color ?? "#ff8a5b") : "#2f3250";
      g.fill();
      g.fillStyle = i <= at ? INK : "#8c8fb0";
      g.textAlign = "center";
      g.font = `900 24px ${F}`;
      g.fillText(`${i < at ? "✓ " : ""}${goal.kind === "research" ? st.research : st.build}`, x + sw / 2, y + 1);
    });
    y += 60;
  }

  // The team.
  const staffed = desks.filter((d) => d.worker);
  g.textAlign = "left";
  if (!staffed.length) {
    g.fillStyle = "#8c8fb0";
    g.font = `800 28px ${F}`;
    g.fillText("No workers yet — hire one at a desk on the work floor", 32, y + 10);
    return;
  }
  const cols = 2;
  const rowH = Math.min(52, (H - y - 10) / Math.ceil(Math.min(staffed.length, 8) / cols));
  staffed.slice(0, 8).forEach((d, i) => {
    const w = d.worker!;
    const x = 32 + (i % cols) * ((W - 64) / cols);
    const ry = y + rowH * Math.floor(i / cols) + rowH / 2;
    dot(g, x + 14, ry, 12, STATUS_BULB[w.status]);
    g.fillStyle = "#fff";
    g.font = `900 26px ${F}`;
    g.fillText(AGENT_LABELS[w.agent], x + 36, ry - 1);
    const nw = g.measureText(AGENT_LABELS[w.agent]).width;
    g.fillStyle = "#b9bbd6";
    g.font = `700 22px ${F}`;
    const [act] = wrap(g, `${STATUS_TEXT[w.status] ?? w.status} · ${w.activity}`, (W - 64) / cols - nw - 60, 1);
    g.fillText(act ?? "", x + 48 + nw, ry);
  });
}

const NOTE_COLORS: Record<Idea["status"], string> = { open: "#fff3a8", handed: "#c9f5e6", goal: "#d6e4ff" };

/**
 * An idea board: what's pinned as sticky notes (a sketch and a title each),
 * or — while you draw at it — your sketch, big.
 */
export function paintIdeaBoard(c: HTMLCanvasElement, ideas: Idea[], thumbs: Map<string, HTMLImageElement>, live: HTMLCanvasElement | null): void {
  const g = c.getContext("2d")!;
  const W = c.width;
  const H = c.height;
  g.fillStyle = "#fbfdff";
  g.fillRect(0, 0, W, H);
  if (live) {
    g.drawImage(live, 0, 0, W, H);
    return;
  }
  g.textBaseline = "middle";
  if (!ideas.length) {
    g.textAlign = "center";
    g.fillStyle = "#3a86ff";
    g.font = `900 64px ${F}`;
    g.fillText("💡 Got an idea?", W / 2, H * 0.36);
    g.fillStyle = "#5c5f77";
    g.font = `800 36px ${F}`;
    g.fillText("Press E to sketch it, then hand it to a worker", W / 2, H * 0.56);
    g.strokeStyle = "#ffbe0b";
    g.lineWidth = 6;
    g.beginPath();
    g.ellipse(W / 2, H * 0.36, 300, 70, -0.04, 0, Math.PI * 2);
    g.stroke();
    return;
  }
  // Fewer notes, bigger notes.
  const cols = ideas.length <= 4 ? 2 : 3;
  const rows = ideas.length <= 2 ? 1 : 2;
  const pad = 26;
  const nw = (W - pad * (cols + 1)) / cols;
  const nh = (H - pad * (rows + 1)) / rows;
  ideas.slice(0, cols * rows).forEach((idea, i) => {
    const x = pad + (i % cols) * (nw + pad);
    const y = pad + Math.floor(i / cols) * (nh + pad);
    g.save();
    g.translate(x + nw / 2, y + nh / 2);
    g.rotate(((i * 37) % 7) / 100 - 0.03);
    g.fillStyle = "rgba(43,45,66,0.18)";
    g.fillRect(-nw / 2 + 6, -nh / 2 + 8, nw, nh);
    g.fillStyle = NOTE_COLORS[idea.status];
    g.fillRect(-nw / 2, -nh / 2, nw, nh);
    const img = thumbs.get(idea.id);
    const th = nh - 70;
    if (img?.complete && img.naturalWidth) {
      const tw = Math.min(nw - 24, (th * 16) / 9);
      g.drawImage(img, -tw / 2, -nh / 2 + 12, tw, th);
    } else {
      g.textAlign = "center";
      g.font = `900 72px ${F}`;
      g.fillText(idea.status === "handed" ? "🤝" : idea.status === "goal" ? "🎯" : "💡", 0, -nh / 2 + 12 + th / 2);
    }
    g.fillStyle = INK;
    g.textAlign = "center";
    g.font = `900 30px ${F}`;
    const [line] = wrap(g, idea.title, nw - 24, 1);
    g.fillText(line ?? "", 0, nh / 2 - 32);
    g.restore();
  });
  if (ideas.length > cols * rows) {
    g.textAlign = "right";
    g.fillStyle = "#5c5f77";
    g.font = `800 24px ${F}`;
    g.fillText(`+${ideas.length - cols * rows} more`, W - 14, H - 12);
  }
}
