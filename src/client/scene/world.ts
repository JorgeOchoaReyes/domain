import * as THREE from "three";
import { OutlineEffect } from "three/examples/jsm/effects/OutlineEffect.js";
import type { AgentKind, Desk, Peer, Presentation, WorkerStatus } from "../../shared/protocol.js";
import { AGENT_LABELS } from "../../shared/protocol.js";

/**
 * The Three.js scene: a bright, toon-shaded cartoon office. It owns the
 * renderer, camera, lights, the room, the presentation stage, and the live
 * meshes for desks, worker avatars and peers. State comes in through
 * syncDesks / syncWorkerAvatars / syncPeers; update() animates avatars and
 * render() draws a frame with a cartoon outline.
 */

/** Colors the laptop screen glows per worker status. */
const STATUS_COLOR: Record<WorkerStatus, number> = {
  booting: 0x6ea8fe,
  idle: 0x4ade80,
  working: 0x38bdf8,
  waiting: 0xf87171,
  presenting: 0xc58bff,
  done: 0xfbbf24,
};

/** Avatar body color per agent kind. */
const AGENT_BODY: Record<AgentKind, number> = {
  claude: 0xc58bff,
  codex: 0x4ade80,
  opencode: 0x38bdf8,
  gemini: 0xfbbf24,
};

const ROOM_HALF = 12; // half-width/-depth of the walkable floor

// The "office" stage at the back of the room where workers present.
const PODIUM = new THREE.Vector2(0, -9.3);
const STAGE_SCREEN_Z = -11.6;

// ---------------------------------------------------------------------------
// Toon material helpers (the cartoon look: flat banding + dark outline).
// ---------------------------------------------------------------------------

let gradientTex: THREE.DataTexture | null = null;
function gradientMap(): THREE.DataTexture {
  if (gradientTex) return gradientTex;
  const data = new Uint8Array([96, 96, 96, 255, 190, 190, 190, 255, 255, 255, 255, 255]);
  gradientTex = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  gradientTex.minFilter = THREE.NearestFilter;
  gradientTex.magFilter = THREE.NearestFilter;
  gradientTex.needsUpdate = true;
  return gradientTex;
}

const toonCache = new Map<string, THREE.MeshToonMaterial>();
function toon(color: number, emissive = 0x000000): THREE.MeshToonMaterial {
  const key = `${color}|${emissive}`;
  const hit = toonCache.get(key);
  if (hit) return hit;
  const m = new THREE.MeshToonMaterial({ color, gradientMap: gradientMap() });
  if (emissive) m.emissive = new THREE.Color(emissive);
  toonCache.set(key, m);
  return m;
}
function toonUnique(color: number): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ color, gradientMap: gradientMap() });
}

/** A cheap rounded box, centered at the origin. */
function roundedBox(w: number, h: number, d: number, r = 0.08): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const x = -w / 2;
  const y = -d / 2;
  r = Math.min(r, w / 2, d / 2);
  shape.moveTo(x + r, y);
  shape.lineTo(x + w - r, y);
  shape.quadraticCurveTo(x + w, y, x + w, y + r);
  shape.lineTo(x + w, y + d - r);
  shape.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  shape.lineTo(x + r, y + d);
  shape.quadraticCurveTo(x, y + d, x, y + d - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 3 });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -h / 2, 0);
  geo.computeVertexNormals();
  return geo;
}

interface DeskView {
  group: THREE.Group;
  screen: THREE.MeshToonMaterial;
  beacon: THREE.Mesh;
  label: THREE.Sprite;
  labelText: string;
}

interface WorkerView {
  group: THREE.Group;
  target: THREE.Vector3;
  facing: number; // desired facing once arrived
  label: THREE.Sprite;
  labelText: string;
  bob: number; // phase for idle bob
}

interface PeerView {
  group: THREE.Group;
  label: THREE.Sprite;
  labelText: string;
}

export class World {
  readonly renderer: THREE.WebGLRenderer;
  private effect: OutlineEffect;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** The local player's avatar; moved by the Player controller. */
  readonly player = new THREE.Group();

  private desks = new Map<string, DeskView>();
  private workers = new Map<string, WorkerView>();
  private peers = new Map<string, PeerView>();
  private deskPositions = new Map<string, THREE.Vector2>();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // The cartoon outline that makes everything read as drawn.
    this.effect = new OutlineEffect(this.renderer, {
      defaultThickness: 0.003,
      defaultColor: [0.14, 0.15, 0.22],
    });

    this.scene.background = new THREE.Color(0xbfe3ff);
    this.scene.fog = new THREE.Fog(0xbfe3ff, 26, 60);

    this.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 200);
    this.camera.position.set(0, 6, 12);

    this.buildLighting();
    this.buildRoom();
    this.buildStage();
    this.buildAvatar(this.player, 0x6ea8fe);
    this.player.position.set(0, 0, 8);
    this.scene.add(this.player);

    this.resize();
  }

  // --- setup --------------------------------------------------------------

  private buildLighting(): void {
    this.scene.add(new THREE.HemisphereLight(0xfff5e6, 0xc9a27a, 1.4));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const sun = new THREE.DirectionalLight(0xfff1d6, 2.0);
    sun.position.set(-8, 18, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 80 });
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun);
  }

  private buildRoom(): void {
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM_HALF * 2, ROOM_HALF * 2),
      toon(0xe9eef7),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // A soft rug to warm up the middle of the room.
    const rug = new THREE.Mesh(new THREE.CircleGeometry(5.5, 40), toon(0xcfe0f3));
    rug.rotation.x = -Math.PI / 2;
    rug.position.y = 0.011;
    rug.receiveShadow = true;
    this.scene.add(rug);

    const wallMat = toon(0xf3ede1);
    const wallH = 4.5;
    const span = ROOM_HALF * 2;
    const mkWall = (w: number, x: number, z: number, ry: number) => {
      const wall = new THREE.Mesh(roundedBox(w, wallH, 0.3, 0.05), wallMat);
      wall.position.set(x, wallH / 2, z);
      wall.rotation.y = ry;
      wall.receiveShadow = true;
      this.scene.add(wall);
    };
    mkWall(span, 0, -ROOM_HALF, 0);
    mkWall(span, 0, ROOM_HALF, 0);
    mkWall(span, -ROOM_HALF, 0, Math.PI / 2);
    mkWall(span, ROOM_HALF, 0, Math.PI / 2);
  }

  /** The presentation stage at the back: a glowing screen, a podium and a dais. */
  private buildStage(): void {
    const dais = new THREE.Mesh(roundedBox(9, 0.25, 3.4, 0.15), toon(0x9fb7d8));
    dais.position.set(PODIUM.x, 0.12, STAGE_SCREEN_Z + 1.7);
    dais.receiveShadow = true;
    this.scene.add(dais);

    const screen = new THREE.Mesh(roundedBox(7, 3, 0.2, 0.12), toon(0x11151c, 0x1b2740));
    screen.position.set(PODIUM.x, 2.3, STAGE_SCREEN_Z);
    this.scene.add(screen);

    const podium = new THREE.Mesh(roundedBox(0.9, 1.1, 0.6, 0.1), toon(0x7d5a3c));
    podium.position.set(PODIUM.x - 2.2, 0.68, STAGE_SCREEN_Z + 1.6);
    podium.castShadow = true;
    this.scene.add(podium);

    const sign = makeLabelSprite("Presentation", "#c58bff");
    sign.position.set(PODIUM.x, 4.0, STAGE_SCREEN_Z + 0.2);
    this.scene.add(sign);
  }

  /** Build a simple rounded, toon-shaded avatar into the given group. */
  private buildAvatar(group: THREE.Group, color: number): void {
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.7, 4, 14), toon(color));
    body.position.y = 0.75;
    body.castShadow = true;
    group.add(body);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 20, 16), toon(0xf1d2b0));
    head.position.y = 1.5;
    head.castShadow = true;
    group.add(head);

    // Nose marks facing (−Z is "forward").
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.12), toon(0xd9a066));
    nose.position.set(0, 1.5, -0.28);
    group.add(nose);
  }

  // --- desks --------------------------------------------------------------

  private buildDesk(desk: Desk): DeskView {
    const group = new THREE.Group();
    group.position.set(desk.x, 0, desk.z);

    const top = new THREE.Mesh(roundedBox(1.8, 0.12, 1.0, 0.06), toon(0xb98a5e));
    top.position.y = 0.75;
    top.castShadow = true;
    top.receiveShadow = true;
    group.add(top);

    const legMat = toon(0x6b4f36);
    for (const [lx, lz] of [
      [-0.8, -0.4],
      [0.8, -0.4],
      [-0.8, 0.4],
      [0.8, 0.4],
    ]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.75, 0.1), legMat);
      leg.position.set(lx, 0.375, lz);
      group.add(leg);
    }

    const laptop = new THREE.Group();
    laptop.position.set(0, 0.82, -0.1);
    laptop.add(new THREE.Mesh(roundedBox(0.6, 0.04, 0.42, 0.03), toon(0x2a2f3a)));
    const screenMat = toonUnique(0x11151c);
    const screen = new THREE.Mesh(roundedBox(0.58, 0.38, 0.03, 0.03), screenMat);
    screen.position.set(0, 0.2, -0.2);
    screen.rotation.x = -0.28;
    laptop.add(screen);
    group.add(laptop);

    const beacon = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.5, 16),
      toon(0xf87171, 0xf87171),
    );
    beacon.position.set(0, 2.1, 0);
    beacon.rotation.x = Math.PI;
    beacon.visible = false;
    group.add(beacon);

    const label = makeLabelSprite("", "#6ea8fe");
    label.position.set(0, 2.5, 0);
    label.visible = false;
    group.add(label);

    this.scene.add(group);
    return { group, screen: screenMat, beacon, label, labelText: "" };
  }

  syncDesks(desks: Desk[]): void {
    const seen = new Set<string>();
    for (const desk of desks) {
      seen.add(desk.id);
      this.deskPositions.set(desk.id, new THREE.Vector2(desk.x, desk.z));
      let view = this.desks.get(desk.id);
      if (!view) {
        view = this.buildDesk(desk);
        this.desks.set(desk.id, view);
      }
      this.updateDeskView(view, desk);
    }
    for (const [id, view] of this.desks) {
      if (!seen.has(id)) {
        this.scene.remove(view.group);
        this.desks.delete(id);
      }
    }
  }

  private updateDeskView(view: DeskView, desk: Desk): void {
    const w = desk.worker;
    if (!w) {
      view.screen.emissive.setHex(0x000000);
      view.beacon.visible = false;
      if (view.labelText !== "") {
        view.label.visible = false;
        view.labelText = "";
      }
      return;
    }
    const color = STATUS_COLOR[w.status];
    view.screen.emissive.setHex(color);
    view.beacon.visible = w.status === "waiting" || w.status === "presenting";

    const text = `${AGENT_LABELS[w.agent]} · ${w.activity}`;
    if (text !== view.labelText) {
      updateLabelSprite(view.label, text, "#" + color.toString(16).padStart(6, "0"));
      view.label.visible = true;
      view.labelText = text;
    }
  }

  // --- worker avatars -----------------------------------------------------

  /**
   * Ensure one avatar per occupied desk and point it at where it should be:
   * at its desk when working, or at a spot in the presentation line (order 0
   * is the podium) when it has a report to present.
   */
  syncWorkerAvatars(desks: Desk[], presentations: Presentation[]): void {
    const orderByDesk = new Map<string, number>();
    for (const p of presentations) orderByDesk.set(p.deskId, p.order);

    const seen = new Set<string>();
    for (const desk of desks) {
      if (!desk.worker) continue;
      seen.add(desk.id);
      let view = this.workers.get(desk.id);
      if (!view) {
        const group = new THREE.Group();
        this.buildAvatar(group, AGENT_BODY[desk.worker.agent]);
        group.position.set(desk.x, 0, desk.z + 0.95);
        const label = makeLabelSprite(desk.worker.hiredBy, "#ffffff");
        label.position.set(0, 2.15, 0);
        group.add(label);
        view = { group, target: group.position.clone(), facing: 0, label, labelText: desk.worker.hiredBy, bob: Math.random() * 6 };
        this.scene.add(group);
        this.workers.set(desk.id, view);
      }

      const order = orderByDesk.get(desk.id);
      if (order !== undefined) {
        const slot = slotFor(order);
        view.target.set(slot.x, 0, slot.y);
        view.facing = Math.PI; // face the room / the manager
      } else {
        view.target.set(desk.x, 0, desk.z + 0.95);
        view.facing = 0; // face the desk
      }

      const label = `${AGENT_LABELS[desk.worker.agent]} · ${desk.worker.hiredBy}`;
      if (label !== view.labelText) {
        updateLabelSprite(view.label, label, "#ffffff");
        view.labelText = label;
      }
    }

    for (const [id, view] of this.workers) {
      if (!seen.has(id)) {
        this.scene.remove(view.group);
        this.workers.delete(id);
      }
    }
  }

  // --- peers --------------------------------------------------------------

  syncPeers(peers: Peer[], selfId: string): void {
    const seen = new Set<string>();
    for (const peer of peers) {
      if (peer.id === selfId) continue;
      seen.add(peer.id);
      let view = this.peers.get(peer.id);
      if (!view) {
        const group = new THREE.Group();
        this.buildAvatar(group, 0xff9f68);
        const label = makeLabelSprite(peer.name, "#ffffff");
        label.position.set(0, 2.1, 0);
        group.add(label);
        this.scene.add(group);
        view = { group, label, labelText: peer.name };
        this.peers.set(peer.id, view);
      }
      view.group.position.set(peer.x, 0, peer.z);
      view.group.rotation.y = peer.facing;
      if (view.labelText !== peer.name) {
        updateLabelSprite(view.label, peer.name, "#ffffff");
        view.labelText = peer.name;
      }
    }
    for (const [id, view] of this.peers) {
      if (!seen.has(id)) {
        this.scene.remove(view.group);
        this.peers.delete(id);
      }
    }
  }

  // --- queries & loop -----------------------------------------------------

  nearestDesk(x: number, z: number): { id: string; dist: number } | null {
    let best: { id: string; dist: number } | null = null;
    for (const [id, p] of this.deskPositions) {
      const dist = Math.hypot(p.x - x, p.y - z);
      if (!best || dist < best.dist) best = { id, dist };
    }
    return best;
  }

  resolveCollision(x: number, z: number): [number, number] {
    const pad = 0.9;
    let nx = THREE.MathUtils.clamp(x, -ROOM_HALF + pad, ROOM_HALF - pad);
    let nz = THREE.MathUtils.clamp(z, -ROOM_HALF + pad, ROOM_HALF - pad);
    for (const p of this.deskPositions.values()) {
      const dx = nx - p.x;
      const dz = nz - p.y;
      const minX = 1.2;
      const minZ = 0.9;
      if (Math.abs(dx) < minX && Math.abs(dz) < minZ) {
        if (minX - Math.abs(dx) < minZ - Math.abs(dz)) {
          nx = p.x + Math.sign(dx || 1) * minX;
        } else {
          nz = p.y + Math.sign(dz || 1) * minZ;
        }
      }
    }
    return [nx, nz];
  }

  /** Animate worker avatars walking to/from the stage. dt in seconds. */
  update(dt: number): void {
    for (const view of this.workers.values()) {
      const g = view.group;
      const dx = view.target.x - g.position.x;
      const dz = view.target.z - g.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.05) {
        const speed = 3.2;
        const step = Math.min(dist, speed * dt);
        g.position.x += (dx / dist) * step;
        g.position.z += (dz / dist) * step;
        g.rotation.y = Math.atan2(-dx, -dz); // face travel direction
        g.position.y = Math.abs(Math.sin(performance.now() * 0.012)) * 0.08; // walk bob
      } else {
        g.position.y = 0;
        // Ease toward the desired resting facing.
        const d = normalizeAngle(view.facing - g.rotation.y);
        g.rotation.y += d * Math.min(1, dt * 8);
      }
    }
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    this.effect.render(this.scene, this.camera);
  }
}

function slotFor(order: number): THREE.Vector2 {
  if (order <= 0) return new THREE.Vector2(PODIUM.x - 2.2, STAGE_SCREEN_Z + 2.3); // at the podium
  // A line to the side of the podium, stretching toward the room.
  return new THREE.Vector2(PODIUM.x + 1.2 + (order - 1) * 1.3, STAGE_SCREEN_Z + 2.6);
}

function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// ---------------------------------------------------------------------------
// Text label sprites (canvas-backed, rounded font).
// ---------------------------------------------------------------------------

function makeLabelSprite(text: string, accent: string): THREE.Sprite {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ transparent: true, depthWrite: false }),
  );
  updateLabelSprite(sprite, text, accent);
  return sprite;
}

function updateLabelSprite(sprite: THREE.Sprite, text: string, accent: string): void {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const font = '800 30px Nunito, ui-rounded, "Segoe UI", system-ui, sans-serif';
  ctx.font = font;
  const padding = 22;
  const textW = Math.min(ctx.measureText(text).width, 560);
  canvas.width = textW + padding * 2;
  canvas.height = 56;

  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = "rgba(20,24,33,0.88)";
  roundRect(ctx, 1, 1, w - 2, h - 2, 16);
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  roundRect(ctx, 1, 1, w - 2, h - 2, 16);
  ctx.stroke();

  ctx.font = font;
  ctx.fillStyle = "#f3f5fb";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, w / 2, h / 2 + 1, textW);

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  const mat = sprite.material;
  mat.map?.dispose();
  mat.map = tex;
  mat.needsUpdate = true;

  const scale = 0.004;
  sprite.scale.set(w * scale, h * scale, 1);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
