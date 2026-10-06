import * as THREE from "three";
import { STREET, WORLD_BOUNDS } from "../../shared/layout.js";
import type { Collider } from "./office.js";
import { box, mesh, roundedBox, toon } from "./toon.js";

/**
 * The cars parked on the street out front — and you can drive them. Walk up
 * to one and press E: W/S is gas and brake (or reverse), A/D steers, Space is
 * the handbrake, E gets you out. They bump off walls, trees and each other,
 * and stay wherever you leave them. A car's front is +x: at heading h it
 * points along (cos h, -sin h), which is what rotation.y = h does to +x.
 */

export interface Car {
  root: THREE.Group;
  x: number;
  z: number;
  heading: number;
  /** Speed along its heading (m/s; negative is reversing). */
  v: number;
  /** Where the front wheels point (radians, + is left). */
  steer: number;
  /** Its footprint, kept up to date as it moves (in the world's colliders). */
  collider: Collider;
  wheels: THREE.Mesh[];
  front: THREE.Object3D[];
}

export interface DriveInput {
  /** +1 gas, -1 brake / reverse. */
  throttle: number;
  /** +1 left, -1 right. */
  steer: number;
  handbrake: boolean;
}

const HALF_L = 1.85;
const HALF_W = 0.9;
const WHEELBASE = 2.3;
const MAX_FWD = 15;
const MAX_REV = 5;
const ACCEL = 8;
const BRAKE = 16;
const MAX_STEER = 0.55;

export function buildCars(): { group: THREE.Group; cars: Car[]; colliders: Collider[] } {
  const group = new THREE.Group();
  const spots: [number, number, string, number][] = [
    [-30, STREET.minZ + 1.5, "#ef476f", 0],
    [-15, STREET.minZ + 1.5, "#ffd166", 0],
    [16, STREET.minZ + 1.5, "#5bc0eb", 0],
    [31, STREET.minZ + 1.5, "#9bc53d", 0],
    [-22, STREET.maxZ - 1.5, "#b388eb", Math.PI],
    [9, STREET.maxZ - 1.5, "#ff8a5b", Math.PI],
  ];
  const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.26, 14).rotateX(Math.PI / 2);
  const wheelMat = toon("#1b1d2e");
  const hubMat = toon("#c9ced8");
  const hubGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.28, 8).rotateX(Math.PI / 2);
  const glassMat = toon("#bfe3ff");
  const lightMat = toon("#fff7d6", { emissive: "#ffe08a" });
  const tailMat = toon("#ff5d73", { emissive: "#c9184a" });
  const cars: Car[] = [];
  for (const [x, z, color, heading] of spots) {
    const root = new THREE.Group();
    const paint = toon(color);
    root.add(mesh(roundedBox(3.6, 0.75, 1.7, 0.3), paint, 0, 0.72, 0));
    root.add(mesh(roundedBox(2.0, 0.62, 1.5, 0.28), paint, -0.2, 1.36, 0));
    root.add(mesh(box(1.7, 0.42, 1.54), glassMat, -0.2, 1.38, 0, false));
    root.add(mesh(box(0.06, 0.16, 0.36), lightMat, 1.8, 0.8, 0.5, false));
    root.add(mesh(box(0.06, 0.16, 0.36), lightMat, 1.8, 0.8, -0.5, false));
    root.add(mesh(box(0.06, 0.14, 0.3), tailMat, -1.8, 0.82, 0.55, false));
    root.add(mesh(box(0.06, 0.14, 0.3), tailMat, -1.8, 0.82, -0.55, false));
    const wheels: THREE.Mesh[] = [];
    const front: THREE.Object3D[] = [];
    for (const sx of [-1.15, 1.15])
      for (const sz of [-0.82, 0.82]) {
        // Each wheel turns about its own axle; the front pair also steers.
        const holder = new THREE.Group();
        holder.position.set(sx, 0.36, sz);
        const w = mesh(wheelGeo, wheelMat, 0, 0, 0);
        w.add(mesh(hubGeo, hubMat, 0, 0, 0, false));
        holder.add(w);
        root.add(holder);
        wheels.push(w);
        if (sx > 0) front.push(holder);
      }
    group.add(root);
    const car: Car = { root, x, z, heading, v: 0, steer: 0, collider: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 }, wheels, front };
    place(car);
    cars.push(car);
  }
  return { group, cars, colliders: cars.map((c) => c.collider) };
}

/** Put the car's model and footprint where the car is. */
function place(c: Car): void {
  c.root.position.set(c.x, 0, c.z);
  c.root.rotation.y = c.heading;
  const cos = Math.abs(Math.cos(c.heading));
  const sin = Math.abs(Math.sin(c.heading));
  const hx = HALF_L * cos + HALF_W * sin;
  const hz = HALF_L * sin + HALF_W * cos;
  Object.assign(c.collider, { minX: c.x - hx, maxX: c.x + hx, minZ: c.z - hz, maxZ: c.z + hz });
}

/** The parked car you're close enough to get into, if any (by its door, not its bumper). */
export function carNear(cars: Car[], x: number, z: number, reach = 2.6): Car | null {
  let best: Car | null = null;
  let bestD = reach;
  for (const c of cars) {
    const d = Math.hypot(c.x - x, c.z - z);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/**
 * Drive for one frame. `others` are everything it can hit (walls, trees,
 * other cars — not itself). Returns how hard it hit something (m/s), 0 if
 * it didn't.
 */
export function drive(c: Car, input: DriveInput, dt: number, others: Collider[]): number {
  // Gas, brake, reverse, and rolling to a stop.
  if (input.throttle > 0) c.v += (c.v < 0 ? BRAKE : ACCEL) * input.throttle * dt;
  else if (input.throttle < 0) c.v += (c.v > 0.3 ? -BRAKE : -ACCEL * 0.6) * -input.throttle * dt;
  else c.v -= Math.sign(c.v) * Math.min(Math.abs(c.v), 2.2 * dt);
  if (input.handbrake) c.v -= Math.sign(c.v) * Math.min(Math.abs(c.v), 22 * dt);
  c.v = THREE.MathUtils.clamp(c.v, -MAX_REV, MAX_FWD);
  // Steering eases toward the keys, and turns less the faster you go.
  const want = input.steer * MAX_STEER * (1 - 0.45 * Math.min(1, Math.abs(c.v) / MAX_FWD));
  c.steer += (want - c.steer) * (1 - Math.exp(-8 * dt));

  const heading = c.heading + ((c.v / WHEELBASE) * Math.tan(c.steer) + (input.handbrake ? Math.sign(c.v) * input.steer * 0.6 : 0)) * dt;
  const x = c.x + Math.cos(heading) * c.v * dt;
  const z = c.z - Math.sin(heading) * c.v * dt;
  let hit = 0;
  if (blocked(x, z, heading, others)) {
    hit = Math.abs(c.v);
    // A bump: bounce back a little and stop.
    c.v = -c.v * 0.2;
  } else {
    c.x = x;
    c.z = z;
    c.heading = heading;
  }
  // The wheels roll with the road and the front pair shows the steering.
  for (const w of c.wheels) w.rotation.z -= (c.v * dt) / 0.36;
  for (const f of c.front) f.rotation.y = c.steer;
  place(c);
  return hit;
}

/** Whether a car at (x, z, heading) would overlap anything, or leave the world. */
export function blocked(x: number, z: number, heading: number, others: Collider[]): boolean {
  const b = WORLD_BOUNDS;
  const fx = Math.cos(heading);
  const fz = -Math.sin(heading);
  // Three circles down its length cover it well enough.
  for (const along of [-1.15, 0, 1.15]) {
    const px = x + fx * along;
    const pz = z + fz * along;
    const r = 0.9;
    if (px - r < b.minX || px + r > b.maxX || pz - r < b.minZ || pz + r > b.maxZ) return true;
    for (const c of others) {
      const cx = THREE.MathUtils.clamp(px, c.minX, c.maxX);
      const cz = THREE.MathUtils.clamp(pz, c.minZ, c.maxZ);
      if ((px - cx) ** 2 + (pz - cz) ** 2 < r * r) return true;
    }
  }
  return false;
}

/** Where you get out: beside the driver's door, or the other side if that's blocked. */
export function exitSpot(c: Car): { x: number; z: number }[] {
  const lx = -Math.sin(c.heading);
  const lz = -Math.cos(c.heading);
  return [1, -1, 0].map((side) =>
    side === 0 ? { x: c.x - Math.cos(c.heading) * 2.6, z: c.z + Math.sin(c.heading) * 2.6 } : { x: c.x + lx * side * 1.7, z: c.z + lz * side * 1.7 },
  );
}
