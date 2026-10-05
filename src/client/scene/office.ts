import * as THREE from "three";
import {
  BOARDS,
  CLUSTER_X,
  DESKS,
  DESK_SIZE,
  ELEVATOR,
  FLOOR,
  GONG,
  LOUNGE,
  MY_OFFICE,
  OFFICE_DOOR,
  PLANTS,
  REVIEW_BOARD,
  REVIEW_DESK,
  SCREEN,
  TV,
  WALL_HEIGHT,
  WHITEBOARD,
  WINDOWS,
  type DeskDef,
} from "../../shared/layout.js";
import { box, INK, mesh, noOutline, roundedBox, textPlane, textSprite, toon } from "./toon.js";

/**
 * Builds the office: the planked floor and tiled ceiling, the walls with their
 * trim and windows, the boards along the north wall, the elevator and gong,
 * the desk pods, the lounge round the TV, the glass meeting room with the loft
 * over it and the stairs up, plants, lamps and the odd knick-knack.
 *
 * It returns the scene graph plus what the world needs to keep alive: the
 * canvases of the live boards and the TV, each desk's anchors, and the boxes
 * you bump into.
 */

export const PALETTE = {
  floor: "#f2d7b0",
  floorAlt: "#e9c89a",
  seam: "#d9b88c",
  wall: "#fff6ea",
  trim: "#e8a87c",
  ceiling: "#f4e7d3",
  desk: "#f7f3ea",
  deskLeg: "#8d99ae",
  wood: "#c98b5a",
  woodDark: "#8a5a3b",
  chairs: ["#ff8a5b", "#5bc0eb", "#9bc53d", "#b388eb", "#ffb400", "#f7aef8"],
  plant: "#5fb760",
  plantDark: "#3f8f45",
  pot: "#e76f51",
  metal: "#9aa3b2",
};

/** An axis-aligned box on the floor you can't walk through. */
export interface Collider {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Full-height (a wall): the camera stops short of it. */
  tall?: boolean;
}

/** A board whose face is a canvas the world repaints. */
export interface LiveBoard {
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  /** The meshes showing it (for pointing at it in VR). */
  faces?: THREE.Mesh[];
}

/** What a desk gives the world: where its laptop, worker and "+" go. */
export interface DeskView {
  def: DeskDef;
  group: THREE.Group;
  laptopAnchor: THREE.Object3D;
  seatAnchor: THREE.Object3D;
  vacancy: THREE.Group;
}

export interface Office {
  group: THREE.Group;
  colliders: Collider[];
  desks: Map<string, DeskView>;
  boards: { workers: LiveBoard; line: LiveBoard; goals: LiveBoard };
  /** The gong's disc, which swings when a task ships. */
  gong: THREE.Object3D;
  tv: LiveBoard;
  /** The presentation screen in your office. */
  screen: LiveBoard;
  /** The review whiteboard in your office. */
  reviewBoard: LiveBoard;
  /** The whiteboard on wheels: an idea board. */
  ideaBoard: LiveBoard;
}

export function buildOffice(): Office {
  const group = new THREE.Group();
  const colliders: Collider[] = [];
  const add = (o: THREE.Object3D) => group.add(o);
  const solid = (x: number, z: number, hw: number, hd: number) =>
    colliders.push({ minX: x - hw, maxX: x + hw, minZ: z - hd, maxZ: z + hd });

  buildShell(add);

  // --- desks ----------------------------------------------------------------
  const desks = new Map<string, DeskView>();
  DESKS.forEach((def, i) => {
    const view = buildDesk(def, i);
    desks.set(def.id, view);
    add(view.group);
    solid(def.x, def.z, DESK_SIZE.width / 2, DESK_SIZE.depth / 2);
  });
  // A rug under each cluster, and lamps over each pod.
  CLUSTER_X.forEach((cx, i) => {
    const rug = mesh(roundedBox(6.8, 0.02, 13.4, 0.6), toon(i === 0 ? "#ffd6e7" : "#cde7ff"), cx, 0.012, 0, false);
    add(rug);
    for (const z of [-4, 4]) for (const dx of [-1.1, 1.1]) add(pendant(cx + dx, z, 2.1));
  });

  // --- boards along the north wall -------------------------------------------
  const boards = {
    workers: liveBoard(add, BOARDS.workers, "#c98b5a"),
    line: liveBoard(add, BOARDS.line, "#c98b5a"),
    goals: liveBoard(add, BOARDS.goals, "#e8a87c"),
  };

  // --- elevator and gong -------------------------------------------------------
  buildElevator(add);
  solid(ELEVATOR.x, FLOOR.minZ + ELEVATOR.depth / 2, ELEVATOR.width / 2, ELEVATOR.depth / 2);
  const gong = buildGong(add);
  solid(GONG.x, GONG.z, 0.95, 0.3);

  // --- lounge round the TV -------------------------------------------------------
  const tv = buildTv(add);
  buildLounge(add);
  solid(LOUNGE.couch.x, LOUNGE.couch.z, 0.55, 2.15);
  solid(LOUNGE.table.x, LOUNGE.table.z, 0.5, 0.5);
  for (const p of LOUNGE.poufs) solid(p.x, p.z, 0.45, 0.45);
  const juke = jukebox();
  juke.position.set(FLOOR.maxX - 0.45, 0, -7.2);
  juke.rotation.y = -Math.PI / 2;
  add(juke);
  solid(FLOOR.maxX - 0.45, -7.2, 0.45, 0.7);
  add(pendant(LOUNGE.table.x, LOUNGE.table.z, 2.4));

  // --- your office --------------------------------------------------------------
  const { screen, reviewBoard } = buildMyOffice(add);
  const glassT = 0.12;
  const wallZ = MY_OFFICE.minZ;
  const wallX = MY_OFFICE.minX;
  solid((wallX + OFFICE_DOOR.x0) / 2, wallZ, (OFFICE_DOOR.x0 - wallX) / 2, glassT);
  solid((OFFICE_DOOR.x1 + FLOOR.maxX) / 2, wallZ, (FLOOR.maxX - OFFICE_DOOR.x1) / 2, glassT);
  solid(wallX, (wallZ + FLOOR.maxZ) / 2, glassT, (FLOOR.maxZ - wallZ) / 2);
  solid(REVIEW_DESK.x, REVIEW_DESK.z, 1.3, 0.55);

  // --- odds and ends ----------------------------------------------------------------
  const ideaBoard = buildWhiteboard(add);
  solid(WHITEBOARD.x, WHITEBOARD.z, WHITEBOARD.width / 2 + 0.2, 0.25);
  const shelf = bookshelf();
  shelf.position.set(-6.5, 0, FLOOR.maxZ - 0.22);
  shelf.rotation.y = Math.PI;
  add(shelf);
  solid(-6.5, FLOOR.maxZ - 0.22, 0.9, 0.25);
  PLANTS.forEach(([x, z, s], i) => {
    const p = plant(i % 3, s);
    p.position.set(x, 0, z);
    add(p);
    solid(x, z, 0.3 * s, 0.3 * s);
  });

  noOutline(group);
  return { group, colliders, desks, boards, tv, screen, reviewBoard, ideaBoard, gong };
}

// ---------------------------------------------------------------------------
// The shell: floor, ceiling, walls, trim and windows.
// ---------------------------------------------------------------------------

function buildShell(add: (o: THREE.Object3D) => void): void {
  const w = FLOOR.maxX - FLOOR.minX;
  const d = FLOOR.maxZ - FLOOR.minZ;
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshToonMaterial({ map: plankTexture(w, d), gradientMap: toon("#fff").gradientMap }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  add(floor);

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map: tileTexture(w, d) }));
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = WALL_HEIGHT;
  add(ceiling);

  // The walls themselves (with their trim) are built for the whole building
  // in rooms.ts, from the shared floor plan.

  for (const win of WINDOWS) {
    const g = windowFrame(win.width, 2.2);
    if (win.wall === "south") {
      g.position.set(win.u, 2.2, FLOOR.maxZ - 0.02);
      g.rotation.y = Math.PI;
    } else {
      g.position.set(FLOOR.minX + 0.02, 2.2, win.u);
      g.rotation.y = Math.PI / 2;
    }
    add(g);
  }
}

function plankTexture(w: number, d: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d")!;
  g.fillStyle = PALETTE.floor;
  g.fillRect(0, 0, 512, 512);
  for (let row = 0; row < 8; row++) {
    const offset = (row % 2) * 128;
    for (let col = -1; col < 3; col++) {
      g.fillStyle = (row + col) % 3 === 0 ? PALETTE.floorAlt : PALETTE.floor;
      g.fillRect(col * 256 + offset + 2, row * 64 + 2, 252, 60);
    }
    g.fillStyle = PALETTE.seam;
    g.fillRect(0, row * 64, 512, 3);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(w / 6, d / 6);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function tileTexture(w: number, d: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = PALETTE.ceiling;
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = "#dccab0";
  g.fillRect(0, 0, 128, 3);
  g.fillRect(0, 0, 3, 128);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(w / 1.6, d / 1.6);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A window facing +z: a frame round a view of sky, clouds and the city. */
export function windowFrame(width: number, height: number): THREE.Group {
  const g = new THREE.Group();
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 192;
  const x = c.getContext("2d")!;
  const sky = x.createLinearGradient(0, 0, 0, 192);
  sky.addColorStop(0, "#8fd3ff");
  sky.addColorStop(1, "#dff3ff");
  x.fillStyle = sky;
  x.fillRect(0, 0, 256, 192);
  x.fillStyle = "rgba(255,255,255,.9)";
  for (const [cx, cy, r] of [
    [50, 40, 16],
    [72, 34, 20],
    [96, 42, 14],
    [180, 60, 14],
    [200, 54, 18],
  ]) {
    x.beginPath();
    x.arc(cx, cy, r, 0, Math.PI * 2);
    x.fill();
  }
  // A skyline across the bottom.
  const tones = ["#9fb7d8", "#b9cbe6", "#8aa6cc"];
  let bx = -10;
  let i = 0;
  while (bx < 256) {
    const bw = 24 + ((i * 37) % 30);
    const bh = 40 + ((i * 53) % 70);
    x.fillStyle = tones[i % 3];
    x.fillRect(bx, 192 - bh, bw, bh);
    x.fillStyle = "rgba(255,255,255,.55)";
    for (let wy = 192 - bh + 8; wy < 186; wy += 12) for (let wx = bx + 5; wx < bx + bw - 6; wx += 9) x.fillRect(wx, wy, 4, 6);
    bx += bw + 2;
    i++;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const pane = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: tex }));
  pane.position.z = 0.01;
  g.add(pane);
  // Glints so it reads as glass.
  const shine = new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.25 });
  for (const [gx, gw] of [
    [-width * 0.2, 0.18],
    [-width * 0.2 + 0.32, 0.08],
  ]) {
    const glint = new THREE.Mesh(new THREE.PlaneGeometry(gw, height * 0.55), shine);
    glint.position.set(gx, height * 0.05, 0.02);
    glint.rotation.z = -0.5;
    g.add(glint);
  }
  const frame = toon("#ffffff");
  const t = 0.1;
  g.add(mesh(box(width + t * 2, t, 0.12), frame, 0, height / 2 + t / 2, 0.03, false));
  g.add(mesh(box(width + t * 2, t * 1.6, 0.2), frame, 0, -height / 2 - t * 0.8, 0.06, false));
  for (const sx of [-1, 0, 1]) g.add(mesh(box(sx === 0 ? 0.06 : t, height, 0.12), frame, (sx * (width + t)) / 2, 0, 0.03, false));
  return g;
}

// ---------------------------------------------------------------------------
// Desks
// ---------------------------------------------------------------------------

function buildDesk(def: DeskDef, index: number): DeskView {
  const group = new THREE.Group();
  group.position.set(def.x, 0, def.z);
  group.rotation.y = def.rotY;
  const { width, depth, height } = DESK_SIZE;
  group.add(mesh(roundedBox(width - 0.06, 0.08, depth - 0.04, 0.08), toon(PALETTE.desk), 0, height - 0.04, 0));
  const legMat = toon(PALETTE.deskLeg);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      group.add(
        mesh(new THREE.CylinderGeometry(0.035, 0.035, height - 0.08, 8), legMat, sx * (width / 2 - 0.14), (height - 0.08) / 2, sz * (depth / 2 - 0.12)),
      );
    }
  }
  // Modesty panel on the side away from the worker.
  group.add(mesh(box(width - 0.3, 0.32, 0.03), toon(PALETTE.trim), 0, height - 0.26, -depth / 2 + 0.06));

  const deco = index % 3;
  if (deco === 0) {
    const m = mug(PALETTE.chairs[index % 6]);
    m.position.set(width / 2 - 0.25, height, -0.2);
    group.add(m);
  } else if (deco === 1) {
    const p = succulent();
    p.position.set(-width / 2 + 0.25, height, -0.25);
    group.add(p);
  } else {
    const b = books(index);
    b.position.set(width / 2 - 0.26, height, -0.3);
    group.add(b);
  }

  const laptopAnchor = new THREE.Object3D();
  laptopAnchor.position.set(0, height, -0.06);
  laptopAnchor.scale.setScalar(1.3);
  group.add(laptopAnchor);

  // The worker sits on the chair facing the desk.
  const seatAnchor = new THREE.Object3D();
  seatAnchor.position.set(0, 0.4, 0.93);
  seatAnchor.rotation.y = Math.PI;
  seatAnchor.scale.setScalar(0.82);
  group.add(seatAnchor);

  const ch = chair(PALETTE.chairs[index % PALETTE.chairs.length]);
  ch.position.set(0, 0, 0.9);
  group.add(ch);

  const vacancy = new THREE.Group();
  const plusMat = toon("#7cf29a", { emissive: "#1f7a3a" });
  vacancy.add(mesh(box(0.28, 0.08, 0.08), plusMat, 0, 0, 0, false));
  vacancy.add(mesh(box(0.08, 0.28, 0.08), plusMat, 0, 0, 0, false));
  vacancy.position.set(0, height + 0.6, 0.2);
  group.add(vacancy);

  return { def, group, laptopAnchor, seatAnchor, vacancy };
}

export function chair(color: string): THREE.Group {
  const g = new THREE.Group();
  const mat = toon(color);
  g.add(mesh(roundedBox(0.62, 0.1, 0.58, 0.12), mat, 0, 0.5, 0));
  const back = mesh(roundedBox(0.62, 0.1, 0.6, 0.12), mat, 0, 0.86, 0.27);
  back.rotation.x = Math.PI / 2 - 0.12;
  g.add(back);
  const leg = toon("#3d405b");
  g.add(mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.42, 8), leg, 0, 0.26, 0));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const foot = mesh(box(0.05, 0.04, 0.32), leg, Math.sin(a) * 0.15, 0.05, Math.cos(a) * 0.15);
    foot.rotation.y = a;
    g.add(foot);
  }
  return g;
}

function mug(color: string): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.12, 12), toon(color), 0, 0.06, 0));
  g.add(mesh(new THREE.CircleGeometry(0.052, 12).rotateX(-Math.PI / 2), toon("#6f4518"), 0, 0.112, 0, false));
  const handle = mesh(new THREE.TorusGeometry(0.035, 0.012, 6, 10), toon(color), 0.065, 0.06, 0);
  g.add(handle);
  return g;
}

function succulent(): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.CylinderGeometry(0.08, 0.06, 0.1, 10), toon(PALETTE.pot), 0, 0.05, 0));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const leaf = mesh(new THREE.SphereGeometry(0.04, 8, 6), toon(i % 2 ? PALETTE.plant : PALETTE.plantDark), Math.sin(a) * 0.04, 0.13, Math.cos(a) * 0.04);
    leaf.scale.set(0.7, 1.4, 0.7);
    leaf.rotation.set(Math.cos(a) * 0.6, 0, -Math.sin(a) * 0.6);
    g.add(leaf);
  }
  return g;
}

function books(i: number): THREE.Group {
  const g = new THREE.Group();
  const covers = ["#e63946", "#457b9d", "#f4a261", "#2a9d8f"];
  for (let k = 0; k < 3; k++) {
    const h = 0.16 + ((i + k) % 3) * 0.03;
    const b = mesh(box(0.05, h, 0.18), toon(covers[(i + k) % covers.length]), -0.06 + k * 0.06, h / 2, 0);
    if (k === 2) b.rotation.z = -0.25;
    g.add(b);
  }
  return g;
}

// ---------------------------------------------------------------------------
// Boards, the TV, the elevator and the gong
// ---------------------------------------------------------------------------

export function liveBoard(
  add: (o: THREE.Object3D) => void,
  b: { x: number; y: number; width: number; height: number; label: string },
  frameColor: string,
): LiveBoard {
  const g = new THREE.Group();
  g.position.set(b.x, b.y, FLOOR.minZ + 0.08);
  const frame = mesh(roundedBox(b.width + 0.3, 0.12, b.height + 0.3, 0.1), toon(frameColor), 0, 0, 0, false);
  frame.rotation.x = Math.PI / 2;
  g.add(frame);
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = Math.round((1024 * b.height) / b.width);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(b.width, b.height), new THREE.MeshBasicMaterial({ map: texture }));
  face.position.z = 0.07;
  g.add(face);
  const label = textPlane(b.label, { bg: "#fffaf3", size: 64 });
  label.position.set(0, b.height / 2 + 0.38, 0.12);
  g.add(label);
  add(g);
  return { canvas, texture };
}

function buildTv(add: (o: THREE.Object3D) => void): LiveBoard {
  const g = new THREE.Group();
  g.position.set(TV.x, TV.y, TV.z);
  g.rotation.y = -Math.PI / 2;
  g.add(mesh(roundedBox(TV.width + 0.2, 0.12, TV.height + 0.2, 0.08), toon("#1b1d2e"), 0, 0, -0.04, false).rotateX(Math.PI / 2));
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = Math.round((1024 * TV.height) / TV.width);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(TV.width, TV.height), new THREE.MeshBasicMaterial({ map: texture }));
  screen.position.z = 0.04;
  g.add(screen);
  const label = textPlane("🎤 Office hours", { bg: "#fffaf3", size: 64 });
  label.position.set(0, TV.height / 2 + 0.45, 0.06);
  g.add(label);
  add(g);
  return { canvas, texture };
}

function buildElevator(add: (o: THREE.Object3D) => void): void {
  const { x, width, depth } = ELEVATOR;
  const front = FLOOR.minZ + depth;
  const g = new THREE.Group();
  g.add(mesh(box(width, WALL_HEIGHT, depth), toon("#a39b90"), x, WALL_HEIGHT / 2, FLOOR.minZ + depth / 2, false));
  const doorMat = toon("#c9ced8");
  for (const sx of [-1, 1]) g.add(mesh(box(0.68, 2.4, 0.05), doorMat, x + sx * 0.35, 1.2, front + 0.03, false));
  g.add(mesh(box(0.02, 2.4, 0.06), toon(INK), x, 1.2, front + 0.04, false));
  const frameMat = toon("#e8a24a");
  g.add(mesh(box(1.7, 0.12, 0.1), frameMat, x, 2.46, front + 0.05, false));
  for (const sx of [-1, 1]) g.add(mesh(box(0.12, 2.5, 0.1), frameMat, x + sx * 0.79, 1.25, front + 0.05, false));
  // Call button.
  g.add(mesh(box(0.14, 0.26, 0.04), toon("#3d405b"), x + 1.05, 1.2, front + 0.03, false));
  g.add(mesh(new THREE.SphereGeometry(0.04, 8, 6), toon("#ffd166", { emissive: "#c79100" }), x + 1.05, 1.24, front + 0.06, false));
  const sign = textPlane("🏢 domain", { bg: "#fffaf3", size: 90 });
  sign.position.set(x, 3.2, front + 0.08);
  g.add(sign);
  add(g);
}

function buildGong(add: (o: THREE.Object3D) => void): THREE.Object3D {
  const g = new THREE.Group();
  g.position.set(GONG.x, 0, GONG.z);
  const red = toon("#c1272d");
  for (const sx of [-1, 1]) g.add(mesh(new THREE.CylinderGeometry(0.06, 0.07, 2.2, 8), red, sx * 0.85, 1.1, 0));
  const bar = mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.0, 8), red, 0, 2.15, 0);
  bar.rotation.z = Math.PI / 2;
  g.add(bar);
  for (const sx of [-1, 1]) g.add(mesh(box(0.5, 0.06, 0.4), toon(INK), sx * 0.85, 0.03, 0));
  // The disc hangs from the bar on its cords, so it swings about the bar.
  const swing = new THREE.Group();
  swing.position.y = 2.1;
  const disc = mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.06, 28), toon("#e0a526"), 0, -0.75, 0);
  disc.rotation.x = Math.PI / 2;
  swing.add(disc);
  const boss = mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.08, 20), toon("#c98a14"), 0, -0.75, 0.02);
  boss.rotation.x = Math.PI / 2;
  swing.add(boss);
  g.add(swing);
  for (const sx of [-1, 1]) {
    const cord = mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.3, 4), toon(INK), sx * 0.3, 1.98, 0, false);
    g.add(cord);
  }
  const sign = textSprite("🎉 Ship gong", { bg: "#fffaf3", size: 30 });
  sign.position.set(0, 2.45, 0);
  g.add(sign);
  add(g);
  return swing;
}

// ---------------------------------------------------------------------------
// The lounge
// ---------------------------------------------------------------------------

function buildLounge(add: (o: THREE.Object3D) => void): void {
  const rug = mesh(new THREE.CircleGeometry(1, 48), toon("#ffb3d1"), LOUNGE.rug.x, 0.015, LOUNGE.rug.z, false);
  rug.rotation.x = -Math.PI / 2;
  rug.scale.set(LOUNGE.rug.rx, LOUNGE.rug.rz, 1);
  add(rug);

  const c = couch();
  c.position.set(LOUNGE.couch.x, 0, LOUNGE.couch.z);
  c.rotation.y = LOUNGE.couch.rotY;
  add(c);

  const table = new THREE.Group();
  table.position.set(LOUNGE.table.x, 0, LOUNGE.table.z);
  table.add(mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.06, 28), toon(PALETTE.wood), 0, 0.46, 0));
  table.add(mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.44, 8), toon("#3d405b"), 0, 0.22, 0));
  table.add(mesh(new THREE.CylinderGeometry(0.26, 0.28, 0.04, 20), toon("#3d405b"), 0, 0.02, 0));
  const m = mug("#ef476f");
  m.position.set(0.15, 0.49, 0.1);
  table.add(m);
  add(table);

  for (const p of LOUNGE.poufs) {
    const pouf = mesh(new THREE.CylinderGeometry(0.45, 0.5, 0.4, 20), toon(p.color), p.x, 0.2, p.z);
    add(pouf);
    add(mesh(new THREE.TorusGeometry(0.44, 0.06, 8, 24).rotateX(Math.PI / 2), toon(p.color), p.x, 0.4, p.z));
  }
}

/** The lounge's couch, facing +z, 4.2 long. */
function couch(): THREE.Group {
  const g = new THREE.Group();
  const cloth = toon("#5b8def");
  g.add(mesh(roundedBox(4.2, 0.36, 1.0, 0.12), cloth, 0, 0.26, 0));
  for (const x of [-1.38, 0, 1.38]) g.add(mesh(roundedBox(1.3, 0.16, 0.8, 0.12), cloth, x, 0.5, 0.06));
  g.add(mesh(roundedBox(4.2, 0.7, 0.28, 0.12), cloth, 0, 0.75, -0.36));
  for (const sx of [-1, 1]) g.add(mesh(roundedBox(0.28, 0.4, 1.0, 0.12), cloth, sx * 2.0, 0.62, 0));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(mesh(new THREE.CylinderGeometry(0.04, 0.03, 0.1, 6), toon(PALETTE.woodDark), sx * 1.9, 0.05, sz * 0.38));
  for (const [x, color] of [
    [0.6, "#ffd166"],
    [-0.6, "#ef476f"],
  ] as const) {
    const pillow = mesh(roundedBox(0.5, 0.42, 0.16, 0.12), toon(color), x, 0.78, -0.16);
    pillow.rotation.x = -0.2;
    g.add(pillow);
  }
  return g;
}

/** A red jukebox, facing +z. */
export function jukebox(): THREE.Group {
  const g = new THREE.Group();
  const red = toon("#d62828");
  g.add(mesh(roundedBox(1.3, 1.4, 0.7, 0.12), red, 0, 0.7, 0));
  const arch = mesh(new THREE.CylinderGeometry(0.65, 0.65, 0.7, 24, 1, false, -Math.PI / 2, Math.PI), red, 0, 1.4, 0);
  arch.rotation.x = Math.PI / 2;
  g.add(arch);
  g.add(mesh(roundedBox(0.9, 0.5, 0.05, 0.06), toon("#ffd166", { emissive: "#a86b00" }), 0, 1.2, 0.36, false));
  for (let i = 0; i < 5; i++) g.add(mesh(box(0.7, 0.03, 0.04), toon("#f4f1de"), 0, 0.45 + i * 0.1, 0.36, false));
  return g;
}

// ---------------------------------------------------------------------------
// Your office: glass walls, the presentation screen, your desk, the whiteboard
// ---------------------------------------------------------------------------

function canvasFace(width: number, height: number, px = 1024): LiveBoard & { face: THREE.Mesh } {
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = Math.round((px * height) / width);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture }));
  return { canvas, texture, face };
}

function buildMyOffice(add: (o: THREE.Object3D) => void): { screen: LiveBoard; reviewBoard: LiveBoard } {
  const { minX, maxX, minZ, maxZ, height } = MY_OFFICE;
  const glass = new THREE.MeshBasicMaterial({ color: "#d6f1ff", transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide });
  const post = toon("#e8e2d6");
  const trim = toon(PALETTE.trim);

  // A carpet inside, and a wood header band along the top of the glass.
  add(mesh(roundedBox(maxX - minX - 0.3, 0.02, maxZ - minZ - 0.3, 0.3), toon("#d8e2ff"), (minX + maxX) / 2, 0.012, (minZ + maxZ) / 2, false));

  const pane = (cx: number, cz: number, len: number, rotY: number) => {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(len, height), glass);
    p.position.set(cx, height / 2, cz);
    p.rotation.y = rotY;
    add(p);
    for (const [y, h] of [
      [0.05, 0.1],
      [height + 0.08, 0.16],
    ]) {
      const band = mesh(box(len, h, 0.16), y > 1 ? trim : post, cx, y, cz, false);
      band.rotation.y = rotY;
      add(band);
    }
  };
  pane((minX + OFFICE_DOOR.x0) / 2, minZ, OFFICE_DOOR.x0 - minX, 0);
  pane((OFFICE_DOOR.x1 + maxX) / 2, minZ, maxX - OFFICE_DOOR.x1, 0);
  pane(minX, (minZ + maxZ) / 2, maxZ - minZ, Math.PI / 2);
  // A lintel over the open doorway.
  add(mesh(box(OFFICE_DOOR.x1 - OFFICE_DOOR.x0, 0.16, 0.16), trim, (OFFICE_DOOR.x0 + OFFICE_DOOR.x1) / 2, height + 0.08, minZ, false));
  for (const px of [minX, OFFICE_DOOR.x0, OFFICE_DOOR.x1, 13.3, 15.7, maxX - 0.06]) {
    add(mesh(box(0.14, height, 0.14), post, px, height / 2, minZ, false));
  }
  for (const pz of [8.4, 10.8, maxZ - 0.06]) add(mesh(box(0.14, height, 0.14), post, minX, height / 2, pz, false));
  // Frosted stripes across the glass at eye height.
  const frost = new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
  for (const [cx, cz, len, rotY] of [
    [(OFFICE_DOOR.x1 + maxX) / 2, minZ, maxX - OFFICE_DOOR.x1, 0],
    [(minX + OFFICE_DOOR.x0) / 2, minZ, OFFICE_DOOR.x0 - minX, 0],
    [minX, (minZ + maxZ) / 2, maxZ - minZ, Math.PI / 2],
  ] as const) {
    const f = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.14), frost);
    f.position.set(cx, 1.45, cz);
    f.rotation.y = rotY;
    add(f);
  }
  // The sign over the door: readable from the office floor.
  const sign = textPlane("⭐ Your office", { bg: "#ffd166", size: 46 });
  sign.position.set(OFFICE_DOOR.x1 + 1.6, height + 0.5, minZ - 0.1);
  sign.rotation.y = Math.PI;
  add(sign);

  // The presentation screen on the south wall.
  const scr = new THREE.Group();
  scr.position.set(SCREEN.x, SCREEN.y, SCREEN.z);
  scr.rotation.y = Math.PI;
  const bezel = mesh(roundedBox(SCREEN.width + 0.2, 0.1, SCREEN.height + 0.2, 0.08), toon("#1b1d2e"), 0, 0, -0.03, false);
  bezel.rotation.x = Math.PI / 2;
  scr.add(bezel);
  const screen = canvasFace(SCREEN.width, SCREEN.height);
  screen.face.position.z = 0.03;
  scr.add(screen.face);
  add(scr);

  // The presenter's podium beside it.
  const pod = new THREE.Group();
  pod.position.set(16.9, 0, 12.3);
  pod.add(mesh(roundedBox(0.8, 1.05, 0.55, 0.08), toon(PALETTE.woodDark), 0, 0.53, 0));
  const top = mesh(roundedBox(0.95, 0.06, 0.6, 0.05), toon(PALETTE.wood), 0, 1.08, -0.02);
  top.rotation.x = -0.15;
  pod.add(top);
  const mic = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.35, 5), toon(INK), 0, 1.25, -0.15, false);
  mic.rotation.x = -0.5;
  pod.add(mic);
  pod.add(mesh(new THREE.SphereGeometry(0.035, 8, 6), toon(INK), 0, 1.4, -0.25, false));
  add(pod);

  // Your desk, facing the screen, with a chair and two guest armchairs.
  const desk = new THREE.Group();
  desk.position.set(REVIEW_DESK.x, 0, REVIEW_DESK.z);
  desk.add(mesh(roundedBox(2.5, 0.09, 1.05, 0.1), toon(PALETTE.woodDark), 0, 0.78, 0));
  for (const sx of [-1, 1]) desk.add(mesh(box(0.1, 0.74, 0.95), toon(PALETTE.woodDark), sx * 1.15, 0.37, 0));
  desk.add(mesh(box(2.2, 0.4, 0.04), toon(PALETTE.wood), 0, 0.5, 0.46));
  const lid = mesh(roundedBox(0.5, 0.03, 0.34, 0.03), toon("#3d405b"), -0.5, 0.84, 0.02, false);
  desk.add(lid);
  const nameplate = textPlane("👑 Manager", { bg: "#fffaf3", size: 30 });
  // Facing whoever's across the desk (the presenter), not you in your chair.
  nameplate.position.set(0.55, 0.92, 0.3);
  desk.add(nameplate);
  const m = mug("#ff8a5b");
  m.position.set(0.95, 0.825, 0.1);
  desk.add(m);
  add(desk);
  const bossChair = chair("#3d405b");
  bossChair.position.set(REVIEW_DESK.x, 0, REVIEW_DESK.z - 0.85);
  // Its back away from the desk: you sit in it facing the screen.
  bossChair.rotation.y = Math.PI;
  add(bossChair);
  for (const x of [11.2, 16.0]) {
    const arm = armchair(x < 13 ? "#ef476f" : "#06d6a0");
    arm.position.set(x, 0, 10.4);
    arm.rotation.y = x < 13 ? 0.5 : -0.5;
    add(arm);
  }

  // The review whiteboard on the east wall.
  const wb = new THREE.Group();
  wb.position.set(REVIEW_BOARD.x, REVIEW_BOARD.y, REVIEW_BOARD.z);
  wb.rotation.y = -Math.PI / 2;
  const frame = mesh(roundedBox(REVIEW_BOARD.width + 0.16, 0.08, REVIEW_BOARD.height + 0.16, 0.05), toon(PALETTE.metal), 0, 0, -0.02, false);
  frame.rotation.x = Math.PI / 2;
  wb.add(frame);
  const reviewBoard = canvasFace(REVIEW_BOARD.width, REVIEW_BOARD.height);
  reviewBoard.face.position.z = 0.03;
  wb.add(reviewBoard.face);
  wb.add(mesh(box(REVIEW_BOARD.width * 0.7, 0.04, 0.12), toon(PALETTE.metal), 0, -REVIEW_BOARD.height / 2 - 0.06, 0.06, false));
  const wbLabel = textPlane("✍️ Review board", { bg: "#fffaf3", size: 44 });
  wbLabel.position.set(0, REVIEW_BOARD.height / 2 + 0.3, 0.05);
  wb.add(wbLabel);
  add(wb);

  const p = plant(0, 1.2);
  p.position.set(maxX - 0.6, 0, minZ + 0.7);
  add(p);
  const p2 = plant(2, 1.1);
  p2.position.set(minX + 0.7, 0, maxZ - 0.7);
  add(p2);
  for (const x of [11.2, 16]) add(pendantAt(x, 9.8, WALL_HEIGHT, 2.4));

  return { screen, reviewBoard };
}

function armchair(color: string): THREE.Group {
  const g = new THREE.Group();
  const cloth = toon(color);
  g.add(mesh(roundedBox(0.95, 0.4, 0.9, 0.14), cloth, 0, 0.3, 0));
  g.add(mesh(roundedBox(0.95, 0.6, 0.22, 0.1), cloth, 0, 0.7, -0.36));
  for (const sx of [-1, 1]) g.add(mesh(roundedBox(0.18, 0.32, 0.9, 0.08), cloth, sx * 0.45, 0.6, 0));
  return g;
}

// ---------------------------------------------------------------------------
// Odds and ends
// ---------------------------------------------------------------------------

function buildWhiteboard(add: (o: THREE.Object3D) => void): LiveBoard {
  const { x, z, width, height } = WHITEBOARD;
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  const metal = toon(PALETTE.metal);
  const bottom = 0.55;
  for (const sx of [-1, 1]) {
    g.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, bottom + height + 0.15, 8), metal, sx * (width / 2 + 0.06), (bottom + height + 0.15) / 2, 0));
    g.add(mesh(box(0.08, 0.05, 0.8), metal, sx * (width / 2 + 0.06), 0.1, 0));
    for (const sz of [-1, 1]) g.add(mesh(new THREE.SphereGeometry(0.05, 8, 6), toon(INK), sx * (width / 2 + 0.06), 0.05, sz * 0.38));
  }
  g.add(mesh(box(width + 0.1, height + 0.1, 0.05), metal, 0, bottom + height / 2, 0));
  // Its face is drawn by the idea boards (paintIdeaBoard), on both sides.
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = Math.round((1024 * height) / width);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const faces: THREE.Mesh[] = [];
  for (const [rot, dz] of [
    [0, 0.03],
    [Math.PI, -0.03],
  ] as const) {
    const face = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: tex }));
    face.position.set(0, bottom + height / 2, dz);
    face.rotation.y = rot;
    g.add(face);
    faces.push(face);
    const tag = textPlane("💡 Idea board", { bg: "#fffaf3", size: 44 });
    tag.position.set(0, bottom + height + 0.32, dz * 1.5);
    tag.rotation.y = rot;
    g.add(tag);
  }
  g.add(mesh(box(width * 0.6, 0.04, 0.12), metal, 0, bottom - 0.02, 0.08, false));
  for (const [i, col] of ["#ef476f", "#3a86ff", "#2a9d8f"].entries()) {
    g.add(mesh(box(0.14, 0.03, 0.03), toon(col), -0.3 + i * 0.22, bottom + 0.01, 0.1, false));
  }
  add(g);
  return { canvas: c, texture: tex, faces };
}

export function bookshelf(): THREE.Group {
  const g = new THREE.Group();
  const wood = toon(PALETTE.wood);
  const W = 1.7;
  const H = 2.3;
  const D = 0.42;
  for (const sx of [-1, 1]) g.add(mesh(box(0.06, H, D), wood, (sx * (W - 0.06)) / 2, H / 2, 0));
  g.add(mesh(box(W, H, 0.04), toon(PALETTE.woodDark), 0, H / 2, -D / 2 + 0.02, false));
  const covers = ["#e63946", "#457b9d", "#f4a261", "#2a9d8f", "#9b5de5", "#ffd166", "#3d405b"];
  for (let s = 0; s < 5; s++) {
    const y = 0.05 + s * 0.52;
    g.add(mesh(box(W - 0.1, 0.04, D - 0.02), wood, 0, y, 0, false));
    if (s === 4) break;
    let x = -W / 2 + 0.1;
    let k = s * 3;
    while (x < W / 2 - 0.16) {
      const bw = 0.06 + ((k * 7) % 4) * 0.015;
      const bh = 0.3 + ((k * 5) % 4) * 0.03;
      g.add(mesh(box(bw, bh, 0.26), toon(covers[k % covers.length]), x + bw / 2, y + 0.02 + bh / 2, 0.02, false));
      x += bw + 0.012;
      k++;
    }
  }
  const sign = textSprite("📚 Docs", { bg: "#fffaf3", size: 30 });
  sign.position.set(0, H + 0.3, 0);
  g.add(sign);
  return g;
}

/** A potted floor plant: 0 a leafy monstera, 1 a snake plant, 2 a little tree. */
export function plant(kind: number, scale: number): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.CylinderGeometry(0.28, 0.2, 0.5, 14), toon(kind === 1 ? "#8ecae6" : PALETTE.pot), 0, 0.25, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.29, 0.29, 0.06, 14), toon(kind === 1 ? "#6aaecf" : "#d65f43"), 0, 0.5, 0));
  g.add(mesh(new THREE.CircleGeometry(0.25, 14).rotateX(-Math.PI / 2), toon("#6b4226"), 0, 0.46, 0, false));
  const leaf = toon(PALETTE.plant);
  const dark = toon(PALETTE.plantDark);
  if (kind === 1) {
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const h = 0.7 + (i % 3) * 0.2;
      const blade = mesh(new THREE.ConeGeometry(0.07, h, 4), i % 2 ? leaf : dark, Math.sin(a) * 0.1, 0.45 + h / 2, Math.cos(a) * 0.1);
      blade.scale.z = 0.35;
      blade.rotation.set(Math.cos(a) * 0.18, a, -Math.sin(a) * 0.18);
      g.add(blade);
    }
  } else if (kind === 2) {
    g.add(mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.9, 6), toon(PALETTE.woodDark), 0, 0.9, 0));
    for (const [x, y, z, r] of [
      [0, 1.5, 0, 0.36],
      [0.22, 1.32, 0.1, 0.26],
      [-0.2, 1.36, -0.08, 0.28],
      [0.05, 1.75, -0.05, 0.24],
    ]) {
      g.add(mesh(new THREE.IcosahedronGeometry(r, 1), y > 1.6 ? leaf : dark, x, y, z));
    }
  } else {
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const tilt = 0.5 + (i % 2) * 0.25;
      const stem = new THREE.Group();
      stem.position.y = 0.48;
      stem.rotation.set(Math.cos(a) * tilt, 0, -Math.sin(a) * tilt);
      stem.add(mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.55, 4), dark, 0, 0.27, 0, false));
      const l = mesh(new THREE.SphereGeometry(0.2, 10, 8), i % 2 ? leaf : dark, 0, 0.6, 0);
      l.scale.set(1, 0.28, 0.75);
      stem.add(l);
      g.add(stem);
    }
  }
  g.scale.setScalar(scale);
  return g;
}

/** A pendant lamp hanging from the ceiling with its shade `drop` meters down. */
export function pendant(x: number, z: number, drop: number): THREE.Group {
  return pendantAt(x, z, WALL_HEIGHT, drop);
}

function pendantAt(x: number, z: number, ceiling: number, drop: number): THREE.Group {
  const lamp = new THREE.Group();
  lamp.position.set(x, ceiling - drop, z);
  lamp.add(mesh(new THREE.CylinderGeometry(0.008, 0.008, drop, 4), toon(INK), 0, drop / 2, 0, false));
  lamp.add(mesh(new THREE.ConeGeometry(0.4, 0.36, 16, 1, true), toon("#ffd166"), 0, 0, 0, false));
  lamp.add(mesh(new THREE.SphereGeometry(0.13, 10, 8), toon("#fff7d6", { emissive: "#ffe08a" }), 0, -0.12, 0, false));
  return lamp;
}
