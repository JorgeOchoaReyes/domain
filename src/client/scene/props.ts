import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { BUILDING, KITCHEN, LOBBY, PARTITIONS_X, WALL_HEIGHT, WALL_T } from "../../shared/layout.js";
import type { Collider } from "./office.js";
import { box, INK, mesh, textSprite, toon, toonUnique } from "./toon.js";

/**
 * Props from Kenney's Furniture Kit (CC0 — see docs/ASSETS.md), recolored in
 * the toon look, plus a few made here. Some are just there (a bookcase, a
 * coat rack, ceiling fans, a toaster); the rest you can use with E: pop
 * popcorn in the kitchen microwave, tune the lobby radio, click the floor
 * lamp, squeak the teddy on the couch, pet Pixel the lobby cat, and toss
 * paper balls at the bin in your office.
 */

export type PropSound = "bell" | "click" | "thunk" | "xp" | "chime" | "squeak" | "achievement";

/** What a prop wants the game to do: a toast, a sound, a speed boost. */
export interface PropEvent {
  toast?: string;
  sound?: PropSound;
  boostMs?: number;
}

export interface PropSpot {
  id: string;
  title: string;
  /** What E does, as hint HTML after the key. */
  hint: string;
  /** Where the floating E goes. */
  key: { x: number; y: number; z: number };
}

export interface Props {
  group: THREE.Group;
  colliders: Collider[];
  /** The usable prop you're closest to, if any. */
  near(x: number, z: number): PropSpot | null;
  /** E: use the prop you're at. True if something happened. */
  use(x: number, z: number): boolean;
  /** Fans spin, the cat wanders, paper flies. */
  update(dt: number, now: number): void;
  /** Set by the game: plays sounds, shows toasts, boosts you. */
  onEvent: ((e: PropEvent) => void) | null;
}

// ---------------------------------------------------------------------------
// Loading Kenney's models
// ---------------------------------------------------------------------------

const URLS = import.meta.glob("../assets/kenney/*.glb", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
const urlOf = (name: string) => URLS[`../assets/kenney/${name}.glb`];

/** Kenney's flat colors, warmed up to the office's palette. */
const RECOLOR: Record<string, string> = {
  wood: "#c98b5a",
  metal: "#c9ced8",
  metalLight: "#f1f3f6",
  metalMedium: "#7d8597",
  metalDark: "#3d405b",
  lamp: "#ffe8a3",
  plant: "#52b788",
  carpetWhite: "#f4f1ea",
};

const loader = new GLTFLoader();
const loaded = new Map<string, Promise<THREE.Object3D>>();

function load(name: string): Promise<THREE.Object3D> {
  let p = loaded.get(name);
  if (!p) {
    const url = urlOf(name);
    p = url ? loader.loadAsync(url).then((g) => g.scene) : Promise.reject(new Error(`no model ${name}`));
    loaded.set(name, p);
  }
  return p;
}

interface ModelOpts {
  /** How tall it stands, in meters (the model is scaled to fit). */
  height: number;
  x: number;
  y?: number;
  z: number;
  /** Kenney's fronts face +z; this turns it. */
  rotY?: number;
  /** Material names to give their own (changeable) material. */
  unique?: string[];
  /** Override a material's color by name. */
  colors?: Record<string, string>;
  /** Called once it's in, with its own materials by name. */
  ready?: (mats: Map<string, THREE.MeshToonMaterial>, model: THREE.Object3D) => void;
}

/** A Kenney model, placed: an empty group now, filled in when it has loaded. */
function model(name: string, o: ModelOpts): THREE.Group {
  const g = new THREE.Group();
  g.position.set(o.x, o.y ?? 0, o.z);
  g.rotation.y = o.rotY ?? 0;
  load(name)
    .then((src) => {
      const m = src.clone(true);
      const own = new Map<string, THREE.MeshToonMaterial>();
      m.traverse((obj) => {
        const ms = obj as THREE.Mesh;
        if (!ms.isMesh) return;
        ms.castShadow = true;
        ms.receiveShadow = true;
        const swap = (mat: THREE.Material): THREE.Material => {
          const std = mat as THREE.MeshStandardMaterial;
          const color = o.colors?.[mat.name] ?? RECOLOR[mat.name] ?? `#${std.color?.getHexString() ?? "ffffff"}`;
          if (o.unique?.includes(mat.name)) {
            let u = own.get(mat.name);
            if (!u) {
              u = toonUnique(color);
              own.set(mat.name, u);
            }
            return u;
          }
          return toon(color, std.transparent ? { opacity: Math.max(0.35, std.opacity) } : {});
        };
        ms.material = Array.isArray(ms.material) ? ms.material.map(swap) : swap(ms.material);
      });
      // Scale to height, center on x/z, stand it on y = 0.
      const bb = new THREE.Box3().setFromObject(m);
      const size = bb.getSize(new THREE.Vector3());
      const k = o.height / Math.max(size.y, 1e-3);
      m.scale.setScalar(k);
      const c = bb.getCenter(new THREE.Vector3());
      m.position.set(-c.x * k, -bb.min.y * k, -c.z * k);
      g.add(m);
      o.ready?.(own, m);
    })
    .catch(() => {
      /* a missing model just isn't there */
    });
  return g;
}

// ---------------------------------------------------------------------------
// The props
// ---------------------------------------------------------------------------

const COUNTER_TOP = 0.93;
const COUNTER_X = (KITCHEN.counter.minX + KITCHEN.counter.maxX) / 2;
const DESK_TOP = 1.11;

/** Where things are, and where you stand to use them. */
export const PROPS = {
  microwave: { x: COUNTER_X + 0.05, z: 25.2, spot: { x: KITCHEN.counter.maxX + 0.8, z: 25.2 } },
  radio: { x: LOBBY.desk.x + 0.15, z: 22.75, spot: { x: LOBBY.desk.x + 1.25, z: 22.75 } },
  lamp: { x: LOBBY.couch.x + 0.2, z: LOBBY.couch.z + 1.75, spot: { x: LOBBY.couch.x - 0.8, z: LOBBY.couch.z + 1.9 } },
  bear: { x: LOBBY.couch.x - 0.05, z: LOBBY.couch.z + 0.5, spot: { x: LOBBY.couch.x - 1.05, z: LOBBY.couch.z + 0.5 } },
  bin: { x: 8.6, z: 9.6 },
} as const;

/** The cat's rounds in the lobby: clear of the desk and the couch. */
const CAT_ROUTE = [
  { x: 2.7, z: 18.4 },
  { x: 4.2, z: 19.9 },
  { x: 3.3, z: 21.6 },
  { x: 3.8, z: 24.2 },
  { x: 2.5, z: 26.0 },
  { x: 4.1, z: 27.3 },
  { x: 2.4, z: 23.4 },
] as const;

const HEADLINES = [
  "Local developer writes tests first; neighbors stunned",
  "Coffee machine reports record morning, asks for a raise",
  "Pull request merged on the first try. Experts urge calm",
  "Stand-up runs under ten minutes for the third day running",
  "Lobby cat promoted to Head of Morale",
  "Study finds 9 out of 10 bugs were 'just a typo'",
  "Weather: clear skies, light chance of merge conflicts",
  "Traffic: heavy on the main branch, rebase advised",
  "Sports: game room's Bug Smash record falls again",
  "Breaking: someone finally read the README",
];

const store = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem(`domain.props.${k}`);
      return v === null ? d : (JSON.parse(v) as T);
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown): void {
    try {
      localStorage.setItem(`domain.props.${k}`, JSON.stringify(v));
    } catch {
      /* fine */
    }
  },
};

const dist = (x: number, z: number, p: { x: number; z: number }) => Math.hypot(x - p.x, z - p.z);

export function buildProps(): Props {
  const group = new THREE.Group();
  const colliders: Collider[] = [];
  const add = (o: THREE.Object3D) => group.add(o);
  const solid = (x: number, z: number, hw: number, hd: number) => colliders.push({ minX: x - hw, maxX: x + hw, minZ: z - hd, maxZ: z + hd });
  const props: Props = { group, colliders, near, use, update, onEvent: null };
  const emit = (e: PropEvent) => props.onEvent?.(e);

  // --- just there ------------------------------------------------------------------
  // The kitchen counter: a blender by the sink, a toaster past the coffee.
  add(model("kitchenBlender", { height: 0.44, x: COUNTER_X, y: COUNTER_TOP, z: 20.55, rotY: Math.PI / 2 }));
  add(model("toaster", { height: 0.24, x: COUNTER_X + 0.05, y: COUNTER_TOP, z: 23.6, rotY: Math.PI / 2, colors: { metal: "#ff8a5b" } }));
  // The lobby: a bookcase by the way in, a coat rack by the front doors, a plant on the desk.
  const lobbyWest = PARTITIONS_X[1] + WALL_T / 2;
  add(model("bookcaseOpen", { height: 1.85, x: lobbyWest + 0.27, z: 19.3, rotY: Math.PI / 2 }));
  solid(lobbyWest + 0.27, 19.3, 0.3, 0.45);
  add(books(lobbyWest + 0.27, 19.3));
  add(model("coatRackStanding", { height: 1.8, x: lobbyWest + 0.45, z: BUILDING.maxZ - 1.6 }));
  solid(lobbyWest + 0.45, BUILDING.maxZ - 1.6, 0.25, 0.25);
  add(model("plantSmall2", { height: 0.32, x: LOBBY.desk.x - 0.15, y: DESK_TOP, z: LOBBY.desk.z + LOBBY.desk.length / 2 - 0.2 }));
  // Ceiling fans over the kitchen tables and the lobby.
  const fans = [fan((KITCHEN.tables[0].x + KITCHEN.tables[1].x) / 2, (KITCHEN.tables[0].z + KITCHEN.tables[1].z) / 2), fan(3, 26.4)];
  for (const f of fans) add(f.group);

  // --- the microwave: popcorn ------------------------------------------------------
  const mw = PROPS.microwave;
  let mwGlass: THREE.MeshToonMaterial | null = null;
  add(
    model("kitchenMicrowave", {
      height: 0.36,
      x: mw.x,
      y: COUNTER_TOP,
      z: mw.z,
      rotY: Math.PI / 2,
      unique: ["glass"],
      ready: (mats) => (mwGlass = mats.get("glass") ?? null),
    }),
  );
  let popping = 0; // when it's done (ms), 0 = idle
  const pops: THREE.Mesh[] = [];
  const kernel = new THREE.IcosahedronGeometry(0.02, 0);
  const kernelMat = toon("#fff6d6");

  // --- the radio on the reception desk -----------------------------------------------
  const rd = PROPS.radio;
  const radio = model("radio", { height: 0.26, x: rd.x, y: DESK_TOP, z: rd.z, rotY: Math.PI / 2 });
  add(radio);
  let radioUntil = 0;
  let headline = 0;
  const notes: THREE.Sprite[] = [];
  for (let i = 0; i < 3; i++) {
    const s = textSprite(i % 2 ? "♫" : "♪", { color: "#7b2cbf", size: 64 });
    s.visible = false;
    notes.push(s);
    add(s);
  }

  // --- the floor lamp by the couch -----------------------------------------------------
  const lp = PROPS.lamp;
  let lampOn = store.get("lamp", true);
  let shade: THREE.MeshToonMaterial | null = null;
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: "#ffd98a", transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  glow.scale.setScalar(0.9);
  add(glow);
  const lamp = model("lampRoundFloor", {
    height: 1.75,
    x: lp.x,
    z: lp.z,
    unique: ["lamp"],
    ready: (mats) => {
      shade = mats.get("lamp") ?? null;
      paintLamp();
    },
  });
  // The glow sits in the shade, at the top of the pole.
  glow.position.set(lp.x, 1.6, lp.z);
  add(lamp);
  solid(lp.x, lp.z, 0.2, 0.2);
  function paintLamp(): void {
    glow.visible = lampOn;
    if (shade) shade.emissive.set(lampOn ? "#ffcc66" : "#000000");
  }
  paintLamp();

  // --- the teddy bear on the couch -----------------------------------------------------
  const br = PROPS.bear;
  const bear = teddy();
  bear.position.set(br.x, 0.58, br.z);
  bear.rotation.y = -Math.PI / 2;
  add(bear);
  let squeakAt = 0;

  // --- Pixel, the lobby cat ------------------------------------------------------------
  const cat = buildCat();
  add(cat.root);
  const c = { x: CAT_ROUTE[0].x, z: CAT_ROUTE[0].z, leg: 1, rest: 2000, mode: "walk" as "walk" | "sit" | "nap" | "petted", until: 0, heading: 0 };
  cat.root.position.set(c.x, 0, c.z);
  const hearts: { s: THREE.Sprite; born: number }[] = [];
  let pets = store.get("pets", 0);

  // --- the bin in your office: paper toss ------------------------------------------------
  const bn = PROPS.bin;
  add(model("trashcan", { height: 0.6, x: bn.x, z: bn.z, colors: { metal: "#06d6a0" } }));
  solid(bn.x, bn.z, 0.25, 0.25);
  const paper = new THREE.IcosahedronGeometry(0.07, 1);
  const paperMat = toon("#ffffff");
  const flying: { m: THREE.Mesh; from: THREE.Vector3; to: THREE.Vector3; t: number; make: boolean; points: number }[] = [];
  const misses: { m: THREE.Mesh; at: number }[] = [];
  let streak = 0;

  // ---------------------------------------------------------------------------------------

  function near(x: number, z: number): PropSpot | null {
    const spots: { d: number; s: () => PropSpot }[] = [];
    const at = (p: { x: number; z: number }, r: number, s: () => PropSpot) => {
      const d = dist(x, z, p);
      if (d < r) spots.push({ d, s });
    };
    at(mw.spot, 1.2, () => ({
      id: "microwave",
      title: "🍿 Microwave",
      hint: popping ? "Popping… listen for the ding" : "Pop some popcorn",
      key: { x: mw.x + 0.25, y: COUNTER_TOP + 0.65, z: mw.z },
    }));
    at(rd.spot, 1.2, () => ({
      id: "radio",
      title: "📻 Radio KDMN",
      hint: radioUntil > performance.now() ? "Next story" : "Catch the news",
      key: { x: rd.x + 0.3, y: DESK_TOP + 0.55, z: rd.z },
    }));
    at(lp.spot, 1.1, () => ({ id: "lamp", title: "💡 Floor lamp", hint: lampOn ? "Click it off" : "Click it on", key: { x: lp.x - 0.3, y: 1.4, z: lp.z } }));
    at(br.spot, 1.0, () => ({ id: "bear", title: "🧸 Teddy", hint: "Give it a squeeze", key: { x: br.x - 0.2, y: 1.25, z: br.z } }));
    at(c, 1.3, () => ({
      id: "cat",
      title: "🐈 Pixel, the lobby cat",
      hint: `Pet her${pets ? ` · ${pets} pet${pets === 1 ? "" : "s"} so far` : ""}`,
      key: { x: c.x, y: 0.95, z: c.z },
    }));
    const db = dist(x, z, bn);
    if (db > 0.7 && db < 3.4)
      spots.push({
        d: db + 0.5, // the bin's a long way off: anything close by comes first
        s: () => ({
          id: "bin",
          title: "🗑 Paper toss",
          hint: `Throw — farther is worth more${streak ? ` · streak ${streak}` : ""} · best ${store.get("toss", 0)}`,
          key: { x: bn.x, y: 1.0, z: bn.z },
        }),
      });
    if (!spots.length) return null;
    spots.sort((a, b) => a.d - b.d);
    return spots[0].s();
  }

  function use(x: number, z: number): boolean {
    const s = near(x, z);
    if (!s) return false;
    const now = performance.now();
    if (s.id === "microwave") {
      if (popping) return true;
      popping = now + 4500;
      emit({ sound: "click", toast: "🍿 Popcorn's on — 4… 3… 2…" });
    } else if (s.id === "radio") {
      radioUntil = now + 9000;
      headline = (headline + 1 + Math.floor(Math.random() * (HEADLINES.length - 1))) % HEADLINES.length;
      emit({ sound: "chime", toast: `📻 KDMN news: ${HEADLINES[headline]}` });
    } else if (s.id === "lamp") {
      lampOn = !lampOn;
      store.set("lamp", lampOn);
      paintLamp();
      emit({ sound: "click" });
    } else if (s.id === "bear") {
      squeakAt = now;
      emit({ sound: "squeak", toast: Math.random() < 0.15 ? "🧸 *squeak* — it seems to like you" : undefined });
    } else if (s.id === "cat") {
      c.mode = "petted";
      c.until = now + 3500;
      c.heading = Math.atan2(x - c.x, z - c.z);
      pets++;
      store.set("pets", pets);
      for (let i = 0; i < 3; i++) {
        const h = textSprite("❤", { color: "#ef476f", size: 56 });
        h.position.set(c.x + (Math.random() - 0.5) * 0.3, 0.7, c.z + (Math.random() - 0.5) * 0.3);
        add(h);
        hearts.push({ s: h, born: now + i * 250 });
      }
      emit({ sound: "chime", toast: pets % 25 === 0 ? `🐈 Pixel purrs. That's ${pets} pets — she's decided you're her favorite.` : "🐈 Prrrrrr…" });
    } else if (s.id === "bin") {
      toss(x, z);
    }
    return true;
  }

  function toss(x: number, z: number): void {
    const d = dist(x, z, bn);
    const make = Math.random() < Math.max(0.15, 1.1 - d * 0.25);
    const points = Math.max(1, Math.round(d));
    const m = new THREE.Mesh(paper, paperMat);
    const from = new THREE.Vector3(x, 1.4, z);
    // A miss lands beside the bin.
    const a = Math.random() * Math.PI * 2;
    const to = make ? new THREE.Vector3(bn.x, 0.45, bn.z) : new THREE.Vector3(bn.x + Math.cos(a) * 0.45, 0.07, bn.z + Math.sin(a) * 0.45);
    m.position.copy(from);
    add(m);
    flying.push({ m, from, to, t: 0, make, points });
  }

  function landed(f: (typeof flying)[number]): void {
    if (f.make) {
      group.remove(f.m);
      streak += f.points;
      const best = store.get("toss", 0);
      if (streak > best) store.set("toss", streak);
      emit({ sound: streak > best && best ? "achievement" : "thunk", toast: `🗑 Swish! +${f.points} · streak ${streak}${streak > best && best ? " — a new best!" : ""}` });
    } else {
      misses.push({ m: f.m, at: performance.now() });
      if (streak) emit({ toast: `🗑 Rim out. Streak over at ${streak}` });
      streak = 0;
      emit({ sound: "click" });
    }
  }

  function update(dt: number, now: number): void {
    for (const f of fans) f.blades.rotation.y += dt * 2.2;

    // Popcorn: the glass glows while it hums, kernels hop, then — ding.
    if (popping) {
      if (mwGlass) mwGlass.emissive.set(Math.sin(now * 0.02) > 0 ? "#ff9f1c" : "#ffb347");
      if (Math.random() < dt * 6 && pops.length < 12) {
        const k = new THREE.Mesh(kernel, kernelMat);
        k.position.set(mw.x + 0.2, COUNTER_TOP + 0.3, mw.z + (Math.random() - 0.5) * 0.3);
        k.userData.v = new THREE.Vector3(0.6 + Math.random() * 0.5, 1.2 + Math.random(), (Math.random() - 0.5) * 0.8);
        add(k);
        pops.push(k);
      }
      if (now >= popping) {
        popping = 0;
        if (mwGlass) mwGlass.emissive.set("#000000");
        emit({ sound: "bell", boostMs: 60_000, toast: "🍿 Ding! Hot popcorn — you're a little quicker for a minute" });
      }
    }
    for (let i = pops.length - 1; i >= 0; i--) {
      const k = pops[i];
      const v = k.userData.v as THREE.Vector3;
      v.y -= 9.8 * dt;
      k.position.addScaledVector(v, dt);
      k.rotation.x += dt * 8;
      if (k.position.y < COUNTER_TOP) {
        group.remove(k);
        pops.splice(i, 1);
      }
    }

    // The radio: notes drift up while it plays; it bounces to the beat.
    const playing = radioUntil > now;
    notes.forEach((n, i) => {
      n.visible = playing;
      if (!playing) return;
      const t = ((now / 1600 + i / notes.length) % 1 + 1) % 1;
      n.position.set(rd.x + 0.1 + Math.sin(t * 6 + i) * 0.12, DESK_TOP + 0.35 + t * 0.7, rd.z + (i - 1) * 0.12);
      n.material.opacity = 1 - t;
    });
    radio.scale.setScalar(playing ? 1 + Math.max(0, Math.sin(now * 0.016)) * 0.04 : 1);

    // The lamp's glow breathes, just a little.
    if (lampOn) glow.material.opacity = 0.35 + Math.sin(now * 0.002) * 0.04;

    // The teddy: a squash and a hop.
    const sq = (now - squeakAt) / 400;
    if (sq >= 0 && sq < 1) {
      const k = Math.sin(sq * Math.PI);
      bear.scale.set(1 + k * 0.12, 1 - k * 0.15, 1 + k * 0.12);
      bear.position.y = 0.58 + Math.max(0, Math.sin(sq * Math.PI * 2)) * 0.08;
    } else {
      bear.scale.setScalar(1);
      bear.position.y = 0.58;
    }

    updateCat(dt, now);
    for (let i = hearts.length - 1; i >= 0; i--) {
      const h = hearts[i];
      const t = (now - h.born) / 1400;
      h.s.visible = t >= 0;
      if (t < 0) continue;
      h.s.position.y += dt * 0.5;
      h.s.material.opacity = 1 - t;
      if (t >= 1) {
        group.remove(h.s);
        hearts.splice(i, 1);
      }
    }

    // Paper balls in flight, and misses that lie about a bit.
    for (let i = flying.length - 1; i >= 0; i--) {
      const f = flying[i];
      f.t = Math.min(1, f.t + dt / 0.7);
      f.m.position.lerpVectors(f.from, f.to, f.t);
      f.m.position.y += Math.sin(f.t * Math.PI) * (0.6 + f.from.distanceTo(f.to) * 0.15);
      f.m.rotation.x += dt * 10;
      if (f.t >= 1) {
        flying.splice(i, 1);
        landed(f);
      }
    }
    for (let i = misses.length - 1; i >= 0; i--) {
      if (now - misses[i].at > 4000) {
        group.remove(misses[i].m);
        misses.splice(i, 1);
      }
    }
  }

  function updateCat(dt: number, now: number): void {
    const r = cat.root;
    if (c.mode === "petted" || c.mode === "sit" || c.mode === "nap") {
      cat.setPose(c.mode === "nap" ? "nap" : "sit", now);
      if (c.mode === "petted") r.rotation.y += angleTo(r.rotation.y, c.heading) * Math.min(1, dt * 6);
      if (now >= c.until) c.mode = "walk";
      return;
    }
    if (c.rest > 0) {
      c.rest -= dt * 1000;
      cat.setPose("stand", now);
      if (c.rest <= 0) c.leg = (c.leg + 1 + Math.floor(Math.random() * (CAT_ROUTE.length - 1))) % CAT_ROUTE.length;
      return;
    }
    const goal = CAT_ROUTE[c.leg];
    const dx = goal.x - c.x;
    const dz = goal.z - c.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) {
      // Arrived: sometimes sit a while, sometimes nap, else just look about.
      const roll = Math.random();
      if (roll < 0.25) {
        c.mode = "sit";
        c.until = now + 5000 + Math.random() * 6000;
      } else if (roll < 0.35) {
        c.mode = "nap";
        c.until = now + 12_000 + Math.random() * 12_000;
      }
      c.rest = 1500 + Math.random() * 2500;
      return;
    }
    const step = Math.min(d, 0.55 * dt);
    c.x += (dx / d) * step;
    c.z += (dz / d) * step;
    r.position.set(c.x, 0, c.z);
    r.rotation.y += angleTo(r.rotation.y, Math.atan2(dx, dz)) * Math.min(1, dt * 5);
    cat.setPose("walk", now);
  }

  return props;
}

/** The shortest turn from one heading to another. */
function angleTo(from: number, to: number): number {
  return ((((to - from + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
}

/** A ceiling fan on a rod down from the ceiling; its blades spin. */
function fan(x: number, z: number): { group: THREE.Group; blades: THREE.Group } {
  const group = new THREE.Group();
  const hangAt = 4.4;
  group.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, WALL_HEIGHT - hangAt, 6), toon(INK), x, (WALL_HEIGHT + hangAt) / 2, z, false));
  const blades = model("ceilingFan", { height: 0.5, x, y: hangAt - 0.5, z });
  group.add(blades);
  return { group, blades };
}

/** A few rows of colored book spines for the lobby bookcase. */
function books(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  const colors = ["#ef476f", "#ffd166", "#06d6a0", "#118ab2", "#8338ec", "#f4a261"];
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const y of [0.42, 0.88, 1.33]) {
    let at = z - 0.32;
    while (at < z + 0.28) {
      const w = 0.04 + rnd() * 0.04;
      const h = 0.22 + rnd() * 0.1;
      if (rnd() > 0.12) g.add(mesh(box(0.22, h, w), toon(colors[Math.floor(rnd() * colors.length)]), x + 0.02, y + h / 2, at + w / 2, false));
      at += w + 0.005;
    }
  }
  return g;
}

let glowTex: THREE.CanvasTexture | null = null;
function glowTexture(): THREE.CanvasTexture {
  if (glowTex) return glowTex;
  const cv = document.createElement("canvas");
  cv.width = cv.height = 64;
  const g = cv.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.4, "rgba(255,255,255,.35)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(cv);
  return glowTex;
}

/** A sitting teddy bear, facing +z. */
function teddy(): THREE.Group {
  const g = new THREE.Group();
  const fur = toon("#b07a4f");
  const pale = toon("#e9c9a0");
  const body = mesh(new THREE.SphereGeometry(0.12, 12, 10), fur, 0, 0.12, 0);
  body.scale.set(1, 1.1, 0.9);
  g.add(body);
  g.add(mesh(new THREE.SphereGeometry(0.075, 10, 8), pale, 0, 0.11, 0.07, false));
  g.add(mesh(new THREE.SphereGeometry(0.1, 12, 10), fur, 0, 0.3, 0.01));
  g.add(mesh(new THREE.SphereGeometry(0.045, 8, 6), pale, 0, 0.28, 0.09, false));
  g.add(mesh(new THREE.SphereGeometry(0.016, 6, 4), toon(INK), 0, 0.295, 0.13, false));
  for (const s of [-1, 1]) {
    g.add(mesh(new THREE.SphereGeometry(0.038, 8, 6), fur, s * 0.075, 0.39, -0.005, false));
    g.add(mesh(new THREE.SphereGeometry(0.013, 6, 4), toon(INK), s * 0.04, 0.33, 0.085, false));
    const arm = mesh(new THREE.CapsuleGeometry(0.035, 0.08, 4, 8), fur, s * 0.12, 0.16, 0.03, false);
    arm.rotation.z = s * 0.6;
    g.add(arm);
    const leg = mesh(new THREE.CapsuleGeometry(0.042, 0.07, 4, 8), fur, s * 0.07, 0.04, 0.1, false);
    leg.rotation.x = Math.PI / 2;
    g.add(leg);
    g.add(mesh(new THREE.CircleGeometry(0.03, 10), pale, s * 0.07, 0.04, 0.166, false));
  }
  return g;
}

/** Pixel: a little ginger toon cat that walks, sits and naps. */
function buildCat(): { root: THREE.Group; setPose(p: "walk" | "stand" | "sit" | "nap", now: number): void } {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const fur = toon("#f4a261");
  const cream = toon("#fff1dc");
  const torso = mesh(new THREE.SphereGeometry(0.13, 12, 10), fur, 0, 0.2, 0);
  torso.scale.set(0.85, 0.8, 1.5);
  body.add(torso);
  const belly = mesh(new THREE.SphereGeometry(0.1, 10, 8), cream, 0, 0.17, 0.06, false);
  belly.scale.set(0.8, 0.7, 1.3);
  body.add(belly);
  const head = new THREE.Group();
  head.position.set(0, 0.32, 0.2);
  head.add(mesh(new THREE.SphereGeometry(0.1, 12, 10), fur, 0, 0, 0));
  head.add(mesh(new THREE.SphereGeometry(0.05, 8, 6), cream, 0, -0.03, 0.07, false));
  for (const s of [-1, 1]) {
    const ear = mesh(new THREE.ConeGeometry(0.04, 0.08, 4), fur, s * 0.055, 0.09, -0.01, false);
    ear.rotation.z = -s * 0.25;
    head.add(ear);
    head.add(mesh(new THREE.SphereGeometry(0.014, 6, 4), toon(INK), s * 0.04, 0.02, 0.088, false));
  }
  head.add(mesh(new THREE.SphereGeometry(0.012, 6, 4), toon("#ff8fab"), 0, -0.01, 0.105, false));
  body.add(head);
  const legs: THREE.Mesh[] = [];
  for (const [lx, lz] of [
    [-0.06, 0.12],
    [0.06, 0.12],
    [-0.06, -0.12],
    [0.06, -0.12],
  ]) {
    const leg = mesh(new THREE.CylinderGeometry(0.025, 0.022, 0.14, 6), fur, lx, 0.07, lz, false);
    legs.push(leg);
    body.add(leg);
  }
  const tail = new THREE.Group();
  tail.position.set(0, 0.24, -0.18);
  const t1 = mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.22, 6), fur, 0, 0.1, -0.03, false);
  t1.rotation.x = -0.35;
  tail.add(t1);
  body.add(tail);

  return {
    root,
    setPose(p, now) {
      const walk = p === "walk";
      legs.forEach((l, i) => {
        l.visible = p !== "nap";
        // Diagonal pairs swing together.
        l.rotation.x = walk ? Math.sin(now * 0.014 + (i === 0 || i === 3 ? 0 : Math.PI)) * 0.5 : 0;
      });
      tail.rotation.z = Math.sin(now * (p === "nap" ? 0.001 : 0.004)) * 0.5;
      if (p === "sit") {
        body.rotation.x = -0.45;
        body.position.set(0, 0.04, -0.05);
        head.rotation.x = 0.4;
      } else if (p === "nap") {
        body.rotation.x = 0;
        body.position.set(0, -0.09, 0);
        head.rotation.x = 0.5;
        torso.scale.y = 0.8 + Math.sin(now * 0.002) * 0.04;
      } else {
        body.rotation.x = 0;
        body.position.set(0, walk ? Math.abs(Math.sin(now * 0.014)) * 0.012 : 0, 0);
        head.rotation.x = 0;
        torso.scale.y = 0.8;
      }
    },
  };
}
