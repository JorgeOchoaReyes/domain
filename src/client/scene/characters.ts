import * as THREE from "three";
import type { AgentKind, Look, WorkerStatus } from "../../shared/protocol.js";
import { defaultLook, type CharacterLook } from "../../shared/team.js";
import { AGENT_LABELS, HAIR_COLORS, SHIRT_COLORS, SKIN_TONES, doingLabel } from "../../shared/protocol.js";
import { cardSprite, disposeSprite, INK, mesh, textSprite, toon, toonUnique } from "./toon.js";

/**
 * The two kinds of character in the office, both facing +z:
 *  - Person: you and the other people in the room — a round head with a
 *    smile, a shirt in the color you picked, and a hairdo.
 *  - Bot: a worker — a little bean with big eyes and an antenna whose bulb
 *    shows its status. By default it's colored by the agent it runs and wears
 *    a headset; one of your team's characters has its own color, face, hat
 *    and accessory (see shared/team.ts), and its name on its card.
 */

export const AGENT_COLOR: Record<AgentKind, string> = {
  claude: "#f08a5d",
  codex: "#5bc0eb",
  opencode: "#9b5de5",
  gemini: "#ffc145",
};

export const STATUS_BULB: Record<WorkerStatus, string> = {
  booting: "#adb5bd",
  idle: "#8ecae6",
  working: "#ffd166",
  waiting: "#ef476f",
  presenting: "#c77dff",
  done: "#06d6a0",
  asleep: "#5c6b8a",
};

const HIPS = 0.52;

// ---------------------------------------------------------------------------
// Person
// ---------------------------------------------------------------------------

export class Person {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private head = new THREE.Group();
  private hair = new THREE.Group();
  private legL: THREE.Group;
  private legR: THREE.Group;
  private armL: THREE.Group;
  private armR: THREE.Group;
  private shirt: THREE.MeshToonMaterial;
  private skin: THREE.MeshToonMaterial;
  private hairMat: THREE.MeshToonMaterial;
  private tag: THREE.Sprite | null = null;
  private tagText = "";
  /** Whether it wears a floating name tag (your own avatar doesn't). */
  private tagged: boolean;
  private look: Look;
  private phase = Math.random() * 6;
  private blinkAt = 1 + Math.random() * 3;
  /** On a skateboard: stand on the deck, no walking. */
  riding = false;
  /** In a chair. */
  seated = false;
  private eyes: THREE.Mesh[] = [];

  constructor(name: string, look: Look, opts: { tag?: boolean } = {}) {
    this.look = { ...look };
    this.shirt = toonUnique(SHIRT_COLORS[look.shirt]);
    this.skin = toonUnique(SKIN_TONES[look.skin]);
    this.hairMat = toonUnique(HAIR_COLORS[look.hairColor]);
    this.hairMat.side = THREE.DoubleSide;
    const pants = toon("#3d405b");
    const ink = toon("#1d1d1d");

    this.root.add(this.body);
    this.body.add(mesh(new THREE.CapsuleGeometry(0.26, 0.28, 6, 12), this.shirt, 0, 0.74, 0));

    this.head.position.y = 1.34;
    this.head.add(mesh(new THREE.SphereGeometry(0.34, 22, 16), this.skin));
    this.head.add(this.hair);
    for (const sx of [-1, 1]) {
      const eye = mesh(new THREE.SphereGeometry(0.055, 10, 8), ink, sx * 0.12, 0.02, 0.3, false);
      this.eyes.push(eye);
      this.head.add(eye);
      this.head.add(mesh(new THREE.SphereGeometry(0.05, 10, 8), toon("#ff9f9f"), sx * 0.2, -0.08, 0.27, false));
    }
    const smile = mesh(new THREE.TorusGeometry(0.06, 0.015, 6, 12, Math.PI), ink, 0, -0.08, 0.32, false);
    smile.rotation.z = Math.PI;
    this.head.add(smile);
    this.body.add(this.head);

    const limb = (len: number, r: number, mat: THREE.Material, x: number, y: number) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, 0);
      pivot.add(mesh(new THREE.CapsuleGeometry(r, len, 4, 8), mat, 0, -len / 2 - r / 2, 0));
      this.body.add(pivot);
      return pivot;
    };
    this.legL = limb(0.22, 0.1, pants, -0.12, HIPS);
    this.legR = limb(0.22, 0.1, pants, 0.12, HIPS);
    this.armL = limb(0.24, 0.08, this.shirt, -0.33, 0.92);
    this.armR = limb(0.24, 0.08, this.shirt, 0.33, 0.92);
    for (const arm of [this.armL, this.armR]) {
      arm.add(mesh(new THREE.SphereGeometry(0.085, 12, 10), this.skin, 0, -0.38, 0));
    }
    this.buildHair();
    this.tagged = opts.tag !== false;
    this.setName(name);
  }

  setName(name: string): void {
    if (name === this.tagText || !this.tagged) return;
    if (this.tag) {
      this.root.remove(this.tag);
      disposeSprite(this.tag);
    }
    this.tagText = name;
    this.tag = textSprite(name, { bg: "#fffaf3", size: 34 });
    this.tag.position.y = 2.05;
    this.root.add(this.tag);
  }

  setLook(look: Look): void {
    if (
      look.skin === this.look.skin &&
      look.hair === this.look.hair &&
      look.hairColor === this.look.hairColor &&
      look.shirt === this.look.shirt
    )
      return;
    this.look = { ...look };
    this.shirt.color.set(SHIRT_COLORS[look.shirt]);
    this.skin.color.set(SKIN_TONES[look.skin]);
    this.hairMat.color.set(HAIR_COLORS[look.hairColor]);
    this.buildHair();
  }

  private buildHair(): void {
    for (const c of [...this.hair.children]) this.hair.remove(c);
    const m = this.hairMat;
    const style = this.look.hair;
    if (style === "bald") return;
    // A cap over the top and back of the head, leaving the face clear.
    const cap = mesh(new THREE.SphereGeometry(0.365, 22, 12, 0, Math.PI * 2, 0, Math.PI * 0.42), m, 0, 0.02, -0.02);
    cap.rotation.x = -0.32;
    this.hair.add(cap);
    if (style === "long") {
      const back = mesh(new THREE.CapsuleGeometry(0.3, 0.32, 4, 14), m, 0, -0.18, -0.12);
      back.scale.set(1.05, 1, 0.7);
      this.hair.add(back);
    } else if (style === "bun") {
      this.hair.add(mesh(new THREE.SphereGeometry(0.15, 14, 10), m, 0, 0.32, -0.18));
    } else if (style === "spiky") {
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        const spike = mesh(new THREE.ConeGeometry(0.07, 0.24, 6), m, Math.sin(a) * 0.17, 0.33, Math.cos(a) * 0.17 - 0.05);
        spike.rotation.set(Math.cos(a) * 0.5, 0, -Math.sin(a) * 0.5);
        this.hair.add(spike);
      }
    } else if (style === "curly") {
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        const y = 0.12 + (i % 2) * 0.12;
        this.hair.add(mesh(new THREE.SphereGeometry(0.1, 10, 8), m, Math.sin(a) * 0.29, y, Math.cos(a) * 0.29 - 0.06));
      }
    } else if (style === "ponytail") {
      const tail = mesh(new THREE.CapsuleGeometry(0.08, 0.3, 4, 10), m, 0, -0.06, -0.36);
      tail.rotation.x = 0.4;
      this.hair.add(tail);
    }
  }

  /** Advance the walk cycle; `speed` is how fast it's moving (0 = standing). */
  update(dt: number, speed: number): void {
    if (this.seated) {
      const ease = Math.min(1, dt * 10);
      this.legL.rotation.x += (-1.45 - this.legL.rotation.x) * ease;
      this.legR.rotation.x += (-1.45 - this.legR.rotation.x) * ease;
      this.armL.rotation.x += (-0.5 - this.armL.rotation.x) * ease;
      this.armR.rotation.x += (-0.5 - this.armR.rotation.x) * ease;
      this.body.position.y = -0.22;
      this.body.rotation.z = 0;
      return;
    }
    if (this.riding) {
      // Side-on stance, knees soft, arms out, a little sway with speed.
      const ease = Math.min(1, dt * 10);
      const sway = Math.sin((this.phase += dt * 3)) * Math.min(1, speed / 6) * 0.08;
      this.legL.rotation.x += (0.28 - this.legL.rotation.x) * ease;
      this.legR.rotation.x += (-0.28 - this.legR.rotation.x) * ease;
      this.armL.rotation.x += (-0.3 - this.armL.rotation.x) * ease;
      this.armR.rotation.x += (0.3 - this.armR.rotation.x) * ease;
      this.body.position.y = 0.13 + sway * 0.2;
      this.body.rotation.z = sway;
      return;
    }
    this.body.rotation.z = 0;
    const walking = speed > 0.1;
    this.phase += dt * (walking ? 9 : 2);
    const swing = walking ? Math.sin(this.phase) * 0.7 : 0;
    const ease = Math.min(1, dt * 12);
    this.legL.rotation.x += (swing - this.legL.rotation.x) * ease;
    this.legR.rotation.x += (-swing - this.legR.rotation.x) * ease;
    this.armL.rotation.x += (-swing * 0.8 - this.armL.rotation.x) * ease;
    this.armR.rotation.x += (swing * 0.8 - this.armR.rotation.x) * ease;
    this.body.position.y = walking ? Math.abs(Math.sin(this.phase)) * 0.06 : Math.sin(this.phase) * 0.008;

    this.blinkAt -= dt;
    const closed = this.blinkAt < 0.12;
    for (const e of this.eyes) e.scale.y = closed ? 0.15 : 1;
    if (this.blinkAt < 0) this.blinkAt = 2 + Math.random() * 4;
  }

  dispose(): void {
    if (this.tag) disposeSprite(this.tag);
  }
}

// ---------------------------------------------------------------------------
// Bot (a worker)
// ---------------------------------------------------------------------------

/** What a worker is doing this frame, as far as its animation cares. */
export interface BotPose {
  /** Sitting in its desk chair. */
  seated: boolean;
  /** Walking to or from the line. */
  walking: boolean;
  status: WorkerStatus;
}

// Shapes every bot shares (made once, reused): a worker is a dozen or so
// small meshes, so sharing geometry keeps a full office cheap.
let G: ReturnType<typeof makeGeometry> | null = null;
function geo(): ReturnType<typeof makeGeometry> {
  return (G ??= makeGeometry());
}
function makeGeometry() {
  const half = (r: number) => new THREE.SphereGeometry(r, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  return {
    body: new THREE.CapsuleGeometry(0.28, 0.3, 8, 16),
    eye: new THREE.SphereGeometry(0.09, 12, 10),
    pupil: new THREE.SphereGeometry(0.045, 10, 8),
    lid: new THREE.BoxGeometry(0.2, 0.025, 0.06),
    band: new THREE.TorusGeometry(0.29, 0.025, 6, 20, Math.PI),
    cup: new THREE.SphereGeometry(0.07, 10, 8),
    bigCup: new THREE.CylinderGeometry(0.1, 0.1, 0.07, 14),
    mic: new THREE.CylinderGeometry(0.012, 0.012, 0.2, 5),
    antenna: new THREE.CylinderGeometry(0.015, 0.015, 0.22, 6),
    bulb: new THREE.SphereGeometry(0.075, 12, 10),
    arm: new THREE.CapsuleGeometry(0.055, 0.16, 4, 8),
    foot: new THREE.CapsuleGeometry(0.06, 0.1, 4, 8),
    smile: new THREE.TorusGeometry(0.07, 0.014, 6, 12, Math.PI),
    grin: new THREE.CircleGeometry(0.085, 14, Math.PI, Math.PI),
    lens: new THREE.BoxGeometry(0.15, 0.09, 0.03),
    bridge: new THREE.BoxGeometry(0.08, 0.02, 0.02),
    ring: new THREE.TorusGeometry(0.075, 0.012, 6, 16),
    brow: new THREE.BoxGeometry(0.11, 0.022, 0.03),
    dome: half(0.285),
    beanieBand: new THREE.TorusGeometry(0.275, 0.035, 6, 20),
    pompom: new THREE.SphereGeometry(0.06, 10, 8),
    brim: new THREE.CylinderGeometry(0.2, 0.2, 0.025, 16, 1, false, -Math.PI / 2, Math.PI),
    crownBase: new THREE.CylinderGeometry(0.2, 0.2, 0.09, 16, 1, true),
    spike: new THREE.ConeGeometry(0.045, 0.1, 6),
    party: new THREE.ConeGeometry(0.12, 0.32, 14),
    wizard: new THREE.ConeGeometry(0.2, 0.5, 16),
    wizardBrim: new THREE.CylinderGeometry(0.34, 0.34, 0.025, 20),
    bowWing: new THREE.ConeGeometry(0.06, 0.1, 4),
    knot: new THREE.SphereGeometry(0.03, 8, 6),
    scarf: new THREE.TorusGeometry(0.235, 0.05, 8, 20),
    tail: new THREE.BoxGeometry(0.08, 0.2, 0.04),
    badge: new THREE.CylinderGeometry(0.06, 0.06, 0.02, 16),
    stache: new THREE.CapsuleGeometry(0.025, 0.07, 4, 8),
  };
}

const GOLD = "#ffd166";

export class Bot {
  readonly root = new THREE.Group();
  /** The look it was built with, as a key (rebuild the bot when it changes). */
  readonly lookKey: string;
  /** Its character's name (null: it shows its agent's name). */
  name: string | null;
  private body = new THREE.Group();
  private bulb: THREE.MeshToonMaterial;
  private armL: THREE.Group;
  private armR: THREE.Group;
  private feet: THREE.Mesh[] = [];
  private eyes: THREE.Mesh[] = [];
  private card: THREE.Sprite | null = null;
  private cardKey = "";
  private t = Math.random() * 10;
  private blinkAt = Math.random() * 4;
  private canBlink = true;

  constructor(
    readonly agent: AgentKind,
    look: CharacterLook | null = null,
    name: string | null = null,
  ) {
    const l = look ?? { ...defaultLook(agent), color: AGENT_COLOR[agent] };
    this.lookKey = Bot.keyFor(agent, look);
    this.name = name;
    const g = geo();
    const skin = toonUnique(l.color);
    const white = toon("#ffffff");
    const ink = toon("#1d1d1d");
    const dark = toon(INK);
    const add = (geometry: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, shadow = false) => {
      const m = mesh(geometry, mat, x, y, z, shadow);
      this.body.add(m);
      return m;
    };

    this.root.add(this.body);
    add(g.body, skin, 0, 0.55, 0, true);
    this.buildFace(l, add, white, ink, dark);
    this.buildHat(l, add, dark);
    this.buildAccessory(l, add, ink, dark);
    // Antenna with the status bulb.
    add(g.antenna, dark, 0, 1.07, 0);
    this.bulb = toonUnique(STATUS_BULB.booting);
    add(g.bulb, this.bulb, 0, 1.2, 0);

    const arm = (x: number) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, 0.58, 0.05);
      pivot.add(mesh(g.arm, skin, 0, -0.12, 0));
      this.body.add(pivot);
      return pivot;
    };
    this.armL = arm(-0.3);
    this.armR = arm(0.3);
    for (const sx of [-1, 1]) {
      const foot = add(g.foot, skin, sx * 0.12, 0.2, 0.05, true);
      foot.rotation.x = Math.PI / 2;
      this.feet.push(foot);
    }
  }

  /** The key a look builds to; a bot whose key differs needs rebuilding. */
  static keyFor(agent: AgentKind, look: CharacterLook | null): string {
    return look ? `${agent}|${look.color}|${look.face}|${look.hat}|${look.accessory}` : agent;
  }

  private buildFace(
    l: CharacterLook,
    add: (g: THREE.BufferGeometry, m: THREE.Material, x?: number, y?: number, z?: number) => THREE.Mesh,
    white: THREE.Material,
    ink: THREE.Material,
    dark: THREE.Material,
  ): void {
    const g = geo();
    for (const sx of [-1, 1]) {
      const eye = add(g.eye, white, sx * 0.11, 0.7, 0.23);
      eye.scale.z = 0.6;
      const pupil = add(g.pupil, ink, sx * 0.11, 0.7, 0.29);
      this.eyes.push(eye, pupil);
      if (l.face === "wink" && sx === 1) {
        // One eye shut in a happy squint.
        eye.scale.y = 0.15;
        eye.userData.squint = true;
        pupil.visible = false;
      }
      if (l.face === "sleepy") {
        // Heavy lids halfway down.
        const lid = add(g.lid, toon(l.color), sx * 0.11, 0.735, 0.27);
        lid.scale.y = 2.4;
      }
      if (l.face === "focused") {
        const brow = add(g.brow, dark, sx * 0.11, 0.81, 0.27);
        brow.rotation.z = sx * 0.35;
      }
    }
    if (l.face === "cool") {
      // Shades over the eyes; no blinking behind them.
      this.canBlink = false;
      for (const sx of [-1, 1]) add(g.lens, dark, sx * 0.1, 0.71, 0.3);
      add(g.bridge, dark, 0, 0.72, 0.3);
    }
    if (l.face === "grin") {
      // A wide open grin, sitting just proud of the face (tilted to follow its curve).
      const mouth = add(g.grin, dark, 0, 0.585, 0.293);
      mouth.rotation.x = -0.25;
      mouth.scale.set(1, 0.85, 1);
    } else if (l.face !== "focused") {
      const mouth = add(g.smile, dark, 0, 0.6, 0.265);
      mouth.rotation.z = Math.PI;
      if (l.face === "sleepy") mouth.scale.set(0.6, 0.5, 1);
    }
  }

  private buildHat(
    l: CharacterLook,
    add: (g: THREE.BufferGeometry, m: THREE.Material, x?: number, y?: number, z?: number) => THREE.Mesh,
    dark: THREE.Material,
  ): void {
    const g = geo();
    const accent = toon(l.color === "#ef476f" ? "#3d5a80" : "#ef476f");
    switch (l.hat) {
      case "headset": {
        // A band over the top, an ear cup each side, and a mic.
        add(g.band, dark, 0, 0.72, 0).rotation.y = Math.PI / 2;
        for (const sx of [-1, 1]) add(g.cup, dark, sx * 0.29, 0.72, 0);
        add(g.mic, dark, 0.25, 0.62, 0.12).rotation.set(0.9, 0, 0.5);
        break;
      }
      case "headphones": {
        add(g.band, dark, 0, 0.72, 0).rotation.y = Math.PI / 2;
        for (const sx of [-1, 1]) add(g.bigCup, accent, sx * 0.3, 0.72, 0).rotation.z = Math.PI / 2;
        break;
      }
      case "cap": {
        const dome = add(g.dome, accent, 0, 0.83, 0);
        dome.scale.y = 0.55;
        add(g.brim, accent, 0, 0.84, 0.16).rotation.y = Math.PI;
        break;
      }
      case "beanie": {
        const dome = add(g.dome, accent, 0, 0.8, 0);
        dome.scale.y = 0.75;
        add(g.beanieBand, toon("#fffaf3"), 0, 0.82, 0).rotation.x = Math.PI / 2;
        add(g.pompom, toon("#fffaf3"), 0.13, 1.03, 0);
        break;
      }
      case "crown": {
        const gold = toon(GOLD);
        add(g.crownBase, gold, 0, 0.95, 0);
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          add(g.spike, gold, Math.sin(a) * 0.19, 1.04, Math.cos(a) * 0.19);
        }
        break;
      }
      case "party": {
        const hat = add(g.party, accent, 0.13, 1.03, 0);
        hat.rotation.z = -0.35;
        add(g.pompom, toon(GOLD), 0.19, 1.19, 0);
        break;
      }
      case "wizard": {
        const purple = toon("#5a3d9a");
        add(g.wizardBrim, purple, 0, 0.86, 0);
        const cone = add(g.wizard, purple, -0.06, 1.1, -0.02);
        cone.rotation.z = 0.25;
        add(g.spike, toon(GOLD), -0.04, 1.02, 0.17).rotation.x = 0.6;
        break;
      }
      case "none":
        break;
    }
  }

  private buildAccessory(
    l: CharacterLook,
    add: (g: THREE.BufferGeometry, m: THREE.Material, x?: number, y?: number, z?: number) => THREE.Mesh,
    ink: THREE.Material,
    dark: THREE.Material,
  ): void {
    const g = geo();
    switch (l.accessory) {
      case "glasses": {
        if (l.face === "cool") break;
        for (const sx of [-1, 1]) add(g.ring, dark, sx * 0.11, 0.7, 0.29);
        add(g.bridge, dark, 0, 0.71, 0.3);
        break;
      }
      case "bowtie": {
        const red = toon("#ef476f");
        for (const sx of [-1, 1]) add(g.bowWing, red, sx * 0.06, 0.38, 0.25).rotation.z = sx * Math.PI / 2;
        add(g.knot, red, 0, 0.38, 0.27);
        break;
      }
      case "scarf": {
        const scarf = toon("#06d6a0");
        add(g.scarf, scarf, 0, 0.4, 0).rotation.x = Math.PI / 2;
        add(g.tail, scarf, 0.12, 0.28, 0.22).rotation.z = 0.15;
        break;
      }
      case "badge": {
        add(g.badge, toon(GOLD), -0.13, 0.45, 0.25).rotation.x = Math.PI / 2;
        break;
      }
      case "mustache": {
        for (const sx of [-1, 1]) {
          const half = add(g.stache, ink, sx * 0.05, 0.6, 0.27);
          half.rotation.z = Math.PI / 2 + sx * 0.25;
        }
        break;
      }
      case "none":
        break;
    }
  }

  /**
   * The card over its head: a status chip, the agent's name and what it's
   * doing. `onStage` says whether it's the one presenting (rather than waiting
   * in line).
   */
  setCard(status: WorkerStatus, hiredBy: string, activity: string, onStage = false, doing = ""): void {
    const base = status === "presenting" && !onStage ? IN_LINE : CHIP[status];
    // At work, the chip says what it's on right now, in a word or three.
    const chip: typeof base = status === "working" && doing ? [doingLabel(doing), base[1], base[2]] : base;
    const key = `${status}|${hiredBy}|${activity}|${onStage}|${this.name ?? ""}|${chip[0]}`;
    if (key === this.cardKey) return;
    this.cardKey = key;
    if (this.card) {
      this.root.remove(this.card);
      disposeSprite(this.card);
    }
    const hot = status === "waiting" || status === "presenting";
    this.card = cardSprite({
      chip: { text: chip[0], bg: chip[1], color: chip[2] },
      title: this.name ? `${this.name} · ${AGENT_LABELS[this.agent]}` : `${AGENT_LABELS[this.agent]} · ${hiredBy}`,
      body: activity,
      bg: status === "waiting" ? "#ffc2d1" : status === "working" ? "#ffec99" : status === "done" ? "#caffbf" : "#fffaf3",
      border: hot ? STATUS_BULB[status] : undefined,
    });
    this.card.position.y = 1.45;
    this.root.add(this.card);
  }

  update(dt: number, pose: BotPose): void {
    this.t += dt;
    const t = this.t;
    const s = pose.status;
    const bulbColor = STATUS_BULB[s];
    this.bulb.color.set(bulbColor);
    const pulse = s === "waiting" ? 0.5 + 0.5 * Math.sin(t * 8) : s === "working" ? 0.35 : 0.2;
    this.bulb.emissive.set(bulbColor).multiplyScalar(pulse);

    let bodyY = 0;
    let armL = 0;
    let armR = 0;
    let tilt = 0;
    if (pose.walking) {
      // A waddle: a hop each step and a side-to-side sway.
      bodyY = Math.abs(Math.sin(t * 10)) * 0.08;
      tilt = Math.sin(t * 10) * 0.12;
      armL = Math.sin(t * 10) * 0.6;
      armR = -armL;
      this.feet[0].position.z = 0.05 + Math.sin(t * 10) * 0.06;
      this.feet[1].position.z = 0.05 - Math.sin(t * 10) * 0.06;
    } else {
      for (const f of this.feet) f.position.z = 0.05;
      if (s === "working" && pose.seated) {
        // Typing: both hands out at the keyboard, tapping.
        armL = -1.25 + Math.sin(t * 22) * 0.12;
        armR = -1.25 + Math.sin(t * 22 + 1.7) * 0.12;
        bodyY = Math.abs(Math.sin(t * 3)) * 0.01;
      } else if (s === "waiting") {
        // Hopping and waving for attention.
        bodyY = Math.max(0, Math.sin(t * 6)) * 0.18;
        armR = -2.6 + Math.sin(t * 12) * 0.35;
      } else if (s === "done") {
        bodyY = Math.max(0, Math.sin(t * 7)) * 0.12;
        armL = armR = -2.4;
      } else if (s === "presenting") {
        // Gesturing at the screen while it talks.
        armR = -1.4 + Math.sin(t * 2.4) * 0.5;
        armL = -0.4 + Math.sin(t * 1.7) * 0.2;
        bodyY = Math.abs(Math.sin(t * 2)) * 0.02;
      } else {
        bodyY = Math.sin(t * 2) * 0.012;
      }
    }
    const ease = Math.min(1, dt * 10);
    this.body.position.y += (bodyY - this.body.position.y) * ease;
    this.body.rotation.z += (tilt - this.body.rotation.z) * ease;
    this.armL.rotation.x += (armL - this.armL.rotation.x) * ease;
    this.armR.rotation.x += (armR - this.armR.rotation.x) * ease;

    this.blinkAt -= dt;
    const closed = this.canBlink && this.blinkAt < 0.1;
    for (const e of this.eyes) if (e.userData.squint !== true) e.scale.y = closed ? 0.12 : 1;
    if (this.blinkAt < 0) this.blinkAt = 2 + Math.random() * 4;
  }

  dispose(): void {
    if (this.card) disposeSprite(this.card);
  }
}

/** The chip of a worker waiting in line outside your office. */
const IN_LINE: [string, string, string] = ["⏳ IN LINE", "#e0c3fc", INK];

/** Status pill text, background and text color. */
const CHIP: Record<WorkerStatus, [string, string, string]> = {
  booting: ["⏳ STARTING", STATUS_BULB.booting, INK],
  idle: ["💬 READY", STATUS_BULB.idle, INK],
  working: ["⌨️ WORKING", STATUS_BULB.working, INK],
  waiting: ["🙋 NEEDS YOU", STATUS_BULB.waiting, "#ffffff"],
  presenting: ["🎤 PRESENTING", STATUS_BULB.presenting, "#ffffff"],
  done: ["✅ DONE", STATUS_BULB.done, INK],
  asleep: ["💤 ASLEEP", STATUS_BULB.asleep, "#ffffff"],
};
