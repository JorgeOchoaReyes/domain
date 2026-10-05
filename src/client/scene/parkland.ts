import * as THREE from "three";
import { CAMPFIRE, DOCK, GARDEN, POND, TRACK } from "../../shared/layout.js";
import { PALETTE, type Collider } from "./office.js";
import { INK, box, mesh, textPlane, toon, toonUnique } from "./toon.js";

/**
 * Out back: a running track (laps are timed), a campfire ringed with logs to
 * sit and work on, a garden you water, and east of the building a pond with
 * a dock to fish from.
 */

export interface Parkland {
  group: THREE.Group;
  colliders: Collider[];
  /** Fishing: the bobber goes out, dips when something bites, comes back. */
  fishing: { cast(): void; bite(): void; reset(): void };
  /** The garden's blooms, 0 (buds) … 1 (in full flower). */
  setBloom(level: number): void;
  update(dt: number, now: number): void;
}

export function buildParkland(): Parkland {
  const group = new THREE.Group();
  const colliders: Collider[] = [];
  const add = (o: THREE.Object3D) => group.add(o);
  const solid = (minX: number, maxX: number, minZ: number, maxZ: number) => colliders.push({ minX, maxX, minZ, maxZ });

  // --- the running track ---------------------------------------------------------------
  const ellipse = (rx: number, rz: number) => {
    const s = new THREE.Shape();
    s.absellipse(0, 0, rx, rz, 0, Math.PI * 2, false, 0);
    return s;
  };
  const outer = ellipse(TRACK.rx + TRACK.width / 2, TRACK.rz + TRACK.width / 2);
  outer.holes.push(ellipse(TRACK.rx - TRACK.width / 2, TRACK.rz - TRACK.width / 2) as unknown as THREE.Path);
  const track = new THREE.Mesh(new THREE.ShapeGeometry(outer, 64), toon("#d9734e"));
  track.rotation.x = -Math.PI / 2;
  track.position.set(TRACK.x, 0.014, TRACK.z);
  track.receiveShadow = true;
  add(track);
  const lane = new THREE.Mesh(
    new THREE.ShapeGeometry(
      (() => {
        const s = ellipse(TRACK.rx + 0.04, TRACK.rz + 0.04);
        s.holes.push(ellipse(TRACK.rx - 0.04, TRACK.rz - 0.04) as unknown as THREE.Path);
        return s;
      })(),
      64,
    ),
    toon("#ffffff"),
  );
  lane.rotation.x = -Math.PI / 2;
  lane.position.set(TRACK.x, 0.018, TRACK.z);
  add(lane);
  // The infield.
  const infield = new THREE.Mesh(new THREE.ShapeGeometry(ellipse(TRACK.rx - TRACK.width / 2, TRACK.rz - TRACK.width / 2), 48), toon("#8fd16f"));
  infield.rotation.x = -Math.PI / 2;
  infield.position.set(TRACK.x, 0.01, TRACK.z);
  add(infield);
  // Start/finish: a line and an arch.
  const sz = TRACK.z + TRACK.rz;
  add(mesh(box(0.25, 0.01, TRACK.width), toon("#ffffff"), TRACK.x, 0.02, sz, false));
  for (const s of [-1, 1]) add(mesh(box(0.14, 2.9, 0.14), toon(INK), TRACK.x, 1.45, sz + s * (TRACK.width / 2 + 0.25)));
  add(mesh(box(0.2, 0.5, TRACK.width + 0.8), toon("#ef476f"), TRACK.x, 2.95, sz));
  const banner = textPlane("🏁 START · FINISH", { bg: "#ef476f", size: 44 });
  banner.position.set(TRACK.x + 0.11, 2.95, sz);
  banner.rotation.y = Math.PI / 2;
  banner.scale.setScalar(0.55);
  add(banner);
  const banner2 = banner.clone();
  banner2.position.x = TRACK.x - 0.11;
  banner2.rotation.y = -Math.PI / 2;
  add(banner2);
  // Cones at the far checkpoints.
  for (const [x, z] of [
    [TRACK.x + TRACK.rx + 1.1, TRACK.z],
    [TRACK.x, TRACK.z - TRACK.rz - 1.1],
    [TRACK.x - TRACK.rx - 1.1, TRACK.z],
  ]) {
    add(mesh(new THREE.ConeGeometry(0.18, 0.45, 12), toon("#ff9f1c"), x, 0.23, z));
  }
  const sign = textPlane("🏃 Run a lap — it's timed", { bg: "#fffaf3", size: 44 });
  sign.position.set(TRACK.x + 3.2, 1.3, sz + 1.6);
  sign.rotation.y = Math.PI;
  sign.scale.setScalar(0.6);
  add(sign);
  add(mesh(box(0.08, 1.1, 0.08), toon(PALETTE.woodDark), TRACK.x + 3.2, 0.55, sz + 1.62, false));

  // --- the campfire --------------------------------------------------------------------
  const C = CAMPFIRE;
  const stones = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.16, 0), toon("#8d99ae"), 12);
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    m4.makeTranslation(C.x + Math.sin(a) * 0.7, 0.1, C.z + Math.cos(a) * 0.7);
    stones.setMatrixAt(i, m4);
  }
  add(stones);
  for (let i = 0; i < 3; i++) {
    const w = mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.8, 6), toon(PALETTE.woodDark), C.x, 0.12, C.z);
    w.rotation.set(Math.PI / 2, (i / 3) * Math.PI, 0.3);
    add(w);
  }
  const flames: THREE.Mesh[] = [];
  for (const [r, h, color, dx] of [
    [0.32, 0.9, "#ff6b35", 0],
    [0.22, 0.7, "#ffb000", 0.08],
    [0.12, 0.5, "#fff3b0", -0.05],
  ] as const) {
    const f = mesh(new THREE.ConeGeometry(r, h, 10), toon(color, { emissive: color }), C.x + dx, 0.15 + h / 2, C.z, false);
    flames.push(f);
    add(f);
  }
  colliders.push({ minX: C.x - 0.75, maxX: C.x + 0.75, minZ: C.z - 0.75, maxZ: C.z + 0.75 });
  // Logs round it, to sit on (the south one is a work spot).
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const lx = C.x + Math.sin(a) * C.logR;
    const lz = C.z + Math.cos(a) * C.logR;
    const log = mesh(new THREE.CylinderGeometry(0.24, 0.26, 1.7, 10), toon("#9c6644"), lx, 0.26, lz);
    log.rotation.z = Math.PI / 2;
    log.rotation.y = a;
    add(log);
  }

  // --- the garden ------------------------------------------------------------------------
  const G = GARDEN;
  const blooms: THREE.Object3D[] = [];
  const bedW = G.maxX - G.minX;
  for (let r = 0; r < 3; r++) {
    const z = G.minZ + 1 + r * 2;
    add(mesh(box(bedW, 0.35, 1.1), toon(PALETTE.woodDark), (G.minX + G.maxX) / 2, 0.17, z));
    add(mesh(box(bedW - 0.15, 0.04, 0.95), toon("#6b4a2b"), (G.minX + G.maxX) / 2, 0.36, z, false));
    solid(G.minX, G.maxX, z - 0.55, z + 0.55);
    for (let i = 0; i < Math.floor(bedW / 0.7); i++) {
      const x = G.minX + 0.4 + i * 0.7;
      const f = new THREE.Group();
      f.position.set(x, 0.36, z + ((i % 2) - 0.5) * 0.3);
      f.add(mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.4, 4), toon("#3f8f45"), 0, 0.2, 0, false));
      const petals = mesh(new THREE.SphereGeometry(0.1, 8, 6), toonUnique(["#ef476f", "#ffd166", "#b388eb", "#ff8fab"][(i + r) % 4]), 0, 0.42, 0, false);
      petals.scale.set(1, 0.6, 1);
      f.add(petals);
      f.add(mesh(new THREE.SphereGeometry(0.04, 6, 4), toon("#ffb000"), 0, 0.46, 0, false));
      blooms.push(f);
      add(f);
    }
  }
  // A watering can and a sign.
  const can = new THREE.Group();
  can.position.set(G.spot.x + 1.2, 0, G.spot.z - 0.3);
  can.add(mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.32, 12), toon("#2a9d8f"), 0, 0.16, 0));
  const spout = mesh(new THREE.CylinderGeometry(0.025, 0.035, 0.38, 6), toon("#2a9d8f"), 0.2, 0.28, 0, false);
  spout.rotation.z = -0.9;
  can.add(spout);
  add(can);
  const gsign = textPlane("🌻 The garden — water it (E)", { bg: "#fffaf3", size: 44 });
  gsign.position.set((G.minX + G.maxX) / 2, 1.2, G.maxZ + 0.3);
  gsign.rotation.y = Math.PI;
  gsign.scale.setScalar(0.6);
  add(gsign);

  // --- the pond and the dock -------------------------------------------------------------
  const P = POND;
  const water = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshToonMaterial({ color: "#4cc9f0", gradientMap: toon("#fff").gradientMap }));
  water.rotation.x = -Math.PI / 2;
  water.scale.set(P.rx, P.rz, 1);
  water.position.set(P.x, 0.02, P.z);
  add(water);
  const shore = new THREE.Mesh(new THREE.RingGeometry(1, 1.12, 48), toon("#c2a878"));
  shore.rotation.x = -Math.PI / 2;
  shore.scale.set(P.rx, P.rz, 1);
  shore.position.set(P.x, 0.016, P.z);
  add(shore);
  for (const [x, z, s] of [
    [33.5, -4.2, 0.5],
    [35.2, 0.6, 0.4],
    [30.4, 1.6, 0.45],
  ]) {
    const pad = mesh(new THREE.CircleGeometry(s, 16, 0.4, Math.PI * 1.8), toon("#5fb760"), x, 0.03, z, false);
    pad.rotation.x = -Math.PI / 2;
    add(pad);
  }
  for (let i = 0; i < 9; i++) {
    const a = 1.2 + i * 0.18;
    add(mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.9, 4), toon("#6a994e"), P.x + Math.cos(a) * P.rx * 0.98, 0.45, P.z + Math.sin(a) * P.rz * 0.98, false));
  }
  // The dock, out over the water from the west bank.
  const dockLen = DOCK.x1 - DOCK.x0;
  add(mesh(box(dockLen, 0.1, DOCK.width), toon(PALETTE.wood), (DOCK.x0 + DOCK.x1) / 2, 0.16, DOCK.z));
  for (let i = 0; i <= dockLen / 0.3; i++) add(mesh(box(0.02, 0.012, DOCK.width), toon(PALETTE.woodDark), DOCK.x0 + i * 0.3, 0.215, DOCK.z, false));
  for (const x of [DOCK.x0 + 0.1, DOCK.x1 - 0.1]) for (const s of [-1, 1]) add(mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.6, 8), toon(PALETTE.woodDark), x, 0.1, DOCK.z + s * (DOCK.width / 2 - 0.05)));
  // The water you can't walk on: east of the dock's end, and either side of it.
  const half = DOCK.width / 2;
  solid(DOCK.x1 + 0.05, P.x + P.rx, P.z - P.rz, P.z + P.rz);
  solid(P.x - P.rx, DOCK.x1 + 0.05, P.z - P.rz * 0.9, DOCK.z - half);
  solid(P.x - P.rx, DOCK.x1 + 0.05, DOCK.z + half, P.z + P.rz * 0.9);
  // A rod leaning on a post, and the bobber (out when you're fishing).
  const rod = mesh(new THREE.CylinderGeometry(0.012, 0.02, 1.8, 5), toon(INK), DOCK.x1 - 0.1, 0.95, DOCK.z + half - 0.05, false);
  rod.rotation.z = -0.5;
  add(rod);
  const bobber = new THREE.Group();
  bobber.add(mesh(new THREE.SphereGeometry(0.07, 10, 8), toon("#ef476f"), 0, 0.05, 0, false));
  bobber.add(mesh(new THREE.SphereGeometry(0.07, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2), toon("#ffffff"), 0, 0.06, 0, false));
  bobber.position.set(DOCK.x1 + 2.4, 0.02, DOCK.z);
  bobber.visible = false;
  add(bobber);
  const fsign = textPlane("🎣 Fishing dock", { bg: "#fffaf3", size: 44 });
  fsign.position.set(DOCK.x0 - 0.3, 1.25, DOCK.z + 1.1);
  fsign.rotation.y = -Math.PI / 2;
  fsign.scale.setScalar(0.6);
  add(fsign);
  add(mesh(box(0.08, 1.0, 0.08), toon(PALETTE.woodDark), DOCK.x0 - 0.32, 0.5, DOCK.z + 1.1, false));

  let biting = 0;
  let bloom = 0.3;
  const applyBloom = () => {
    blooms.forEach((b, i) => {
      const k = Math.max(0.15, Math.min(1, bloom * 1.15 - (i % 5) * 0.04));
      b.scale.setScalar(0.45 + k * 0.75);
    });
  };
  applyBloom();
  return {
    group,
    colliders,
    fishing: {
      cast() {
        bobber.visible = true;
        biting = 0;
      },
      bite() {
        biting = 1;
      },
      reset() {
        bobber.visible = false;
        biting = 0;
      },
    },
    setBloom(level) {
      bloom = Math.max(0, Math.min(1, level));
      applyBloom();
    },
    update(dt, now) {
      const t = now / 1000;
      flames.forEach((f, i) => {
        const k = 1 + Math.sin(t * (9 + i * 3) + i) * 0.12 + Math.sin(t * 23 + i * 2) * 0.05;
        f.scale.set(1 / Math.sqrt(k), k, 1 / Math.sqrt(k));
        f.rotation.y += dt * (i + 1);
      });
      if (bobber.visible) bobber.position.y = biting ? 0.02 - 0.06 * Math.abs(Math.sin(t * 16)) : 0.02 + Math.sin(t * 2.4) * 0.015;
    },
  };
}
