import * as THREE from "three";
import type { World } from "./world.js";
import type { Car } from "./cars.js";
import { DEFAULT_SETTINGS, type Settings } from "../ui/settings.js";

/**
 * Local player controller: WASD movement relative to where you're looking,
 * Shift to sprint, Space to jump, and two views — an orbit camera behind you
 * (drag to orbit, scroll to zoom) or first person (drag to look). Scroll all
 * the way in to go first person and back out to leave it; V toggles too.
 * It mutates the world's player group and camera each frame. It owns no state
 * the server needs beyond the transform, which main.ts reads to send
 * presence updates.
 */

export type ViewMode = "third" | "first";

const WALK = 5.5;
/** Eye height sitting in a chair. */
const SEATED_EYE = 1.12;
/** How much faster the skateboard is than walking. */
const BOARD_SPEED = 2.1;
const JUMP_V = 5.4;
const GRAVITY = 17;
const EYE = 1.48;
const MIN_DIST = 3.2;

export class Player {
  private keys = new Set<string>();
  /** Which way you look: the orbit angle in third person, your heading in first (forward is -sin, -cos). */
  private yaw = Math.PI;
  /** Third person: 0 = level, up to ~1.3 looking down. */
  private pitch = 0.5;
  /** First person: + looks up, - looks down. */
  private lookPitch = 0;
  private distance = 7.5;
  private mode: ViewMode = "third";

  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  private vy = 0;
  /** Your ground velocity (m/s), eased toward what the keys ask for. */
  private vel = { x: 0, z: 0 };
  /** The third-person camera's current distance (eases back out after a wall). */
  private camDist = 7.5;
  private locked = false;
  /** Called when the mouse is captured or let go (first-person look). */
  onLock: ((locked: boolean) => void) | null = null;
  private bobT = 0;
  private bob = 0;

  /** When false, movement keys are ignored (e.g. a menu is open). */
  enabled = true;
  /** Extra speed (a coffee), as a multiplier, until a time (ms since epoch). */
  private boost = { k: 1, until: 0 };
  /** How fast you moved last frame (m/s), for kicking balls about. */
  readonly velocity = { x: 0, z: 0 };
  /** Called on each footstep and on landing from a jump (for sounds). */
  onStep: ((kind: "step" | "land") => void) | null = null;
  /** Called when the view changes (to show the crosshair, save the choice). */
  onView: ((mode: ViewMode) => void) | null = null;

  private tmp = new THREE.Vector3();
  private settings: Settings = { ...DEFAULT_SETTINGS };
  /** How fast you're going right now (m/s). */
  speed = 0;
  /** In VR: the headset places the camera, the thumbstick walks you. */
  xr = false;
  /** On the skateboard (B): about twice as fast, and you glide. */
  board = false;
  /** The car you're driving: the keys drive it, the camera follows. */
  driving: Car | null = null;
  /** The view you had before you got in (you drive in third person). */
  private viewBeforeCar: ViewMode | null = null;
  /** Called when the car you're driving hits something, with how hard (m/s). */
  onCrash: ((speed: number) => void) | null = null;
  /** Sitting (your chair in office hours): you don't move until you stand up. */
  private seated = false;
  /** Called when you stand up from a chair (any move key). */
  onStand: (() => void) | null = null;
  /** A thumbstick: x right, y forward (-1..1). */
  readonly stick = { x: 0, y: 0 };
  /** In VR, which way your head faces (moves go that way); null: where you look. */
  heading: number | null = null;

  constructor(
    private world: World,
    private dom: HTMLElement,
    mode: ViewMode = "third",
  ) {
    this.bind();
    this.setView(mode);
  }

  get view(): ViewMode {
    return this.mode;
  }

  setView(mode: ViewMode): void {
    // You drive in third person (from inside, the car's roof is all you'd see).
    if (this.driving && mode === "first") return;
    this.mode = mode;
    if (mode === "first") this.lookPitch = 0;
    else this.distance = Math.max(this.distance, 5.5);
    this.world.setFirstPerson(mode === "first");
    this.updateCamera();
    this.onView?.(mode);
  }

  /** Speeds, mouse feel, field of view, head bob. */
  applySettings(s: Settings): void {
    this.settings = { ...s };
    this.world.camera.fov = s.fov;
    this.world.camera.updateProjectionMatrix();
  }

  toggleView(): void {
    this.setView(this.mode === "first" ? "third" : "first");
  }

  /** Move faster for a while (a coffee from the kitchen). */
  boostFor(ms: number, k = 1.35): void {
    this.boost = { k, until: Date.now() + ms };
  }

  get boosted(): number {
    return Math.max(0, this.boost.until - Date.now());
  }

  private bind(): void {
    // Keys are tracked by their physical position (KeyW, ShiftLeft…), so Shift,
    // Caps Lock or a non-QWERTY layout never leaves one "stuck".
    window.addEventListener("keydown", (e) => {
      if (isEditable(e.target)) return;
      this.keys.add(e.code);
      if (e.code === "Space" && this.enabled) {
        e.preventDefault();
        if (!e.repeat) this.jump();
      }
    });
    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.code);
    });
    // Dropping key state on blur avoids "stuck" movement after tab switches.
    window.addEventListener("blur", () => this.keys.clear());

    // Like Minecraft: click the view to capture the mouse — it hides, moving
    // it turns the view (in either camera), clicking uses things. Tab, Ctrl or
    // Esc let it go to use the menus. Without capture you can still drag to look.
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.dom;
      this.onLock?.(this.locked);
    });
    document.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      // Some browsers report a huge jump on the first event after capture.
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.look(e.movementX, e.movementY, this.mode === "first" ? 0.0022 : 0.003);
    });

    this.dom.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement)?.closest(".interactive")) return;
      if (this.enabled && !this.locked && e.button === 0) {
        this.lock();
        return;
      }
      if (this.locked) return;
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.dom.setPointerCapture(e.pointerId);
    });
    this.dom.addEventListener("pointermove", (e) => {
      if (!this.dragging || this.locked) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.look(dx, dy, this.mode === "first" ? 0.004 : 0.005);
    });
    const endDrag = (e: PointerEvent) => {
      this.dragging = false;
      try {
        this.dom.releasePointerCapture(e.pointerId);
      } catch {
        /* capture may already be gone */
      }
    };
    this.dom.addEventListener("pointerup", endDrag);
    this.dom.addEventListener("pointercancel", endDrag);
    this.dom.addEventListener(
      "wheel",
      (e) => {
        const dir = Math.sign(e.deltaY);
        if (this.mode === "first") {
          if (dir > 0) {
            this.distance = MIN_DIST + 0.8;
            this.pitch = 0.35;
            this.setView("third");
          }
          return;
        }
        if (dir < 0 && this.distance <= MIN_DIST) {
          this.setView("first");
          return;
        }
        this.distance = THREE.MathUtils.clamp(this.distance + dir * 0.8, MIN_DIST, 18);
      },
      { passive: true },
    );
  }

  /** Turn the view by a mouse movement. */
  private look(dx: number, dy: number, k: number): void {
    const s = k * this.settings.sensitivity;
    const vy = this.settings.invertY ? -dy : dy;
    this.yaw -= dx * s;
    if (this.mode === "first") this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - vy * s, -1.45, 1.45);
    else this.pitch = THREE.MathUtils.clamp(this.pitch + vy * s, 0.08, 1.3);
  }

  /** Capture the mouse for first-person look. */
  lock(): void {
    try {
      const p = this.dom.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {});
    } catch {
      /* not allowed here (e.g. no user gesture) */
    }
  }

  /** Let the mouse go (a window opened). */
  unlock(): void {
    if (this.locked) document.exitPointerLock();
  }

  private jump(): void {
    if (this.driving || this.world.player.position.y > 0.01) return;
    this.vy = JUMP_V;
  }

  /** Advance one frame. dt is in seconds. Returns true if the transform moved. */
  update(dt: number): boolean {
    if (this.driving) return this.updateDriving(this.driving, dt);
    const group = this.world.player;
    let moved = false;

    // What you're asking for: a direction relative to where you look, at walk
    // or sprint speed.
    let wantX = 0;
    let wantZ = 0;
    if (this.enabled) {
      let f = (this.has("KeyW") || this.has("ArrowUp") ? 1 : 0) - (this.has("KeyS") || this.has("ArrowDown") ? 1 : 0);
      let r = (this.has("KeyD") || this.has("ArrowRight") ? 1 : 0) - (this.has("KeyA") || this.has("ArrowLeft") ? 1 : 0);
      // A thumbstick walks as far as it's pushed (past a small dead zone).
      const push = Math.hypot(this.stick.x, this.stick.y);
      let throttle = 1;
      if (f === 0 && r === 0 && push > 0.15) {
        f = this.stick.y;
        r = this.stick.x;
        throttle = Math.min(1, (push - 0.15) / 0.75);
      }
      // Trying to walk while seated: stand up first (this frame you just get up).
      if (this.seated && (f !== 0 || r !== 0)) {
        this.standUp();
        f = r = 0;
      }
      if (f !== 0 || r !== 0) {
        const yaw = this.heading ?? this.yaw;
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);
        let mx = fx * f + Math.cos(yaw) * r;
        let mz = fz * f - Math.sin(yaw) * r;
        const len = Math.hypot(mx, mz);
        mx /= len;
        mz /= len;
        const sprint = this.has("ShiftLeft") || this.has("ShiftRight");
        const speed = WALK * this.settings.walk * (sprint ? this.settings.sprint : 1) * (Date.now() < this.boost.until ? this.boost.k : 1) * throttle * (this.board ? BOARD_SPEED : 1);
        wantX = mx * speed;
        wantZ = mz * speed;
      }
    }

    // Ease toward it: quick to get going, quicker to stop, a little floatier
    // in the air. Frame-rate independent.
    const going = wantX !== 0 || wantZ !== 0;
    const airborne = group.position.y > 0;
    // On the board: pushing off takes a moment, and you roll on when you let go.
    const rate = airborne ? 6 : this.board ? (going ? 3.2 : 1.4) : going ? 16 : 22;
    const k = 1 - Math.exp(-rate * dt);
    this.vel.x += (wantX - this.vel.x) * k;
    this.vel.z += (wantZ - this.vel.z) * k;
    if (!going && Math.hypot(this.vel.x, this.vel.z) < 0.05) this.vel.x = this.vel.z = 0;

    const ox = group.position.x;
    const oz = group.position.z;
    if (this.vel.x !== 0 || this.vel.z !== 0) {
      // Step in small pieces so fast movement slides cleanly along walls.
      const steps = Math.max(1, Math.ceil((Math.hypot(this.vel.x, this.vel.z) * dt) / 0.12));
      let x = ox;
      let z = oz;
      for (let i = 0; i < steps; i++) [x, z] = this.world.resolveCollision(x + (this.vel.x * dt) / steps, z + (this.vel.z * dt) / steps);
      group.position.x = x;
      group.position.z = z;
      // Whatever a wall took away is gone from your velocity too (no sticking).
      const inv = 1 / Math.max(dt, 1e-3);
      this.vel.x = (x - ox) * inv;
      this.vel.z = (z - oz) * inv;
      if (x !== ox || z !== oz) moved = true;
    }
    this.velocity.x = this.vel.x;
    this.velocity.z = this.vel.z;
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    const stepBefore = Math.floor(this.bobT / Math.PI);
    this.bobT += dt * this.speed * 2.1;
    // A footstep at each low point of the stride.
    if (Math.floor(this.bobT / Math.PI) !== stepBefore && this.speed > 1 && group.position.y === 0) this.onStep?.("step");

    // Facing: in first person, where you look; in third, turn smoothly toward
    // where you're heading.
    if (this.xr) group.rotation.y = (this.heading ?? this.yaw) + Math.PI;
    else if (this.mode === "first") group.rotation.y = this.yaw + Math.PI;
    else if (this.speed > 0.4) {
      const target = Math.atan2(this.vel.x, this.vel.z);
      const d = Math.atan2(Math.sin(target - group.rotation.y), Math.cos(target - group.rotation.y));
      group.rotation.y += d * (1 - Math.exp(-18 * dt));
    }

    // Jumping.
    if (group.position.y > 0 || this.vy > 0) {
      this.vy -= GRAVITY * dt;
      group.position.y = Math.max(0, group.position.y + this.vy * dt);
      if (group.position.y === 0) {
        if (this.vy < -2) this.onStep?.("land");
        this.vy = 0;
      }
      moved = true;
    }

    const bobbing = this.speed > 0.5 && group.position.y === 0 && this.settings.headBob && !this.board;
    this.bob = THREE.MathUtils.lerp(this.bob, bobbing ? Math.sin(this.bobT) * 0.04 * Math.min(1, this.speed / 5) : 0, Math.min(1, dt * 12));
    this.updateCamera(dt);
    return moved;
  }

  /** At the wheel: the keys drive the car, you ride in it, and the camera swings round behind it. */
  private updateDriving(car: Car, dt: number): boolean {
    const on = this.enabled;
    const throttle = on ? (this.has("KeyW") || this.has("ArrowUp") ? 1 : 0) - (this.has("KeyS") || this.has("ArrowDown") ? 1 : 0) || this.stick.y : 0;
    const steer = on ? (this.has("KeyA") || this.has("ArrowLeft") ? 1 : 0) - (this.has("KeyD") || this.has("ArrowRight") ? 1 : 0) || -this.stick.x : 0;
    const before = { x: car.x, z: car.z, h: car.heading };
    const hit = this.world.driveCar(car, { throttle, steer, handbrake: on && this.has("Space") }, dt);
    if (hit > 2) this.onCrash?.(hit);
    const group = this.world.player;
    group.position.set(car.x, 0, car.z);
    group.rotation.y = car.heading + Math.PI / 2;
    this.vel.x = this.velocity.x = Math.cos(car.heading) * car.v;
    this.vel.z = this.velocity.z = -Math.sin(car.heading) * car.v;
    this.speed = Math.abs(car.v);
    // The camera eases round behind the car (behind is yaw = heading - 90°), unless you're dragging it.
    if (!this.dragging) {
      const want = car.heading - Math.PI / 2;
      const d = Math.atan2(Math.sin(want - this.yaw), Math.cos(want - this.yaw));
      this.yaw += d * (1 - Math.exp(-(1.5 + this.speed * 0.25) * dt));
      this.pitch += (0.32 - this.pitch) * (1 - Math.exp(-2 * dt));
    }
    this.distance += (9 - this.distance) * (1 - Math.exp(-3 * dt));
    this.bob = 0;
    this.updateCamera(dt);
    return car.x !== before.x || car.z !== before.z || car.heading !== before.h;
  }

  private updateCamera(dt = 0): void {
    // In VR the headset is the camera.
    if (this.xr) return;
    const p = this.world.player.position;
    const cam = this.world.camera;
    if (this.mode === "first") {
      const eye = this.seated ? SEATED_EYE : EYE;
      cam.position.set(p.x, p.y + eye + this.bob, p.z);
      const cp = Math.cos(this.lookPitch);
      this.tmp.set(p.x - Math.sin(this.yaw) * cp, p.y + eye + this.bob + Math.sin(this.lookPitch), p.z - Math.cos(this.yaw) * cp);
      cam.lookAt(this.tmp);
      return;
    }
    // The camera sits on a boom behind your head. Walk it out from your head
    // in 3D and stop short of the first wall, the wall over a door, or the
    // ceiling — so it can never end up on the far side of anything. It comes
    // in at once and eases back out, so it never lurches.
    const cp = Math.cos(this.pitch);
    const hx = p.x;
    const hy = p.y + 1.3;
    const hz = p.z;
    const dx = Math.sin(this.yaw) * cp;
    const dy = Math.sin(this.pitch);
    const dz = Math.cos(this.yaw) * cp;
    let room = this.distance;
    for (let d = 0.2; d <= this.distance; d += 0.1) {
      if (this.world.cameraBlocked(hx + dx * d, hy + dy * d, hz + dz * d)) {
        room = Math.max(0.15, d - 0.15);
        break;
      }
    }
    if (dt === 0 || room < this.camDist) this.camDist = room;
    else this.camDist += (room - this.camDist) * (1 - Math.exp(-6 * dt));
    const dist = this.camDist;
    const b = this.world.bounds;
    cam.position.set(
      THREE.MathUtils.clamp(hx + dx * dist, b.minX, b.maxX),
      hy + dy * dist,
      THREE.MathUtils.clamp(hz + dz * dist, b.minZ, b.maxZ),
    );
    this.tmp.set(hx, hy, hz);
    cam.lookAt(this.tmp);
    // Right up behind you, your own head would fill the view: hide it.
    this.world.setSelfHidden(dist < 1.1);
  }

  /** Get in a car and take the wheel (in third person, the camera behind it). */
  startDriving(car: Car): void {
    if (this.seated) this.standUp();
    this.board = false;
    this.world.setBoard(false);
    this.driving = car;
    this.vy = 0;
    this.world.player.position.y = 0;
    this.viewBeforeCar = this.mode;
    if (this.mode !== "third") this.setView("third");
    this.world.setInCar(true);
  }

  /** Get out of the car, at (x, z) beside it (or just leave it, when you're being moved anyway). */
  stopDriving(at?: { x: number; z: number }): void {
    const car = this.driving;
    if (!car) return;
    car.v = 0;
    this.driving = null;
    this.world.setInCar(false);
    this.vel.x = this.vel.z = 0;
    if (at) this.world.player.position.set(at.x, 0, at.z);
    if (this.viewBeforeCar && this.viewBeforeCar !== this.mode) this.setView(this.viewBeforeCar);
    this.viewBeforeCar = null;
  }

  /** Put the avatar at (x, z) facing `facing`, looking the same way. */
  placeAt(x: number, z: number, facing: number): void {
    this.stopDriving();
    this.world.player.position.set(x, 0, z);
    this.world.player.rotation.y = facing;
    this.vy = 0;
    this.vel.x = this.vel.z = 0;
    this.yaw = facing + Math.PI;
    this.lookPitch = 0;
    this.updateCamera();
  }

  /** Sit at (x, z) facing `facing`: the view drops to seated height, and any move key stands you up. */
  sit(x: number, z: number, facing: number, pitch = -0.05): void {
    this.placeAt(x, z, facing);
    this.seated = true;
    this.lookPitch = pitch;
    this.updateCamera();
  }

  get sitting(): boolean {
    return this.seated;
  }

  standUp(): void {
    if (!this.seated) return;
    this.seated = false;
    this.onStand?.();
  }

  /** Turn on the spot (VR snap turning). */
  turn(rad: number): void {
    this.yaw += rad;
  }

  get mouseCaptured(): boolean {
    return this.locked;
  }

  /** Your heading, for the first-person hand. */
  get yawAngle(): number {
    return this.yaw;
  }

  /** Where you're looking, flat on the floor (unit vector). */
  get lookDir(): { x: number; z: number } {
    return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) };
  }

  get facing(): number {
    return this.world.player.rotation.y;
  }

  get position(): THREE.Vector3 {
    return this.world.player.position;
  }

  /** The arrow keys are for something else right now (the monitor wall's cameras): they don't walk. */
  arrowsTaken = false;

  private has(key: string): boolean {
    if (this.arrowsTaken && key.startsWith("Arrow")) return false;
    return this.keys.has(key);
  }
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable === true;
}
