import * as THREE from "three";
import type { Desk, Peer, WorkerStatus } from "../../shared/protocol.js";
import { AGENT_LABELS } from "../../shared/protocol.js";

/** Colors the laptop screen glows per worker status. */
const STATUS_COLOR: Record<WorkerStatus, number> = {
  booting: 0x6ea8fe,
  idle: 0x4ade80,
  working: 0x38bdf8,
  waiting: 0xf87171,
  done: 0xfbbf24,
};

const ROOM_HALF = 12; // half-width/-depth of the walkable floor

interface DeskView {
  group: THREE.Group;
  screen: THREE.MeshStandardMaterial;
  beacon: THREE.Mesh;
  label: THREE.Sprite;
  labelText: string;
}

interface PeerView {
  group: THREE.Group;
  label: THREE.Sprite;
  labelText: string;
}

/**
 * Owns the Three.js scene: renderer, camera, lighting, the room, and the live
 * meshes for desks and peers. It is told about state via syncDesks/syncPeers
 * and renders whatever the player/main loop asks for. It holds no networking
 * and no input logic.
 */
export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** The local player's avatar; moved by the Player controller. */
  readonly player = new THREE.Group();

  private desks = new Map<string, DeskView>();
  private peers = new Map<string, PeerView>();
  private deskPositions = new Map<string, THREE.Vector2>();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene.background = new THREE.Color(0x0b0d12);
    this.scene.fog = new THREE.Fog(0x0b0d12, 22, 46);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
    this.camera.position.set(0, 6, 12);

    this.buildLighting();
    this.buildRoom();
    this.buildAvatar(this.player, 0x6ea8fe);
    this.player.position.set(0, 0, 8);
    this.scene.add(this.player);

    this.resize();
  }

  // --- setup --------------------------------------------------------------

  private buildLighting(): void {
    this.scene.add(new THREE.HemisphereLight(0xcfd8ff, 0x20242e, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(8, 16, 10);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const d = 20;
    key.shadow.camera.left = -d;
    key.shadow.camera.right = d;
    key.shadow.camera.top = d;
    key.shadow.camera.bottom = -d;
    this.scene.add(key);
  }

  private buildRoom(): void {
    // Floor
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM_HALF * 2, ROOM_HALF * 2),
      new THREE.MeshStandardMaterial({ color: 0x1b2030, roughness: 0.95 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Subtle grid for a sense of scale.
    const grid = new THREE.GridHelper(ROOM_HALF * 2, ROOM_HALF * 2, 0x2a3140, 0x222736);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    grid.position.y = 0.01;
    this.scene.add(grid);

    // Walls
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x151a24, roughness: 1 });
    const wallH = 4;
    const mkWall = (w: number, x: number, z: number, ry: number) => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, wallH, 0.3), wallMat);
      wall.position.set(x, wallH / 2, z);
      wall.rotation.y = ry;
      wall.receiveShadow = true;
      this.scene.add(wall);
    };
    const span = ROOM_HALF * 2;
    mkWall(span, 0, -ROOM_HALF, 0);
    mkWall(span, 0, ROOM_HALF, 0);
    mkWall(span, -ROOM_HALF, 0, Math.PI / 2);
    mkWall(span, ROOM_HALF, 0, Math.PI / 2);
  }

  /** Build a simple blocky avatar into the given group. */
  private buildAvatar(group: THREE.Group, color: number): void {
    const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.7, 4, 12), bodyMat);
    body.position.y = 0.75;
    body.castShadow = true;
    group.add(body);

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 20, 16),
      new THREE.MeshStandardMaterial({ color: 0xf1d2b0, roughness: 0.7 }),
    );
    head.position.y = 1.5;
    head.castShadow = true;
    group.add(head);

    // A little nose marks facing direction (−Z is "forward").
    const nose = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.1, 0.12),
      new THREE.MeshStandardMaterial({ color: 0xd9a066 }),
    );
    nose.position.set(0, 1.5, -0.28);
    group.add(nose);
  }

  // --- desks --------------------------------------------------------------

  private buildDesk(desk: Desk): DeskView {
    const group = new THREE.Group();
    group.position.set(desk.x, 0, desk.z);

    // Desk top + legs
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 0.1, 1.0),
      new THREE.MeshStandardMaterial({ color: 0x3a4152, roughness: 0.7 }),
    );
    top.position.y = 0.75;
    top.castShadow = true;
    top.receiveShadow = true;
    group.add(top);

    const legMat = new THREE.MeshStandardMaterial({ color: 0x20242e });
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

    // Laptop: base + screen. The screen's emissive color tracks status.
    const laptop = new THREE.Group();
    laptop.position.set(0, 0.81, -0.1);
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.03, 0.42),
      new THREE.MeshStandardMaterial({ color: 0x2a2f3a }),
    );
    laptop.add(base);
    const screenMat = new THREE.MeshStandardMaterial({
      color: 0x11151c,
      emissive: 0x000000,
      emissiveIntensity: 0.9,
      roughness: 0.4,
    });
    const screen = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.38, 0.02), screenMat);
    screen.position.set(0, 0.2, -0.2);
    screen.rotation.x = -0.28;
    laptop.add(screen);
    group.add(laptop);

    // Beacon: a glowing cone that appears when the worker needs you.
    const beacon = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.5, 16),
      new THREE.MeshStandardMaterial({
        color: 0xf87171,
        emissive: 0xf87171,
        emissiveIntensity: 1.2,
      }),
    );
    beacon.position.set(0, 2.1, 0);
    beacon.rotation.x = Math.PI;
    beacon.visible = false;
    group.add(beacon);

    const label = makeLabelSprite("");
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
    // Remove desks that vanished (shouldn't happen; desks are fixed).
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
      view.screen.color.setHex(0x11151c);
      view.beacon.visible = false;
      if (view.labelText !== "") {
        view.label.visible = false;
        view.labelText = "";
      }
      return;
    }
    const color = STATUS_COLOR[w.status];
    view.screen.emissive.setHex(color);
    view.screen.color.setHex(0x11151c);
    view.beacon.visible = w.status === "waiting";

    const text = `${AGENT_LABELS[w.agent]} · ${w.activity}`;
    if (text !== view.labelText) {
      updateLabelSprite(view.label, text);
      view.label.visible = true;
      view.labelText = text;
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
        this.buildAvatar(group, 0xc58bff);
        const label = makeLabelSprite(peer.name);
        label.position.set(0, 2.1, 0);
        group.add(label);
        this.scene.add(group);
        view = { group, label, labelText: peer.name };
        this.peers.set(peer.id, view);
      }
      view.group.position.set(peer.x, 0, peer.z);
      view.group.rotation.y = peer.facing;
      if (view.labelText !== peer.name) {
        updateLabelSprite(view.label, peer.name);
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

  /** The id and distance of the nearest desk to a floor-plane point. */
  nearestDesk(x: number, z: number): { id: string; dist: number } | null {
    let best: { id: string; dist: number } | null = null;
    for (const [id, p] of this.deskPositions) {
      const dist = Math.hypot(p.x - x, p.y - z);
      if (!best || dist < best.dist) best = { id, dist };
    }
    return best;
  }

  /** Clamp a desired position to the room and push it out of desk footprints. */
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
        // Push out along the smaller overlap axis.
        if (minX - Math.abs(dx) < minZ - Math.abs(dz)) {
          nx = p.x + Math.sign(dx || 1) * minX;
        } else {
          nz = p.y + Math.sign(dz || 1) * minZ;
        }
      }
    }
    return [nx, nz];
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}

// ---------------------------------------------------------------------------
// Text label sprites (canvas-backed).
// ---------------------------------------------------------------------------

function makeLabelSprite(text: string): THREE.Sprite {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ transparent: true, depthWrite: false }),
  );
  updateLabelSprite(sprite, text);
  return sprite;
}

function updateLabelSprite(sprite: THREE.Sprite, text: string): void {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const font = "500 28px ui-sans-serif, system-ui, sans-serif";
  ctx.font = font;
  const padding = 18;
  const textW = Math.min(ctx.measureText(text).width, 520);
  canvas.width = textW + padding * 2;
  canvas.height = 52;

  const r = 12;
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = "rgba(14,17,24,0.82)";
  roundRect(ctx, 1, 1, w - 2, h - 2, r);
  ctx.fill();
  ctx.strokeStyle = "rgba(110,168,254,0.35)";
  ctx.lineWidth = 1.5;
  roundRect(ctx, 1, 1, w - 2, h - 2, r);
  ctx.stroke();

  ctx.font = font;
  ctx.fillStyle = "#e6e9ef";
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
