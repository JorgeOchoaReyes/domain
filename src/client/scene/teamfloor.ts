import * as THREE from "three";
import { DESK_SIZE, TEAM_AISLE_Z, TEAM_ELEVATOR, TEAM_FLOOR_STEP, UP_HEIGHT, WALL_T, teamFloorRect, teamPods, type Box3D } from "../../shared/layout.js";
import { PALETTE, pendantAt, plant, type Collider } from "./office.js";
import { box, mesh, noOutline, textPlane, toon } from "./toon.js";
import { skyline, sofa } from "./upstairs.js";

/**
 * Floor 3, the team floor, up the elevator: four pods of four desks — room
 * for a bigger team, or a pod each when people share the office — round an
 * aisle down from the elevator, with a break corner and the city outside the
 * glass. The desks themselves are the office's (built with the rest, moved
 * up here): laptops, monitors and the CCTV wall see them like any other.
 *
 * Floors 4 and up are the same floor again (k > 0), each further east, with
 * their own pods (E–H, I–L) — opened as the team outgrows the one below.
 */

export interface TeamFloor {
  group: THREE.Group;
  colliders: Collider[];
  occluders: Box3D[];
}

const T = WALL_T;
const H = UP_HEIGHT;
const POD_COLORS = ["#cde7ff", "#ffd6e7", "#d6f5e3", "#fff0bf"];

export function buildTeamFloor(k = 0): TeamFloor {
  const group = new THREE.Group();
  const colliders: Collider[] = [];
  const occluders: Box3D[] = [];
  const add = (o: THREE.Object3D) => group.add(o);
  const solid = (x: number, z: number, hw: number, hd: number) => colliders.push({ minX: x - hw, maxX: x + hw, minZ: z - hd, maxZ: z + hd });
  const F = teamFloorRect(k);
  const pods = teamPods(k);
  const ex = TEAM_ELEVATOR.x + k * TEAM_FLOOR_STEP;

  // --- floor and ceiling: warm wood, a pale aisle down the middle --------------------------
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(F.maxX - F.minX, F.maxZ - F.minZ), toon("#dcc2a1"));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set((F.minX + F.maxX) / 2, 0.002, (F.minZ + F.maxZ) / 2);
  floor.receiveShadow = true;
  add(floor);
  const aisle = new THREE.Mesh(new THREE.PlaneGeometry(F.maxX - F.minX - 4, 2.2), toon("#efe4d2"));
  aisle.rotation.x = -Math.PI / 2;
  aisle.position.set((F.minX + F.maxX) / 2, 0.006, TEAM_AISLE_Z);
  add(aisle);
  const corridor = new THREE.Mesh(new THREE.PlaneGeometry(2.2, TEAM_AISLE_Z - F.minZ), toon("#efe4d2"));
  corridor.rotation.x = -Math.PI / 2;
  corridor.position.set(ex, 0.006, (F.minZ + TEAM_AISLE_Z) / 2);
  add(corridor);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(F.maxX - F.minX, F.maxZ - F.minZ), new THREE.MeshBasicMaterial({ color: PALETTE.ceiling }));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set((F.minX + F.maxX) / 2, H, (F.minZ + F.maxZ) / 2);
  add(ceil);
  occluders.push({ minX: F.minX - T, maxX: F.maxX + T, minZ: F.minZ - T, maxZ: F.maxZ + T, minY: H, maxY: H + 0.5 });

  // --- walls: solid north and west, glass south and east with the city outside ------------
  const wallMat = toon(PALETTE.wall);
  const wall = (minX: number, maxX: number, minZ: number, maxZ: number) => {
    add(mesh(box(maxX - minX, H, maxZ - minZ), wallMat, (minX + maxX) / 2, H / 2, (minZ + maxZ) / 2, false));
    colliders.push({ minX, maxX, minZ, maxZ, tall: true });
    occluders.push({ minX, maxX, minZ, maxZ, minY: 0, maxY: H });
  };
  wall(F.minX - T, F.maxX + T, F.minZ - T, F.minZ);
  wall(F.minX - T, F.minX, F.minZ, F.maxZ);
  const glassWall = (minX: number, maxX: number, minZ: number, maxZ: number, alongX: boolean) => {
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const len = alongX ? maxX - minX : maxZ - minZ;
    const w = alongX ? len : maxX - minX;
    const d = alongX ? maxZ - minZ : len;
    add(mesh(box(w, 0.8, d), wallMat, cx, 0.4, cz, false));
    add(mesh(box(w, H - 3.5, d), wallMat, cx, (H + 3.5) / 2, cz, false));
    const glass = new THREE.Mesh(box(alongX ? w : 0.04, 2.7, alongX ? 0.04 : d), new THREE.MeshBasicMaterial({ color: "#cfeaff", transparent: true, opacity: 0.18 }));
    glass.position.set(cx, 2.15, cz);
    add(glass);
    for (let u = 0; u <= len; u += 3) add(mesh(box(0.12, 2.7, 0.12), toon("#3d405b"), alongX ? minX + u : cx, 2.15, alongX ? cz : minZ + u, false));
    colliders.push({ minX, maxX, minZ, maxZ, tall: true });
    occluders.push({ minX, maxX, minZ, maxZ, minY: 0, maxY: 0.8 });
    occluders.push({ minX, maxX, minZ, maxZ, minY: 3.5, maxY: H });
  };
  glassWall(F.minX - T, F.maxX + T, F.maxZ, F.maxZ + T, true);
  glassWall(F.maxX, F.maxX + T, F.minZ, F.maxZ, false);
  add(skyline(F.minX - 30, F.maxX + 30, F.maxZ + 16, 0));
  add(skyline(F.minZ - 30, F.maxZ + 30, F.maxX + 16, Math.PI / 2));

  // --- the elevator ------------------------------------------------------------------------
  add(mesh(box(TEAM_ELEVATOR.width + 0.5, 2.9, 0.12), toon("#3d405b"), ex, 1.45, F.minZ + 0.06, false));
  for (const s of [-1, 1]) add(mesh(box(TEAM_ELEVATOR.width / 2 - 0.04, 2.6, 0.06), toon("#c0c8d6"), ex + (s * TEAM_ELEVATOR.width) / 4, 1.32, F.minZ + 0.14, false));
  const floorSign = textPlane(String(3 + k), { bg: ["#06d6a0", "#5bc0eb", "#c77dff"][k % 3], size: 80 });
  floorSign.position.set(ex, 3.15, F.minZ + 0.08);
  floorSign.scale.setScalar(0.5);
  add(floorSign);
  const welcome = textPlane(k ? `🧑‍💻 Floor ${3 + k} — pods ${pods[0].name} to ${pods[pods.length - 1].name}, for a growing team` : "🧑‍💻 Team floor — four pods, sixteen desks", { bg: "#fffaf3", size: 52 });
  welcome.position.set(ex + 7, 3.3, F.minZ + 0.06);
  add(welcome);

  // --- the pods: a rug, lamps and a name each -----------------------------------------------
  pods.forEach((pod, i) => {
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(DESK_SIZE.width * 2 + 2.4, DESK_SIZE.depth * 2 + 4.4), toon(POD_COLORS[(i + k) % POD_COLORS.length]));
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(pod.x, 0.01, pod.z);
    add(rug);
    for (const dx of [-1.1, 1.1]) add(pendantAt(pod.x + dx, pod.z, H, 1.9));
    const sign = textPlane(`Pod ${pod.name}`, { bg: POD_COLORS[(i + k) % POD_COLORS.length], size: 64 });
    sign.position.set(pod.x, 3.0, pod.z);
    sign.scale.setScalar(0.8);
    add(sign);
    const back = sign.clone();
    back.rotation.y = Math.PI;
    add(back);
  });

  // --- a break corner by the windows: a sofa, a low table, plants --------------------------
  const s = sofa(["#3a86ff", "#ef476f", "#2a9d8f"][k % 3]);
  s.position.set(ex, 0, F.maxZ - 1.6);
  s.rotation.y = Math.PI;
  add(s);
  solid(ex, F.maxZ - 1.6, 1.3, 0.5);
  add(mesh(box(1.4, 0.06, 0.7), toon(PALETTE.woodDark), ex, 0.42, F.maxZ - 3.2));
  add(mesh(box(1.2, 0.4, 0.5), toon(PALETTE.wood), ex, 0.2, F.maxZ - 3.2, false));
  solid(ex, F.maxZ - 3.2, 0.7, 0.35);
  for (const [x, z, k] of [
    [F.minX + 1, F.minZ + 1, 0],
    [F.maxX - 1, F.minZ + 1, 2],
    [F.minX + 1, F.maxZ - 1, 1],
    [ex - 2.6, F.maxZ - 1.2, 2],
    [ex + 2.6, F.maxZ - 1.2, 0],
  ] as const) {
    const p = plant(k, 1.1);
    p.position.set(x, 0, z);
    add(p);
    solid(x, z, 0.35, 0.35);
  }

  noOutline(group);
  return { group, colliders, occluders };
}
