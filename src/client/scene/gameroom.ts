import * as THREE from "three";
import { ALL_ARCADES, floorOf,
  BUILDING,
  GAME_MONITORS,
  HOOP,
  PARTITIONS_X,
  PING_PONG,
  WALL_HEIGHT,
  WING_ROOMS_Z,
  WORK_PAD,
  type ArcadeId,
} from "../../shared/layout.js";
import { jukebox, plant, type Collider, type LiveBoard } from "./office.js";
import { box, INK, mesh, noOutline, roundedBox, textPlane, textSprite, toon } from "./toon.js";

/**
 * The game room at the east end of the wing: an arcade carpet under neon,
 * three cabinets along the south wall, a basketball hoop on the east wall
 * with its key painted on the floor, ping-pong, beanbags in front of two live
 * screens that keep an eye on the work, and the glowing pad that sends you
 * straight back to your desk.
 */

export interface GameRoom {
  group: THREE.Group;
  colliders: Collider[];
  /** The cabinets upstairs (floor 2's lounge, the team floor's break corner): the world puts each group on its floor. */
  upstairsCabinets: { 2: THREE.Group; 3: THREE.Group };
  /** Live screens on the west wall (facing +x) at GAME_MONITORS. The world paints workers/goals onto them. */
  monitors: { workers: LiveBoard; goals: LiveBoard };
  /** Repaint a cabinet's screen with its best score. */
  setBest(id: ArcadeId, best: number): void;
  /** Neon pulse, attract-mode animation on cabinet screens, pad glow. */
  update(dt: number, now: number): void;
  /** Disco: the ball spins up and lights sweep the floor, beating with the music (pulse 0..1). */
  setDisco(on: boolean, pulse: number): void;
}

const ROOM = {
  minX: PARTITIONS_X[2] + 0.15,
  maxX: BUILDING.maxX,
  minZ: WING_ROOMS_Z,
  maxZ: BUILDING.maxZ,
};
const F = 'Nunito, ui-rounded, "Segoe UI", system-ui, sans-serif';
const NEON = ["#ff4fd8", "#3ef0ff", "#ffe14d", "#7cff6b"];

interface Cabinet {
  id: ArcadeId;
  name: string;
  color: string;
  best: number;
  board: LiveBoard;
}

export function buildGameRoom(): GameRoom {
  const group = new THREE.Group();
  const colliders: Collider[] = [];
  const add = (o: THREE.Object3D) => group.add(o);
  const solid = (x: number, z: number, hw: number, hd: number) =>
    colliders.push({ minX: x - hw, maxX: x + hw, minZ: z - hd, maxZ: z + hd });

  const w = ROOM.maxX - ROOM.minX;
  const d = ROOM.maxZ - ROOM.minZ;
  const cx = (ROOM.minX + ROOM.maxX) / 2;
  const cz = (ROOM.minZ + ROOM.maxZ) / 2;

  // --- floor and ceiling -------------------------------------------------------
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshToonMaterial({ map: carpetTexture(w, d), gradientMap: toon("#fff").gradientMap }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cx, 0.004, cz);
  floor.receiveShadow = true;
  add(floor);

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ color: "#1b1838" }));
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(cx, WALL_HEIGHT - 0.01, cz);
  add(ceiling);

  // --- neon: strips round the top of the walls, and signs ----------------------
  const neonMats: THREE.MeshBasicMaterial[] = [];
  const neonMat = (color: string) => {
    const m = new THREE.MeshBasicMaterial({ color });
    m.userData.base = new THREE.Color(color);
    neonMats.push(m);
    return m;
  };
  const stripY = 4.9;
  add(mesh(box(0.05, 0.07, d - 0.2), neonMat(NEON[0]), ROOM.minX + 0.03, stripY, cz, false));
  add(mesh(box(0.05, 0.07, d - 0.2), neonMat(NEON[1]), ROOM.maxX - 0.03, stripY, cz, false));
  add(mesh(box(w - 0.2, 0.07, 0.05), neonMat(NEON[2]), cx, stripY, ROOM.maxZ - 0.03, false));
  add(mesh(box(w - 0.2, 0.07, 0.05), neonMat(NEON[3]), cx, stripY, ROOM.minZ + 0.03, false));
  // A lower zig-zag on the south wall, over the cabinets.
  for (let i = 0; i < 10; i++) {
    const seg = mesh(box(0.62, 0.05, 0.04), neonMat(NEON[i % 2 === 0 ? 0 : 1]), ROOM.minX + 0.7 + i * 0.55, 3.15, ROOM.maxZ - 0.04, false);
    seg.rotation.z = i % 2 === 0 ? 0.5 : -0.5;
    add(seg);
  }

  const title = neonSign("GAME ROOM", "#ff4fd8", 120, 4.6);
  title.position.set(10.4, 3.9, ROOM.maxZ - 0.05);
  title.rotation.y = Math.PI;
  add(title);
  const motto = neonSign("PLAY HARD · SHIP HARDER", "#3ef0ff", 64, 4.4);
  motto.position.set(15.3, 3.6, ROOM.minZ + 0.05);
  add(motto);

  // --- arcade cabinets ---------------------------------------------------------
  const cabinets: Cabinet[] = [];
  const upstairsCabinets = { 2: new THREE.Group(), 3: new THREE.Group() } as const;
  for (const a of ALL_ARCADES) {
    const { g, board } = cabinet(a.name, a.color);
    g.position.set(a.x, 0, a.z);
    g.rotation.y = a.rotY;
    const floor = floorOf(a.x);
    if (floor === 1) add(g);
    else upstairsCabinets[floor].add(g);
    // Square enough for either way it faces.
    solid(a.x, a.z, 0.46, 0.46);
    cabinets.push({ id: a.id, name: a.name, color: a.color, best: 0, board });
  }

  // --- the hoop on the east wall -------------------------------------------------
  const { rim } = HOOP;
  const hoop = new THREE.Group();
  const boardX = ROOM.maxX - 0.27;
  hoop.add(mesh(box(0.04, 0.78, 1.25), toon("#ffffff", { opacity: 0.85 }), boardX, rim.y + 0.3, rim.z, false));
  const red = toon("#e63946");
  hoop.add(mesh(box(0.05, 0.04, 0.5), red, boardX - 0.02, rim.y + 0.12, rim.z, false));
  hoop.add(mesh(box(0.05, 0.04, 0.5), red, boardX - 0.02, rim.y + 0.46, rim.z, false));
  for (const s of [-1, 1]) hoop.add(mesh(box(0.05, 0.38, 0.04), red, boardX - 0.02, rim.y + 0.29, rim.z + s * 0.23, false));
  // Bracket back to the wall.
  hoop.add(mesh(box(0.27, 0.08, 0.08), toon("#3d405b"), (boardX + ROOM.maxX) / 2, rim.y + 0.3, rim.z, false));
  const rimMesh = mesh(new THREE.TorusGeometry(0.23, 0.02, 8, 28), toon("#ff7b00"), rim.x, rim.y, rim.z, false);
  rimMesh.rotation.x = Math.PI / 2;
  hoop.add(rimMesh);
  hoop.add(mesh(box(boardX - rim.x - 0.2, 0.03, 0.06), toon("#ff7b00"), (boardX + rim.x + 0.2) / 2, rim.y, rim.z, false));
  const net = new THREE.Mesh(
    new THREE.CylinderGeometry(0.23, 0.14, 0.42, 14, 3, true),
    new THREE.MeshBasicMaterial({ color: "#ffffff", wireframe: true }),
  );
  net.name = "hoop-net";
  net.geometry.translate(0, -0.21, 0);
  net.position.set(rim.x, rim.y, rim.z);
  hoop.add(net);
  add(hoop);

  // The key and the free-throw line, painted on the carpet.
  const paint = new THREE.MeshBasicMaterial({ color: "#f7f3ea" });
  const lineX = HOOP.spot.x + 0.35;
  const keyHalf = 1.0;
  const strip = (x: number, z: number, sx: number, sz: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(sx, sz), paint);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.012, z);
    add(m);
  };
  strip(lineX, rim.z, 0.07, keyHalf * 2);
  strip((lineX + ROOM.maxX) / 2, rim.z - keyHalf, ROOM.maxX - lineX, 0.07);
  strip((lineX + ROOM.maxX) / 2, rim.z + keyHalf, ROOM.maxX - lineX, 0.07);
  const arc = new THREE.Mesh(new THREE.RingGeometry(keyHalf - 0.035, keyHalf + 0.035, 32, 1, Math.PI / 2, Math.PI), paint);
  arc.rotation.x = -Math.PI / 2;
  arc.position.set(lineX, 0.012, rim.z);
  add(arc);
  const keyFill = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.maxX - lineX, keyHalf * 2), new THREE.MeshBasicMaterial({ color: "#e76f51", transparent: true, opacity: 0.35 }));
  keyFill.rotation.x = -Math.PI / 2;
  keyFill.position.set((lineX + ROOM.maxX) / 2, 0.009, rim.z);
  add(keyFill);

  // --- live screens on the west wall ----------------------------------------------
  const monitors = {
    workers: monitor(add, GAME_MONITORS.workers, "🤖 Workers live"),
    goals: monitor(add, GAME_MONITORS.goals, "🎯 Goals"),
  };

  // Beanbags in front of them.
  const bagColors = ["#ff4fd8", "#3ef0ff", "#ffd166"];
  [
    [8.0, 19.5],
    [8.1, 21.1],
    [8.0, 25.4],
  ].forEach(([x, z], i) => {
    const bag = mesh(new THREE.SphereGeometry(0.48, 18, 12), toon(bagColors[i]), x, 0.3, z);
    bag.scale.set(1, 0.62, 1);
    add(bag);
    const dent = mesh(new THREE.SphereGeometry(0.3, 14, 10), toon(bagColors[i]), x + 0.12, 0.48, z);
    dent.scale.set(1, 0.4, 1);
    add(dent);
    solid(x, z, 0.42, 0.42);
  });

  // --- ping-pong -----------------------------------------------------------------
  add(pingPong(PING_PONG.x, PING_PONG.z));
  solid(PING_PONG.x, PING_PONG.z, 0.7, 1.25);

  // --- lounge corner: sofa and mini-fridge ------------------------------------------
  const sofa = couch("#7b2cbf");
  sofa.position.set(ROOM.maxX - 0.5, 0, 26.3);
  sofa.rotation.y = -Math.PI / 2;
  add(sofa);
  solid(ROOM.maxX - 0.48, 26.3, 0.48, 1.15);
  add(miniFridge(ROOM.maxX - 0.42, ROOM.maxZ - 0.42));
  solid(ROOM.maxX - 0.42, ROOM.maxZ - 0.42, 0.37, 0.37);

  // --- the disco ball, and its lights on the floor ----------------------------------------
  const disco = discoBall();
  disco.position.set((ROOM.minX + ROOM.maxX) / 2, WALL_HEIGHT - 0.75, (ROOM.minZ + ROOM.maxZ) / 2);
  add(disco);
  const spots = new THREE.Group();
  const spotMats: THREE.MeshBasicMaterial[] = [];
  for (let i = 0; i < 14; i++) {
    const m = new THREE.MeshBasicMaterial({ color: NEON[i % NEON.length], transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    spotMats.push(m);
    const s = new THREE.Mesh(new THREE.CircleGeometry(0.28 + (i % 3) * 0.08, 18), m);
    s.rotation.x = -Math.PI / 2;
    const a = (i / 14) * Math.PI * 2;
    const r = 1.6 + (i % 4) * 0.9;
    s.position.set(Math.cos(a) * r, 0.02 + i * 0.0005, Math.sin(a) * r);
    spots.add(s);
  }
  spots.position.set(disco.position.x, 0, disco.position.z);
  add(spots);
  let discoOn = false;
  let discoPulse = 0;
  let discoLevel = 0;

  // --- claw machine, jukebox, plants --------------------------------------------------
  add(clawMachine(14.7, ROOM.maxZ - 0.62));
  solid(14.7, ROOM.maxZ - 0.62, 0.55, 0.55);
  const juke = jukebox();
  juke.position.set(ROOM.minX + 0.4, 0, 27.0);
  juke.rotation.y = Math.PI / 2;
  add(juke);
  solid(ROOM.minX + 0.4, 27.0, 0.4, 0.7);
  for (const [x, z] of [
    [ROOM.minX + 0.45, ROOM.minZ + 0.5],
    [ROOM.maxX - 0.45, ROOM.minZ + 0.5],
  ]) {
    const p = plant(1, 1.1);
    p.position.set(x, 0, z);
    add(p);
    solid(x, z, 0.33, 0.33);
  }

  // --- the pad back to work ------------------------------------------------------------
  const padMat = new THREE.MeshBasicMaterial({ color: "#3ef0ff", transparent: true, opacity: 0.55, depthWrite: false });
  const pad = new THREE.Mesh(new THREE.CircleGeometry(WORK_PAD.r, 40), padMat);
  pad.rotation.x = -Math.PI / 2;
  pad.position.set(WORK_PAD.x, 0.015, WORK_PAD.z);
  add(pad);
  const ring = new THREE.Mesh(new THREE.RingGeometry(WORK_PAD.r - 0.06, WORK_PAD.r + 0.04, 40), new THREE.MeshBasicMaterial({ color: "#ffffff" }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(WORK_PAD.x, 0.02, WORK_PAD.z);
  add(ring);
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(WORK_PAD.r * 0.9, WORK_PAD.r, 2.2, 32, 1, true),
    new THREE.MeshBasicMaterial({ color: "#3ef0ff", transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }),
  );
  beam.position.set(WORK_PAD.x, 1.1, WORK_PAD.z);
  add(beam);
  const padLabel = textSprite("🖥 Back to work", { bg: "#1b1838", color: "#3ef0ff", border: "#3ef0ff", size: 28 });
  padLabel.position.set(WORK_PAD.x, 2.0, WORK_PAD.z);
  add(padLabel);

  // --- lights ----------------------------------------------------------------------------
  const pink = new THREE.PointLight("#ff4fd8", 6, 13, 1.4);
  pink.position.set(9, 4.4, 26);
  add(pink);
  const cyan = new THREE.PointLight("#3ef0ff", 6, 13, 1.4);
  cyan.position.set(15, 4.4, 20);
  add(cyan);

  noOutline(group);
  // Keep the wireframe net and the beam from getting toon outlines too.
  for (const m of [net.material, beam.material, padMat]) (m as THREE.Material).userData.outlineParameters = { visible: false };

  let attractT = 0;
  const paintAll = (now: number) => {
    for (const c of cabinets) {
      paintCabinetScreen(c, now);
      c.board.texture.needsUpdate = true;
    }
  };
  paintAll(0);

  return {
    group,
    colliders,
    monitors,
    upstairsCabinets,
    setBest(id, best) {
      // Every cabinet with this game shows the same best.
      for (const c of cabinets.filter((x) => x.id === id)) {
        c.best = best;
        paintCabinetScreen(c, performance.now());
        c.board.texture.needsUpdate = true;
      }
    },
    setDisco(on, pulse) {
      discoOn = on;
      discoPulse = pulse;
    },
    update(dt, now) {
      // The ball always turns a little; with disco on it spins and the lights come up.
      discoLevel += ((discoOn ? 1 : 0) - discoLevel) * Math.min(1, dt * 2);
      disco.rotation.y += dt * (0.25 + discoLevel * 1.4);
      spots.rotation.y -= dt * (0.15 + discoLevel * 0.9);
      spots.visible = discoLevel > 0.01;
      spotMats.forEach((m, i) => (m.opacity = discoLevel * (0.6 + 0.4 * discoPulse) * (0.75 + 0.25 * Math.sin(now * 0.003 + i))));
      const pulse = 0.75 + 0.25 * Math.sin(now * 0.004);
      neonMats.forEach((m, i) => {
        const k = i % 3 === 0 ? pulse : 0.85 + 0.15 * Math.sin(now * 0.006 + i);
        m.color.copy(m.userData.base as THREE.Color).multiplyScalar(k);
      });
      padMat.opacity = 0.4 + 0.2 * Math.sin(now * 0.005);
      ring.scale.setScalar(1 + 0.04 * Math.sin(now * 0.005));
      padLabel.position.y = 2.2 + Math.sin(now * 0.003) * 0.06;
      attractT += dt;
      if (attractT >= 0.2) {
        attractT = 0;
        paintAll(now);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** A mirror ball on a short chain: silver tiles with a few that catch the light. */
function discoBall(): THREE.Group {
  const g = new THREE.Group();
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 128;
  const x = c.getContext("2d")!;
  for (let i = 0; i < 32; i++) {
    for (let j = 0; j < 16; j++) {
      const v = 150 + Math.floor(Math.random() * 90);
      x.fillStyle = Math.random() < 0.06 ? NEON[(i + j) % NEON.length] : `rgb(${v},${v},${v + 10})`;
      x.fillRect(i * 8, j * 8, 7, 7);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.42, 24, 16), new THREE.MeshBasicMaterial({ map: tex }));
  g.add(ball);
  g.add(mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.7, 6), toon("#c9ced8"), 0, 0.75, 0, false));
  return g;
}

function carpetTexture(w: number, d: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d")!;
  g.fillStyle = "#231b4d";
  g.fillRect(0, 0, 512, 512);
  // A '90s cinema carpet: squiggles, triangles and rings in neon.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.lineWidth = 7;
  g.lineCap = "round";
  for (let i = 0; i < 46; i++) {
    const x = rnd() * 512;
    const y = rnd() * 512;
    g.strokeStyle = NEON[i % NEON.length];
    g.fillStyle = NEON[(i + 1) % NEON.length];
    g.globalAlpha = 0.85;
    const kind = i % 3;
    g.beginPath();
    if (kind === 0) {
      g.moveTo(x - 22, y);
      g.bezierCurveTo(x - 10, y - 18, x + 4, y + 18, x + 22, y);
      g.stroke();
    } else if (kind === 1) {
      g.moveTo(x, y - 12);
      g.lineTo(x + 12, y + 10);
      g.lineTo(x - 12, y + 10);
      g.closePath();
      g.fill();
    } else {
      g.arc(x, y, 10, 0, Math.PI * 2);
      g.stroke();
    }
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(w / 4, d / 4);
  tex.anisotropy = 8;
  return tex;
}

/** Neon lettering on a dark backing plate, facing +z. */
function neonSign(text: string, color: string, size: number, width: number): THREE.Group {
  const g = new THREE.Group();
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  const font = `900 ${size}px ${F}`;
  ctx.font = font;
  const tw = Math.ceil(ctx.measureText(text).width);
  c.width = tw + size;
  c.height = Math.ceil(size * 1.7);
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = color;
  for (const blur of [size * 0.5, size * 0.25, 0]) {
    ctx.shadowBlur = blur;
    ctx.fillStyle = blur ? color : "#ffffff";
    ctx.fillText(text, c.width / 2, c.height / 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const scale = width / c.width;
  const pw = c.width * scale;
  const ph = c.height * scale;
  g.add(mesh(box(pw * 0.92, ph * 0.8, 0.04), toon("#14112e"), 0, 0, 0, false));
  const face = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
  face.position.z = 0.03;
  g.add(face);
  return g;
}

/** An upright cabinet, screen facing +z (rotate it into place). */
function cabinet(name: string, color: string): { g: THREE.Group; board: LiveBoard } {
  const g = new THREE.Group();
  const body = toon(color);
  const dark = toon("#16142b");
  // Sides, back and the kick plate.
  for (const s of [-1, 1]) g.add(mesh(box(0.06, 1.95, 0.8), body, s * 0.42, 0.975, 0));
  g.add(mesh(box(0.8, 1.95, 0.06), dark, 0, 0.975, -0.37));
  g.add(mesh(box(0.8, 0.9, 0.7), dark, 0, 0.45, -0.02));
  g.add(mesh(box(0.8, 0.08, 0.8), body, 0, 1.95, 0));
  // The coin door.
  g.add(mesh(box(0.34, 0.36, 0.02), toon("#2b2d42"), 0, 0.45, 0.34, false));
  for (const s of [-1, 1]) g.add(mesh(box(0.05, 0.08, 0.02), toon("#ffd166", { emissive: "#7a4d00" }), s * 0.08, 0.5, 0.355, false));
  // Control panel with a joystick and buttons.
  const panel = mesh(box(0.8, 0.07, 0.36), body, 0, 0.98, 0.36);
  panel.rotation.x = 0.18;
  g.add(panel);
  g.add(mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.14, 8), toon("#2b2d42"), -0.18, 1.08, 0.38, false));
  g.add(mesh(new THREE.SphereGeometry(0.045, 12, 10), toon("#ef476f"), -0.18, 1.16, 0.38, false));
  ["#ffd166", "#06d6a0", "#5bc0eb"].forEach((c, i) =>
    g.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.03, 12), toon(c), 0.06 + i * 0.1, 1.04, 0.36 + (i % 2) * 0.05, false)),
  );
  // The screen, tilted back in its bezel.
  const bezel = mesh(box(0.74, 0.62, 0.04), dark, 0, 1.38, 0.2, false);
  bezel.rotation.x = -0.22;
  g.add(bezel);
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 256;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.64, 0.51), new THREE.MeshBasicMaterial({ map: texture }));
  screen.position.set(0, 1.38, 0.225);
  screen.rotation.x = -0.22;
  g.add(screen);
  // Lit marquee on top.
  const marquee = textPlane(name.toUpperCase(), { bg: "#16142b", color, border: color, size: 56 });
  const ms = 0.78 / (marquee.geometry as THREE.PlaneGeometry).parameters.width;
  marquee.scale.setScalar(Math.min(ms, 1.6));
  marquee.position.set(0, 1.8, 0.31);
  g.add(marquee);
  return { g, board: { canvas, texture } };
}

/** Attract mode: a little loop of the game, the name, the best score and "press E". */
function paintCabinetScreen(c: Cabinet, now: number): void {
  const g = c.board.canvas.getContext("2d")!;
  const W = c.board.canvas.width;
  const H = c.board.canvas.height;
  g.fillStyle = "#0b0a1a";
  g.fillRect(0, 0, W, H);
  const t = now / 1000;
  g.save();
  if (c.id === "snake") {
    const cell = 16;
    const len = 9;
    for (let i = 0; i < len; i++) {
      const p = (t * 6 - i) % 40;
      const x = Math.floor(p < 20 ? p : 40 - p) * cell + 8;
      const y = 60 + Math.sin((t * 6 - i) * 0.4) * 30;
      g.fillStyle = i === 0 ? "#b8ffde" : c.color;
      g.fillRect(x, Math.round(y / cell) * cell + 40, cell - 2, cell - 2);
    }
    g.fillStyle = "#ef476f";
    g.fillRect(W - 60, 104, 12, 12);
  } else if (c.id === "bugsmash") {
    for (let i = 0; i < 3; i++) {
      const x = 60 + i * 100;
      g.fillStyle = "#24203f";
      g.beginPath();
      g.ellipse(x, 140, 36, 12, 0, 0, Math.PI * 2);
      g.fill();
      const up = Math.max(0, Math.sin(t * 3 + i * 2.1));
      g.font = `40px ${F}`;
      g.textAlign = "center";
      g.textBaseline = "bottom";
      g.save();
      g.beginPath();
      g.rect(x - 40, 60, 80, 80);
      g.clip();
      g.fillText(i === 1 && Math.sin(t * 0.7) > 0.6 ? "🚀" : "🐛", x, 150 - up * 46);
      g.restore();
    }
  } else if (c.id === "merge") {
    // Tiles sliding together.
    const vals = [2, 4, 8, 16, 32, 64, 128, 256];
    const colors = ["#3a3f6b", "#4b4f8c", "#06d6a0", "#1fb98a", "#5bc0eb", "#3a86ff", "#ffd166", "#ffb703"];
    for (let k = 0; k < 4; k++) {
      const v = (Math.floor(t) + k) % vals.length;
      const x = 40 + k * 64 + Math.sin(t * 3 + k) * 6;
      g.fillStyle = colors[v];
      g.fillRect(x, 70, 54, 54);
      g.fillStyle = "#fff";
      g.font = `900 22px ${F}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(String(vals[v]), x + 27, 98);
    }
  } else if (c.id === "dash") {
    // A rocket bobbing through the CI gates.
    const gx = W - ((t * 90) % (W + 60));
    g.fillStyle = "#1fb98a";
    g.fillRect(gx, 0, 34, 60);
    g.fillRect(gx, 150, 34, H - 150);
    g.font = `34px serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("🚀", 90, 105 + Math.sin(t * 4) * 18);
  } else {
    const cols = 8;
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < cols; k++) {
        if ((r * cols + k + Math.floor(t)) % 7 === 0) continue;
        g.fillStyle = ["#ef476f", "#ffd166", "#06d6a0", "#5bc0eb"][r];
        g.fillRect(16 + k * 37, 34 + r * 16, 33, 12);
      }
    const bx = W / 2 + Math.sin(t * 2.3) * (W / 2 - 30);
    const by = 160 + Math.abs(Math.cos(t * 3.1)) * -70;
    g.fillStyle = "#fff";
    g.beginPath();
    g.arc(bx, by, 5, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = c.color;
    g.fillRect(bx - 30, 176, 60, 8);
  }
  g.restore();
  // Title, best, blinking prompt.
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `900 30px ${F}`;
  g.shadowColor = c.color;
  g.shadowBlur = 12;
  g.fillStyle = "#ffffff";
  g.fillText(c.name.toUpperCase(), W / 2, 22);
  g.shadowBlur = 0;
  g.font = `800 20px ${F}`;
  g.fillStyle = "#ffd166";
  g.fillText(`BEST ${c.best}`, W / 2, H - 46);
  if (Math.floor(t * 2) % 2 === 0) {
    g.fillStyle = c.color;
    g.font = `900 22px ${F}`;
    g.fillText("PRESS E TO PLAY", W / 2, H - 18);
  }
  // Scanlines.
  g.fillStyle = "rgba(0,0,0,0.18)";
  for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 2);
}

/** A framed live screen on the west wall, facing +x. */
function monitor(
  add: (o: THREE.Object3D) => void,
  m: { x: number; y: number; z: number; width: number; height: number },
  label: string,
): LiveBoard {
  const g = new THREE.Group();
  g.position.set(m.x, m.y, m.z);
  g.rotation.y = Math.PI / 2;
  const frame = mesh(roundedBox(m.width + 0.2, 0.08, m.height + 0.2, 0.08), toon("#14112e"), 0, 0, -0.02, false);
  frame.rotation.x = Math.PI / 2;
  g.add(frame);
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = Math.round((1024 * m.height) / m.width);
  const cg = canvas.getContext("2d")!;
  cg.fillStyle = "#14112e";
  cg.fillRect(0, 0, canvas.width, canvas.height);
  cg.fillStyle = "#3ef0ff";
  cg.font = `900 56px ${F}`;
  cg.textAlign = "center";
  cg.textBaseline = "middle";
  cg.fillText("Loading…", canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(m.width, m.height), new THREE.MeshBasicMaterial({ map: texture }));
  face.position.z = 0.03;
  g.add(face);
  const tag = textPlane(label, { bg: "#14112e", color: "#ffffff", border: "#3ef0ff", size: 52 });
  tag.position.set(0, m.height / 2 + 0.32, 0.04);
  g.add(tag);
  add(g);
  return { canvas, texture };
}

function pingPong(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  const top = toon("#1d6fa5");
  g.add(mesh(box(1.3, 0.05, 2.4), top, 0, 0.74, 0));
  const white = new THREE.MeshBasicMaterial({ color: "#ffffff" });
  for (const s of [-1, 1]) {
    g.add(mesh(box(0.025, 0.052, 2.4), white, s * 0.637, 0.742, 0, false));
    g.add(mesh(box(1.3, 0.052, 0.025), white, 0, 0.742, s * 1.187, false));
  }
  g.add(mesh(box(0.012, 0.052, 2.4), white, 0, 0.743, 0, false));
  // The net across the middle.
  g.add(mesh(box(1.42, 0.13, 0.015), new THREE.MeshBasicMaterial({ color: "#f4f1de", transparent: true, opacity: 0.8 }), 0, 0.83, 0, false));
  for (const s of [-1, 1]) g.add(mesh(box(0.03, 0.16, 0.03), toon(INK), s * 0.71, 0.82, 0, false));
  const legs = toon("#3d405b");
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(mesh(box(0.06, 0.72, 0.06), legs, sx * 0.55, 0.36, sz * 1.05));
  // Two paddles and a ball resting on it.
  const paddle = (px: number, pz: number, color: string, rot: number) => {
    const p = new THREE.Group();
    p.add(mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.015, 18), toon(color), 0, 0, 0, false));
    p.add(mesh(box(0.035, 0.015, 0.1), toon("#c98b5a"), 0, 0, 0.12, false));
    p.position.set(px, 0.775, pz);
    p.rotation.y = rot;
    g.add(p);
  };
  paddle(-0.3, -0.7, "#e63946", 0.4);
  paddle(0.25, 0.75, "#2b2d42", -2.4);
  g.add(mesh(new THREE.SphereGeometry(0.025, 10, 8), toon("#ffffff"), 0.1, 0.79, 0.3, false));
  return g;
}

/** A plump sofa, seat facing +z (rotate it into place). */
function couch(color: string): THREE.Group {
  const g = new THREE.Group();
  const fabric = toon(color);
  g.add(mesh(roundedBox(2.2, 0.42, 0.9, 0.12), fabric, 0, 0.26, 0));
  g.add(mesh(roundedBox(2.2, 0.6, 0.25, 0.1), fabric, 0, 0.66, -0.36));
  for (const s of [-1, 1]) g.add(mesh(roundedBox(0.24, 0.62, 0.9, 0.1), fabric, s * 1.0, 0.4, 0));
  const cushion = toon("#9d4edd");
  for (const s of [-1, 1]) g.add(mesh(roundedBox(0.86, 0.12, 0.7, 0.08), cushion, s * 0.45, 0.52, 0.06));
  g.add(mesh(roundedBox(0.36, 0.32, 0.12, 0.06), toon("#ffd166"), -0.6, 0.72, -0.18).rotateZ(0.2));
  return g;
}

function miniFridge(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = -Math.PI * 0.75;
  g.add(mesh(roundedBox(0.7, 0.95, 0.7, 0.06), toon("#e8e8f0"), 0, 0.475, 0));
  g.add(mesh(box(0.56, 0.62, 0.02), toon("#7fdfff", { emissive: "#1d5b7a", opacity: 0.85 }), 0, 0.55, 0.355, false));
  const cans = ["#e63946", "#06d6a0", "#ffd166", "#5bc0eb", "#ff4fd8", "#f77f00"];
  cans.forEach((c, i) =>
    g.add(mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.12, 10), toon(c), -0.18 + (i % 3) * 0.18, 0.36 + Math.floor(i / 3) * 0.26, 0.24, false)),
  );
  g.add(mesh(box(0.04, 0.3, 0.04), toon("#9aa3b2"), 0.28, 0.55, 0.37, false));
  return g;
}

function clawMachine(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = Math.PI;
  const body = toon("#ff4fd8");
  g.add(mesh(box(1.0, 0.95, 1.0), body, 0, 0.475, 0));
  g.add(mesh(box(1.0, 0.18, 1.0), body, 0, 2.15, 0));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(mesh(box(0.06, 1.12, 0.06), toon("#ffe14d"), sx * 0.47, 1.51, sz * 0.47));
  const glass = new THREE.Mesh(box(0.94, 1.1, 0.94), new THREE.MeshToonMaterial({ color: "#bfe8ff", transparent: true, opacity: 0.25, depthWrite: false }));
  glass.position.y = 1.5;
  g.add(glass);
  // A heap of plushies.
  const plush = ["#ffd166", "#06d6a0", "#5bc0eb", "#ef476f", "#9b5de5", "#f77f00"];
  for (let i = 0; i < 12; i++) {
    const a = i * 2.4;
    const r = 0.12 + (i % 4) * 0.08;
    g.add(mesh(new THREE.SphereGeometry(0.1, 12, 10), toon(plush[i % plush.length]), Math.cos(a) * r, 1.04 + (i % 3) * 0.07, Math.sin(a) * r, false));
  }
  // The claw.
  g.add(mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.4, 6), toon("#9aa3b2"), 0.1, 1.85, 0.05, false));
  for (let i = 0; i < 3; i++) {
    const prong = mesh(box(0.02, 0.14, 0.02), toon("#9aa3b2"), 0.1 + Math.cos((i * Math.PI * 2) / 3) * 0.05, 1.6, 0.05 + Math.sin((i * Math.PI * 2) / 3) * 0.05, false);
    prong.rotation.z = 0.3;
    g.add(prong);
  }
  const sign = textPlane("CLAW", { bg: "#14112e", color: "#ffe14d", border: "#ffe14d", size: 56 });
  sign.scale.setScalar(0.7);
  sign.position.set(0, 2.15, 0.51);
  g.add(sign);
  return g;
}
