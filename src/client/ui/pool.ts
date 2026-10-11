import { BALL_COLORS, POCKETS, POOL_TABLE, type PoolGame } from "../../shared/pool.js";
import { openModal } from "./modal.js";
import { confetti, sound } from "./fx.js";
import "../styles/arcade.css";

/**
 * Pool, in a window: the game room's table seen from above. Aim with the
 * mouse (or ←/→), hold the button (or Space) to build power, let go to
 * shoot. Clear all nine balls in as few shots as you can; R racks again.
 * The 3D table follows along while you play.
 */

const CW = 640;
const CH = 380;
const RAIL = 34;
const SCALE = (CW - RAIL * 2) / POOL_TABLE.length;
const F = 'Nunito, ui-rounded, "Segoe UI", system-ui, sans-serif';
/** How long a full swing of the power meter takes (0 → 1 → 0), in seconds. */
const SWING = 1.8;

export interface PoolOptions {
  /** Your best (fewest shots) so far; 0 for none. */
  best: number;
  /** The table was cleared in `shots`: true if that's a new best. */
  onCleared(shots: number): boolean;
  onClose(): void;
}

export function openPool(game: PoolGame, opts: PoolOptions): void {
  let best = opts.best;
  let angle = 0;
  let charging: number | null = null;
  let power = 0;
  let turn = 0;
  let cleared: { shots: number; best: boolean } | null = null;
  let flash: { text: string; until: number } | null = null;

  const body = document.createElement("div");
  body.className = "arcade";
  body.style.setProperty("--neon", "#2a9d8f");
  body.innerHTML = `
    <div class="arc-bar"><span class="arc-score">SHOTS <b>0</b></span><span class="arc-left">BALLS LEFT <b>9</b></span><span class="arc-best">BEST <b>${best || "—"}</b></span></div>
    <div class="arc-screen"><canvas class="pool-canvas"></canvas></div>
    <div class="arc-help">Aim with the mouse or ←/→ · hold the button or Space for power, let go to shoot · R racks again</div>`;
  const canvas = body.querySelector("canvas")!;
  const shotsEl = body.querySelector(".arc-score b")!;
  const leftEl = body.querySelector(".arc-left b")!;
  const bestEl = body.querySelector(".arc-best b")!;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = CW * dpr;
  canvas.height = CH * dpr;
  const g = canvas.getContext("2d")!;
  g.scale(dpr, dpr);

  const toScreen = (x: number, z: number): [number, number] => [CW / 2 + x * SCALE, CH / 2 + z * SCALE];
  const toTable = (sx: number, sy: number): [number, number] => [(sx - CW / 2) / SCALE, (sy - CH / 2) / SCALE];

  const ready = () => !game.moving && !game.cleared && !game.cue.potted;
  const release = () => {
    if (charging === null) return;
    charging = null;
    if (ready() && power > 0.02 && game.shoot(angle, power)) sound.click();
    power = 0;
  };
  const rack = () => {
    game.rack();
    cleared = null;
    charging = null;
    power = 0;
    sound.click();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") return; // the window closes itself
    const code = e.code;
    if (!/^(ArrowLeft|ArrowRight|KeyA|KeyD|Space|KeyR|Enter)$/.test(code)) return;
    e.preventDefault();
    e.stopPropagation();
    const down = e.type === "keydown";
    if (code === "ArrowLeft" || code === "KeyA") turn = down ? -1 : turn === -1 ? 0 : turn;
    else if (code === "ArrowRight" || code === "KeyD") turn = down ? 1 : turn === 1 ? 0 : turn;
    else if (code === "KeyR" && down) rack();
    else if (code === "Space" || code === "Enter") {
      if (down && cleared) rack();
      else if (down && charging === null && ready()) charging = performance.now();
      else if (!down) release();
    }
  };
  const pointerAt = (e: PointerEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * CW, ((e.clientY - r.top) / r.height) * CH];
  };
  const aimAt = (e: PointerEvent) => {
    const [x, z] = toTable(...pointerAt(e));
    const c = game.cue;
    if (Math.hypot(x - c.x, z - c.z) > 0.01) angle = Math.atan2(z - c.z, x - c.x);
  };
  const onDown = (e: PointerEvent) => {
    e.preventDefault();
    if (cleared) return rack();
    aimAt(e);
    if (ready()) charging = performance.now();
  };
  const onMove = (e: PointerEvent) => {
    if (charging === null) aimAt(e);
  };
  const onUp = () => release();

  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);

  let raf = 0;
  let last = performance.now();
  let closed = false;
  const frame = (now: number) => {
    if (closed) return;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (turn) angle += turn * dt * 1.1;
    if (charging !== null) {
      const t = ((now - charging) / 1000 / SWING) % 1;
      power = t < 0.5 ? t * 2 : 2 - t * 2;
    }
    for (const ev of game.step(dt)) {
      if (ev.kind === "pot") {
        sound.chime();
        flash = { text: `${ev.n} in!`, until: now + 900 };
      } else if (ev.kind === "scratch") {
        sound.thunk();
        flash = { text: "Scratch — +1 shot", until: now + 1400 };
      } else if (ev.kind === "hit" && ev.speed > 0.6) sound.click();
      else if (ev.kind === "cleared") {
        const isBest = opts.onCleared(ev.shots);
        if (isBest) best = ev.shots;
        cleared = { shots: ev.shots, best: isBest };
        bestEl.textContent = String(best || "—");
        sound.levelUp();
        confetti(isBest ? 140 : 70);
      }
    }
    shotsEl.textContent = String(game.shots);
    leftEl.textContent = String(game.left);
    draw(now);
    raf = requestAnimationFrame(frame);
  };

  const draw = (now: number) => {
    g.fillStyle = "#4a2a19";
    g.fillRect(0, 0, CW, CH);
    // Rails and felt.
    const [fx, fy] = toScreen(-POOL_TABLE.length / 2, -POOL_TABLE.width / 2);
    const fw = POOL_TABLE.length * SCALE;
    const fh = POOL_TABLE.width * SCALE;
    g.fillStyle = "#6b3e26";
    g.fillRect(fx - RAIL + 6, fy - RAIL + 6, fw + RAIL * 2 - 12, fh + RAIL * 2 - 12);
    g.fillStyle = "#17603b";
    g.fillRect(fx - 7, fy - 7, fw + 14, fh + 14);
    g.fillStyle = "#1f7a4d";
    g.fillRect(fx, fy, fw, fh);
    // The head string and spots.
    g.strokeStyle = "rgba(255,255,255,.12)";
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(fx + fw / 4, fy);
    g.lineTo(fx + fw / 4, fy + fh);
    g.stroke();
    g.fillStyle = "#f4f1de";
    for (let i = 1; i < 8; i++) {
      if (i === 4) continue;
      for (const y of [fy - RAIL / 2 - 2, fy + fh + RAIL / 2 + 2]) {
        g.beginPath();
        g.arc(fx + (i * fw) / 8, y, 2.5, 0, Math.PI * 2);
        g.fill();
      }
    }
    // Pockets.
    g.fillStyle = "#0b0a10";
    for (const p of POCKETS) {
      const [px, py] = toScreen(p.x, p.z);
      g.beginPath();
      g.arc(px, py, POOL_TABLE.pocketR * SCALE, 0, Math.PI * 2);
      g.fill();
    }
    const r = POOL_TABLE.ballR * SCALE;
    // The aim: a line from the cue ball to where it first meets a ball (with a ghost ball there).
    if (ready()) {
      const c = game.cue;
      const [cx, cy] = toScreen(c.x, c.z);
      const dx = Math.cos(angle);
      const dz = Math.sin(angle);
      const hit = firstContact(game, dx, dz);
      const reach = hit ?? 2.4;
      const [ex, ey] = toScreen(c.x + dx * reach, c.z + dz * reach);
      g.save();
      g.setLineDash([6, 6]);
      g.strokeStyle = "rgba(255,255,255,.55)";
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(ex, ey);
      g.stroke();
      g.restore();
      if (hit !== null) {
        g.strokeStyle = "rgba(255,255,255,.7)";
        g.beginPath();
        g.arc(ex, ey, r, 0, Math.PI * 2);
        g.stroke();
      }
      // The cue, pulled back by the power.
      const back = r + 6 + power * 60;
      const len = 260;
      g.strokeStyle = "#d9a066";
      g.lineWidth = 6;
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(cx - dx * back, cy - dz * back);
      g.lineTo(cx - dx * (back + len), cy - dz * (back + len));
      g.stroke();
      g.strokeStyle = "#5bc0eb";
      g.beginPath();
      g.moveTo(cx - dx * back, cy - dz * back);
      g.lineTo(cx - dx * (back + 6), cy - dz * (back + 6));
      g.stroke();
      g.lineCap = "butt";
    }
    // Balls.
    for (const b of game.balls) {
      if (b.potted) continue;
      const [bx, by] = toScreen(b.x, b.z);
      g.fillStyle = "rgba(0,0,0,.28)";
      g.beginPath();
      g.arc(bx + 2, by + 3, r, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = BALL_COLORS[b.n] ?? "#fff";
      g.beginPath();
      g.arc(bx, by, r, 0, Math.PI * 2);
      g.fill();
      if (b.n === 9) {
        // The stripe ball: white with a yellow band.
        g.save();
        g.beginPath();
        g.arc(bx, by, r, 0, Math.PI * 2);
        g.clip();
        g.fillStyle = "#fdfdf6";
        g.fillRect(bx - r, by - r, r * 2, r * 0.55);
        g.fillRect(bx - r, by + r * 0.45, r * 2, r * 0.55);
        g.restore();
      }
      if (b.n) {
        g.fillStyle = "#fff";
        g.beginPath();
        g.arc(bx, by, r * 0.5, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = "#1b1b26";
        g.font = `900 ${Math.round(r * 0.75)}px ${F}`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(String(b.n), bx, by + 0.5);
      }
      g.fillStyle = "rgba(255,255,255,.45)";
      g.beginPath();
      g.arc(bx - r * 0.35, by - r * 0.35, r * 0.25, 0, Math.PI * 2);
      g.fill();
    }
    // The power meter.
    if (charging !== null) {
      g.fillStyle = "rgba(11,10,26,.7)";
      g.fillRect(CW / 2 - 102, CH - 22, 204, 14);
      g.fillStyle = power > 0.8 ? "#ef476f" : power > 0.5 ? "#ffd166" : "#06d6a0";
      g.fillRect(CW / 2 - 100, CH - 20, 200 * power, 10);
    }
    g.textAlign = "center";
    g.textBaseline = "middle";
    if (flash && now < flash.until) {
      g.font = `900 22px ${F}`;
      g.fillStyle = "#ffd166";
      g.fillText(flash.text, CW / 2, 18);
    }
    if (cleared) {
      g.fillStyle = "rgba(11,10,26,.72)";
      g.fillRect(0, 0, CW, CH);
      g.font = `900 40px ${F}`;
      g.fillStyle = "#06d6a0";
      g.fillText(`Cleared in ${cleared.shots} shot${cleared.shots === 1 ? "" : "s"}!`, CW / 2, CH / 2 - 20);
      g.font = `800 18px ${F}`;
      g.fillStyle = "#ffd166";
      g.fillText(cleared.best ? "★ New best ★" : `Best: ${best}`, CW / 2, CH / 2 + 22);
      if (Math.floor(now / 500) % 2 === 0) {
        g.fillStyle = "#fff";
        g.fillText("Click, Space or R to rack again", CW / 2, CH / 2 + 56);
      }
    }
  };
  raf = requestAnimationFrame(frame);

  openModal({
    title: "Pool",
    icon: "🎱",
    className: "arcade-modal pool-modal",
    body,
    onClose: () => {
      closed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      opts.onClose();
    },
  });
}

/** How far the cue ball travels along (dx, dz) before it touches another ball (null: it doesn't). */
function firstContact(game: PoolGame, dx: number, dz: number): number | null {
  const c = game.cue;
  const R2 = 2 * POOL_TABLE.ballR;
  let best: number | null = null;
  for (const b of game.balls) {
    if (b === c || b.potted) continue;
    const ox = b.x - c.x;
    const oz = b.z - c.z;
    const along = ox * dx + oz * dz;
    if (along <= 0) continue;
    const off2 = ox * ox + oz * oz - along * along;
    if (off2 > R2 * R2) continue;
    const t = along - Math.sqrt(R2 * R2 - off2);
    if (best === null || t < best) best = t;
  }
  return best;
}
