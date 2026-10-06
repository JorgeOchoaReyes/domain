import * as THREE from "three";
import {
  BUILDING,
  FLOOR,
  FOUNTAIN,
  FRONT_DOOR,
  HALL,
  KITCHEN,
  LOBBY,
  OFFICE_HALL_DOORS,
  PARTITIONS_X,
  PICNIC,
  PITCH,
  PLAZA,
  ROOM_DOORS,
  SIDEWALK,
  STANDUP,
  STREET,
  WALL_HEIGHT,
  WALL_T,
  WING_ROOMS_Z,
  WORLD_BOUNDS,
  wallRects,
  type Rect,
  DOOR_HEIGHT,
  FRONT_AWNING,
  FRONT_DOOR_HEIGHT,
  LOBBY_OPENING_HEIGHT,
} from "../../shared/layout.js";
import { PALETTE, chair, pendant, plant, type Collider, type LiveBoard } from "./office.js";
import { box, INK, mesh, noOutline, roundedBox, textPlane, toon } from "./toon.js";

/**
 * Builds everything outside the open office: every wall of the building (from
 * the shared floor plan), the hallway and the wing's rooms — kitchen,
 * stand-up room and lobby (the game room is built in gameroom.ts) — the roof,
 * and the grounds round the building: plaza and fountain, the pitch, picnic
 * tables, trees, the street and its parked cars.
 */

export interface Rooms {
  group: THREE.Group;
  /** The areas, each its own group (walls and the roof are always drawn). */
  areas: Record<"hall" | "kitchen" | "standup" | "lobby" | "grounds", THREE.Group>;
  /** Walls (tall: true, one per wallRects() rect) plus furniture, trees, cars, etc. */
  colliders: Collider[];
  /** The stand-up room's big screen on its south wall, facing north (-z). */
  standupScreen: LiveBoard;
  /** The idea board on the stand-up room's east wall. */
  standupIdeas: LiveBoard;
  /** Per frame: the front doors slide open as you come near, the fountain plays. */
  update(dt: number, now: number, player: { x: number; z: number }): void;
}

type Add = (o: THREE.Object3D) => void;

let onFrontDoors: ((opening: boolean) => void) | null = null;
/** Hear the front doors: called as they start to open (true) or close (false). */
export function listenToFrontDoors(cb: (opening: boolean) => void): void {
  onFrontDoors = cb;
}

const H = WALL_HEIGHT;
const T = WALL_T;
const DOOR_H = DOOR_HEIGHT;

export function buildRooms(): Rooms {
  const group = new THREE.Group();
  const colliders: Collider[] = [];
  // Each area in its own group, so the world can skip drawing the ones you can't see.
  const areas = {
    hall: new THREE.Group(),
    kitchen: new THREE.Group(),
    standup: new THREE.Group(),
    lobby: new THREE.Group(),
    grounds: new THREE.Group(),
  };
  for (const g of Object.values(areas)) group.add(g);
  const into =
    (g: THREE.Group): Add =>
    (o) =>
      g.add(o);
  const add: Add = (o) => group.add(o);
  const solid = (x: number, z: number, hw: number, hd: number) =>
    colliders.push({ minX: x - hw, maxX: x + hw, minZ: z - hd, maxZ: z + hd });

  buildWalls(add, colliders);
  buildRoof(add);
  buildHall(into(areas.hall));
  buildKitchen(into(areas.kitchen), solid);
  const { screen: standupScreen, ideaBoard: standupIdeas } = buildStandup(into(areas.standup), solid);
  const door = buildLobby(into(areas.lobby), solid);
  const fountain = buildGrounds(into(areas.grounds), solid);

  noOutline(group);
  return {
    group,
    areas,
    colliders,
    standupScreen,
    standupIdeas,
    update(dt, now, player) {
      door(dt, player);
      fountain(now);
    },
  };
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

const gradientMap = () => toon("#fff").gradientMap;

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat?: [number, number]): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  if (repeat) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat[0], repeat[1]);
  }
  return tex;
}

function mapped(tex: THREE.Texture): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ map: tex, gradientMap: gradientMap() });
}

/** A flat floor over a rect, at a hair above y = 0. */
function floor(add: Add, r: Rect, mat: THREE.Material, y = 0.002): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(r.maxX - r.minX, r.maxZ - r.minZ), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.set((r.minX + r.maxX) / 2, y, (r.minZ + r.maxZ) / 2);
  m.receiveShadow = true;
  add(m);
  return m;
}

let tileCanvas: HTMLCanvasElement | null = null;
/** Ceiling tiles, like the open office's. */
function ceiling(add: Add, r: Rect): void {
  if (!tileCanvas) {
    tileCanvas = document.createElement("canvas");
    tileCanvas.width = tileCanvas.height = 128;
    const g = tileCanvas.getContext("2d")!;
    g.fillStyle = PALETTE.ceiling;
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = "#e2d2bb";
    g.lineWidth = 4;
    g.strokeRect(2, 2, 124, 124);
  }
  const w = r.maxX - r.minX;
  const d = r.maxZ - r.minZ;
  const tex = new THREE.CanvasTexture(tileCanvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(w / 1.2, d / 1.2);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map: tex }));
  m.rotation.x = Math.PI / 2;
  m.position.set((r.minX + r.maxX) / 2, H, (r.minZ + r.maxZ) / 2);
  add(m);
}

/** A framed live canvas: the group sits on a wall, its face toward the group's +z. */
function screenBoard(add: Add, s: { x: number; y: number; z: number; width: number; height: number }, rotY: number, label: string): LiveBoard {
  const g = new THREE.Group();
  g.position.set(s.x, s.y, s.z);
  g.rotation.y = rotY;
  const frame = mesh(roundedBox(s.width + 0.3, 0.12, s.height + 0.3, 0.1), toon("#1b1d2e"), 0, 0, 0, false);
  frame.rotation.x = Math.PI / 2;
  g.add(frame);
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = Math.round((1024 * s.height) / s.width);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(s.width, s.height), new THREE.MeshBasicMaterial({ map: texture }));
  face.position.z = 0.07;
  g.add(face);
  const tag = textPlane(label, { bg: "#fffaf3", size: 64 });
  tag.position.set(0, s.height / 2 + 0.42, 0.12);
  g.add(tag);
  add(g);
  return { canvas, texture };
}

/** A sign on a wall: a text plane whose face points along `rotY`. */
function sign(add: Add, text: string, x: number, y: number, z: number, rotY: number, size = 56, bg = "#fffaf3"): THREE.Mesh {
  const p = textPlane(text, { bg, size });
  p.position.set(x, y, z);
  p.rotation.y = rotY;
  add(p);
  return p;
}

// ---------------------------------------------------------------------------
// Walls, door frames, outside windows and the roof
// ---------------------------------------------------------------------------

function buildWalls(add: Add, colliders: Collider[]): void {
  const wallMat = toon(PALETTE.wall);
  const trimMat = toon(PALETTE.trim);
  for (const r of wallRects()) {
    const w = r.maxX - r.minX;
    const d = r.maxZ - r.minZ;
    const cx = (r.minX + r.maxX) / 2;
    const cz = (r.minZ + r.maxZ) / 2;
    add(mesh(box(w, H, d), wallMat, cx, H / 2, cz, false));
    colliders.push({ ...r, tall: true });
    // Baseboard and picture rail, standing proud of both faces.
    const alongX = w >= d;
    for (const [y, h] of [
      [0.09, 0.18],
      [3.6, 0.08],
    ]) {
      // Where two walls meet, their trims overlap in the corner: the ones along z
      // sit a hair lower and thinner so the two never share a face (no flicker).
      add(mesh(alongX ? box(w, h, d + 0.08) : box(w + 0.08, h - 0.006, d), trimMat, cx, alongX ? y : y - 0.002, cz, false));
    }
  }

  // Door frames, and the wall over each door.
  const doorway = (g: { x0: number; x1: number }, z: number, height = DOOR_H) => {
    const w = g.x1 - g.x0;
    const cx = (g.x0 + g.x1) / 2;
    // The wall over the door starts a little above the opening, inside the
    // trim: if both bottoms sat at the same height they'd flicker as you move.
    const lift = 0.05;
    add(mesh(box(w, H - height - lift, T), wallMat, cx, (H + height + lift) / 2, z, false));
    add(mesh(box(w + 0.24, 0.14, T + 0.14), trimMat, cx, height + 0.07, z, false));
    // The picture rail carries on over the door (the walls either side only have it up to the opening).
    if (height < 3.6 - 0.1) add(mesh(box(w, 0.08, T + 0.08), trimMat, cx, 3.6, z, false));
    for (const x of [g.x0, g.x1]) add(mesh(box(0.12, height, T + 0.14), trimMat, x, height / 2, z, false));
  };
  const officeWallZ = FLOOR.maxZ + T / 2;
  const hallWallZ = HALL.maxZ + T / 2;
  for (const g of OFFICE_HALL_DOORS) {
    doorway(g, officeWallZ);
    const cx = (g.x0 + g.x1) / 2;
    sign(add, "🚪 Hallway · Kitchen · Stand-up · Game room", cx, DOOR_H + 0.5, FLOOR.maxZ - 0.03, Math.PI, 40);
    sign(add, "🖥 Work floor", cx, DOOR_H + 0.5, FLOOR.maxZ + T + 0.03, 0, 48);
  }
  const roomSigns: Record<keyof typeof ROOM_DOORS, string> = {
    kitchen: "☕ Kitchen",
    standup: "☀️ Stand-up",
    lobby: "🛎 Lobby · Way out",
    game: "🕹 Game room",
  };
  for (const [id, g] of Object.entries(ROOM_DOORS) as [keyof typeof ROOM_DOORS, { x0: number; x1: number }][]) {
    doorway(g, hallWallZ, id === "lobby" ? LOBBY_OPENING_HEIGHT : DOOR_H);
    sign(add, roomSigns[id], (g.x0 + g.x1) / 2, (id === "lobby" ? LOBBY_OPENING_HEIGHT : DOOR_H) + 0.5, HALL.maxZ - 0.03, Math.PI, 56);
  }
  doorway(FRONT_DOOR, FRONT_DOOR.z, FRONT_DOOR_HEIGHT);

  buildOutsideWindows(add);
}

/** Decorative windows on the building's outside faces, so it isn't a blank box from the grounds. */
function buildOutsideWindows(add: Add): void {
  const slots: { x: number; z: number; rot: number }[] = [];
  const S = BUILDING.maxZ + T;
  const N = BUILDING.minZ - T;
  const W = BUILDING.minX - T;
  const E = BUILDING.maxX + T;
  for (const x of [-15.5, -12, -8.5, -5, -1.5, 7.5, 11, 14.5]) slots.push({ x, z: S, rot: 0 });
  for (const x of [-15, -10, -5, 0, 5, 12, 16]) slots.push({ x, z: N, rot: Math.PI });
  for (const z of [-10, -5, 0, 5, 10, 19, 24]) {
    slots.push({ x: W, z, rot: -Math.PI / 2 });
    slots.push({ x: E, z, rot: Math.PI / 2 });
  }
  const rows = [2.3, 4.75];
  const count = slots.length * rows.length;
  const frames = new THREE.InstancedMesh(box(2.4, 1.8, 0.08), toon("#ffffff"), count);
  const panes = new THREE.InstancedMesh(box(2.12, 1.52, 0.06), toon("#9fd3f5"), count);
  const sills = new THREE.InstancedMesh(box(2.6, 0.12, 0.22), toon(PALETTE.trim), count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  let i = 0;
  for (const s of slots) {
    q.setFromAxisAngle(up, s.rot);
    const nx = Math.sin(s.rot);
    const nz = Math.cos(s.rot);
    for (const y of rows) {
      m.compose(new THREE.Vector3(s.x + nx * 0.04, y, s.z + nz * 0.04), q, one);
      frames.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(s.x + nx * 0.09, y, s.z + nz * 0.09), q, one);
      panes.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(s.x + nx * 0.11, y - 0.95, s.z + nz * 0.11), q, one);
      sills.setMatrixAt(i, m);
      i++;
    }
  }
  for (const im of [frames, panes, sills]) add(im);
}

function buildRoof(add: Add): void {
  const minX = BUILDING.minX - T;
  const maxX = BUILDING.maxX + T;
  const minZ = BUILDING.minZ - T;
  const maxZ = BUILDING.maxZ + T;
  const w = maxX - minX;
  const d = maxZ - minZ;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  add(mesh(box(w + 0.2, 0.3, d + 0.2), toon("#9aa3b2"), cx, H + 0.05 + 0.15, cz, false));
  // A fascia round the top edge hides the seam between the walls and the roof.
  const fascia = toon(PALETTE.trim);
  add(mesh(box(w + 0.4, 0.7, 0.2), fascia, cx, H + 0.05, minZ - 0.1, false));
  add(mesh(box(w + 0.4, 0.7, 0.2), fascia, cx, H + 0.05, maxZ + 0.1, false));
  add(mesh(box(0.2, 0.7, d + 0.4), fascia, minX - 0.1, H + 0.05, cz, false));
  add(mesh(box(0.2, 0.7, d + 0.4), fascia, maxX + 0.1, H + 0.05, cz, false));
  // Air handlers on the roof.
  const unit = toon("#c9ced8");
  for (const [x, z] of [
    [-8, -4],
    [6, 2],
    [-2, 20],
  ]) {
    add(mesh(roundedBox(2.4, 1.2, 1.6, 0.1), unit, x, H + 0.95, z));
    add(mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.1, 16), toon("#3d405b"), x + 0.5, H + 1.6, z, false));
  }
}

// ---------------------------------------------------------------------------
// The hallway
// ---------------------------------------------------------------------------

function buildHall(add: Add): void {
  const base = canvasTexture(128, 128, (g) => {
    g.fillStyle = "#e9dfcf";
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = "#dfd2bf";
    g.fillRect(0, 62, 128, 4);
    g.fillRect(62, 0, 4, 128);
  }, [(HALL.maxX - HALL.minX) / 1.5, (WING_ROOMS_Z - FLOOR.maxZ) / 1.5]);
  floor(add, { minX: HALL.minX, maxX: HALL.maxX, minZ: FLOOR.maxZ, maxZ: WING_ROOMS_Z }, mapped(base));
  // A runner down the middle.
  const runnerTex = canvasTexture(256, 64, (g) => {
    g.fillStyle = "#c8553d";
    g.fillRect(0, 0, 256, 64);
    g.strokeStyle = "#ffd166";
    g.lineWidth = 4;
    g.strokeRect(6, 6, 244, 52);
    g.fillStyle = "#e07a5f";
    for (let x = 20; x < 256; x += 40) {
      g.beginPath();
      g.arc(x, 32, 7, 0, Math.PI * 2);
      g.fill();
    }
  }, [(HALL.maxX - HALL.minX - 2) / 4, 1]);
  const midZ = (HALL.minZ + HALL.maxZ) / 2;
  floor(add, { minX: HALL.minX + 1, maxX: HALL.maxX - 1, minZ: midZ - 0.8, maxZ: midZ + 0.8 }, mapped(runnerTex), 0.006);
  ceiling(add, HALL);

  // Framed posters on both walls.
  const posters: [string, string, string][] = [
    ["🚀", "SHIP IT", "#ff8a5b"],
    ["🧪", "STAY CURIOUS", "#5bc0eb"],
    ["🐛", "SQUASH BUGS", "#9bc53d"],
    ["🎯", "ONE GOAL", "#b388eb"],
    ["☕", "REFUEL", "#ffb400"],
    ["🤝", "REVIEW KINDLY", "#ef476f"],
    ["🎮", "PLAY HARD", "#06d6a0"],
  ];
  const spots: [number, number, number][] = [
    [-16, HALL.minZ + 0.03, 0],
    [-6.5, HALL.minZ + 0.03, 0],
    [8, HALL.minZ + 0.03, 0],
    [14, HALL.minZ + 0.03, 0],
    [-10.5, HALL.maxZ - 0.03, Math.PI],
    [-1.6, HALL.maxZ - 0.03, Math.PI],
    [16, HALL.maxZ - 0.03, Math.PI],
  ];
  const frameMat = toon(PALETTE.woodDark);
  spots.forEach(([x, z, rot], i) => {
    const [icon, text, color] = posters[i % posters.length];
    const tex = canvasTexture(240, 320, (g) => {
      g.fillStyle = color;
      g.fillRect(0, 0, 240, 320);
      g.fillStyle = "rgba(255,255,255,.25)";
      g.beginPath();
      g.arc(120, 130, 90, 0, Math.PI * 2);
      g.fill();
      g.font = "110px serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(icon, 120, 135);
      g.fillStyle = "#fff";
      g.font = '900 30px Nunito, ui-rounded, "Segoe UI", sans-serif';
      g.fillText(text, 120, 278);
    });
    const p = new THREE.Group();
    p.position.set(x, 1.9, z);
    p.rotation.y = rot;
    p.add(mesh(box(1.1, 1.42, 0.05), frameMat, 0, 0, 0.02, false));
    const face = new THREE.Mesh(new THREE.PlaneGeometry(0.96, 1.28), new THREE.MeshBasicMaterial({ map: tex }));
    face.position.z = 0.05;
    p.add(face);
    add(p);
  });

  for (const x of [-17.4, 17.4]) {
    const p = plant(1, 1.1);
    p.position.set(x, 0, midZ);
    add(p);
  }
  for (const x of [-14, -6, 2, 10]) add(pendant(x, midZ, 2.4));
}

// ---------------------------------------------------------------------------
// The kitchen
// ---------------------------------------------------------------------------

function buildKitchen(add: Add, solid: (x: number, z: number, hw: number, hd: number) => void): void {
  const room: Rect = { minX: BUILDING.minX, maxX: PARTITIONS_X[0], minZ: WING_ROOMS_Z, maxZ: BUILDING.maxZ };
  const tiles = canvasTexture(128, 128, (g) => {
    g.fillStyle = "#f7fbf8";
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = "#bde0c4";
    g.fillRect(0, 0, 64, 64);
    g.fillRect(64, 64, 64, 64);
  }, [(room.maxX - room.minX) / 1.4, (room.maxZ - room.minZ) / 1.4]);
  floor(add, room, mapped(tiles));
  ceiling(add, { ...room, maxX: room.maxX - T / 2 });

  // The counter along the west wall, the fridge at its south end.
  const c = KITCHEN.counter;
  const fridgeZ0 = KITCHEN.fridge.z - 0.55;
  const cx = (c.minX + c.maxX) / 2;
  const len = fridgeZ0 - c.minZ;
  const cz = c.minZ + len / 2;
  add(mesh(box(c.maxX - c.minX, 0.86, len), toon("#5bc0eb"), cx, 0.43, cz));
  add(mesh(box(c.maxX - c.minX + 0.06, 0.07, len + 0.04), toon("#f4f1ea"), cx, 0.895, cz));
  // Cabinet doors.
  const knob = toon(INK);
  for (let z = c.minZ + 0.5; z < fridgeZ0 - 0.2; z += 0.75) {
    add(mesh(box(0.02, 0.6, 0.62), toon("#7fd0f0"), c.maxX + 0.005, 0.45, z, false));
    add(mesh(box(0.04, 0.05, 0.05), knob, c.maxX + 0.03, 0.68, z + 0.22, false));
  }
  // Cabinets overhead.
  add(mesh(box(0.42, 0.75, len), toon("#ffffff"), c.minX + 0.21, 2.35, cz));
  solid(cx, (c.minZ + c.maxZ) / 2, (c.maxX - c.minX) / 2, (c.maxZ - c.minZ) / 2);
  // Sink.
  add(mesh(box(0.5, 0.04, 0.7), toon("#9aa3b2"), cx + 0.05, 0.935, 19.5, false));
  add(mesh(box(0.42, 0.02, 0.6), toon("#4a5568"), cx + 0.05, 0.95, 19.5, false));
  const tap = mesh(new THREE.TorusGeometry(0.14, 0.025, 6, 12, Math.PI), toon(PALETTE.metal), c.minX + 0.18, 1.06, 19.5, false);
  tap.rotation.y = Math.PI / 2;
  add(tap);
  // Fridge.
  const fz = KITCHEN.fridge.z;
  add(mesh(roundedBox(0.85, 2.1, 1.05, 0.08), toon("#e9ecef"), KITCHEN.fridge.x, 1.05, fz));
  add(mesh(box(0.02, 0.02, 1.0), toon("#c9ced8"), KITCHEN.fridge.x + 0.43, 1.35, fz, false));
  for (const y of [0.9, 1.7]) add(mesh(box(0.05, 0.35, 0.05), toon(PALETTE.metal), KITCHEN.fridge.x + 0.46, y, fz - 0.38, false));
  // Fridge magnets.
  ["#ef476f", "#ffd166", "#06d6a0"].forEach((col, i) =>
    add(mesh(new THREE.CircleGeometry(0.05, 10).rotateY(Math.PI / 2), toon(col), KITCHEN.fridge.x + 0.44, 1.55 + i * 0.12, fz + 0.1 - i * 0.12, false)),
  );

  // The coffee machine: red and chrome, a cup under the spout.
  const cm = new THREE.Group();
  cm.position.set(KITCHEN.coffee.x + 0.05, 0.93, KITCHEN.coffee.z);
  cm.rotation.y = Math.PI / 2; // front faces +x, into the room
  cm.add(mesh(roundedBox(0.62, 0.72, 0.5, 0.08), toon("#e63946"), 0, 0.36, -0.05));
  cm.add(mesh(roundedBox(0.66, 0.1, 0.54, 0.05), toon("#c9ced8"), 0, 0.77, -0.05));
  cm.add(mesh(box(0.44, 0.06, 0.3), toon("#c9ced8"), 0, 0.03, 0.2, false));
  cm.add(mesh(box(0.12, 0.12, 0.12), toon(PALETTE.metal), 0, 0.5, 0.24, false));
  cm.add(mesh(new THREE.CircleGeometry(0.07, 14), toon("#1b1d2e", { emissive: "#06d6a0" }), -0.18, 0.6, 0.205, false));
  const cup = new THREE.Group();
  cup.position.set(0, 0.06, 0.24);
  cup.add(mesh(new THREE.CylinderGeometry(0.07, 0.055, 0.14, 12), toon("#ffffff"), 0, 0.07, 0));
  cup.add(mesh(new THREE.CircleGeometry(0.062, 12).rotateX(-Math.PI / 2), toon("#6f4518"), 0, 0.135, 0, false));
  cm.add(cup);
  add(cm);
  sign(add, "☕ Coffee", KITCHEN.coffee.x + 0.15, 1.95, KITCHEN.coffee.z, Math.PI / 2, 48, "#fff3d6");

  // Two round tables with chairs.
  const colors = PALETTE.chairs;
  KITCHEN.tables.forEach((t, ti) => {
    add(mesh(new THREE.CylinderGeometry(0.75, 0.75, 0.06, 24), toon(PALETTE.wood), t.x, 0.75, t.z));
    add(mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.72, 10), toon(INK), t.x, 0.36, t.z));
    add(mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.03, 16), toon(INK), t.x, 0.015, t.z, false));
    const seats: [number, number, number][] = [
      [0, 1.0, 0],
      [0, -1.0, Math.PI],
      [1.0, 0, Math.PI / 2],
      [-1.0, 0, -Math.PI / 2],
    ];
    seats.forEach(([dx, dz, rot], i) => {
      const ch = chair(colors[(ti * 4 + i) % colors.length]);
      ch.position.set(t.x + dx, 0, t.z + dz);
      ch.rotation.y = rot;
      add(ch);
    });
    solid(t.x, t.z, 1.3, 1.3);
    if (ti === 0) {
      // A fruit bowl.
      add(mesh(new THREE.SphereGeometry(0.2, 14, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), toon("#ffffff"), t.x, 0.98, t.z));
      [
        ["#ef476f", 0.06, 0],
        ["#ffd166", -0.07, 0.05],
        ["#9bc53d", 0, -0.07],
      ].forEach(([col, ox, oz]) => add(mesh(new THREE.SphereGeometry(0.07, 10, 8), toon(col as string), t.x + (ox as number), 0.86, t.z + (oz as number))));
    } else {
      // A pizza box, it's that kind of day.
      add(mesh(box(0.5, 0.05, 0.5), toon("#f4d6a0"), t.x, 0.805, t.z));
    }
    add(pendant(t.x, t.z, 2.9));
  });

  // Water cooler by the door.
  const wc = new THREE.Group();
  wc.position.set(PARTITIONS_X[0] - T / 2 - 0.4, 0, 18.0);
  wc.add(mesh(roundedBox(0.4, 1.0, 0.4, 0.05), toon("#f4f1ea"), 0, 0.5, 0));
  wc.add(mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.48, 14), toon("#8ecae6", { opacity: 0.75 }), 0, 1.24, 0));
  wc.add(mesh(box(0.06, 0.08, 0.06), toon("#5bc0eb"), -0.21, 0.75, 0, false));
  add(wc);
  solid(wc.position.x, wc.position.z, 0.25, 0.25);

  // The menu board on the east wall.
  const menu = canvasTexture(512, 384, (g) => {
    g.fillStyle = "#2f3e46";
    g.fillRect(0, 0, 512, 384);
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.font = '900 44px Nunito, ui-rounded, "Segoe UI", sans-serif';
    g.fillText("Today's menu", 256, 64);
    g.textAlign = "left";
    g.font = '700 32px Nunito, ui-rounded, "Segoe UI", sans-serif';
    ["☕  Free coffee (speed boost!)", "🍩  Donuts", "🥗  Big salad", "🍕  Pizza Friday"].forEach((l, i) => g.fillText(l, 40, 140 + i * 58));
  });
  const mb = new THREE.Group();
  mb.position.set(PARTITIONS_X[0] - T / 2 - 0.03, 2.1, 23.5);
  mb.rotation.y = -Math.PI / 2;
  mb.add(mesh(box(2.1, 1.6, 0.05), toon(PALETTE.woodDark), 0, 0, 0, false));
  const mf = new THREE.Mesh(new THREE.PlaneGeometry(1.95, 1.45), new THREE.MeshBasicMaterial({ map: menu }));
  mf.position.z = 0.03;
  mb.add(mf);
  add(mb);

  const p = plant(0, 1.2);
  p.position.set(PARTITIONS_X[0] - 0.6, 0, BUILDING.maxZ - 0.6);
  add(p);
  solid(p.position.x, p.position.z, 0.35, 0.35);
}

// ---------------------------------------------------------------------------
// The stand-up room
// ---------------------------------------------------------------------------

function buildStandup(add: Add, solid: (x: number, z: number, hw: number, hd: number) => void): { screen: LiveBoard; ideaBoard: LiveBoard } {
  const room: Rect = { minX: PARTITIONS_X[0], maxX: PARTITIONS_X[1], minZ: WING_ROOMS_Z, maxZ: BUILDING.maxZ };
  const carpet = canvasTexture(128, 128, (g) => {
    g.fillStyle = "#ffe8b0";
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = "#ffdb8a";
    for (let y = 8; y < 128; y += 32) for (let x = 8 + ((y / 32) % 2) * 16; x < 128; x += 32) g.fillRect(x, y, 6, 6);
  }, [(room.maxX - room.minX) / 1.6, (room.maxZ - room.minZ) / 1.6]);
  floor(add, room, mapped(carpet));
  ceiling(add, { ...room, minX: room.minX + T / 2, maxX: room.maxX - T / 2 });

  const screen = screenBoard(add, STANDUP.screen, Math.PI, "☀️ Stand-up");
  const g = screen.canvas.getContext("2d")!;
  g.fillStyle = "#1b1d2e";
  g.fillRect(0, 0, screen.canvas.width, screen.canvas.height);
  g.fillStyle = "#ffd166";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = '900 72px Nunito, ui-rounded, "Segoe UI", sans-serif';
  g.fillText("☀️ Stand-up", screen.canvas.width / 2, screen.canvas.height / 2 - 30);
  g.fillStyle = "#c9ced8";
  g.font = '700 36px Nunito, ui-rounded, "Segoe UI", sans-serif';
  g.fillText("Set the goal and the tone for the session", screen.canvas.width / 2, screen.canvas.height / 2 + 40);
  screen.texture.needsUpdate = true;

  // The circle you stand in.
  const c = STANDUP.circle;
  const ring = new THREE.Mesh(new THREE.RingGeometry(c.r - 0.14, c.r, 56), new THREE.MeshBasicMaterial({ color: "#ff8a5b" }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(c.x, 0.012, c.z);
  add(ring);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(c.r - 0.14, 56), new THREE.MeshBasicMaterial({ color: "#fff3d6" }));
  disc.rotation.x = -Math.PI / 2;
  disc.position.set(c.x, 0.009, c.z);
  add(disc);
  // Footprints round the edge, where people stand.
  const foot = new THREE.MeshBasicMaterial({ color: "#ffb38a" });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const f = new THREE.Mesh(new THREE.CircleGeometry(0.16, 12), foot);
    f.rotation.x = -Math.PI / 2;
    f.position.set(c.x + Math.sin(a) * (c.r - 0.45), 0.014, c.z + Math.cos(a) * (c.r - 0.45));
    add(f);
  }

  // Tall standing tables at the sides.
  for (const x of [room.minX + 1.0, room.maxX - 1.0]) {
    add(mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.05, 20), toon(PALETTE.wood), x, 1.08, 19.8));
    add(mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.06, 8), toon(INK), x, 0.53, 19.8));
    add(mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.03, 16), toon(INK), x, 0.015, 19.8, false));
    solid(x, 19.8, 0.45, 0.45);
  }

  // A sticky-note wall on the west partition.
  const corkX = room.minX + T / 2 + 0.04;
  const cork = mesh(box(0.05, 1.8, 6.4), toon("#d4a373"), corkX, 1.8, 23.2, false);
  add(cork);
  const noteColors = ["#ffd166", "#ff8fab", "#8ecae6", "#b5e48c", "#e0c3fc"];
  const notes = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.28, 0.28), new THREE.MeshBasicMaterial({ color: "#ffffff" }), 48);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const col = new THREE.Color();
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 48; i++) {
    const row = Math.floor(i / 12);
    const k = i % 12;
    q.setFromEuler(new THREE.Euler(0, Math.PI / 2, (rnd() - 0.5) * 0.3));
    m.compose(new THREE.Vector3(corkX + 0.03, 1.15 + row * 0.42 + (rnd() - 0.5) * 0.06, 20.4 + k * 0.5 + (rnd() - 0.5) * 0.08), q, new THREE.Vector3(1, 1, 1));
    notes.setMatrixAt(i, m);
    notes.setColorAt(i, col.set(noteColors[Math.floor(rnd() * noteColors.length)]));
  }
  add(notes);

  // The idea board on the east partition (drawn by paintIdeaBoard).
  const ideas = document.createElement("canvas");
  ideas.width = 1024;
  ideas.height = Math.round((1024 * 1.6) / 2.75);
  const wbTex = new THREE.CanvasTexture(ideas);
  wbTex.colorSpace = THREE.SRGBColorSpace;
  wbTex.anisotropy = 8;
  const wb = new THREE.Group();
  wb.position.set(room.maxX - T / 2 - 0.04, 1.85, STANDUP.circle.z);
  wb.rotation.y = -Math.PI / 2;
  wb.add(mesh(box(2.9, 1.75, 0.06), toon("#c9ced8"), 0, 0, 0, false));
  const wf = new THREE.Mesh(new THREE.PlaneGeometry(2.75, 1.6), new THREE.MeshBasicMaterial({ map: wbTex }));
  wf.position.z = 0.035;
  const wbTag = textPlane("💡 Idea board", { bg: "#fffaf3", size: 44 });
  wbTag.position.set(0, 1.12, 0.05);
  wb.add(wbTag);
  wb.add(wf);
  add(wb);
  const ideaBoard: LiveBoard = { canvas: ideas, texture: wbTex, faces: [wf] };

  for (const x of [room.minX + 0.7, room.maxX - 0.7]) {
    const p = plant(2, 1.1);
    p.position.set(x, 0, BUILDING.maxZ - 0.6);
    add(p);
    solid(x, BUILDING.maxZ - 0.6, 0.35, 0.35);
  }
  add(pendant(c.x - 1.6, c.z, 2.6));
  add(pendant(c.x + 1.6, c.z, 2.6));
  return { screen, ideaBoard };
}

// ---------------------------------------------------------------------------
// The lobby and the front doors
// ---------------------------------------------------------------------------

function buildLobby(add: Add, solid: (x: number, z: number, hw: number, hd: number) => void): (dt: number, p: { x: number; z: number }) => void {
  const room: Rect = { minX: PARTITIONS_X[1], maxX: PARTITIONS_X[2], minZ: WING_ROOMS_Z, maxZ: BUILDING.maxZ + T };
  const stone = canvasTexture(256, 256, (g) => {
    g.fillStyle = "#ece8e1";
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = "#d6d0c4";
    g.lineWidth = 3;
    g.strokeRect(1, 1, 126, 126);
    g.strokeRect(129, 1, 126, 126);
    g.strokeRect(1, 129, 126, 126);
    g.strokeRect(129, 129, 126, 126);
    g.fillStyle = "rgba(255,255,255,.6)";
    g.fillRect(20, 20, 40, 6);
    g.fillRect(150, 160, 50, 6);
  }, [(room.maxX - room.minX) / 2, (room.maxZ - room.minZ) / 2]);
  floor(add, room, mapped(stone));
  ceiling(add, { minX: room.minX + T / 2, maxX: room.maxX - T / 2, minZ: WING_ROOMS_Z, maxZ: BUILDING.maxZ });

  // Reception desk, long along z on the west side.
  const d = LOBBY.desk;
  const desk = new THREE.Group();
  desk.position.set(d.x, 0, d.z);
  desk.add(mesh(roundedBox(0.8, 1.05, d.length, 0.1), toon(PALETTE.wood), 0, 0.525, 0));
  desk.add(mesh(roundedBox(0.95, 0.06, d.length + 0.1, 0.06), toon("#ffffff"), 0, 1.08, 0));
  desk.add(mesh(box(0.02, 0.3, d.length - 0.3), toon("#ff8a5b"), 0.41, 0.7, 0, false));
  // Monitor and a bell.
  desk.add(mesh(box(0.05, 0.36, 0.55), toon("#1b1d2e"), -0.2, 1.35, -0.4));
  desk.add(mesh(box(0.04, 0.12, 0.04), toon(INK), -0.2, 1.15, -0.4, false));
  desk.add(mesh(new THREE.SphereGeometry(0.08, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), toon("#ffd166"), 0.2, 1.11, 0.6));
  add(desk);
  solid(d.x, d.z, 0.48, d.length / 2 + 0.05);

  // The company sign behind the desk.
  sign(add, "🏢 domain", room.minX + T / 2 + 0.03, 3.2, d.z, Math.PI / 2, 110, "#fff3d6");
  sign(add, "Make work fun — without faking it", room.minX + T / 2 + 0.03, 2.35, d.z, Math.PI / 2, 34);

  // A couch on the east side, facing west.
  const c = LOBBY.couch;
  const couch = new THREE.Group();
  couch.position.set(c.x, 0, c.z);
  const fabric = toon("#5bc0eb");
  couch.add(mesh(roundedBox(0.9, 0.45, 2.2, 0.12), fabric, 0, 0.25, 0));
  couch.add(mesh(roundedBox(0.25, 0.75, 2.2, 0.1), fabric, 0.33, 0.6, 0));
  for (const s of [-1, 1]) couch.add(mesh(roundedBox(0.9, 0.6, 0.22, 0.08), fabric, 0, 0.4, s * 1.0));
  for (const s of [-1, 1]) couch.add(mesh(roundedBox(0.55, 0.14, 0.95, 0.06), toon("#8ecae6"), -0.08, 0.53, s * 0.48));
  add(couch);
  solid(c.x, c.z, 0.47, 1.12);

  for (const [x, z, k] of [
    [room.minX + 0.6, BUILDING.maxZ - 0.6, 1],
    [room.maxX - 0.6, BUILDING.maxZ - 0.6, 2],
    [room.maxX - 0.55, 21.6, 0],
  ] as const) {
    const p = plant(k, 1.15);
    p.position.set(x, 0, z);
    add(p);
    solid(x, z, 0.35, 0.35);
  }

  // Welcome mat inside the doors.
  const matTex = canvasTexture(256, 128, (g) => {
    g.fillStyle = "#8a5a3b";
    g.fillRect(0, 0, 256, 128);
    g.strokeStyle = "#ffd166";
    g.lineWidth = 6;
    g.strokeRect(10, 10, 236, 108);
    g.fillStyle = "#ffd166";
    g.font = '900 40px Nunito, ui-rounded, "Segoe UI", sans-serif';
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("WELCOME", 128, 66);
  });
  const mat = new THREE.Mesh(new THREE.PlaneGeometry(2, 1), new THREE.MeshBasicMaterial({ map: matTex }));
  mat.rotation.x = -Math.PI / 2;
  mat.rotation.z = Math.PI; // reads from inside, walking in
  mat.position.set((FRONT_DOOR.x0 + FRONT_DOOR.x1) / 2, 0.01, BUILDING.maxZ - 0.7);
  add(mat);
  add(pendant((room.minX + room.maxX) / 2, 22.5, 2.4));

  // Sliding glass doors.
  const glass = toon("#bfe3ff", { opacity: 0.4 });
  const edge = toon("#9aa3b2");
  const half = (FRONT_DOOR.x1 - FRONT_DOOR.x0) / 2;
  const cx = (FRONT_DOOR.x0 + FRONT_DOOR.x1) / 2;
  const panel = () => {
    const g = new THREE.Group();
    g.add(mesh(box(half, 2.55, 0.05), glass, 0, 1.3, 0, false));
    g.add(mesh(box(half, 0.08, 0.08), edge, 0, 2.58, 0, false));
    g.add(mesh(box(half, 0.08, 0.08), edge, 0, 0.04, 0, false));
    g.add(mesh(box(0.06, 2.6, 0.08), edge, half / 2 - 0.03, 1.3, 0, false));
    g.add(mesh(box(0.06, 2.6, 0.08), edge, -half / 2 + 0.03, 1.3, 0, false));
    g.position.z = FRONT_DOOR.z;
    add(g);
    return g;
  };
  const left = panel();
  const right = panel();
  let open = 0;
  const place = () => {
    left.position.x = cx - half / 2 - open * (half - 0.08);
    right.position.x = cx + half / 2 + open * (half - 0.08);
  };
  place();
  let wasNear = false;
  return (dt, p) => {
    const near = Math.hypot(p.x - cx, p.z - FRONT_DOOR.z) < 3.2;
    if (near !== wasNear) {
      wasNear = near;
      onFrontDoors?.(near);
    }
    open += ((near ? 1 : 0) - open) * Math.min(1, dt * 6);
    place();
  };
}

// ---------------------------------------------------------------------------
// The grounds
// ---------------------------------------------------------------------------

function buildGrounds(add: Add, solid: (x: number, z: number, hw: number, hd: number) => void): (now: number) => void {
  // Grass to the horizon.
  const grassTex = canvasTexture(128, 128, (g) => {
    g.fillStyle = "#8fd16b";
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = "#84c85f";
    for (let i = 0; i < 40; i++) g.fillRect((i * 37) % 128, (i * 71) % 128, 3, 8);
  }, [120, 120]);
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(480, 480), mapped(grassTex));
  grass.rotation.x = -Math.PI / 2;
  grass.position.set(0, -0.02, 13);
  grass.receiveShadow = true;
  add(grass);

  // The plaza out front, a path to the street, and a round plaza for the fountain.
  const paving = (w: number, d: number) =>
    mapped(
      canvasTexture(128, 128, (g) => {
        g.fillStyle = "#dcd6cc";
        g.fillRect(0, 0, 128, 128);
        g.strokeStyle = "#c4bcae";
        g.lineWidth = 3;
        g.strokeRect(1, 1, 62, 62);
        g.strokeRect(65, 1, 62, 62);
        g.strokeRect(33, 65, 62, 62);
        g.strokeRect(-31, 65, 62, 62);
        g.strokeRect(97, 65, 62, 62);
      }, [w / 1.6, d / 1.6]),
    );
  floor(add, PLAZA, paving(PLAZA.maxX - PLAZA.minX, PLAZA.maxZ - PLAZA.minZ), 0.004);
  const path = { minX: FOUNTAIN.x - 1.3, maxX: FOUNTAIN.x + 1.3, minZ: PLAZA.maxZ, maxZ: SIDEWALK.minZ };
  floor(add, path, paving(2.6, path.maxZ - path.minZ), 0.004);
  const round = new THREE.Mesh(new THREE.CircleGeometry(FOUNTAIN.r + 1.9, 40), toon("#dcd6cc"));
  round.rotation.x = -Math.PI / 2;
  round.position.set(FOUNTAIN.x, 0.006, FOUNTAIN.z);
  round.receiveShadow = true;
  add(round);

  // The fountain.
  const f = new THREE.Group();
  f.position.set(FOUNTAIN.x, 0, FOUNTAIN.z);
  const stoneMat = toon("#c9ced8");
  f.add(mesh(new THREE.CylinderGeometry(FOUNTAIN.r, FOUNTAIN.r + 0.1, 0.55, 32, 1, true), stoneMat, 0, 0.275, 0));
  f.add(mesh(new THREE.TorusGeometry(FOUNTAIN.r, 0.12, 6, 32).rotateX(Math.PI / 2), stoneMat, 0, 0.55, 0));
  const water = new THREE.Mesh(new THREE.CircleGeometry(FOUNTAIN.r - 0.05, 32), toon("#5bc0eb"));
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0.42;
  f.add(water);
  f.add(mesh(new THREE.CylinderGeometry(0.22, 0.32, 1.3, 14), stoneMat, 0, 0.9, 0));
  f.add(mesh(new THREE.CylinderGeometry(0.9, 0.35, 0.25, 20), stoneMat, 0, 1.6, 0));
  const top = new THREE.Mesh(new THREE.CircleGeometry(0.8, 20), toon("#8ecae6"));
  top.rotation.x = -Math.PI / 2;
  top.position.y = 1.72;
  f.add(top);
  const spout = mesh(new THREE.ConeGeometry(0.16, 0.9, 10, 1, true), toon("#bfe3ff", { opacity: 0.7 }), 0, 2.15, 0, false);
  f.add(spout);
  const ripples: THREE.Mesh[] = [];
  for (let i = 0; i < 2; i++) {
    const r = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.0, 32), new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.5 }));
    r.rotation.x = -Math.PI / 2;
    r.position.y = 0.43;
    f.add(r);
    ripples.push(r);
  }
  add(f);
  solid(FOUNTAIN.x, FOUNTAIN.z, FOUNTAIN.r + 0.05, FOUNTAIN.r + 0.05);

  // Sidewalk, curb and street.
  const wb = WORLD_BOUNDS;
  floor(add, { minX: wb.minX - 6, maxX: wb.maxX + 6, minZ: SIDEWALK.minZ, maxZ: SIDEWALK.maxZ }, toon("#e3ddd2"), 0.008);
  add(mesh(box(wb.maxX - wb.minX + 12, 0.12, 0.2), toon("#c4bcae"), 0, 0.06, SIDEWALK.maxZ, false));
  floor(add, { minX: wb.minX - 6, maxX: wb.maxX + 6, minZ: STREET.minZ, maxZ: STREET.maxZ }, toon("#4a4e5a"), 0.005);
  const laneZ = (STREET.minZ + STREET.maxZ) / 2;
  const dashCount = Math.floor((wb.maxX - wb.minX + 12) / 3);
  const dashes = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.6, 0.18).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#ffd166" }), dashCount);
  const m = new THREE.Matrix4();
  for (let i = 0; i < dashCount; i++) {
    m.makeTranslation(wb.minX - 6 + 1.5 + i * 3, 0.012, laneZ);
    dashes.setMatrixAt(i, m);
  }
  add(dashes);

  // The parked cars are in cars.ts (you can drive them).

  // The pitch: lighter grass, lines, and a goal at each end.
  const pw = PITCH.maxX - PITCH.minX;
  const pd = PITCH.maxZ - PITCH.minZ;
  const pitchTex = canvasTexture(1024, Math.round((1024 * pd) / pw), (g) => {
    const W = g.canvas.width;
    const Hh = g.canvas.height;
    for (let i = 0; i < 12; i++) {
      g.fillStyle = i % 2 ? "#9ddc78" : "#a9e386";
      g.fillRect((i * W) / 12, 0, W / 12 + 1, Hh);
    }
    g.strokeStyle = "#ffffff";
    g.lineWidth = 8;
    g.strokeRect(10, 10, W - 20, Hh - 20);
    g.beginPath();
    g.moveTo(W / 2, 10);
    g.lineTo(W / 2, Hh - 10);
    g.stroke();
    g.beginPath();
    g.arc(W / 2, Hh / 2, Hh * 0.18, 0, Math.PI * 2);
    g.stroke();
    const bw = W * 0.14;
    const bh = Hh * 0.5;
    g.strokeRect(10, (Hh - bh) / 2, bw, bh);
    g.strokeRect(W - 10 - bw, (Hh - bh) / 2, bw, bh);
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.arc(W / 2, Hh / 2, 8, 0, Math.PI * 2);
    g.fill();
  });
  floor(add, PITCH, mapped(pitchTex), 0.006);
  const netTex = canvasTexture(128, 128, (g) => {
    g.clearRect(0, 0, 128, 128);
    g.strokeStyle = "#ffffff";
    g.lineWidth = 3;
    for (let i = 0; i <= 128; i += 16) {
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i, 128);
      g.moveTo(0, i);
      g.lineTo(128, i);
      g.stroke();
    }
  }, [3, 2]);
  const netMat = new THREE.MeshBasicMaterial({ map: netTex, transparent: true, alphaTest: 0.1, side: THREE.DoubleSide });
  const postMat = toon("#ffffff");
  const midZ = (PITCH.minZ + PITCH.maxZ) / 2;
  const gw = PITCH.goalWidth;
  const GH = 1.8;
  const GD = 1.2;
  for (const [lineX, out] of [
    [PITCH.minX, -1],
    [PITCH.maxX, 1],
  ] as const) {
    const backX = lineX + out * GD;
    for (const z of [midZ - gw / 2, midZ + gw / 2]) {
      add(mesh(new THREE.CylinderGeometry(0.07, 0.07, GH, 8), postMat, lineX, GH / 2, z));
      solid(lineX, z, 0.1, 0.1);
      // Side nets.
      const side = new THREE.Mesh(new THREE.PlaneGeometry(GD, GH), netMat);
      side.position.set(lineX + (out * GD) / 2, GH / 2, z);
      add(side);
      colliders(lineX + (out * GD) / 2, z, GD / 2, 0.06);
    }
    const bar = mesh(new THREE.CylinderGeometry(0.07, 0.07, gw, 8), postMat, lineX, GH, midZ);
    bar.rotation.x = Math.PI / 2;
    add(bar);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(gw, GH), netMat);
    back.rotation.y = Math.PI / 2;
    back.position.set(backX, GH / 2, midZ);
    add(back);
    colliders(backX, midZ, 0.08, gw / 2);
    const roof = new THREE.Mesh(new THREE.PlaneGeometry(GD, gw), netMat);
    roof.rotation.x = Math.PI / 2;
    roof.position.set(lineX + (out * GD) / 2, GH, midZ);
    add(roof);
  }
  function colliders(x: number, z: number, hw: number, hd: number) {
    solid(x, z, hw, hd);
  }

  // Picnic tables, one with a parasol.
  const wood = toon(PALETTE.wood);
  PICNIC.forEach((p, i) => {
    const t = new THREE.Group();
    t.position.set(p.x, 0, p.z);
    t.add(mesh(box(1.9, 0.08, 0.85), wood, 0, 0.76, 0));
    for (const s of [-1, 1]) {
      t.add(mesh(box(1.9, 0.06, 0.3), wood, 0, 0.44, s * 0.7));
      t.add(mesh(box(0.08, 0.76, 1.6), toon(PALETTE.woodDark), s * 0.75, 0.38, 0, false));
    }
    if (i === 1) {
      t.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.3, 6), toon(INK), 0, 1.15, 0, false));
      t.add(mesh(new THREE.ConeGeometry(1.4, 0.5, 8), toon("#ef476f"), 0, 2.4, 0));
    }
    add(t);
    solid(p.x, p.z, 1.0, 0.9);
  });

  // Benches round the plaza and the fountain.
  const bench = (x: number, z: number, rot: number) => {
    const b = new THREE.Group();
    b.position.set(x, 0, z);
    b.rotation.y = rot;
    b.add(mesh(box(1.8, 0.07, 0.5), wood, 0, 0.45, 0));
    b.add(mesh(box(1.8, 0.4, 0.06), wood, 0, 0.75, 0.24));
    for (const s of [-1, 1]) b.add(mesh(box(0.08, 0.45, 0.5), toon(INK), s * 0.8, 0.22, 0, false));
    add(b);
    const across = Math.abs(Math.sin(rot)) > 0.5;
    solid(x, z, across ? 0.32 : 0.95, across ? 0.95 : 0.32);
  };
  bench(PLAZA.minX + 0.8, 34, Math.PI / 2);
  bench(PLAZA.maxX - 0.8, 34, -Math.PI / 2);
  bench(FOUNTAIN.x - FOUNTAIN.r - 1.5, FOUNTAIN.z, Math.PI / 2);
  bench(FOUNTAIN.x + FOUNTAIN.r + 1.5, FOUNTAIN.z, -Math.PI / 2);
  bench(PITCH.minX + pw / 2 - 4, PITCH.maxZ + 1.0, Math.PI);
  bench(PITCH.minX + pw / 2 + 4, PITCH.maxZ + 1.0, Math.PI);

  // Lamp posts along the sidewalk and at the plaza's corners.
  const lampPole = new THREE.CylinderGeometry(0.07, 0.1, 3.6, 8);
  const lampHead = new THREE.SphereGeometry(0.26, 12, 10);
  const poleMat = toon("#3d405b");
  const glowMat = toon("#fff7d6", { emissive: "#ffe08a" });
  const lamps: [number, number][] = [
    [PLAZA.minX + 0.3, PLAZA.maxZ - 0.3],
    [PLAZA.maxX - 0.3, PLAZA.maxZ - 0.3],
    [PLAZA.minX + 0.3, PLAZA.minZ + 1.5],
    [PLAZA.maxX - 0.3, PLAZA.minZ + 1.5],
  ];
  for (let x = -36; x <= 36; x += 12) lamps.push([x, SIDEWALK.minZ + 0.4]);
  for (const [x, z] of lamps) {
    add(mesh(lampPole, poleMat, x, 1.8, z));
    add(mesh(lampHead, glowMat, x, 3.7, z, false));
    solid(x, z, 0.15, 0.15);
  }

  // Flower beds along the front of the building, either side of the plaza.
  const soil = toon("#8a5a3b");
  const petals = ["#ef476f", "#ffd166", "#ff8fab", "#e0c3fc", "#ffffff"];
  const beds: [number, number][] = [
    [BUILDING.minX + 0.5, PLAZA.minX - 0.6],
    [PLAZA.maxX + 0.6, BUILDING.maxX - 0.5],
  ];
  const bedZ = BUILDING.maxZ + T + 0.6;
  let flowerCount = 0;
  for (const [x0, x1] of beds) flowerCount += Math.floor((x1 - x0) / 0.45);
  const flowers = new THREE.InstancedMesh(new THREE.SphereGeometry(0.11, 8, 6), toonPlain(), flowerCount);
  const fc = new THREE.Color();
  let fi = 0;
  for (const [x0, x1] of beds) {
    add(mesh(box(x1 - x0, 0.22, 0.9), soil, (x0 + x1) / 2, 0.11, bedZ));
    add(mesh(box(x1 - x0 + 0.1, 0.26, 0.08), toon(PALETTE.trim), (x0 + x1) / 2, 0.13, bedZ + 0.47, false));
    solid((x0 + x1) / 2, bedZ, (x1 - x0) / 2, 0.45);
    for (let x = x0 + 0.25; x < x1 - 0.2 && fi < flowerCount; x += 0.45) {
      m.makeTranslation(x, 0.32 + (fi % 3) * 0.04, bedZ + ((fi % 2) - 0.5) * 0.4);
      flowers.setMatrixAt(fi, m);
      flowers.setColorAt(fi, fc.set(petals[fi % petals.length]));
      fi++;
    }
  }
  flowers.count = fi;
  add(flowers);

  // Trees all round, kept off the plaza, paths, pitch and street.
  const trees: [number, number][] = [
    [-36, -22], [-26, -28], [-16, -21], [-6, -27], [24, -22], [34, -27], [-31, -33], [0, -33], [29, -33], [-40, -12],
    [-24, -10], [-31, -3], [-25, 6], [-33, 14], [-24, 20], [-38, 25], [-28, 28],
    [24, -10], [25, 7], [33, 14], [24, 22], [38, 26], [40, -12], [29, 29],
    [-8, 34], [-9, 44], [14, 33], [15, 47], [34, 34], [38, 46], [-41, 40], [-8, 48.5], [12, 41], [30, 48], [-41, 30],
  ];
  const trunkGeo = new THREE.CylinderGeometry(0.2, 0.28, 1.8, 8);
  const trunks = new THREE.InstancedMesh(trunkGeo, toon(PALETTE.woodDark), trees.length);
  const canopyGeo = new THREE.IcosahedronGeometry(1, 1);
  const canopyMats = [toon("#5fb760"), toon("#3f8f45"), toon("#7cc96b")];
  const canopies = canopyMats.map((mat) => new THREE.InstancedMesh(canopyGeo, mat, trees.length * 2));
  const counts = [0, 0, 0];
  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();
  const s = new THREE.Vector3();
  trees.forEach(([x, z], i) => {
    const k = 0.85 + ((i * 37) % 10) / 20;
    m.compose(v.set(x, 0.9 * k, z), q.identity(), s.set(k, k, k));
    trunks.setMatrixAt(i, m);
    const puffs: [number, number, number, number][] = [
      [0, 2.6, 0, 1.35],
      [0.6, 2.2, 0.3, 0.95],
      [-0.5, 2.3, -0.3, 1.0],
      [0.1, 3.3, -0.1, 0.85],
    ];
    puffs.forEach(([px, py, pz, r], j) => {
      const which = (i + j) % 3;
      const im = canopies[which];
      if (counts[which] >= trees.length * 2) return;
      m.compose(v.set(x + px * k, py * k, z + pz * k), q.identity(), s.set(r * k, r * k * 0.9, r * k));
      im.setMatrixAt(counts[which]++, m);
    });
    solid(x, z, 0.35 * k, 0.35 * k);
  });
  canopies.forEach((im, i) => {
    im.count = counts[i];
    im.castShadow = true;
    add(im);
  });
  trunks.castShadow = true;
  add(trunks);

  // A hedge round the grounds and a fence beyond the street.
  const hedgeMat = toon("#4f9d4f");
  const hedge = (x: number, z: number, w: number, d: number) => {
    add(mesh(roundedBox(w, 1.1, d, 0.3), hedgeMat, x, 0.55, z));
    solid(x, z, w / 2, d / 2);
  };
  const hedgeEndZ = SIDEWALK.minZ - 0.4;
  hedge((wb.minX + wb.maxX) / 2, wb.minZ + 0.4, wb.maxX - wb.minX, 0.8);
  hedge(wb.minX + 0.4, (wb.minZ + hedgeEndZ) / 2, 0.8, hedgeEndZ - wb.minZ);
  hedge(wb.maxX - 0.4, (wb.minZ + hedgeEndZ) / 2, 0.8, hedgeEndZ - wb.minZ);
  const fenceZ = wb.maxZ - 0.3;
  const postCount = Math.floor((wb.maxX - wb.minX) / 2) + 1;
  const posts = new THREE.InstancedMesh(box(0.14, 1.1, 0.14), toon("#ffffff"), postCount);
  for (let i = 0; i < postCount; i++) {
    m.makeTranslation(wb.minX + i * 2, 0.55, fenceZ);
    posts.setMatrixAt(i, m);
  }
  add(posts);
  for (const y of [0.45, 0.9]) add(mesh(box(wb.maxX - wb.minX, 0.1, 0.06), toon("#ffffff"), (wb.minX + wb.maxX) / 2, y, fenceZ, false));
  colliders((wb.minX + wb.maxX) / 2, fenceZ, (wb.maxX - wb.minX) / 2, 0.1);

  // The building's name over the front doors, outside.
  sign(add, "🏢 domain HQ", (FRONT_DOOR.x0 + FRONT_DOOR.x1) / 2, 4.6, BUILDING.maxZ + T + 0.05, 0, 120, "#fff3d6");
  // An awning over the doors.
  const aw = FRONT_AWNING;
  add(mesh(box(aw.maxX - aw.minX, aw.thick, aw.maxZ - aw.minZ), toon("#ff8a5b"), (aw.minX + aw.maxX) / 2, aw.y, (aw.minZ + aw.maxZ) / 2));

  return (now) => {
    const t = now / 1000;
    spout.scale.set(1 + Math.sin(t * 7) * 0.08, 1 + Math.sin(t * 5) * 0.12, 1 + Math.cos(t * 7) * 0.08);
    ripples.forEach((r, i) => {
      const k = (t * 0.45 + i * 0.5) % 1;
      const sc = 0.8 + k * 1.3;
      r.scale.set(sc, sc, 1);
      (r.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - k);
    });
  };
}

/** A white toon material for instanced meshes colored per instance. */
function toonPlain(): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ color: "#ffffff", gradientMap: gradientMap() });
}
