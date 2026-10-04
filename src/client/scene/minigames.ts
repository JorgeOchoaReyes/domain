import * as THREE from "three";
import { BUILDING, HOOP, PARTITIONS_X, PITCH, WING_ROOMS_Z, WORLD_BOUNDS } from "../../shared/layout.js";
import type { Collider } from "./office.js";
import { mesh, toon } from "./toon.js";
import { sound } from "../ui/fx.js";
import "../styles/arcade.css";

/**
 * The games you play in the world itself: shooting hoops in the game room
 * (with a power meter) and kicking a ball about on the pitch outside.
 */

const G = 9.8;

// ---------------------------------------------------------------------------
// Hoops
// ---------------------------------------------------------------------------

const BALL_R = 0.12;
const RIM_R = 0.23;
const RIM_TUBE = 0.02;
const SWEET = 0.72;
/** The backboard's face, toward the room. */
const BOARD_X = BUILDING.maxX - 0.29;
const GAME_ROOM = { minX: PARTITIONS_X[2] + 0.15, maxX: BUILDING.maxX, minZ: WING_ROOMS_Z, maxZ: BUILDING.maxZ };

export class Hoops {
  private ball: THREE.Mesh;
  private pos = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private rim = new THREE.Vector3(HOOP.rim.x, HOOP.rim.y, HOOP.rim.z);
  private flying = false;
  private resolved = true;
  private scored = false;
  private life = 0;
  private settled = 0;
  private net: THREE.Object3D | null = null;
  private wiggle = 0;
  private lastClank = 0;

  constructor(private parent: THREE.Object3D) {
    this.ball = mesh(new THREE.SphereGeometry(BALL_R, 20, 14), new THREE.MeshToonMaterial({ map: ballTexture("#f77f00", "#2b1a0e"), gradientMap: toon("#fff").gradientMap }));
    this.ball.visible = false;
    parent.add(this.ball);
  }

  /** A shot is in the air and hasn't been called yet. */
  get busy(): boolean {
    return this.flying && !this.resolved;
  }

  shoot(from: THREE.Vector3, power: number): void {
    const p = THREE.MathUtils.clamp(power, 0, 1);
    const dx = this.rim.x - from.x;
    const dz = this.rim.z - from.z;
    const dist = Math.hypot(dx, dz) || 1;
    const dir = new THREE.Vector2(dx / dist, dz / dist);
    // How far long or short of the rim's center the shot lands: the sweet
    // window (±0.07) maps to inside the rim, and gets tighter with distance.
    const k = 1.6 * (1 + Math.max(0, dist - 3.45) * 0.08);
    const offset = (p - SWEET) * k;
    const target = new THREE.Vector3(this.rim.x + dir.x * offset, this.rim.y + 0.02, this.rim.z + dir.y * offset + (Math.random() - 0.5) * 0.04);
    // A ballistic arc that comes down onto the target from above.
    const T = 0.85 + dist * 0.07;
    this.pos.copy(from);
    this.vel.set((target.x - from.x) / T, (target.y - from.y + 0.5 * G * T * T) / T, (target.z - from.z) / T);
    this.ball.position.copy(this.pos);
    this.ball.visible = true;
    this.flying = true;
    this.resolved = false;
    this.scored = false;
    this.life = 0;
    this.settled = 0;
  }

  update(dt: number): "score" | "miss" | null {
    if (this.wiggle > 0) {
      this.wiggle = Math.max(0, this.wiggle - dt);
      const net = this.findNet();
      if (net) {
        const t = 1 - this.wiggle;
        net.scale.set(1 + Math.sin(t * 30) * 0.12 * this.wiggle, 1 + Math.sin(t * 22) * 0.25 * this.wiggle, 1 + Math.cos(t * 30) * 0.12 * this.wiggle);
      }
    }
    if (!this.flying) return null;
    let event: "score" | "miss" | null = null;
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const prevY = this.pos.y;
      this.vel.y -= G * h;
      this.pos.addScaledVector(this.vel, h);
      this.collideRim();
      this.collideBoard();
      this.collideRoom();

      // Through the hoop: crossing the rim's plane going down, inside the ring.
      if (!this.scored && prevY > this.rim.y && this.pos.y <= this.rim.y && this.vel.y < 0) {
        const r = Math.hypot(this.pos.x - this.rim.x, this.pos.z - this.rim.z);
        if (r < RIM_R - RIM_TUBE) {
          this.scored = true;
          this.wiggle = 1;
          // The net slows it down.
          this.vel.multiplyScalar(0.35);
          if (!this.resolved) {
            this.resolved = true;
            event = "score";
          }
        }
      }
      // The floor.
      if (this.pos.y < BALL_R) {
        this.pos.y = BALL_R;
        if (Math.abs(this.vel.y) > 0.6) this.clank(0.6);
        this.vel.y = -this.vel.y * 0.62;
        this.vel.x *= 0.86;
        this.vel.z *= 0.86;
        if (!this.resolved) {
          this.resolved = true;
          event = "miss";
        }
      }
    }
    // Rolling friction once it's down.
    if (this.pos.y <= BALL_R + 0.01) {
      const f = Math.exp(-1.6 * dt);
      this.vel.x *= f;
      this.vel.z *= f;
    }
    this.ball.position.copy(this.pos);
    this.ball.rotation.x += this.vel.z * dt * 6;
    this.ball.rotation.z -= this.vel.x * dt * 6;

    this.life += dt;
    if (this.resolved && this.vel.length() < 0.35 && this.pos.y <= BALL_R + 0.02) this.settled += dt;
    if (this.settled > 0.8 || this.life > 7) {
      this.flying = false;
      this.ball.visible = false;
      if (!this.resolved) {
        this.resolved = true;
        event = event ?? "miss";
      }
    }
    return event;
  }

  private collideRim(): void {
    const dx = this.pos.x - this.rim.x;
    const dz = this.pos.z - this.rim.z;
    const r = Math.hypot(dx, dz) || 1e-6;
    // Closest point on the rim's ring to the ball.
    const q = new THREE.Vector3(this.rim.x + (dx / r) * RIM_R, this.rim.y, this.rim.z + (dz / r) * RIM_R);
    const n = this.pos.clone().sub(q);
    const d = n.length();
    const min = BALL_R + RIM_TUBE;
    if (d < min && d > 1e-6) {
      n.divideScalar(d);
      this.pos.copy(q).addScaledVector(n, min);
      const vn = this.vel.dot(n);
      if (vn < 0) {
        this.vel.addScaledVector(n, -vn * 1.55);
        this.vel.multiplyScalar(0.92);
        this.clank(Math.abs(vn));
      }
    }
  }

  private collideBoard(): void {
    const { y, z } = this.rim;
    if (this.pos.y < y - 0.12 || this.pos.y > y + 0.7 || Math.abs(this.pos.z - z) > 0.63) return;
    if (this.pos.x + BALL_R > BOARD_X && this.vel.x > 0) {
      this.pos.x = BOARD_X - BALL_R;
      this.clank(this.vel.x);
      this.vel.x = -this.vel.x * 0.6;
    }
  }

  private collideRoom(): void {
    const b = GAME_ROOM;
    if (this.pos.x < b.minX + BALL_R) {
      this.pos.x = b.minX + BALL_R;
      this.vel.x = Math.abs(this.vel.x) * 0.6;
    } else if (this.pos.x > b.maxX - BALL_R) {
      this.pos.x = b.maxX - BALL_R;
      this.vel.x = -Math.abs(this.vel.x) * 0.6;
    }
    if (this.pos.z < b.minZ + BALL_R) {
      this.pos.z = b.minZ + BALL_R;
      this.vel.z = Math.abs(this.vel.z) * 0.6;
    } else if (this.pos.z > b.maxZ - BALL_R) {
      this.pos.z = b.maxZ - BALL_R;
      this.vel.z = -Math.abs(this.vel.z) * 0.6;
    }
  }

  private clank(speed: number): void {
    const now = performance.now();
    if (speed < 0.5 || now - this.lastClank < 90) return;
    this.lastClank = now;
    sound.click();
  }

  private findNet(): THREE.Object3D | null {
    if (this.net) return this.net;
    let root: THREE.Object3D = this.parent;
    while (root.parent) root = root.parent;
    this.net = root.getObjectByName("hoop-net") ?? null;
    return this.net;
  }
}

// ---------------------------------------------------------------------------
// The power meter
// ---------------------------------------------------------------------------

const SWEET_HALF = 0.07;

export class ShotMeter {
  private el: HTMLElement;
  private fill: HTMLElement;
  private needle: HTMLElement;
  private label: HTMLElement;
  private t = 0;
  private power = 0;
  private running = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "shot-meter hidden";
    this.el.innerHTML = `
      <div class="sm-label">🏀 Press <span class="key">E</span> to shoot</div>
      <div class="sm-track">
        <div class="sm-sweet" style="left:${(SWEET - SWEET_HALF) * 100}%;width:${SWEET_HALF * 200}%"></div>
        <div class="sm-fill"></div>
        <div class="sm-needle"></div>
      </div>`;
    this.fill = this.el.querySelector(".sm-fill")!;
    this.needle = this.el.querySelector(".sm-needle")!;
    this.label = this.el.querySelector(".sm-label")!;
    (document.getElementById("hud") ?? document.body).appendChild(this.el);
  }

  get active(): boolean {
    return this.running;
  }

  start(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.t = 0;
    this.power = 0;
    this.running = true;
    this.label.innerHTML = `🏀 Press <span class="key">E</span> to shoot`;
    this.el.classList.remove("hidden", "frozen", "good", "bad");
    this.draw();
  }

  stop(): number {
    if (!this.running) return this.power;
    this.running = false;
    const good = Math.abs(this.power - SWEET) <= SWEET_HALF;
    this.el.classList.add("frozen", good ? "good" : "bad");
    this.label.textContent = good ? "Nice release!" : this.power < SWEET ? "A bit short…" : "Too strong…";
    this.hideTimer = setTimeout(() => this.hide(), 1100);
    return this.power;
  }

  update(dt: number): void {
    if (!this.running) return;
    // A triangle wave, 0 → 1 → 0, a bit over a second each way.
    this.t += dt * 0.85;
    const ph = this.t % 2;
    this.power = ph < 1 ? ph : 2 - ph;
    this.draw();
  }

  hide(): void {
    this.running = false;
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.el.classList.add("hidden");
  }

  private draw(): void {
    const pct = `${(this.power * 100).toFixed(1)}%`;
    this.fill.style.width = pct;
    this.needle.style.left = pct;
  }
}

// ---------------------------------------------------------------------------
// The football
// ---------------------------------------------------------------------------

const SOCCER_R = 0.22;
const PLAYER_R = 0.35;
const PITCH_CENTER = { x: (PITCH.minX + PITCH.maxX) / 2, z: (PITCH.minZ + PITCH.maxZ) / 2 };

export class SoccerBall {
  readonly position = new THREE.Vector3(PITCH_CENTER.x, SOCCER_R, PITCH_CENTER.z);
  private vel = new THREE.Vector3();
  private mesh: THREE.Mesh;
  private resetIn = 0;
  private tmpQ = new THREE.Quaternion();
  private axis = new THREE.Vector3();

  constructor(parent: THREE.Object3D) {
    this.mesh = mesh(
      new THREE.SphereGeometry(SOCCER_R, 24, 16),
      new THREE.MeshToonMaterial({ map: soccerTexture(), gradientMap: toon("#fff").gradientMap }),
    );
    this.mesh.position.copy(this.position);
    parent.add(this.mesh);
  }

  near(x: number, z: number): boolean {
    return Math.hypot(this.position.x - x, this.position.z - z) < 1.3;
  }

  kick(dx: number, dz: number, power: number): void {
    const len = Math.hypot(dx, dz);
    if (len < 1e-6 || this.resetIn > 0) return;
    const p = THREE.MathUtils.clamp(power, 0, 1);
    const speed = 6 + 10 * p;
    this.vel.set((dx / len) * speed, 2 + 2 * p, (dz / len) * speed);
    sound.click();
  }

  update(dt: number, player: { x: number; z: number; vx: number; vz: number }, colliders: Collider[]): "west" | "east" | null {
    if (this.resetIn > 0) {
      this.resetIn -= dt;
      if (this.resetIn <= 0) {
        this.position.set(PITCH_CENTER.x, SOCCER_R, PITCH_CENTER.z);
        this.vel.set(0, 0, 0);
      }
      this.mesh.position.copy(this.position);
      return null;
    }
    const prevX = this.position.x;

    // Dribbling: the player pushes the ball when they touch it.
    const dx = this.position.x - player.x;
    const dz = this.position.z - player.z;
    const d = Math.hypot(dx, dz);
    const contact = PLAYER_R + SOCCER_R;
    if (d < contact && this.position.y < 0.9) {
      const nx = d > 1e-6 ? dx / d : 1;
      const nz = d > 1e-6 ? dz / d : 0;
      this.position.x = player.x + nx * contact;
      this.position.z = player.z + nz * contact;
      const along = player.vx * nx + player.vz * nz;
      const vn = this.vel.x * nx + this.vel.z * nz;
      const want = Math.max(0, along) * 1.35 + 0.8;
      if (vn < want) {
        this.vel.x += nx * (want - vn);
        this.vel.z += nz * (want - vn);
      }
    }

    // Flight and bounce.
    this.vel.y -= G * dt;
    this.position.addScaledVector(this.vel, dt);
    if (this.position.y < SOCCER_R) {
      this.position.y = SOCCER_R;
      this.vel.y = Math.abs(this.vel.y) > 1 ? -this.vel.y * 0.5 : 0;
    }
    if (this.position.y <= SOCCER_R + 0.001) {
      const f = Math.exp(-1.1 * dt);
      this.vel.x *= f;
      this.vel.z *= f;
      if (Math.hypot(this.vel.x, this.vel.z) < 0.03) {
        this.vel.x = 0;
        this.vel.z = 0;
      }
    }

    // Things in the way, and the edges of the world.
    if (this.position.y < 1.2) {
      for (const c of colliders) {
        const minX = c.minX - SOCCER_R;
        const maxX = c.maxX + SOCCER_R;
        const minZ = c.minZ - SOCCER_R;
        const maxZ = c.maxZ + SOCCER_R;
        const p = this.position;
        if (p.x <= minX || p.x >= maxX || p.z <= minZ || p.z >= maxZ) continue;
        const pushes = [p.x - minX, maxX - p.x, p.z - minZ, maxZ - p.z];
        const i = pushes.indexOf(Math.min(...pushes));
        if (i === 0) {
          p.x = minX;
          this.vel.x = -Math.abs(this.vel.x) * 0.6;
        } else if (i === 1) {
          p.x = maxX;
          this.vel.x = Math.abs(this.vel.x) * 0.6;
        } else if (i === 2) {
          p.z = minZ;
          this.vel.z = -Math.abs(this.vel.z) * 0.6;
        } else {
          p.z = maxZ;
          this.vel.z = Math.abs(this.vel.z) * 0.6;
        }
      }
    }
    const b = WORLD_BOUNDS;
    if (this.position.x < b.minX + SOCCER_R) {
      this.position.x = b.minX + SOCCER_R;
      this.vel.x = Math.abs(this.vel.x) * 0.6;
    } else if (this.position.x > b.maxX - SOCCER_R) {
      this.position.x = b.maxX - SOCCER_R;
      this.vel.x = -Math.abs(this.vel.x) * 0.6;
    }
    if (this.position.z < b.minZ + SOCCER_R) {
      this.position.z = b.minZ + SOCCER_R;
      this.vel.z = Math.abs(this.vel.z) * 0.6;
    } else if (this.position.z > b.maxZ - SOCCER_R) {
      this.position.z = b.maxZ - SOCCER_R;
      this.vel.z = -Math.abs(this.vel.z) * 0.6;
    }

    // Roll it by the distance it covered.
    const mx = this.position.x - this.mesh.position.x;
    const mz = this.position.z - this.mesh.position.z;
    const dist = Math.hypot(mx, mz);
    if (dist > 1e-5) {
      this.axis.set(mz, 0, -mx).normalize();
      this.tmpQ.setFromAxisAngle(this.axis, dist / SOCCER_R);
      this.mesh.quaternion.premultiply(this.tmpQ);
    }
    this.mesh.position.copy(this.position);

    // Goal?
    const inMouth = Math.abs(this.position.z - PITCH_CENTER.z) < PITCH.goalWidth / 2 && this.position.y < 2.2;
    if (inMouth && prevX >= PITCH.minX && this.position.x < PITCH.minX) return this.goal("west");
    if (inMouth && prevX <= PITCH.maxX && this.position.x > PITCH.maxX) return this.goal("east");
    return null;
  }

  private goal(side: "west" | "east"): "west" | "east" {
    this.resetIn = 1.5;
    this.vel.multiplyScalar(0.2);
    return side;
  }
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

function ballTexture(color: string, seams: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = color;
  g.fillRect(0, 0, 256, 128);
  g.strokeStyle = seams;
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(0, 64);
  g.lineTo(256, 64);
  for (const x of [64, 192]) {
    g.moveTo(x, 0);
    g.lineTo(x, 128);
  }
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function soccerTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, 512, 256);
  g.fillStyle = "#1d1d1d";
  // Black patches on an equirectangular map: wider apart toward the poles.
  const rows = [
    [128, 5],
    [64, 5],
    [192, 5],
  ] as const;
  rows.forEach(([y, n], ri) => {
    for (let i = 0; i < n; i++) {
      const x = (i / n) * 512 + (ri === 0 ? 0 : 51);
      pentagon(g, x, y, ri === 0 ? 30 : 26, 1.6 / Math.max(0.35, Math.sin((y / 256) * Math.PI)));
    }
  });
  pentagon(g, 256, 8, 40, 6);
  pentagon(g, 256, 248, 40, 6);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function pentagon(g: CanvasRenderingContext2D, x: number, y: number, r: number, stretchX: number): void {
  g.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / 5;
    const px = x + Math.cos(a) * r * Math.min(stretchX, 8) * 0.6;
    const py = y + Math.sin(a) * r;
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.closePath();
  g.fill();
}
