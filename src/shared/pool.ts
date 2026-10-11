/**
 * Pool, for the table in the game room: a top-down physics game on the
 * table's playing surface, shared by the 3D table (which draws it, and lets
 * workers on a break shoot) and the window you play it in.
 *
 * Coordinates are the playing surface's, in meters, centered: x along its
 * length, z across it. Simple physics — rolling friction, elastic ball-to-ball
 * hits, cushions that soak up a little, six pockets — stepped in small fixed
 * steps so nothing tunnels through anything.
 *
 * The game is solo "clear the table": nine balls racked in a diamond, sink
 * them all in as few shots as you can. Sinking the cue ball is a scratch: it
 * comes back on its spot and costs a shot.
 */

export const POOL_TABLE = { length: 2.0, width: 1.0, ballR: 0.028, pocketR: 0.062 } as const;

const L = POOL_TABLE.length;
const W = POOL_TABLE.width;
const R = POOL_TABLE.ballR;
/** The fastest the cue ball leaves the cue, m/s. */
export const MAX_SHOT_SPEED = 3.4;
/** Rolling friction (a constant slowing, m/s²) plus a little drag (1/s). */
const DECEL = 0.85;
const DRAG = 0.35;
const STOP = 0.012;
/** How bouncy a ball-to-ball hit and a cushion are. */
const BALL_E = 0.94;
const CUSHION_E = 0.76;
const STEP = 1 / 600;

export const POCKETS: readonly { x: number; z: number }[] = [
  { x: -L / 2, z: -W / 2 },
  { x: 0, z: -W / 2 - 0.012 },
  { x: L / 2, z: -W / 2 },
  { x: -L / 2, z: W / 2 },
  { x: 0, z: W / 2 + 0.012 },
  { x: L / 2, z: W / 2 },
];

/** The balls' colors (0 is the cue ball); 9 is the striped yellow. */
export const BALL_COLORS = ["#fdfdf6", "#ffd23f", "#1f6feb", "#e63946", "#7b2cbf", "#f77f00", "#2a9d8f", "#8d2b1e", "#1b1b26", "#ffd23f"] as const;
export const OBJECT_BALLS = 9;
/** Where the cue ball starts (and comes back to after a scratch): the head spot. */
export const HEAD_SPOT = { x: -L / 4, z: 0 } as const;
/** The apex of the rack: the foot spot. */
export const FOOT_SPOT = { x: L / 4, z: 0 } as const;

export interface PoolBall {
  /** 0 is the cue ball. */
  n: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  potted: boolean;
}

export type PoolEvent = { kind: "pot"; n: number } | { kind: "scratch" } | { kind: "hit"; speed: number } | { kind: "cushion"; speed: number } | { kind: "cleared"; shots: number };

export class PoolGame {
  balls: PoolBall[] = [];
  /** Shots taken this rack (a scratch adds one). */
  shots = 0;
  scratches = 0;
  private scratched = false;
  private clearedSaid = false;

  constructor() {
    this.rack();
  }

  /** A fresh rack: the cue ball on the head spot, nine balls in a diamond on the foot spot. */
  rack(): void {
    this.balls = [{ n: 0, x: HEAD_SPOT.x, z: HEAD_SPOT.z, vx: 0, vz: 0, potted: false }];
    // Rows of 1, 2, 3, 2, 1 along +x; the 1 at the apex, the 9 in the middle.
    const rows = [1, 2, 3, 2, 1];
    const gap = 2 * R * 1.004;
    const dx = gap * Math.cos(Math.PI / 6);
    const order = [1, 2, 3, 9, 4, 5, 6, 7, 8];
    let k = 0;
    rows.forEach((count, r) => {
      for (let i = 0; i < count; i++) {
        const z = (i - (count - 1) / 2) * gap;
        const slot = r === 2 && i === 1 ? 9 : order.filter((n) => n !== 9)[k++];
        this.balls.push({ n: slot, x: FOOT_SPOT.x + r * dx, z, vx: 0, vz: 0, potted: false });
      }
    });
    this.balls.sort((a, b) => a.n - b.n);
    this.shots = 0;
    this.scratches = 0;
    this.scratched = false;
    this.clearedSaid = false;
  }

  get cue(): PoolBall {
    return this.balls[0];
  }

  /** Anything still rolling. */
  get moving(): boolean {
    return this.balls.some((b) => !b.potted && (b.vx !== 0 || b.vz !== 0));
  }

  /** Every object ball is down. */
  get cleared(): boolean {
    return this.balls.every((b) => b.n === 0 || b.potted);
  }

  /** How many object balls are still on the table. */
  get left(): number {
    return this.balls.filter((b) => b.n !== 0 && !b.potted).length;
  }

  /** Strike the cue ball toward `angle` (radians: 0 is +x, π/2 is +z) at `power` 0..1. False when it can't be taken now. */
  shoot(angle: number, power: number): boolean {
    if (this.moving || this.cleared || this.cue.potted) return false;
    const p = Math.min(1, Math.max(0.02, Number.isFinite(power) ? power : 0));
    const a = Number.isFinite(angle) ? angle : 0;
    this.cue.vx = Math.cos(a) * p * MAX_SHOT_SPEED;
    this.cue.vz = Math.sin(a) * p * MAX_SHOT_SPEED;
    this.shots++;
    return true;
  }

  /** Advance the table by dt seconds; returns what happened. */
  step(dt: number): PoolEvent[] {
    const events: PoolEvent[] = [];
    if (!this.moving) return events;
    const steps = Math.ceil(Math.min(Math.max(dt, 0), 0.1) / STEP);
    for (let s = 0; s < steps; s++) {
      this.tick(STEP, events);
      if (!this.moving) break;
    }
    if (!this.moving) this.settle(events);
    return events;
  }

  /** Run until everything has stopped (for tests and the workers' quick games). */
  settleAll(maxSeconds = 60): PoolEvent[] {
    const events: PoolEvent[] = [];
    for (let t = 0; t < maxSeconds && this.moving; t += 0.05) events.push(...this.step(0.05));
    return events;
  }

  private tick(h: number, events: PoolEvent[]): void {
    const live = this.balls.filter((b) => !b.potted);
    for (const b of live) {
      const v = Math.hypot(b.vx, b.vz);
      if (v === 0) continue;
      const nv = Math.max(0, v - (DECEL + DRAG * v) * h);
      if (nv < STOP) {
        b.vx = b.vz = 0;
        continue;
      }
      b.vx *= nv / v;
      b.vz *= nv / v;
      b.x += b.vx * h;
      b.z += b.vz * h;
    }
    // Into a pocket.
    for (const b of live) {
      if (POCKETS.some((p) => Math.hypot(b.x - p.x, b.z - p.z) < POOL_TABLE.pocketR)) {
        b.potted = true;
        b.vx = b.vz = 0;
        if (b.n === 0) {
          this.scratched = true;
          events.push({ kind: "scratch" });
        } else events.push({ kind: "pot", n: b.n });
      }
    }
    // Off the cushions.
    for (const b of live) {
      if (b.potted) continue;
      if (b.x < -L / 2 + R || b.x > L / 2 - R) {
        b.x = b.x < 0 ? -L / 2 + R : L / 2 - R;
        if (Math.abs(b.vx) > 0.05) events.push({ kind: "cushion", speed: Math.abs(b.vx) });
        b.vx = -b.vx * CUSHION_E;
        b.vz *= 0.97;
      }
      if (b.z < -W / 2 + R || b.z > W / 2 - R) {
        b.z = b.z < 0 ? -W / 2 + R : W / 2 - R;
        if (Math.abs(b.vz) > 0.05) events.push({ kind: "cushion", speed: Math.abs(b.vz) });
        b.vz = -b.vz * CUSHION_E;
        b.vx *= 0.97;
      }
    }
    // Ball on ball: equal masses, along the line between their centers.
    for (let i = 0; i < live.length; i++) {
      const a = live[i];
      if (a.potted) continue;
      for (let j = i + 1; j < live.length; j++) {
        const b = live[j];
        if (b.potted) continue;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= 4 * R * R) continue;
        const d = Math.sqrt(d2) || 1e-6;
        const nx = d2 ? dx / d : 1;
        const nz = d2 ? dz / d : 0;
        // Pull them apart so they just touch.
        const push = (2 * R - d) / 2;
        a.x -= nx * push;
        a.z -= nz * push;
        b.x += nx * push;
        b.z += nz * push;
        const closing = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
        if (closing <= 0) continue;
        const j2 = (closing * (1 + BALL_E)) / 2;
        a.vx -= j2 * nx;
        a.vz -= j2 * nz;
        b.vx += j2 * nx;
        b.vz += j2 * nz;
        if (closing > 0.05) events.push({ kind: "hit", speed: closing });
      }
    }
  }

  /** Everything's stopped: a scratched cue ball comes back, and a cleared table is called. */
  private settle(events: PoolEvent[]): void {
    if (this.scratched) {
      this.scratched = false;
      this.scratches++;
      this.shots++;
      const cue = this.cue;
      cue.potted = false;
      cue.vx = cue.vz = 0;
      cue.z = HEAD_SPOT.z;
      // On its spot, or the nearest clear place toward the head cushion.
      for (let x = HEAD_SPOT.x; x > -L / 2 + R; x -= R) {
        cue.x = x;
        if (!this.balls.some((b) => b !== cue && !b.potted && Math.hypot(b.x - cue.x, b.z - cue.z) < 2 * R + 0.002)) break;
      }
    }
    if (this.cleared && !this.clearedSaid) {
      this.clearedSaid = true;
      events.push({ kind: "cleared", shots: this.shots });
    }
  }

  /**
   * A shot a decent player would take: for each ball and pocket, aim the cue
   * ball at the "ghost ball" spot that sends it in, favoring straight-ish cuts
   * with nothing in the way. `skill` 0..1 sets how much the aim wobbles.
   */
  pickShot(rand: () => number = Math.random, skill = 0.8): { angle: number; power: number } {
    const cue = this.cue;
    const targets = this.balls.filter((b) => b.n !== 0 && !b.potted);
    let best: { angle: number; power: number; score: number } | null = null;
    for (const t of targets) {
      for (const p of POCKETS) {
        const tpx = p.x - t.x;
        const tpz = p.z - t.z;
        const tp = Math.hypot(tpx, tpz) || 1e-6;
        const gx = t.x - (tpx / tp) * 2 * R;
        const gz = t.z - (tpz / tp) * 2 * R;
        const cgx = gx - cue.x;
        const cgz = gz - cue.z;
        const cg = Math.hypot(cgx, cgz) || 1e-6;
        const cut = (cgx * tpx + cgz * tpz) / (cg * tp);
        if (cut < 0.25) continue;
        if (this.blocked(cue.x, cue.z, gx, gz, [cue, t]) || this.blocked(t.x, t.z, p.x, p.z, [cue, t])) continue;
        const score = cut * 2 - (cg + tp) * 0.5;
        if (!best || score > best.score) {
          const power = Math.min(0.95, Math.max(0.22, 0.12 + (cg + tp * 1.4) / (cut * 2.6)));
          best = { angle: Math.atan2(cgz, cgx), power, score };
        }
      }
    }
    let shot: { angle: number; power: number };
    if (best) shot = best;
    else {
      // Nothing clean: hit the nearest ball firmly and hope.
      const near = targets.reduce<PoolBall | null>((m, b) => (!m || Math.hypot(b.x - cue.x, b.z - cue.z) < Math.hypot(m.x - cue.x, m.z - cue.z) ? b : m), null);
      shot = near ? { angle: Math.atan2(near.z - cue.z, near.x - cue.x), power: 0.7 } : { angle: 0, power: 0.5 };
    }
    // The first shot of a rack is the break: hard.
    if (this.left === OBJECT_BALLS && this.shots === 0) shot = { angle: Math.atan2(FOOT_SPOT.z - cue.z, FOOT_SPOT.x - cue.x), power: 1 };
    const wobble = (1 - Math.min(1, Math.max(0, skill))) * 0.06;
    return { angle: shot.angle + (rand() - 0.5) * wobble, power: Math.min(1, shot.power * (0.95 + rand() * 0.1)) };
  }

  /** Whether any ball (but those skipped) sits within a ball's width of the segment a→b. */
  private blocked(ax: number, az: number, bx: number, bz: number, skip: PoolBall[]): boolean {
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz || 1e-9;
    return this.balls.some((o) => {
      if (o.potted || skip.includes(o)) return false;
      const t = Math.max(0, Math.min(1, ((o.x - ax) * dx + (o.z - az) * dz) / len2));
      return Math.hypot(o.x - (ax + dx * t), o.z - (az + dz * t)) < 2 * R;
    });
  }
}
