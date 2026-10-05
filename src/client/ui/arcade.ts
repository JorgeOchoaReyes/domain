import type { ArcadeId } from "../../shared/layout.js";
import { ARCADES } from "../../shared/layout.js";
import { openModal } from "./modal.js";
import { confetti, sound } from "./fx.js";
import "../styles/arcade.css";

/**
 * The game room's arcade cabinets: Snake, Bug Smash and Brick Breaker, each a
 * small canvas game in a window. Scores are just for fun — they never turn
 * into XP — and the best one per cabinet is kept in this browser.
 */

const KEY = "domain.arcade.best";
const W = 480;
const H = 480;
const F = 'Nunito, ui-rounded, "Segoe UI", system-ui, sans-serif';

function readBest(): Record<string, number> {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === "object" ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function arcadeBest(id: ArcadeId): number {
  const v = readBest()[id];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function saveBest(id: ArcadeId, score: number): void {
  try {
    const all = readBest();
    all[id] = score;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage blocked: the best lasts this sitting only */
  }
}

/** One game: it steps, draws, and takes keys and pointer input while playing. */
interface Game {
  readonly score: number;
  readonly over: boolean;
  /** Shown under the title on the start screen. */
  readonly help: string;
  update(dt: number): void;
  draw(g: CanvasRenderingContext2D, t: number): void;
  key(code: string): void;
  /** A key let go (for held movement). */
  release?(code: string): void;
  pointer(x: number, y: number, down: boolean): void;
}

const MAKERS: Record<ArcadeId, () => Game> = {
  snake: () => new Snake(),
  bugsmash: () => new BugSmash(),
  breakout: () => new Breakout(),
};

export function openArcade(id: ArcadeId, onDone: (score: number, best: number) => void): void {
  const def = ARCADES.find((a) => a.id === id)!;
  const color = def.color;
  let best = arcadeBest(id);
  let sittingBest = 0;
  let game: Game | null = null;
  let state: "title" | "play" | "over" = "title";
  let newBest = false;

  const body = document.createElement("div");
  body.className = "arcade";
  body.style.setProperty("--neon", color);
  body.innerHTML = `
    <div class="arc-bar"><span class="arc-score">SCORE <b>0</b></span><span class="arc-best">BEST <b>${best}</b></span></div>
    <div class="arc-screen"><canvas></canvas></div>
    <div class="arc-help"></div>`;
  const canvas = body.querySelector("canvas")!;
  const scoreEl = body.querySelector(".arc-score b")!;
  const bestEl = body.querySelector(".arc-best b")!;
  const helpEl = body.querySelector<HTMLElement>(".arc-help")!;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const g = canvas.getContext("2d")!;
  g.scale(dpr, dpr);

  let raf = 0;
  let last = performance.now();
  let closed = false;

  const start = () => {
    game = MAKERS[id]();
    state = "play";
    newBest = false;
    sound.click();
  };

  const finish = () => {
    if (!game) return;
    state = "over";
    const s = game.score;
    sittingBest = Math.max(sittingBest, s);
    if (s > best) {
      best = s;
      newBest = true;
      saveBest(id, best);
      bestEl.textContent = String(best);
      sound.levelUp();
      if (s > 0) confetti(120);
    } else sound.bell();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") return; // main.ts closes the window
    const code = e.code;
    const handled = /^(Arrow|Key[WASD]|Space|Enter|Digit[1-9]|Numpad[1-9])/.test(code);
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type !== "keydown") {
      if (state === "play") game?.release?.(code);
      return;
    }
    if (state !== "play") {
      if (code === "Space" || code === "Enter") start();
      return;
    }
    game?.key(code);
  };
  const toCanvas = (e: PointerEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  };
  const onDown = (e: PointerEvent) => {
    e.preventDefault();
    if (state !== "play") {
      start();
      return;
    }
    const [x, y] = toCanvas(e);
    game?.pointer(x, y, true);
  };
  const onMove = (e: PointerEvent) => {
    if (state !== "play") return;
    const [x, y] = toCanvas(e);
    game?.pointer(x, y, false);
  };

  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);

  const frame = (now: number) => {
    if (closed) return;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const t = now / 1000;
    g.fillStyle = "#0b0a1a";
    g.fillRect(0, 0, W, H);
    if (game) {
      if (state === "play") {
        game.update(dt);
        if (game.over) finish();
      }
      game.draw(g, t);
      scoreEl.textContent = String(game.score);
    }
    if (state === "title") titleScreen(g, t, def.name, color, MAKERS[id]().help);
    else if (state === "over") overScreen(g, t, game!.score, newBest, color);
    helpEl.textContent = state === "play" ? game!.help : "Esc to leave · scores are just for fun";
    scanlines(g);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  openModal({
    title: def.name,
    icon: "🕹",
    className: "arcade-modal",
    body,
    onClose: () => {
      closed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      if (state === "play" && game) sittingBest = Math.max(sittingBest, game.score);
      if (sittingBest > best) {
        best = sittingBest;
        saveBest(id, best);
      }
      onDone(sittingBest, best);
    },
  });
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function glowText(g: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string): void {
  g.font = `900 ${size}px ${F}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.shadowColor = color;
  g.shadowBlur = size * 0.5;
  g.fillStyle = color;
  g.fillText(text, x, y);
  g.shadowBlur = 0;
  g.fillStyle = "#ffffff";
  g.fillText(text, x, y);
}

function dim(g: CanvasRenderingContext2D): void {
  g.fillStyle = "rgba(11,10,26,0.72)";
  g.fillRect(0, 0, W, H);
}

function titleScreen(g: CanvasRenderingContext2D, t: number, name: string, color: string, help: string): void {
  dim(g);
  glowText(g, name.toUpperCase(), W / 2, H / 2 - 50 + Math.sin(t * 2) * 4, 52, color);
  g.font = `700 16px ${F}`;
  g.fillStyle = "#c9c6e8";
  g.fillText(help, W / 2, H / 2 + 6);
  if (Math.floor(t * 2) % 2 === 0) glowText(g, "PRESS SPACE / CLICK TO START", W / 2, H / 2 + 60, 20, "#ffd166");
}

function overScreen(g: CanvasRenderingContext2D, t: number, score: number, newBest: boolean, color: string): void {
  dim(g);
  glowText(g, "GAME OVER", W / 2, H / 2 - 60, 50, "#ef476f");
  glowText(g, `SCORE ${score}`, W / 2, H / 2, 32, color);
  if (newBest) glowText(g, "★ NEW BEST ★", W / 2, H / 2 + 42, 24, "#ffd166");
  if (Math.floor(t * 2) % 2 === 0) glowText(g, "SPACE / CLICK TO PLAY AGAIN", W / 2, H / 2 + 92, 18, "#ffffff");
}

function scanlines(g: CanvasRenderingContext2D): void {
  g.fillStyle = "rgba(0,0,0,0.12)";
  for (let y = 0; y < H; y += 3) g.fillRect(0, y, W, 1);
}

/** Little bursts of squares when something pops. */
class Sparks {
  private list: { x: number; y: number; vx: number; vy: number; life: number; color: string }[] = [];
  burst(x: number, y: number, color: string, n = 14): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 60 + Math.random() * 160;
      this.list.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.5 + Math.random() * 0.3, color });
    }
  }
  update(dt: number): void {
    for (const p of this.list) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 300 * dt;
      p.life -= dt;
    }
    this.list = this.list.filter((p) => p.life > 0);
  }
  draw(g: CanvasRenderingContext2D): void {
    for (const p of this.list) {
      g.globalAlpha = Math.min(1, p.life * 2);
      g.fillStyle = p.color;
      g.fillRect(p.x - 2, p.y - 2, 4, 4);
    }
    g.globalAlpha = 1;
  }
}

/** Floating "+10" style labels. */
class Pops {
  private list: { x: number; y: number; text: string; color: string; life: number }[] = [];
  add(x: number, y: number, text: string, color: string): void {
    this.list.push({ x, y, text, color, life: 0.9 });
  }
  update(dt: number): void {
    for (const p of this.list) {
      p.y -= 50 * dt;
      p.life -= dt;
    }
    this.list = this.list.filter((p) => p.life > 0);
  }
  draw(g: CanvasRenderingContext2D): void {
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `900 20px ${F}`;
    for (const p of this.list) {
      g.globalAlpha = Math.min(1, p.life * 2);
      g.fillStyle = p.color;
      g.fillText(p.text, p.x, p.y);
    }
    g.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------------------
// Snake
// ---------------------------------------------------------------------------

const GRID = 20;
const CELL = W / GRID;

class Snake implements Game {
  score = 0;
  over = false;
  readonly help = "Arrows / WASD to steer · eat 🍎, don't bite yourself";
  private body: { x: number; y: number }[] = [
    { x: 8, y: 10 },
    { x: 7, y: 10 },
    { x: 6, y: 10 },
  ];
  private dir = { x: 1, y: 0 };
  private queue: { x: number; y: number }[] = [];
  private food = { x: 14, y: 10 };
  private acc = 0;
  private step = 0.13;
  private sparks = new Sparks();
  private pops = new Pops();
  private flash = 0;

  key(code: string): void {
    const d =
      code === "ArrowUp" || code === "KeyW"
        ? { x: 0, y: -1 }
        : code === "ArrowDown" || code === "KeyS"
          ? { x: 0, y: 1 }
          : code === "ArrowLeft" || code === "KeyA"
            ? { x: -1, y: 0 }
            : code === "ArrowRight" || code === "KeyD"
              ? { x: 1, y: 0 }
              : null;
    if (!d) return;
    const lastDir = this.queue[this.queue.length - 1] ?? this.dir;
    if (d.x === -lastDir.x && d.y === -lastDir.y) return;
    if (d.x === lastDir.x && d.y === lastDir.y) return;
    if (this.queue.length < 3) this.queue.push(d);
  }

  pointer(x: number, y: number, down: boolean): void {
    if (!down) return;
    // Tap a side of the board, relative to the head, to turn that way.
    const h = this.body[0];
    const dx = x - (h.x + 0.5) * CELL;
    const dy = y - (h.y + 0.5) * CELL;
    if (Math.abs(dx) > Math.abs(dy)) this.key(dx > 0 ? "ArrowRight" : "ArrowLeft");
    else this.key(dy > 0 ? "ArrowDown" : "ArrowUp");
  }

  update(dt: number): void {
    this.sparks.update(dt);
    this.pops.update(dt);
    this.flash = Math.max(0, this.flash - dt);
    this.acc += dt;
    while (this.acc >= this.step && !this.over) {
      this.acc -= this.step;
      this.tick();
    }
  }

  private tick(): void {
    if (this.queue.length) this.dir = this.queue.shift()!;
    const h = this.body[0];
    const next = { x: h.x + this.dir.x, y: h.y + this.dir.y };
    const eats = next.x === this.food.x && next.y === this.food.y;
    const hitsSelf = this.body.slice(0, eats ? this.body.length : this.body.length - 1).some((b) => b.x === next.x && b.y === next.y);
    if (next.x < 0 || next.y < 0 || next.x >= GRID || next.y >= GRID || hitsSelf) {
      this.over = true;
      this.sparks.burst((h.x + 0.5) * CELL, (h.y + 0.5) * CELL, "#ef476f", 30);
      return;
    }
    this.body.unshift(next);
    if (eats) {
      this.score += 10;
      this.flash = 0.15;
      this.step = Math.max(0.055, this.step * 0.965);
      this.sparks.burst((next.x + 0.5) * CELL, (next.y + 0.5) * CELL, "#ef476f");
      this.pops.add((next.x + 0.5) * CELL, next.y * CELL, "+10", "#ffd166");
      sound.xp();
      this.placeFood();
    } else this.body.pop();
  }

  private placeFood(): void {
    for (let i = 0; i < 500; i++) {
      const f = { x: Math.floor(Math.random() * GRID), y: Math.floor(Math.random() * GRID) };
      if (!this.body.some((b) => b.x === f.x && b.y === f.y)) {
        this.food = f;
        return;
      }
    }
  }

  draw(g: CanvasRenderingContext2D, t: number): void {
    // The grid.
    g.strokeStyle = "rgba(6,214,160,0.07)";
    g.lineWidth = 1;
    for (let i = 1; i < GRID; i++) {
      g.beginPath();
      g.moveTo(i * CELL, 0);
      g.lineTo(i * CELL, H);
      g.moveTo(0, i * CELL);
      g.lineTo(W, i * CELL);
      g.stroke();
    }
    if (this.flash > 0) {
      g.fillStyle = `rgba(6,214,160,${this.flash})`;
      g.fillRect(0, 0, W, H);
    }
    // The apple pulses.
    const s = 1 + Math.sin(t * 8) * 0.1;
    g.shadowColor = "#ef476f";
    g.shadowBlur = 14;
    g.fillStyle = "#ef476f";
    g.beginPath();
    g.arc((this.food.x + 0.5) * CELL, (this.food.y + 0.5) * CELL, CELL * 0.36 * s, 0, Math.PI * 2);
    g.fill();
    // The snake, head brightest.
    g.shadowColor = "#06d6a0";
    this.body.forEach((b, i) => {
      const k = 1 - (i / this.body.length) * 0.55;
      g.shadowBlur = i === 0 ? 16 : 6;
      g.fillStyle = i === 0 ? "#b8ffde" : `rgba(6,214,160,${k})`;
      g.beginPath();
      g.roundRect(b.x * CELL + 1.5, b.y * CELL + 1.5, CELL - 3, CELL - 3, 6);
      g.fill();
    });
    g.shadowBlur = 0;
    // Eyes.
    const h = this.body[0];
    g.fillStyle = "#0b0a1a";
    for (const side of [-1, 1]) {
      const ex = (h.x + 0.5) * CELL + this.dir.x * 5 + this.dir.y * side * 5;
      const ey = (h.y + 0.5) * CELL + this.dir.y * 5 + this.dir.x * side * 5;
      g.fillRect(ex - 2, ey - 2, 4, 4);
    }
    this.sparks.draw(g);
    this.pops.draw(g);
  }
}

// ---------------------------------------------------------------------------
// Bug Smash
// ---------------------------------------------------------------------------

const ROUND = 30;

interface Hole {
  x: number;
  y: number;
  kind: "bug" | "feature" | null;
  /** 0..1 how far up it is. */
  up: number;
  /** Seconds left before it ducks back down. */
  stay: number;
  hit: number;
}

class BugSmash implements Game {
  score = 0;
  over = false;
  readonly help = "Click bugs 🐛 (or keys 1–9) · don't squash the 🚀 features!";
  private holes: Hole[] = [];
  private left = ROUND;
  private spawnIn = 0.6;
  private combo = 0;
  private sparks = new Sparks();
  private pops = new Pops();
  private shake = 0;
  private mouse = { x: -100, y: -100 };

  constructor() {
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) this.holes.push({ x: 90 + c * 150, y: 150 + r * 120, kind: null, up: 0, stay: 0, hit: 0 });
  }

  key(code: string): void {
    const m = /(?:Digit|Numpad)([1-9])/.exec(code);
    if (!m) return;
    // Keys laid out like a numpad: 7 8 9 on top.
    const n = Number(m[1]) - 1;
    const row = 2 - Math.floor(n / 3);
    this.whack(this.holes[row * 3 + (n % 3)]);
  }

  pointer(x: number, y: number, down: boolean): void {
    this.mouse = { x, y };
    if (!down) return;
    const hole = this.holes.find((h) => Math.abs(x - h.x) < 56 && y > h.y - 90 && y < h.y + 22);
    if (hole) this.whack(hole);
    else this.combo = 0;
  }

  private whack(h: Hole): void {
    if (!h.kind || h.up < 0.4 || h.hit > 0) {
      this.combo = 0;
      return;
    }
    h.hit = 0.35;
    h.stay = 0;
    if (h.kind === "bug") {
      this.combo++;
      const mult = Math.min(5, 1 + Math.floor(this.combo / 3));
      const pts = 10 * mult;
      this.score += pts;
      this.sparks.burst(h.x, h.y - 40, "#7cff6b", 18);
      this.pops.add(h.x, h.y - 80, mult > 1 ? `+${pts} x${mult}` : `+${pts}`, "#7cff6b");
      sound.xp();
    } else {
      this.combo = 0;
      this.score = Math.max(0, this.score - 25);
      this.shake = 0.3;
      this.sparks.burst(h.x, h.y - 40, "#ef476f", 18);
      this.pops.add(h.x, h.y - 80, "-25 that was a feature!", "#ef476f");
      sound.gong();
    }
  }

  update(dt: number): void {
    this.left -= dt;
    this.shake = Math.max(0, this.shake - dt);
    this.sparks.update(dt);
    this.pops.update(dt);
    if (this.left <= 0) {
      this.left = 0;
      this.over = true;
      return;
    }
    const pace = 1 - this.left / ROUND; // 0 → 1 over the round
    this.spawnIn -= dt;
    if (this.spawnIn <= 0) {
      this.spawnIn = 0.75 - pace * 0.45 + Math.random() * 0.25;
      const free = this.holes.filter((h) => !h.kind);
      if (free.length) {
        const h = free[Math.floor(Math.random() * free.length)];
        h.kind = Math.random() < 0.2 ? "feature" : "bug";
        h.up = 0;
        h.stay = 1.1 - pace * 0.5;
        h.hit = 0;
      }
    }
    for (const h of this.holes) {
      if (!h.kind) continue;
      if (h.hit > 0) {
        h.hit -= dt;
        if (h.hit <= 0) h.kind = null;
        continue;
      }
      if (h.stay > 0) {
        h.up = Math.min(1, h.up + dt * 7);
        h.stay -= dt;
      } else {
        h.up -= dt * 6;
        if (h.up <= 0) {
          // A bug that got away breaks your combo.
          if (h.kind === "bug") this.combo = 0;
          h.kind = null;
          h.up = 0;
        }
      }
    }
  }

  draw(g: CanvasRenderingContext2D, t: number): void {
    g.save();
    if (this.shake > 0) g.translate((Math.random() - 0.5) * 12 * this.shake * 3, (Math.random() - 0.5) * 12 * this.shake * 3);
    // Timer bar and combo.
    g.fillStyle = "#24203f";
    g.fillRect(20, 24, W - 40, 12);
    const pct = this.left / ROUND;
    g.fillStyle = pct < 0.25 ? "#ef476f" : "#ffd166";
    g.fillRect(20, 24, (W - 40) * pct, 12);
    g.font = `900 18px ${F}`;
    g.textAlign = "left";
    g.textBaseline = "middle";
    g.fillStyle = "#ffffff";
    g.fillText(`⏱ ${Math.ceil(this.left)}s`, 20, 58);
    if (this.combo >= 3) {
      g.textAlign = "right";
      g.fillStyle = "#7cff6b";
      g.fillText(`COMBO x${Math.min(5, 1 + Math.floor(this.combo / 3))}`, W - 20, 58);
    }
    this.holes.forEach((h, i) => {
      // The hole.
      g.fillStyle = "#1a1733";
      g.beginPath();
      g.ellipse(h.x, h.y, 56, 18, 0, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "rgba(239,71,111,0.35)";
      g.lineWidth = 3;
      g.stroke();
      // Its number for keyboard players.
      const n = [7, 8, 9, 4, 5, 6, 1, 2, 3][i];
      g.font = `800 12px ${F}`;
      g.textAlign = "center";
      g.fillStyle = "rgba(255,255,255,0.3)";
      g.fillText(String(n), h.x, h.y + 32);
      if (!h.kind) return;
      // What's popping out, clipped to above the hole's rim.
      g.save();
      g.beginPath();
      g.rect(h.x - 60, h.y - 120, 120, 120);
      g.clip();
      const rise = h.up * 62;
      const squash = h.hit > 0 ? 0.5 : 1;
      g.translate(h.x, h.y - rise + 18);
      g.scale(1 / squash, squash);
      g.font = `52px ${F}`;
      g.textBaseline = "bottom";
      g.fillText(h.kind === "bug" ? (h.hit > 0 ? "💥" : "🐛") : "🚀", 0, Math.sin(t * 12 + i) * 2);
      g.restore();
    });
    this.sparks.draw(g);
    this.pops.draw(g);
    g.restore();
    // A mallet cursor.
    if (this.mouse.x > 0) {
      g.font = `30px ${F}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("🔨", this.mouse.x + 10, this.mouse.y - 10);
    }
  }
}

// ---------------------------------------------------------------------------
// Brick Breaker
// ---------------------------------------------------------------------------

const DEBT = ["TODO", "FIXME", "any", "hack", "XXX", "legacy", "@ts-ignore", "eval", "goto", "magic#", "flaky", "copy-pasta"];
const ROW_COLORS = ["#ef476f", "#f77f00", "#ffd166", "#06d6a0", "#5bc0eb"];

interface Brick {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  color: string;
  hp: number;
}

class Breakout implements Game {
  score = 0;
  over = false;
  readonly help = "Mouse or ← → to move · Space to launch · clear the tech debt";
  private paddle = { x: W / 2, w: 86 };
  private ball = { x: W / 2, y: H - 60, vx: 0, vy: 0, r: 7 };
  private stuck = true;
  private lives = 3;
  private level = 1;
  private bricks: Brick[] = [];
  private left = false;
  private right = false;
  private sparks = new Sparks();
  private pops = new Pops();

  constructor() {
    this.build();
  }

  private build(): void {
    this.bricks = [];
    const cols = 7;
    const bw = (W - 40) / cols;
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < cols; c++) {
        this.bricks.push({
          x: 20 + c * bw + 2,
          y: 70 + r * 26,
          w: bw - 4,
          h: 22,
          label: DEBT[(r * cols + c * 3 + this.level) % DEBT.length],
          color: ROW_COLORS[r],
          hp: r === 0 && this.level > 1 ? 2 : 1,
        });
      }
  }

  key(code: string): void {
    if (code === "Space" || code === "Enter" || code === "ArrowUp" || code === "KeyW") this.launch();
    if (code === "ArrowLeft" || code === "KeyA") this.left = true;
    if (code === "ArrowRight" || code === "KeyD") this.right = true;
  }

  release(code: string): void {
    if (code === "ArrowLeft" || code === "KeyA") this.left = false;
    if (code === "ArrowRight" || code === "KeyD") this.right = false;
  }

  pointer(x: number, _y: number, down: boolean): void {
    this.paddle.x = x;
    if (down) this.launch();
  }

  private launch(): void {
    if (!this.stuck) return;
    this.stuck = false;
    const speed = 300 + this.level * 30;
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 0.6;
    this.ball.vx = Math.cos(a) * speed;
    this.ball.vy = Math.sin(a) * speed;
    sound.click();
  }

  update(dt: number): void {
    this.sparks.update(dt);
    this.pops.update(dt);
    const dir = (this.right ? 1 : 0) - (this.left ? 1 : 0);
    this.paddle.x += dir * 480 * dt;
    const half = this.paddle.w / 2;
    this.paddle.x = Math.max(half, Math.min(W - half, this.paddle.x));
    const b = this.ball;
    if (this.stuck) {
      b.x = this.paddle.x;
      b.y = H - 40 - b.r;
      return;
    }
    const steps = 4;
    for (let i = 0; i < steps; i++) this.step(dt / steps);
  }

  private step(dt: number): void {
    const b = this.ball;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.x < b.r) {
      b.x = b.r;
      b.vx = Math.abs(b.vx);
    } else if (b.x > W - b.r) {
      b.x = W - b.r;
      b.vx = -Math.abs(b.vx);
    }
    if (b.y < b.r) {
      b.y = b.r;
      b.vy = Math.abs(b.vy);
    }
    // The paddle: where it hits sets the angle.
    const py = H - 40;
    if (b.vy > 0 && b.y + b.r >= py && b.y + b.r <= py + 14 && Math.abs(b.x - this.paddle.x) <= this.paddle.w / 2 + b.r) {
      const off = (b.x - this.paddle.x) / (this.paddle.w / 2);
      const speed = Math.hypot(b.vx, b.vy) * 1.01;
      const a = -Math.PI / 2 + clamp1(off) * 1.05;
      b.vx = Math.cos(a) * speed;
      b.vy = Math.sin(a) * speed;
      b.y = py - b.r;
      sound.click();
    }
    // Bricks.
    for (const k of this.bricks) {
      if (k.hp <= 0) continue;
      if (b.x + b.r < k.x || b.x - b.r > k.x + k.w || b.y + b.r < k.y || b.y - b.r > k.y + k.h) continue;
      const overlapX = Math.min(b.x + b.r - k.x, k.x + k.w - (b.x - b.r));
      const overlapY = Math.min(b.y + b.r - k.y, k.y + k.h - (b.y - b.r));
      if (overlapX < overlapY) b.vx = -b.vx;
      else b.vy = -b.vy;
      k.hp--;
      if (k.hp <= 0) {
        this.score += 10 * this.level;
        this.sparks.burst(k.x + k.w / 2, k.y + k.h / 2, k.color, 16);
        this.pops.add(k.x + k.w / 2, k.y, `-${k.label}`, k.color);
        sound.xp();
      } else sound.click();
      break;
    }
    if (this.bricks.every((k) => k.hp <= 0)) {
      this.level++;
      this.score += 100;
      this.pops.add(W / 2, H / 2, "DEBT PAID! +100", "#ffd166");
      sound.achievement();
      this.build();
      this.stuck = true;
      return;
    }
    if (b.y - b.r > H) {
      this.lives--;
      sound.bell();
      if (this.lives <= 0) this.over = true;
      else this.stuck = true;
    }
  }

  draw(g: CanvasRenderingContext2D): void {
    g.font = `900 16px ${F}`;
    g.textBaseline = "middle";
    g.textAlign = "left";
    g.fillStyle = "#ffffff";
    g.fillText(`${"♥".repeat(this.lives)}`, 20, 30);
    g.textAlign = "right";
    g.fillText(`LEVEL ${this.level}`, W - 20, 30);
    for (const k of this.bricks) {
      if (k.hp <= 0) continue;
      g.shadowColor = k.color;
      g.shadowBlur = 8;
      g.fillStyle = k.color;
      g.globalAlpha = k.hp > 1 ? 1 : 0.88;
      g.beginPath();
      g.roundRect(k.x, k.y, k.w, k.h, 5);
      g.fill();
      g.shadowBlur = 0;
      g.globalAlpha = 1;
      if (k.hp > 1) {
        g.strokeStyle = "#ffffff";
        g.lineWidth = 2;
        g.stroke();
      }
      g.fillStyle = "#0b0a1a";
      g.font = `800 11px ui-monospace, Consolas, monospace`;
      g.textAlign = "center";
      g.fillText(k.label, k.x + k.w / 2, k.y + k.h / 2 + 1);
    }
    // Paddle and ball.
    g.shadowColor = "#5bc0eb";
    g.shadowBlur = 14;
    g.fillStyle = "#5bc0eb";
    g.beginPath();
    g.roundRect(this.paddle.x - this.paddle.w / 2, H - 40, this.paddle.w, 12, 6);
    g.fill();
    g.fillStyle = "#ffffff";
    g.shadowColor = "#ffffff";
    g.beginPath();
    g.arc(this.ball.x, this.ball.y, this.ball.r, 0, Math.PI * 2);
    g.fill();
    g.shadowBlur = 0;
    if (this.stuck && !this.over) {
      g.font = `800 14px ${F}`;
      g.textAlign = "center";
      g.fillStyle = "#c9c6e8";
      g.fillText("Space / click to launch", W / 2, H - 80);
    }
    this.sparks.draw(g);
    this.pops.draw(g);
  }
}

/** Clamp the paddle offset to -1..1. */
function clamp1(v: number): number {
  return Math.max(-1, Math.min(1, v));
}
