import * as THREE from "three";
import { OutlineEffect } from "three/examples/jsm/effects/OutlineEffect.js";
import type { Desk, Look, Peer, Presentation } from "../../shared/protocol.js";
import type { Idea } from "../../shared/ideas.js";
import { AGENT_LABELS } from "../../shared/protocol.js";
import {
  DESK_BY_ID,
  ELEVATOR,
  FLOOR,
  IDEA_BOARDS,
  type IdeaBoardId,
  REVIEW_SPOT,
  WALL_HEIGHT,
  WORLD_BOUNDS,
  cameraOccluders,
  isIndoors,
  roomAt,
  type Box3D,
  SPAWN,
  deskSeat,
  inMyOffice,
  lineSpot,
  route,
} from "../../shared/layout.js";
import { Bot, Person } from "./characters.js";
import { Laptop } from "./laptop.js";
import { buildOffice, type Collider, type LiveBoard, type Office } from "./office.js";
import { buildRooms, type Rooms } from "./rooms.js";
import { buildGameRoom, type GameRoom } from "./gameroom.js";
import { Hoops, SoccerBall } from "./minigames.js";
import { Hand } from "./hand.js";
import {
  paintBlankBoard,
  paintGoalsBoard,
  paintIdeaBoard,
  paintLineBoard,
  paintSlide,
  paintStandupBoard,
  paintTv,
  paintWorkersBoard,
} from "./boards.js";
import { TONES, briefLine, type ProgressState, type ToneId } from "../../shared/progress.js";
import { disposeSprite, fitLabels, label, textSprite } from "./toon.js";

/**
 * The 3D office: renderer, camera, lights and the room (office.ts), plus the
 * live things in it — the people, the workers at their desks or in line for
 * your office, the laptops showing their terminals, and the boards and
 * screens. State comes in through sync(); update() animates; render() draws.
 */

const PLAYER_RADIUS = 0.35;
const WORKER_SPEED = 3.6;

type Pt = { x: number; z: number };

interface WorkerView {
  bot: Bot;
  /** Where it's walking, point by point; empty once it's there. */
  path: Pt[];
  /** Where it's headed in the end, and the facing it settles into there. */
  dest: Pt & { facing: number; seated: boolean };
  destKey: string;
  pos: THREE.Vector3;
  facing: number;
  seated: boolean;
  speech: { sprite: THREE.Sprite; left: number } | null;
}

interface PeerView {
  person: Person;
  target: THREE.Vector3;
  facing: number;
}

export class World {
  readonly renderer: THREE.WebGLRenderer;
  private effect: OutlineEffect;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** The local player's avatar group; moved by the Player controller. */
  readonly player: THREE.Group;
  private me: Person;
  private lastMe = new THREE.Vector3();

  private office: Office;
  private rooms: Rooms;
  readonly gameRoom: GameRoom;
  readonly hoops: Hoops;
  readonly ball: SoccerBall;
  private colliders: Collider[];
  private occluders: Box3D[];
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private tone: ToneId | null = null;
  /** The floating key over whatever E would use right now. */
  private prompt: THREE.Sprite;
  private promptAt: THREE.Vector3 | null = null;
  /** Follow the real time of day (off: always daytime). */
  private dayNight = true;
  private lastSkyMinute = -1;
  private ambient: THREE.AmbientLight;
  /** Daylight outside right now: 0 night … 1 day. */
  private daylight = 1;
  /** The light level you're seeing: the sky's outdoors, office lights indoors. Eased. */
  private seen = 1;
  /** Your arm in first person; it hangs off the camera. */
  readonly hand: Hand;
  private firstPerson = false;
  /** In VR (set by setXR). */
  private xr = false;
  private showHand = true;
  /** How far you can walk (and the third-person camera can go). */
  readonly bounds = { minX: WORLD_BOUNDS.minX + 0.4, maxX: WORLD_BOUNDS.maxX - 0.4, minZ: WORLD_BOUNDS.minZ + 0.4, maxZ: WORLD_BOUNDS.maxZ - 0.4 };
  private laptops = new Map<string, Laptop>();
  private workers = new Map<string, WorkerView>();
  private peers = new Map<string, PeerView>();
  private desks: Desk[] = [];
  private line: Presentation[] = [];
  /** The worker presenting in your office right now, and which slide is up. */
  private presenting: string | null = null;
  private slide = 0;
  private boardsDirty = true;
  private progress: ProgressState | null = null;
  private lastTvSecond = -1;
  private lastCardTick = 0;
  /** Seconds left in the gong's swing. */
  private gongT = 0;
  private tmp = new THREE.Vector3();
  private camAt = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement, look: Look, name: string) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.effect = new OutlineEffect(this.renderer, { defaultThickness: 0.0032, defaultColor: [0.17, 0.18, 0.26] });

    this.scene.background = new THREE.Color("#bfe3ff");
    this.scene.fog = new THREE.Fog("#bfe3ff", 40, 90);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);

    this.hemi = new THREE.HemisphereLight("#fff5e6", "#c9a27a", 1.5);
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight("#ffffff", 0.55);
    this.scene.add(this.ambient);
    const sun = new THREE.DirectionalLight("#fff1d6", 1.6);
    this.sun = sun;
    sun.position.set(-8, 18, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -24, right: 24, top: 20, bottom: -20, near: 1, far: 60 });
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun);
    this.scene.add(sun.target);

    this.office = buildOffice();
    this.scene.add(this.office.group);
    this.rooms = buildRooms();
    this.scene.add(this.rooms.group);
    this.gameRoom = buildGameRoom();
    this.scene.add(this.gameRoom.group);
    this.hoops = new Hoops(this.scene);
    this.ball = new SoccerBall(this.scene);
    this.colliders = [...this.office.colliders, ...this.rooms.colliders, ...this.gameRoom.colliders];
    this.collectOccludable([this.office.group, this.rooms.group, this.gameRoom.group]);
    this.occluders = cameraOccluders();
    this.occluders.push({
      minX: ELEVATOR.x - ELEVATOR.width / 2,
      maxX: ELEVATOR.x + ELEVATOR.width / 2,
      minZ: FLOOR.minZ - 1,
      maxZ: FLOOR.minZ + ELEVATOR.depth,
      minY: 0,
      maxY: WALL_HEIGHT,
    });
    for (const [id, view] of this.office.desks) {
      const laptop = new Laptop();
      view.laptopAnchor.add(laptop.group);
      this.laptops.set(id, laptop);
    }
    paintGoalsBoard(this.office.boards.goals.canvas, null);
    this.office.boards.goals.texture.needsUpdate = true;
    paintBlankBoard(this.office.reviewBoard.canvas);
    this.office.reviewBoard.texture.needsUpdate = true;
    this.paintIdeas();

    this.prompt = keySprite("E");
    this.prompt.visible = false;
    this.scene.add(this.prompt);
    this.board.visible = false;
    this.scene.add(this.board);
    this.hand = new Hand(look);
    this.camera.add(this.hand.group);
    this.scene.add(this.camera);
    this.hand.group.visible = false;
    // Your own name tag would hang right in front of the camera: others see it, you don't.
    this.me = new Person(name, look, { tag: false });
    this.player = this.me.root;
    this.player.position.set(SPAWN.x, 0, SPAWN.z);
    this.player.rotation.y = SPAWN.facing;
    this.lastMe.copy(this.player.position);
    this.scene.add(this.player);

    this.resize();
  }

  /** Float the E key over the thing you can use (null hides it). */
  setPrompt(at: { x: number; y: number; z: number } | null): void {
    this.promptAt = at ? new THREE.Vector3(at.x, at.y, at.z) : null;
    this.prompt.visible = at !== null;
  }

  /** Follow the real time of day, or keep it daytime. */
  setDayNight(on: boolean): void {
    this.dayNight = on;
    this.lastSkyMinute = -1;
  }

  /**
   * The sky, the sun and the fog by the hour: blue days, warm dawns and
   * dusks, a deep blue night with a cool moon. Indoors stays lit.
   */
  private updateSky(): void {
    const d = new Date();
    const minute = this.dayNight ? d.getHours() * 60 + d.getMinutes() : 12 * 60;
    if (minute === this.lastSkyMinute) return;
    this.lastSkyMinute = minute;
    const h = minute / 60;
    const DAY = new THREE.Color("#bfe3ff");
    const DUSK = new THREE.Color("#ffb38a");
    const NIGHT = new THREE.Color("#1c2547");
    // 0 = night, 1 = day, with dawn 5–7 and dusk 17–20 in between.
    const light = h < 5 ? 0 : h < 7 ? (h - 5) / 2 : h < 17 ? 1 : h < 20 ? 1 - (h - 17) / 3 : 0;
    const warm = 1 - Math.abs(light - 0.5) * 2; // strongest mid-dawn and mid-dusk
    const sky = NIGHT.clone().lerp(DAY, light).lerp(DUSK, warm * 0.55);
    (this.scene.background as THREE.Color).copy(sky);
    this.scene.fog?.color.copy(sky);
    this.sun.color.set(light > 0.2 ? "#fff1d6" : "#b8c8ff").lerp(new THREE.Color("#ffb070"), warm * 0.5);
    this.daylight = light;
  }

  /**
   * How bright things look, eased each frame: outside it follows the sky, so
   * a night walk is dark; indoors the office lights are on.
   */
  private updateLight(dt: number): void {
    const p = this.player.position;
    const target = isIndoors(p.x, p.z) ? Math.max(this.daylight, 0.8) : this.daylight;
    this.seen += (target - this.seen) * Math.min(1, dt * 2.5);
    const l = this.seen;
    this.sun.intensity = 0.25 + 1.35 * l;
    this.hemi.intensity = 0.55 + 0.95 * l;
    this.ambient.intensity = 0.22 + 0.33 * l;
    this.ambient.color.set("#ffffff").lerp(new THREE.Color("#8fa4ff"), (1 - l) * 0.5);
  }

  /** First person: hide your own avatar so it doesn't fill the view. */
  setFirstPerson(on: boolean): void {
    this.firstPerson = on;
    this.me.root.visible = !on && !this.selfHidden && !this.xr;
    this.hand.group.visible = on && this.showHand && !this.xr;
  }

  setShowHand(on: boolean): void {
    this.showHand = on;
    this.hand.group.visible = this.firstPerson && on && !this.xr;
  }

  setMe(name: string, look: Look): void {
    this.me.setName(name);
    this.me.setLook(look);
    this.hand.setLook(look);
  }

  // --- state ------------------------------------------------------------------

  sync(desks: Desk[], line: Presentation[], peers: Peer[], selfId: string): void {
    this.desks = desks;
    this.line = line;
    this.syncDesks(desks);
    this.syncWorkers(desks, line);
    this.syncPeers(peers, selfId);
    this.boardsDirty = true;
  }

  /** Feed a worker's terminal output to its laptop. */
  output(deskId: string, data: string, fresh = false): void {
    const laptop = this.laptops.get(deskId);
    if (!laptop) return;
    if (fresh) laptop.reset();
    laptop.write(data);
  }

  /** Goals and the focus session changed: repaint the Goals board (and the TV). */
  setProgress(p: ProgressState): void {
    this.progress = p;
    paintGoalsBoard(this.office.boards.goals.canvas, p);
    this.office.boards.goals.texture.needsUpdate = true;
    paintGoalsBoard(this.gameRoom.monitors.goals.canvas, p);
    this.gameRoom.monitors.goals.texture.needsUpdate = true;
    this.setTone(p.session?.tone ?? null);
    this.boardsDirty = true;
  }

  /** The session's tone colors the light a little, so the office feels different in each. */
  private setTone(tone: ToneId | null): void {
    if (tone === this.tone) return;
    this.tone = tone;
    const def = TONES.find((t) => t.id === tone);
    const sky = new THREE.Color("#fff5e6");
    if (def) sky.lerp(new THREE.Color(def.color), 0.22);
    this.hemi.color.copy(sky);
  }

  /** A task shipped: the gong swings. */
  ringGong(): void {
    this.gongT = 2.5;
  }

  /** Who's presenting in your office (they walk to the podium), and the slide up. */
  setPresenting(deskId: string | null, slide = 0): void {
    if (deskId !== this.presenting) {
      this.presenting = deskId;
      this.syncWorkers(this.desks, this.line);
    }
    this.slide = slide;
    this.boardsDirty = true;
  }

  /** Copy the review whiteboard you're drawing on onto the one in your office. */
  showReviewBoard(source: HTMLCanvasElement | null): void {
    const b = this.office.reviewBoard;
    if (!source) paintBlankBoard(b.canvas);
    else {
      const g = b.canvas.getContext("2d")!;
      g.fillStyle = "#fbfdff";
      g.fillRect(0, 0, b.canvas.width, b.canvas.height);
      g.drawImage(source, 0, 0, b.canvas.width, b.canvas.height);
    }
    b.texture.needsUpdate = true;
  }

  // --- idea boards ---------------------------------------------------------------

  private ideas: Idea[] = [];
  private ideaThumbs = new Map<string, HTMLImageElement>();
  /** The board you're drawing at, and your sketch (mirrored onto it). */
  private ideaLive: { board: IdeaBoardId; sketch: HTMLCanvasElement } | null = null;

  /** What's pinned changed: repaint both idea boards (thumbnails load in the background). */
  setIdeas(ideas: Idea[]): void {
    this.ideas = ideas;
    for (const i of ideas) {
      const img = this.ideaThumbs.get(i.id);
      if (i.thumb && img?.src !== i.thumb) {
        const next = new Image();
        next.onload = () => this.paintIdeas();
        next.src = i.thumb;
        this.ideaThumbs.set(i.id, next);
      } else if (!i.thumb) this.ideaThumbs.delete(i.id);
    }
    this.paintIdeas();
  }

  /** Mirror the sketch you're drawing onto the idea board you're at (null: back to the notes). */
  showIdeaSketch(board: IdeaBoardId | null, sketch: HTMLCanvasElement | null): void {
    this.ideaLive = board && sketch ? { board, sketch } : null;
    this.paintIdeas();
  }

  /** The idea boards' faces, each tagged with its board's id (userData.board), for drawing on in VR. */
  ideaBoardFaces(): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [id, b] of [
      ["floor", this.office.ideaBoard],
      ["standup", this.rooms.standupIdeas],
    ] as const) {
      for (const f of b.faces ?? []) {
        f.userData.board = id;
        out.push(f);
      }
    }
    return out;
  }

  /** The idea board you're standing at, if any. */
  ideaBoardAt(x: number, z: number): (typeof IDEA_BOARDS)[number] | null {
    return IDEA_BOARDS.find((b) => Math.hypot(x - b.spot.x, z - b.spot.z) < b.r) ?? null;
  }

  private paintIdeas(): void {
    const boards: [IdeaBoardId, LiveBoard][] = [
      ["floor", this.office.ideaBoard],
      ["standup", this.rooms.standupIdeas],
    ];
    for (const [id, b] of boards) {
      paintIdeaBoard(b.canvas, this.ideas, this.ideaThumbs, this.ideaLive?.board === id ? this.ideaLive.sketch : null);
      b.texture.needsUpdate = true;
    }
  }

  /** A worker says something: a speech bubble over its head for a while. */
  speak(deskId: string, text: string): void {
    const view = this.workers.get(deskId);
    if (!view) return;
    if (view.speech) {
      view.bot.root.remove(view.speech.sprite);
      disposeSprite(view.speech.sprite);
    }
    const short = text.length > 60 ? text.slice(0, 58) + "…" : text;
    const sprite = textSprite(`💬 ${short}`, { bg: "#ffffff", size: 32 });
    sprite.position.y = 2.6;
    view.bot.root.add(sprite);
    view.speech = { sprite, left: 4 + text.length * 0.05 };
  }

  private syncDesks(desks: Desk[]): void {
    for (const desk of desks) {
      const view = this.office.desks.get(desk.id);
      if (view) view.vacancy.visible = !desk.worker;
      const laptop = this.laptops.get(desk.id);
      if (laptop) laptop.setHeader(desk.worker?.status ?? null, desk.worker ? `${AGENT_LABELS[desk.worker.agent]} — ${desk.worker.activity}` : "");
    }
  }

  /** Where each worker should be: at its desk, in line, or at the podium. */
  private syncWorkers(desks: Desk[], line: Presentation[]): void {
    const spots = new Map<string, Pt & { facing: number; seated: boolean; key: string }>();
    let order = 1;
    for (const p of line) {
      if (p.deskId === this.presenting) {
        spots.set(p.deskId, { ...lineSpot(0), seated: false, key: "podium" });
      } else {
        const s = lineSpot(order);
        spots.set(p.deskId, { ...s, seated: false, key: `line-${order}` });
        order++;
      }
    }

    const seen = new Set<string>();
    for (const desk of desks) {
      const w = desk.worker;
      if (!w) continue;
      seen.add(desk.id);
      const def = DESK_BY_ID.get(desk.id);
      if (!def) continue;
      const seat = deskSeat(def, 0.93);
      const atDesk = { x: seat.x, z: seat.z, facing: def.rotY + Math.PI, seated: true, key: "desk" };
      const dest = spots.get(desk.id) ?? atDesk;

      // One of your characters looks like itself; rebuild the bot if that changed.
      const look = w.identity?.look ?? null;
      let view = this.workers.get(desk.id);
      if (view && view.bot.lookKey !== Bot.keyFor(w.agent, look)) {
        this.removeWorker(desk.id);
        view = undefined;
      }
      if (!view) {
        const bot = new Bot(w.agent, look, w.identity?.name ?? null);
        bot.root.scale.setScalar(0.82);
        this.scene.add(bot.root);
        view = {
          bot,
          path: [],
          dest: atDesk,
          destKey: "desk",
          pos: new THREE.Vector3(atDesk.x, 0, atDesk.z),
          facing: atDesk.facing,
          seated: true,
          speech: null,
        };
        this.workers.set(desk.id, view);
      }
      if (dest.key !== view.destKey) {
        view.destKey = dest.key;
        view.dest = dest;
        view.path = route({ x: view.pos.x, z: view.pos.z }, dest);
        view.seated = false;
      }
      // The card over its head also shows the task's clock, model and plan.
      const task = this.progress?.goals.flatMap((g) => g.tasks).find((t) => t.deskId === desk.id && t.status !== "done");
      const terms = task ? briefLine(task) : "";
      view.bot.name = w.identity?.name ?? null;
      view.bot.setCard(w.status, w.hiredBy, terms ? `${w.activity} · ${terms}` : w.activity, desk.id === this.presenting);
    }
    for (const id of [...this.workers.keys()]) if (!seen.has(id)) this.removeWorker(id);
  }

  private removeWorker(id: string): void {
    const view = this.workers.get(id);
    if (!view) return;
    this.scene.remove(view.bot.root);
    view.bot.dispose();
    if (view.speech) disposeSprite(view.speech.sprite);
    this.workers.delete(id);
  }

  private syncPeers(peers: Peer[], selfId: string): void {
    const seen = new Set<string>();
    for (const peer of peers) {
      if (peer.id === selfId) continue;
      seen.add(peer.id);
      let view = this.peers.get(peer.id);
      if (!view) {
        const person = new Person(peer.name, peer.look);
        person.root.position.set(peer.x, 0, peer.z);
        this.scene.add(person.root);
        view = { person, target: new THREE.Vector3(peer.x, 0, peer.z), facing: peer.facing };
        this.peers.set(peer.id, view);
      }
      view.target.set(peer.x, 0, peer.z);
      view.facing = peer.facing;
      view.person.setName(peer.name);
      view.person.setLook(peer.look);
    }
    for (const [id, view] of this.peers) {
      if (seen.has(id)) continue;
      this.scene.remove(view.person.root);
      view.person.dispose();
      this.peers.delete(id);
    }
  }

  // --- queries ------------------------------------------------------------------

  /** The desk whose chair you're nearest, if any. */
  nearestDesk(x: number, z: number): { id: string; dist: number } | null {
    let best: { id: string; dist: number } | null = null;
    for (const view of this.office.desks.values()) {
      const seat = deskSeat(view.def, 1.2);
      const dist = Math.min(Math.hypot(seat.x - x, seat.z - z), Math.hypot(view.def.x - x, view.def.z - z) + 0.3);
      if (!best || dist < best.dist) best = { id: view.def.id, dist };
    }
    return best;
  }

  /** Whether you're in your office (where you hold reviews). */
  inMyOffice(x: number, z: number): boolean {
    return inMyOffice({ x, z });
  }

  /** Whether the camera at (x, y, z) would be in (or too close to) a wall, the wall over a door, the roof or the elevator shaft. */
  cameraBlocked(x: number, y: number, z: number): boolean {
    const m = 0.28;
    for (const c of this.occluders) {
      if (x > c.minX - m && x < c.maxX + m && z > c.minZ - m && z < c.maxZ + m && y > c.minY - m && y < c.maxY + m) return true;
    }
    return false;
  }

  /** Hop on or off the skateboard. */
  setBoard(on: boolean): void {
    this.board.visible = on;
    this.me.riding = on;
  }
  private board = skateboard();

  /** Your own avatar fades out when the camera is pulled in tight behind it. */
  setSelfHidden(hidden: boolean): void {
    if (this.selfHidden === hidden) return;
    this.selfHidden = hidden;
    if (!this.firstPerson && !this.xr) this.me.root.visible = !hidden;
  }
  private selfHidden = false;

  /** How high the camera may go at (x, z): under the ceiling indoors. */
  ceilingAt(x: number, z: number): number {
    return isIndoors(x, z) ? WALL_HEIGHT - 0.4 : 16;
  }

  /** Where the workers are, for the minimap. */
  workerSpots(): { x: number; z: number; status: string }[] {
    return [...this.workers.entries()].map(([id, v]) => ({
      x: v.pos.x,
      z: v.pos.z,
      status: this.desks.find((d) => d.id === id)?.worker?.status ?? "idle",
    }));
  }

  /** Where the other people are, for the minimap. */
  peerSpots(): { x: number; z: number }[] {
    return [...this.peers.values()].map((v) => ({ x: v.person.root.position.x, z: v.person.root.position.z }));
  }

  nearReviewDesk(x: number, z: number): boolean {
    return Math.hypot(x - REVIEW_SPOT.x, z - REVIEW_SPOT.z) < 2.2;
  }

  resolveCollision(x: number, z: number): [number, number] {
    const r = PLAYER_RADIUS;
    let nx = THREE.MathUtils.clamp(x, this.bounds.minX, this.bounds.maxX);
    let nz = THREE.MathUtils.clamp(z, this.bounds.minZ, this.bounds.maxZ);
    for (let pass = 0; pass < 2; pass++) {
      for (const c of this.colliders) {
        const minX = c.minX - r;
        const maxX = c.maxX + r;
        const minZ = c.minZ - r;
        const maxZ = c.maxZ + r;
        if (nx <= minX || nx >= maxX || nz <= minZ || nz >= maxZ) continue;
        const pushes = [nx - minX, maxX - nx, nz - minZ, maxZ - nz];
        const i = pushes.indexOf(Math.min(...pushes));
        if (i === 0) nx = minX;
        else if (i === 1) nx = maxX;
        else if (i === 2) nz = minZ;
        else nz = maxZ;
      }
    }
    return [nx, nz];
  }

  // --- loop -------------------------------------------------------------------------

  /** Things that happened in the minigames this frame. */
  readonly events: { hoop: "score" | "miss" | null; goal: "west" | "east" | null } = { hoop: null, goal: null };

  update(dt: number, playerVelocity: { x: number; z: number } = { x: 0, z: 0 }): void {
    const now = performance.now();
    const pp = this.player.position;
    // The sun's shadows follow you round the campus.
    const sx = Math.round(pp.x / 4) * 4;
    const sz = Math.round(pp.z / 4) * 4;
    this.sun.target.position.set(sx, 0, sz);
    this.sun.position.set(sx - 8, 18, sz + 10);
    this.rooms.update(dt, now, { x: pp.x, z: pp.z });
    this.cullAreas();
    this.gameRoom.update(dt, now);
    this.events.hoop = this.hoops.update(dt);
    this.updateSky();
    this.updateLight(dt);
    if (this.promptAt) {
      this.prompt.position.copy(this.promptAt);
      this.prompt.position.y += Math.sin(now * 0.005) * 0.06;
    }
    this.events.goal = this.ball.update(dt, { x: pp.x, z: pp.z, vx: playerVelocity.x, vz: playerVelocity.z }, this.colliders);
    // You: walk animation from how far you moved this frame.
    const moved = this.player.position.distanceTo(this.lastMe) / Math.max(dt, 1e-3);
    this.lastMe.copy(this.player.position);
    this.me.update(dt, moved);
    if (this.board.visible) {
      this.board.position.set(this.player.position.x, this.player.position.y, this.player.position.z);
      this.board.rotation.y = this.player.rotation.y;
      // The wheels roll with how fast you're going.
      for (const w of this.board.userData.wheels as THREE.Mesh[]) w.rotation.x += moved * dt * 9;
    }

    for (const view of this.peers.values()) {
      const root = view.person.root;
      const d = root.position.distanceTo(view.target);
      const k = Math.min(1, dt * 10);
      root.position.lerp(view.target, k);
      root.rotation.y += normalizeAngle(view.facing - root.rotation.y) * k;
      view.person.update(dt, d / Math.max(dt, 1e-3) > 0.3 ? 3 : 0);
    }

    for (const [deskId, view] of this.workers) {
      const walking = view.path.length > 0;
      if (walking) {
        const next = view.path[0];
        const dx = next.x - view.pos.x;
        const dz = next.z - view.pos.z;
        const dist = Math.hypot(dx, dz);
        const step = WORKER_SPEED * dt;
        if (dist <= step) {
          view.pos.set(next.x, 0, next.z);
          view.path.shift();
        } else {
          view.pos.x += (dx / dist) * step;
          view.pos.z += (dz / dist) * step;
        }
        if (dist > 0.01) view.facing = turnToward(view.facing, Math.atan2(dx, dz), dt * 10);
        if (!view.path.length) view.seated = view.dest.seated;
      } else {
        view.facing = turnToward(view.facing, view.dest.facing, dt * 6);
      }
      const root = view.bot.root;
      root.position.copy(view.pos);
      root.position.y = view.seated ? 0.4 : 0;
      root.rotation.y = view.facing;
      const desk = this.desks.find((d) => d.id === deskId);
      view.bot.update(dt, { seated: view.seated, walking, status: desk?.worker?.status ?? "idle" });
      if (view.speech) {
        view.speech.left -= dt;
        if (view.speech.left <= 0) {
          root.remove(view.speech.sprite);
          disposeSprite(view.speech.sprite);
          view.speech = null;
        }
      }
    }

    // Vacant desks' "+" markers bob; laptops near you repaint more often.
    const bob = Math.sin(now * 0.004) * 0.06;
    const p = this.player.position;
    for (const [id, view] of this.office.desks) {
      if (view.vacancy.visible) {
        view.vacancy.position.y = 1.38 + bob;
        view.vacancy.rotation.y += dt * 1.5;
      }
      const near = Math.hypot(view.def.x - p.x, view.def.z - p.z) < 9;
      this.laptops.get(id)?.update(now, near);
    }

    // The gong swings and settles.
    if (this.gongT > 0) {
      this.gongT = Math.max(0, this.gongT - dt);
      const t = 2.5 - this.gongT;
      this.office.gong.rotation.x = Math.sin(t * 9) * 0.35 * Math.exp(-t * 1.4);
    }
    // Task clocks on the workers' cards tick over every few seconds.
    if (now - this.lastCardTick > 5000) {
      this.lastCardTick = now;
      this.syncWorkers(this.desks, this.line);
    }
    // The TV counts down a focus session once a second.
    const session = this.progress?.session;
    if (session) {
      const sec = Math.floor(Date.now() / 1000);
      if (sec !== this.lastTvSecond) {
        this.lastTvSecond = sec;
        this.boardsDirty = true;
      }
    }

    if (this.boardsDirty) {
      this.boardsDirty = false;
      const b = this.office.boards;
      paintWorkersBoard(b.workers.canvas, this.desks);
      b.workers.texture.needsUpdate = true;
      const gm = this.gameRoom.monitors.workers;
      paintWorkersBoard(gm.canvas, this.desks);
      gm.texture.needsUpdate = true;
      paintStandupBoard(this.rooms.standupScreen.canvas, this.progress, this.desks);
      this.rooms.standupScreen.texture.needsUpdate = true;
      paintLineBoard(b.line.canvas, this.line);
      b.line.texture.needsUpdate = true;
      const current = this.line.find((l) => l.deskId === this.presenting) ?? null;
      const goalTitle = session?.goalId ? (this.progress!.goals.find((g) => g.id === session.goalId)?.title ?? null) : null;
      paintTv(this.office.tv.canvas, this.line, current, session ?? null, goalTitle);
      this.office.tv.texture.needsUpdate = true;
      paintSlide(this.office.screen.canvas, current, this.slide, this.line.length);
      this.office.screen.texture.needsUpdate = true;
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
    fitLabels(this.camera.getWorldPosition(this.camAt));
    // In VR: one plain pass per eye (outlines would double the cost), and the
    // quality stays where it is — the headset sets its own frame rate.
    if (this.renderer.xr.isPresenting) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.updateOcclusion();
    if (this.outlines) this.effect.render(this.scene, this.camera);
    else this.renderer.render(this.scene, this.camera);
    this.trackFrame();
  }

  /** Run `frame` every frame — in the window or, in VR, at the headset's rate. */
  loop(frame: (now: number) => void): void {
    this.renderer.setAnimationLoop(frame);
  }

  /**
   * Entering or leaving VR: your avatar and hand hide (you're behind your own
   * eyes, with controllers for hands), and shadows go to keep the headset's
   * frame rate up.
   */
  setXR(on: boolean): void {
    this.xr = on;
    this.renderer.shadowMap.enabled = !on && this.quality !== "fast";
    this.setFirstPerson(this.firstPerson);
  }

  // --- graphics quality ------------------------------------------------------------

  private outlines = true;
  private quality: Quality = "balanced";
  private frameTimes: number[] = [];
  private lastFrameAt = 0;
  /** Called when the game drops its own quality because frames were slow. */
  onAutoQuality: ((q: Quality) => void) | null = null;
  /** Whether quality may drop by itself when frames are slow. */
  autoQuality = true;

  /**
   * High: outlines, sharp shadows, full resolution. Balanced: outlines and
   * lighter shadows. Fast: no outlines or shadows, standard resolution — for
   * machines where the office feels sluggish.
   */
  setQuality(q: Quality): void {
    this.quality = q;
    this.outlines = q !== "fast";
    this.renderer.setPixelRatio(q === "high" ? Math.min(devicePixelRatio, 2) : q === "balanced" ? Math.min(devicePixelRatio, 1.25) : 1);
    this.renderer.shadowMap.enabled = q !== "fast";
    const size = q === "high" ? 2048 : 1024;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null as never;
    }
    // Shadows follow you, so a tighter box keeps them crisp at the lower size.
    const r = q === "high" ? 24 : 18;
    Object.assign(this.sun.shadow.camera, { left: -r, right: r, top: r * 0.85, bottom: -r * 0.85 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.material) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.needsUpdate = true;
    });
    this.resize();
    this.frameTimes = [];
  }

  /** Drop a level when the last few seconds ran under ~45 fps. */
  private trackFrame(): void {
    const now = performance.now();
    if (this.lastFrameAt) this.frameTimes.push(now - this.lastFrameAt);
    this.lastFrameAt = now;
    if (this.frameTimes.length < 240) return;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    this.frameTimes = [];
    // A hidden tab or a modal-heavy moment can stall frames: ignore huge gaps.
    if (!this.autoQuality || median > 200 || median < 22 || this.quality === "fast") return;
    const next: Quality = this.quality === "high" ? "balanced" : "fast";
    this.setQuality(next);
    this.onAutoQuality?.(next);
  }

  // --- keeping the view clear ------------------------------------------------------

  /**
   * Don't draw what can't be seen from here: outside, the building's insides
   * (its walls and roof stay); inside, the grounds — unless you or the camera
   * are where they show through (the lobby's front doors, the hallway).
   */
  private cullAreas(): void {
    const p = this.player.position;
    // In VR the camera hangs off a rig: its world position is what counts.
    const c = this.camera.getWorldPosition(this.camAt);
    const rp = roomAt(p.x, p.z).id;
    const rc = roomAt(c.x, c.z).id;
    const outside = rp === "outside" && rc === "outside";
    const seeGrounds = [rp, rc].some((r) => r === "outside" || r === "lobby" || r === "hall");
    const a = this.rooms.areas;
    this.office.group.visible = !outside;
    this.gameRoom.group.visible = !outside;
    a.kitchen.visible = !outside;
    a.standup.visible = !outside;
    a.grounds.visible = seeGrounds;
    for (const w of this.workers.values()) w.bot.root.visible = !outside;
  }

  /** Small static things (lamps, signs, plants, furniture) that may be hidden when in the way. */
  private occludable: { mesh: THREE.Object3D; box: THREE.Box3 }[] = [];
  private hiddenNow = new Set<THREE.Object3D>();
  private ray = new THREE.Ray();
  private hit = new THREE.Vector3();

  private collectOccludable(groups: THREE.Object3D[]): void {
    const size = new THREE.Vector3();
    for (const g of groups) {
      g.updateMatrixWorld(true);
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh && !(o as THREE.Sprite).isSprite) return;
        const box = new THREE.Box3().setFromObject(m);
        box.getSize(size);
        // Walls, floors, ceilings and the roof are wide: they're never hidden
        // (the camera keeps out of them instead). Height doesn't count, so a
        // lamp's long cord or a lamp post can still step aside.
        if (Math.max(size.x, size.z) > 3.6) return;
        this.occludable.push({ mesh: m, box });
      });
    }
  }

  /**
   * Hide anything small sitting between the camera and you, or right up
   * against the lens — a hanging lamp, a sign over a door, a plant — so the
   * view never clips through a prop or loses you behind one.
   */
  private updateOcclusion(): void {
    // In first person you're looking out of your own eyes: nothing stands
    // between you and you, and leaning over a desk shouldn't make it vanish.
    if (this.firstPerson) {
      if (this.hiddenNow.size) {
        for (const m of this.hiddenNow) m.visible = true;
        this.hiddenNow.clear();
      }
      return;
    }
    const cam = this.camera.position;
    const head = this.tmp.copy(this.player.position).setY(this.player.position.y + 1.2);
    const toHead = head.clone().sub(cam);
    const len = toHead.length();
    this.ray.set(cam, toHead.normalize());
    const now = new Set<THREE.Object3D>();
    for (const o of this.occludable) {
      if (o.box.distanceToPoint(cam) < 1.1) now.add(o.mesh);
      else if (len > 0.3 && this.ray.intersectBox(o.box, this.hit) && this.hit.distanceTo(cam) < len - 0.35) now.add(o.mesh);
    }
    for (const m of this.hiddenNow) if (!now.has(m)) m.visible = true;
    for (const m of now) m.visible = false;
    this.hiddenNow = now;
  }

  /** Where a worker's head is on screen, for the HUD (null if behind you). */
  workerScreenPos(deskId: string): { x: number; y: number } | null {
    const view = this.workers.get(deskId);
    if (!view) return null;
    this.tmp.copy(view.pos).setY(1.6).project(this.camera);
    if (this.tmp.z > 1) return null;
    return { x: ((this.tmp.x + 1) / 2) * window.innerWidth, y: ((1 - this.tmp.y) / 2) * window.innerHeight };
  }
}

function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function turnToward(from: number, to: number, k: number): number {
  return from + normalizeAngle(to - from) * Math.min(1, k);
}

/** A keyboard key floating in the world, e.g. the E over something you can use. */
function keySprite(key: string): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#2b2d42";
  g.beginPath();
  g.roundRect(10, 16, 108, 104, 22);
  g.fill();
  g.fillStyle = "#fffaf3";
  g.beginPath();
  g.roundRect(10, 8, 108, 100, 22);
  g.fill();
  g.lineWidth = 7;
  g.strokeStyle = "#2b2d42";
  g.stroke();
  g.fillStyle = "#2b2d42";
  g.font = '900 68px Nunito, ui-rounded, "Segoe UI", system-ui, sans-serif';
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(key, 64, 62);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set(0.42, 0.42, 1);
  sprite.renderOrder = 20;
  return label(sprite);
}

export type Quality = "high" | "balanced" | "fast";

/** A skateboard: a deck with kicked-up ends, trucks and four wheels. */
function skateboard(): THREE.Group {
  const g = new THREE.Group();
  const deckMat = new THREE.MeshToonMaterial({ color: "#ff8a5b" });
  const deck = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.03, 0.62), deckMat);
  deck.position.y = 0.11;
  g.add(deck);
  for (const sz of [-1, 1]) {
    const kick = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.03, 0.12), deckMat);
    kick.position.set(0, 0.135, sz * 0.36);
    kick.rotation.x = sz * -0.45;
    g.add(kick);
  }
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.005, 0.58), new THREE.MeshToonMaterial({ color: "#2b2d42" }));
  grip.position.y = 0.128;
  g.add(grip);
  const wheels: THREE.Mesh[] = [];
  const wheelMat = new THREE.MeshToonMaterial({ color: "#ffd166" });
  for (const z of [-0.2, 0.2]) {
    const truck = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.03, 0.04), new THREE.MeshToonMaterial({ color: "#c9ced8" }));
    truck.position.set(0, 0.075, z);
    g.add(truck);
    for (const x of [-0.12, 0.12]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.03, 12), wheelMat);
      w.rotation.z = Math.PI / 2;
      w.position.set(x, 0.04, z);
      g.add(w);
      wheels.push(w);
    }
  }
  g.userData.wheels = wheels;
  return g;
}
