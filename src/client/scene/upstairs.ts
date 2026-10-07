import * as THREE from "three";
import { UP, UP_ELEVATOR, UP_HEIGHT, UP_SPLITS_X, UP_SPLIT_GAP, UPSTAIRS, WALL_T, type Box3D } from "../../shared/layout.js";
import { PALETTE, chair, pendantAt, plant, type Collider } from "./office.js";
import { INK, box, mesh, noOutline, roundedBox, textPlane, toon } from "./toon.js";

/**
 * Floor 2, up the elevator: a library (bookshelves, armchairs to work in), a
 * lounge (a sofa, a piano, darts, a vending machine) and a gym (treadmills,
 * yoga mats, a telescope at the window). It's built off to the east of the
 * campus and walled in; its south and east walls are glass with the city
 * outside, a little below — you're upstairs.
 */

export interface Upstairs {
  group: THREE.Group;
  colliders: Collider[];
  occluders: Box3D[];
  /** Which treadmill is running (null: none). */
  setTreadmill(i: number | null): void;
  update(dt: number): void;
}

const T = WALL_T;
const H = UP_HEIGHT;

export function buildUpstairs(): Upstairs {
  const group = new THREE.Group();
  const colliders: Collider[] = [];
  const occluders: Box3D[] = [];
  const add = (o: THREE.Object3D) => group.add(o);
  const solid = (x: number, z: number, hw: number, hd: number, tall = false) =>
    colliders.push({ minX: x - hw, maxX: x + hw, minZ: z - hd, maxZ: z + hd, ...(tall ? { tall: true } : {}) });
  const U = UPSTAIRS;

  // --- floors, ceiling ---------------------------------------------------------------
  const floorPlane = (minX: number, maxX: number, color: string) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(maxX - minX, U.maxZ - U.minZ), toon(color));
    m.rotation.x = -Math.PI / 2;
    m.position.set((minX + maxX) / 2, 0.002, (U.minZ + U.maxZ) / 2);
    m.receiveShadow = true;
    add(m);
  };
  floorPlane(U.minX, UP_SPLITS_X[0], "#b98257");
  floorPlane(UP_SPLITS_X[0], UP_SPLITS_X[1], "#e8d5c0");
  floorPlane(UP_SPLITS_X[1], U.maxX, "#7d8aa3");
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(U.maxX - U.minX, U.maxZ - U.minZ), new THREE.MeshBasicMaterial({ color: PALETTE.ceiling }));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set((U.minX + U.maxX) / 2, H, (U.minZ + U.maxZ) / 2);
  add(ceil);
  occluders.push({ minX: U.minX - T, maxX: U.maxX + T, minZ: U.minZ - T, maxZ: U.maxZ + T, minY: H, maxY: H + 0.5 });

  // --- walls: solid north and west, glass south and east ---------------------------
  const wallMat = toon(PALETTE.wall);
  const trimMat = toon(PALETTE.trim);
  const wall = (minX: number, maxX: number, minZ: number, maxZ: number) => {
    add(mesh(box(maxX - minX, H, maxZ - minZ), wallMat, (minX + maxX) / 2, H / 2, (minZ + maxZ) / 2, false));
    colliders.push({ minX, maxX, minZ, maxZ, tall: true });
    occluders.push({ minX, maxX, minZ, maxZ, minY: 0, maxY: H });
  };
  wall(U.minX - T, U.maxX + T, U.minZ - T, U.minZ);
  wall(U.minX - T, U.minX, U.minZ, U.maxZ);
  const glassWall = (minX: number, maxX: number, minZ: number, maxZ: number, alongX: boolean) => {
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const len = alongX ? maxX - minX : maxZ - minZ;
    const w = alongX ? len : maxX - minX;
    const d = alongX ? maxZ - minZ : len;
    // Sill and header, glass between, mullions every 3 m.
    add(mesh(box(w, 0.8, d), wallMat, cx, 0.4, cz, false));
    add(mesh(box(w, H - 3.5, d), wallMat, cx, (H + 3.5) / 2, cz, false));
    add(mesh(box(alongX ? w : w + 0.06, 0.08, alongX ? d + 0.06 : d), trimMat, cx, 0.82, cz, false));
    const glass = new THREE.Mesh(box(alongX ? w : 0.04, 2.7, alongX ? 0.04 : d), new THREE.MeshBasicMaterial({ color: "#cfeaff", transparent: true, opacity: 0.18 }));
    glass.position.set(cx, 2.15, cz);
    add(glass);
    for (let u = 0; u <= len; u += 3) {
      const x = alongX ? minX + u : cx;
      const z = alongX ? cz : minZ + u;
      add(mesh(box(0.12, 2.7, 0.12), toon("#3d405b"), x, 2.15, z, false));
    }
    colliders.push({ minX, maxX, minZ, maxZ, tall: true });
    occluders.push({ minX, maxX, minZ, maxZ, minY: 0, maxY: 0.8 });
    occluders.push({ minX, maxX, minZ, maxZ, minY: 3.5, maxY: H });
  };
  glassWall(U.minX - T, U.maxX + T, U.maxZ, U.maxZ + T, true);
  glassWall(U.maxX, U.maxX + T, U.minZ, U.maxZ, false);

  // The city outside, a floor below: towers against the sky, south and east.
  add(skyline(U.minX - 30, U.maxX + 30, U.maxZ + 16, 0));
  add(skyline(U.minZ - 30, U.maxZ + 30, U.maxX + 16, Math.PI / 2));

  // Low bookcases between the areas, with a gap to walk through.
  for (const x of UP_SPLITS_X) {
    for (const [z0, z1] of [
      [U.minZ, UP_SPLIT_GAP.z0],
      [UP_SPLIT_GAP.z1, U.maxZ],
    ] as const) {
      add(bookcase(z1 - z0, 1.3, x, (z0 + z1) / 2, Math.PI / 2));
      solid(x, (z0 + z1) / 2, 0.25, (z1 - z0) / 2);
    }
  }

  // Signs over each area.
  for (const [text, x] of [
    ["📚 Library — quiet, please", (U.minX + UP_SPLITS_X[0]) / 2],
    ["🎹 Lounge", (UP_SPLITS_X[0] + UP_SPLITS_X[1]) / 2 - 3.6],
    ["🏋️ Gym", (UP_SPLITS_X[1] + U.maxX) / 2],
  ] as const) {
    const s = textPlane(text, { bg: "#fffaf3", size: 56 });
    s.position.set(x, 3.4, U.minZ + 0.06);
    add(s);
  }

  // --- the elevator --------------------------------------------------------------------
  const ex = UP_ELEVATOR.x;
  add(mesh(box(UP_ELEVATOR.width + 0.5, 2.9, 0.12), toon("#3d405b"), ex, 1.45, U.minZ + 0.06, false));
  for (const s of [-1, 1]) add(mesh(box(UP_ELEVATOR.width / 2 - 0.04, 2.6, 0.06), toon("#c0c8d6"), ex + (s * UP_ELEVATOR.width) / 4, 1.32, U.minZ + 0.14, false));
  const floorSign = textPlane("2", { bg: "#ffd166", size: 80 });
  floorSign.position.set(ex, 3.15, U.minZ + 0.08);
  floorSign.scale.setScalar(0.5);
  add(floorSign);
  add(mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.03, 12).rotateX(Math.PI / 2), toon("#ffd166", { emissive: "#ffb000" }), ex + UP_ELEVATOR.width / 2 + 0.45, 1.3, U.minZ + 0.03, false));

  // --- the library ---------------------------------------------------------------------
  add(bookcase(U.maxZ - U.minZ - 4, 2.8, U.minX + 0.3, 0, Math.PI / 2));
  solid(U.minX + 0.3, 0, 0.3, (U.maxZ - U.minZ - 4) / 2);
  const rug = new THREE.Mesh(new THREE.CircleGeometry(1, 40), toon("#7a4e8c"));
  rug.rotation.x = -Math.PI / 2;
  rug.scale.set(4, 9, 1);
  rug.position.set(68, 0.012, 0);
  add(rug);
  UP.armchairs.forEach((c, i) => {
    const a = armchair(i ? "#2a9d8f" : "#e76f51");
    a.position.set(c.x, 0, c.z);
    a.rotation.y = c.rotY;
    add(a);
    const t = UP.readingTables[i];
    add(mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.05, 20), toon(PALETTE.woodDark), t.x, 0.6, t.z));
    add(mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.58, 8), toon(INK), t.x, 0.3, t.z));
    solid(t.x, t.z, 0.42, 0.42);
    // A reading lamp.
    add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.5, 6), toon(INK), c.x - 0.6, 0.75, c.z + 0.7, false));
    add(mesh(new THREE.ConeGeometry(0.26, 0.3, 16, 1, true), toon("#ffe8a3", { emissive: "#806020" }), c.x - 0.6, 1.55, c.z + 0.7, false));
  });
  for (const [x, z, k] of [
    [72.8, -12.8, 0],
    [72.8, 12.8, 2],
    [63.2, 12.8, 1],
  ] as const) {
    const p = plant(k, 1.1);
    p.position.set(x, 0, z);
    add(p);
    solid(x, z, 0.35, 0.35);
  }

  // --- the lounge ------------------------------------------------------------------------
  const lrug = new THREE.Mesh(new THREE.CircleGeometry(1, 40), toon("#ffd6e0"));
  lrug.rotation.x = -Math.PI / 2;
  lrug.scale.set(4.4, 3, 1);
  lrug.position.set(UP.coffeeTable.x, 0.012, UP.coffeeTable.z + 0.6);
  add(lrug);
  const so = sofa("#ef476f");
  so.position.set(UP.sofa.x, 0, UP.sofa.z);
  so.rotation.y = UP.sofa.rotY;
  add(so);
  solid(UP.sofa.x, UP.sofa.z + 0.1, 1.6, 0.45);
  add(mesh(roundedBox(1.6, 0.08, 0.8, 0.04), toon(PALETTE.wood), UP.coffeeTable.x, 0.42, UP.coffeeTable.z));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(mesh(box(0.06, 0.4, 0.06), toon(INK), UP.coffeeTable.x + sx * 0.7, 0.2, UP.coffeeTable.z + sz * 0.32, false));
  solid(UP.coffeeTable.x, UP.coffeeTable.z, 0.8, 0.4);
  for (const [dx, color] of [
    [-2.2, "#ffd166"],
    [2.2, "#06d6a0"],
  ] as const) {
    const ch = chair(color);
    ch.position.set(UP.coffeeTable.x + dx, 0, UP.coffeeTable.z - 0.1);
    ch.rotation.y = dx < 0 ? Math.PI / 2 : -Math.PI / 2;
    add(ch);
  }
  // The piano, its back to the window.
  add(piano(UP.piano.x, UP.piano.z));
  solid(UP.piano.x, UP.piano.z, 0.85, 0.4);
  // Darts on the north wall, a throw line on the floor.
  add(dartboard(UP.darts.x, UP.darts.y, UP.darts.z));
  add(mesh(box(1.2, 0.01, 0.08), toon("#ef476f"), UP.dartsSpot.x, 0.012, UP.dartsSpot.z - 0.35, false));
  // The vending machine.
  add(vending(UP.vending.x, UP.vending.z));
  solid(UP.vending.x, UP.vending.z, 0.55, 0.45);
  for (const x of [77.5, 82.5]) add(pendantAt(x, 4, H, 1.4));

  // --- the gym ---------------------------------------------------------------------------
  const belts: THREE.Texture[] = [];
  UP.treadmills.forEach((t) => {
    const { group: g, belt } = treadmill();
    g.position.set(t.x, 0, t.z);
    add(g);
    belts.push(belt);
    // Only the console is solid: you step onto the belt.
    solid(t.x, t.z - 0.95, 0.45, 0.12);
  });
  UP.mats.forEach((m, i) => {
    add(mesh(roundedBox(0.8, 0.02, 1.9, 0.01), toon(["#9b5de5", "#00bbf9"][i % 2]), m.x, 0.012, m.z, false));
  });
  // Dumbbells on a rack against the east glass.
  add(mesh(box(0.5, 0.7, 2.2), toon("#3d405b"), U.maxX - 0.5, 0.35, 0));
  solid(U.maxX - 0.5, 0, 0.25, 1.1);
  for (let i = 0; i < 5; i++) {
    const z = -0.8 + i * 0.4;
    for (const s of [-1, 1]) add(mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.07, 12).rotateZ(Math.PI / 2), toon(["#ef476f", "#ffd166", "#06d6a0", "#118ab2", "#8338ec"][i]), U.maxX - 0.5 + s * 0.14, 0.78, z, false));
    add(mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.3, 6).rotateZ(Math.PI / 2), toon(INK), U.maxX - 0.5, 0.78, z, false));
  }
  add(telescope(UP.telescope.x, UP.telescope.z));
  solid(UP.telescope.x, UP.telescope.z, 0.3, 0.3);
  const wc = plant(1, 1.2);
  wc.position.set(U.maxX - 0.7, 0, U.minZ + 0.7);
  add(wc);
  solid(U.maxX - 0.7, U.minZ + 0.7, 0.35, 0.35);
  for (const x of [89.5, 94.5]) add(pendantAt(x, 0, H, 1.2));

  noOutline(ceil);
  let running: number | null = null;
  return {
    group,
    colliders,
    occluders,
    setTreadmill(i) {
      running = i;
    },
    update(dt) {
      if (running !== null && belts[running]) belts[running].offset.y -= dt * 1.6;
    },
  };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

const BOOK_COLORS = ["#ef476f", "#ffd166", "#06d6a0", "#118ab2", "#8338ec", "#f78c6b", "#e9c46a", "#264653"];

/** A bookcase `len` long, `h` tall, its shelves facing ±(local z); rotY turns it. */
function bookcase(len: number, h: number, x: number, z: number, rotY: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = rotY;
  g.add(mesh(box(len, h, 0.5), toon(PALETTE.woodDark), 0, h / 2, 0));
  // Books: one instanced mesh, both faces.
  const shelves = Math.max(1, Math.floor(h / 0.42));
  const perShelf = Math.floor(len / 0.09);
  const count = shelves * perShelf * 2;
  const books = new THREE.InstancedMesh(box(1, 1, 1), toon("#ffffff"), count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const c = new THREE.Color();
  let n = 0;
  for (const side of [-1, 1]) {
    for (let s = 0; s < shelves; s++) {
      for (let i = 0; i < perShelf; i++) {
        const seed = (s * 131 + i * 17 + (side + 1) * 7) % 97;
        if (seed % 11 === 0) continue;
        const bh = 0.24 + (seed % 5) * 0.025;
        m.compose(new THREE.Vector3(-len / 2 + 0.06 + i * 0.09, 0.08 + s * 0.42 + bh / 2, side * 0.27), q, new THREE.Vector3(0.075, bh, 0.06));
        books.setMatrixAt(n, m);
        books.setColorAt(n, c.set(BOOK_COLORS[seed % BOOK_COLORS.length]));
        n++;
      }
    }
  }
  books.count = n;
  g.add(books);
  return g;
}

export function armchair(color: string): THREE.Group {
  const g = new THREE.Group();
  const cloth = toon(color);
  g.add(mesh(roundedBox(0.95, 0.4, 0.9, 0.12), cloth, 0, 0.28, 0));
  g.add(mesh(roundedBox(0.95, 0.75, 0.22, 0.1), cloth, 0, 0.75, -0.36));
  for (const s of [-1, 1]) g.add(mesh(roundedBox(0.2, 0.55, 0.9, 0.08), cloth, s * 0.47, 0.5, 0));
  return g;
}

export function sofa(color: string): THREE.Group {
  const g = new THREE.Group();
  const cloth = toon(color);
  g.add(mesh(roundedBox(3.2, 0.4, 0.95, 0.12), cloth, 0, 0.28, 0));
  g.add(mesh(roundedBox(3.2, 0.7, 0.25, 0.12), cloth, 0, 0.75, -0.36));
  for (const s of [-1, 1]) g.add(mesh(roundedBox(0.25, 0.5, 0.95, 0.1), cloth, s * 1.55, 0.55, 0));
  for (const [x, c] of [
    [-0.8, "#ffd166"],
    [0.8, "#118ab2"],
  ] as const) {
    const p = mesh(roundedBox(0.45, 0.4, 0.14, 0.1), toon(c), x, 0.72, -0.18);
    p.rotation.x = -0.2;
    g.add(p);
  }
  return g;
}

/** An upright piano, keys toward -z. */
function piano(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  const black = toon("#1b1b26");
  g.add(mesh(box(1.6, 1.3, 0.55), black, 0, 0.65, 0.1));
  g.add(mesh(box(1.6, 0.08, 0.35), black, 0, 0.74, -0.32));
  g.add(mesh(box(1.5, 0.03, 0.18), toon("#ffffff"), 0, 0.79, -0.36, false));
  for (let i = 0; i < 21; i++) {
    if ([2, 6, 9, 13, 16, 20].includes(i % 21)) continue;
    g.add(mesh(box(0.035, 0.03, 0.1), black, -0.7 + i * 0.07, 0.81, -0.33, false));
  }
  // A bench.
  g.add(mesh(roundedBox(0.9, 0.08, 0.35, 0.03), black, 0, 0.48, -0.95));
  for (const s of [-1, 1]) g.add(mesh(box(0.06, 0.46, 0.3), black, s * 0.38, 0.23, -0.95, false));
  // Sheet music.
  const sheet = mesh(box(0.42, 0.3, 0.01), toon("#fffaf3"), 0, 1.0, -0.17, false);
  sheet.rotation.x = -0.25;
  g.add(sheet);
  return g;
}

function dartboard(x: number, y: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  const ring = (r: number, color: string, dz: number) => g.add(mesh(new THREE.CircleGeometry(r, 32), toon(color), 0, 0, dz, false));
  g.add(mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.05, 32).rotateX(Math.PI / 2), toon("#1b1b26"), 0, 0, 0, false));
  ring(0.24, "#2a9d8f", 0.027);
  ring(0.21, "#f1e3c6", 0.028);
  ring(0.14, "#ef476f", 0.029);
  ring(0.12, "#f1e3c6", 0.03);
  ring(0.04, "#2a9d8f", 0.031);
  ring(0.016, "#ef476f", 0.032);
  // A few darts already in it.
  for (const [dx, dy] of [
    [0.05, 0.08],
    [-0.1, -0.03],
  ]) {
    const d = mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.16, 6).rotateX(Math.PI / 2), toon("#ffd166"), dx, dy, 0.1, false);
    g.add(d);
  }
  return g;
}

function vending(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.add(mesh(roundedBox(1.1, 2.1, 0.85, 0.06), toon("#118ab2"), 0, 1.05, 0));
  g.add(mesh(box(0.7, 1.4, 0.02), new THREE.MeshBasicMaterial({ color: "#d8f3ff" }), -0.12, 1.25, 0.43, false));
  // Snacks behind the glass.
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      g.add(mesh(box(0.13, 0.18, 0.05), toon(BOOK_COLORS[(r * 4 + c) % BOOK_COLORS.length]), -0.38 + c * 0.17, 0.72 + r * 0.33, 0.4, false));
    }
  }
  g.add(mesh(box(0.2, 0.5, 0.02), toon("#1b1b26"), 0.38, 1.3, 0.43, false));
  g.add(mesh(box(0.7, 0.18, 0.02), toon("#1b1b26"), -0.12, 0.3, 0.43, false));
  const top = textPlane("SNACKS", { bg: "#ffd166", size: 48 });
  top.position.set(0, 2.0, 0.44);
  top.scale.setScalar(0.45);
  g.add(top);
  return g;
}

/** A treadmill, its console at -z; returns the belt's texture to scroll. */
function treadmill(): { group: THREE.Group; belt: THREE.Texture } {
  const g = new THREE.Group();
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#2b2d42";
  ctx.fillRect(0, 0, 32, 64);
  ctx.fillStyle = "#3d405b";
  for (let y = 0; y < 64; y += 8) ctx.fillRect(0, y, 32, 3);
  const belt = new THREE.CanvasTexture(c);
  belt.wrapS = belt.wrapT = THREE.RepeatWrapping;
  belt.repeat.set(1, 4);
  g.add(mesh(box(0.85, 0.16, 1.9), toon("#8d99ae"), 0, 0.08, 0.1));
  const top = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 1.7), new THREE.MeshBasicMaterial({ map: belt }));
  top.rotation.x = -Math.PI / 2;
  top.position.set(0, 0.165, 0.12);
  g.add(top);
  for (const s of [-1, 1]) {
    g.add(mesh(box(0.05, 1.1, 0.05), toon("#8d99ae"), s * 0.38, 0.65, -0.82, false));
    g.add(mesh(box(0.05, 0.05, 0.5), toon("#8d99ae"), s * 0.38, 1.0, -0.6, false));
  }
  g.add(mesh(roundedBox(0.8, 0.3, 0.1, 0.03), toon("#2b2d42"), 0, 1.2, -0.85));
  g.add(mesh(box(0.34, 0.14, 0.01), new THREE.MeshBasicMaterial({ color: "#06d6a0" }), 0, 1.23, -0.795, false));
  return { group: g, belt };
}

function telescope(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const leg = mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.25, 6), toon(INK), Math.sin(a) * 0.22, 0.6, Math.cos(a) * 0.22, false);
    leg.rotation.set(Math.cos(a) * 0.2, 0, -Math.sin(a) * 0.2);
    g.add(leg);
  }
  const tube = mesh(new THREE.CylinderGeometry(0.07, 0.1, 0.9, 14), toon("#f4f1de"), 0, 1.3, 0.1);
  tube.rotation.x = Math.PI / 2 - 0.35;
  g.add(tube);
  return g;
}

/** A painted city skyline across [from, to], `dist` out, facing back in; rotY 0 runs along x. */
export function skyline(from: number, to: number, dist: number, rotY: number): THREE.Mesh {
  const W = 2048;
  const Hc = 512;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = Hc;
  const g = c.getContext("2d")!;
  const sky = g.createLinearGradient(0, 0, 0, Hc);
  sky.addColorStop(0, "#9fd3ff");
  sky.addColorStop(1, "#e6f5ff");
  g.fillStyle = sky;
  g.fillRect(0, 0, W, Hc);
  let seed = Math.round(from * 7 + dist);
  const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  for (const [color, minH, maxH] of [
    ["#b7c8dc", 160, 330],
    ["#8ea6c2", 120, 280],
    ["#6d86a6", 80, 220],
  ] as const) {
    let x = -20;
    while (x < W) {
      const w = 40 + rand() * 110;
      const h = minH + rand() * (maxH - minH);
      g.fillStyle = color;
      g.fillRect(x, Hc - h, w, h);
      // Lit windows.
      g.fillStyle = "rgba(255,240,180,.55)";
      for (let wy = Hc - h + 12; wy < Hc - 10; wy += 18) for (let wx = x + 6; wx < x + w - 8; wx += 14) if (rand() < 0.35) g.fillRect(wx, wy, 6, 8);
      x += w + rand() * 18;
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const len = to - from;
  const height = (len * Hc) / W;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(len, height), new THREE.MeshBasicMaterial({ map: tex, fog: false }));
  // A floor up: the bottom of the view sits below your feet.
  const y = height / 2 - 6;
  if (rotY === 0) {
    m.position.set((from + to) / 2, y, dist);
    m.rotation.y = Math.PI;
  } else {
    m.position.set(dist, y, (from + to) / 2);
    m.rotation.y = -Math.PI / 2;
  }
  return m;
}
