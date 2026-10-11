import * as THREE from "three";
import { CAMPFIRE, FLOOR, FOUNTAIN, PLAZA, POND, TV } from "../../shared/layout.js";
import { angleTo, dist, model, store, type PropEvent, type PropSpot, type Props } from "./props.js";
import { INK, mesh, textSprite, toon } from "./toon.js";

/**
 * The second batch of props, from Kenney's Mini Arcade, Food, Nature and
 * Furniture kits (CC0 — see docs/ASSETS.md), plus a dog made here. They go
 * where the office felt empty:
 *
 * - the open office: a vending machine (E: a snack, a little speed boost)
 *   and speakers either side of the TV;
 * - the game room: an air-hockey table (E: a quick match) and a pinball
 *   machine (E: a ball, a score, your best);
 * - the stand-up room: donuts on one standing table (E: grab one, a speed
 *   boost — they're restocked later), coffee on the other, two plants;
 * - the grounds: Biscuit the dog on the lawn east of the plaza (E: play
 *   fetch), bushes, flowers round the fountain, pines by the pitch, logs
 *   by the campfire and rocks round the pond;
 * - floor 2: a rug under the coffee table, an armchair, plants, lamps and
 *   a speaker by the piano.
 *
 * They hook into the props: office ones in its group (shown when you're in
 * the building), the grounds' and floor 2's in groups of their own that the
 * world shows when you can see those.
 */

export interface Extras {
  /** Out on the grounds: shown with the grounds. */
  grounds: THREE.Group;
  /** On floor 2: shown when you're up there. */
  upstairs: THREE.Group;
}

/** Where things are, and where you stand to use them. */
export const EXTRAS = {
  vending: { x: FLOOR.maxX - 0.75, z: -8.6, spot: { x: FLOOR.maxX - 2.0, z: -8.6 } },
  hockey: { x: 14.6, z: 19.7, spot: { x: 13.2, z: 19.7 } },
  pinball: { x: 9.6, z: 17.45, spot: { x: 9.6, z: 18.75 } },
  donuts: { x: -8, z: 19.8, spot: { x: -7.0, z: 19.8 } },
  coffee: { x: -1, z: 19.8 },
} as const;

/** Biscuit's rounds on the lawn east of the plaza (clear of the trees and picnic tables). */
const DOG_ROUTE = [
  { x: 17, z: 35 },
  { x: 19.2, z: 39 },
  { x: 17.2, z: 43 },
  { x: 19.5, z: 47.5 },
  { x: 16.6, z: 45.2 },
  { x: 17.6, z: 38.2 },
] as const;
/** The lawn the ball may land on. */
const LAWN = { minX: 15.5, maxX: 20.5, minZ: 33.5, maxZ: 48.5 } as const;

const SNACKS = ["🍫 A chocolate bar", "🥨 Pretzels", "🍪 Cookies", "🥜 Trail mix", "🍬 Gummy bears", "🧃 A juice box"];
const TABLE_TOP = 1.105;
/** The air-hockey table's playing surface (measured: the model is 0.95 m tall over its center bar). */
const HOCKEY_TOP = 0.49;

export function addExtras(props: Props): Extras {
  const office = props.group;
  const grounds = new THREE.Group();
  const upstairs = new THREE.Group();
  const add = (o: THREE.Object3D) => office.add(o);
  const solid = (x: number, z: number, hw: number, hd: number) => props.colliders.push({ minX: x - hw, maxX: x + hw, minZ: z - hd, maxZ: z + hd });
  const emit = (e: PropEvent) => props.onEvent?.(e);

  // --- the open office: a vending machine, and speakers either side of the TV -------------------
  const vd = EXTRAS.vending;
  // 1.8 m tall makes it 1.2 m wide and 1.13 m deep: its back against the east wall.
  add(model("arcade/vending-machine", { height: 1.8, x: vd.x, z: vd.z, rotY: -Math.PI / 2 }));
  solid(vd.x, vd.z, 0.6, 0.62);
  let snacks = store.get("snacks", 0);
  let vendBusy = 0;
  const candyMat = toon("#ef476f");
  const candy = mesh(new THREE.BoxGeometry(0.06, 0.05, 0.22), candyMat, vd.x - 0.62, 1.2, vd.z, false);
  candy.visible = false;
  add(candy);
  for (const z of [TV.z - TV.width / 2 - 0.6, TV.z + TV.width / 2 + 0.6]) {
    add(model("speaker", { height: 1.15, x: FLOOR.maxX - 0.35, z, rotY: -Math.PI / 2 }));
    solid(FLOOR.maxX - 0.35, z, 0.2, 0.2);
  }

  // --- the game room: air hockey and pinball ------------------------------------------------
  const hk = EXTRAS.hockey;
  add(model("arcade/air-hockey", { height: 0.95, x: hk.x, z: hk.z }));
  solid(hk.x, hk.z, 0.95, 0.67);
  const puck = mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.035, 16), toon("#ef476f"), hk.x, HOCKEY_TOP, hk.z, false);
  puck.visible = false;
  add(puck);
  let match: { until: number; you: number; them: number; v: THREE.Vector2 } | null = null;
  let wins = store.get("hockey", 0);

  const pb = EXTRAS.pinball;
  add(model("arcade/pinball", { height: 1.35, x: pb.x, z: pb.z }));
  solid(pb.x, pb.z, 0.46, 0.68);
  const flash = new THREE.PointLight("#ff4fd8", 0, 2.2);
  flash.position.set(pb.x, 1.4, pb.z + 0.2);
  add(flash);
  let pinball: { until: number; score: number } | null = null;

  // --- the stand-up room: donuts and coffee on the standing tables, plants in the corners --------------
  const dn = EXTRAS.donuts;
  const donuts: THREE.Group[] = [];
  for (const [dx, dz] of [
    [-0.13, -0.1],
    [0.12, -0.12],
    [0, 0.13],
  ]) {
    const d = model("food/donut-sprinkles", { height: 0.08, x: dn.x + dx, y: TABLE_TOP, z: dn.z + dz, rotY: dx * 9 });
    donuts.push(d);
    add(d);
  }
  let eaten = 0;
  let restockAt = 0;
  for (const [dx, dz] of [
    [-0.12, 0.05],
    [0.14, -0.08],
  ])
    add(model("food/cup-coffee", { height: 0.13, x: EXTRAS.coffee.x + dx, y: TABLE_TOP, z: EXTRAS.coffee.z + dz, rotY: dz * 12 }));
  for (const x of [-8.45, -0.55]) {
    add(model("pottedPlant", { height: 1.15, x, z: 28.45 }));
    solid(x, 28.45, 0.3, 0.3);
  }

  // --- the grounds: Biscuit, and greenery ------------------------------------------------------------
  const gsolid = solid;
  const gadd = (o: THREE.Object3D) => grounds.add(o);
  const dog = buildDog();
  dog.root.userData.dynamic = true;
  gadd(dog.root);
  const g = { x: DOG_ROUTE[0].x, z: DOG_ROUTE[0].z, leg: 1, rest: 1500, mode: "walk" as "walk" | "sit" | "fetch" | "return" | "wag", until: 0 };
  dog.root.position.set(g.x, 0, g.z);
  let fetches = store.get("fetches", 0);
  const ballMat = toon("#c7f464");
  const ball = mesh(new THREE.SphereGeometry(0.07, 12, 10), ballMat, 0, 0.07, 0);
  ball.visible = false;
  gadd(ball);
  let throwFrom: { x: number; z: number } | null = null;
  let flight: { from: THREE.Vector3; to: THREE.Vector3; t: number } | null = null;
  // Bushes at the plaza's corners, outside its paving.
  for (const [x, z] of [
    [PLAZA.minX - 0.8, PLAZA.minZ + 1.6],
    [PLAZA.maxX + 0.8, PLAZA.minZ + 1.6],
    [PLAZA.minX - 0.8, PLAZA.maxZ - 0.8],
    [PLAZA.maxX + 0.8, PLAZA.maxZ - 0.8],
    [LAWN.minX - 0.6, 33],
    [LAWN.maxX + 0.7, 41],
  ])
    gadd(model("nature/plant_bush", { height: 0.75, x, z, rotY: x + z }));
  // Flowers in a ring round the fountain's paving, leaving the paths clear.
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + 0.2;
    if (Math.abs(Math.sin(a)) < 0.35) continue; // the paths run north–south
    const r = FOUNTAIN.r + 2.25;
    gadd(model(i % 2 ? "nature/flower_redA" : "nature/flower_yellowA", { height: 0.4, x: FOUNTAIN.x + Math.sin(a) * r, z: FOUNTAIN.z + Math.cos(a) * r, rotY: a }));
  }
  // Pines along the pitch's east side.
  for (const [x, z] of [
    [-11.2, 39.5],
    [-11.4, 30.8],
  ]) {
    gadd(model("nature/tree_pineRoundA", { height: 4.6, x, z, rotY: x }));
    gsolid(x, z, 0.35, 0.35);
  }
  // Logs stacked by the campfire, rocks round the pond.
  gadd(model("nature/log_stack", { height: 0.7, x: CAMPFIRE.x - CAMPFIRE.logR - 1.5, z: CAMPFIRE.z - 1.6, rotY: 0.4 }));
  gsolid(CAMPFIRE.x - CAMPFIRE.logR - 1.5, CAMPFIRE.z - 1.6, 0.45, 0.6);
  for (const [a, s] of [
    [2.3, 0.55],
    [2.9, 0.4],
    [4.4, 0.5],
    [5.6, 0.35],
  ])
    gadd(model("nature/rock_smallA", { height: s, x: POND.x + Math.cos(a) * (POND.rx + 0.7), z: POND.z + Math.sin(a) * (POND.rz + 0.7), rotY: a * 3 }));

  // --- floor 2: a rug, an armchair, plants, lamps, a speaker ---------------------------------------
  const uadd = (o: THREE.Object3D) => upstairs.add(o);
  uadd(model("rugRound", { height: 0.02, width: 3.4, x: 80, y: 0.006, z: 6.2 }));
  uadd(model("loungeDesignChair", { height: 0.85, x: 82.7, z: 5.6, rotY: -Math.PI / 2 }));
  solid(82.7, 5.6, 0.4, 0.45);
  for (const [x, z] of [
    [63.0, 13.0],
    [85.3, 13.0],
    [97.3, -13.2],
  ]) {
    uadd(model("pottedPlant", { height: 1.2, x, z }));
    solid(x, z, 0.3, 0.3);
  }
  for (const z of [-5.2, 5.2]) {
    uadd(model("lampSquareFloor", { height: 1.7, x: 64.6, z }));
    solid(64.6, z, 0.15, 0.15);
  }
  uadd(model("speaker", { height: 1.1, x: 78.3, z: 13.3, rotY: Math.PI }));
  solid(78.3, 13.3, 0.2, 0.2);

  // --- using them ----------------------------------------------------------------------------------
  const nearBefore = props.near;
  const useBefore = props.use;
  const updateBefore = props.update;

  function near(x: number, z: number): PropSpot | null {
    const own = nearHere(x, z);
    const theirs = nearBefore(x, z);
    if (!own) return theirs;
    if (!theirs) return own.s;
    // The props had their own nearest; the closer one wins (the props' first on a tie).
    const t = theirs.key;
    return own.d < dist(x, z, t) - 0.4 ? own.s : theirs;
  }

  function nearHere(x: number, z: number): { d: number; s: PropSpot } | null {
    const spots: { d: number; s: () => PropSpot }[] = [];
    const at = (p: { x: number; z: number }, r: number, s: () => PropSpot) => {
      const d = dist(x, z, p);
      if (d < r) spots.push({ d, s });
    };
    at(vd.spot, 1.2, () => ({
      id: "vending",
      title: "🍫 Vending machine",
      hint: `Grab a snack · a little speed boost${snacks ? ` · ${snacks} so far` : ""}`,
      key: { x: vd.x - 0.5, y: 2.35, z: vd.z },
    }));
    at(hk.spot, 1.1, () => ({
      id: "hockey",
      title: "🏒 Air hockey",
      hint: match ? "Match on…" : `Play a quick match${wins ? ` · ${wins} won` : ""}`,
      key: { x: hk.x, y: 1.6, z: hk.z },
    }));
    at(pb.spot, 1.1, () => ({
      id: "pinball",
      title: "🎰 Pinball",
      hint: pinball ? "Ball in play…" : `Launch a ball · best ${store.get("pinball", 0).toLocaleString()}`,
      key: { x: pb.x, y: 2.0, z: pb.z },
    }));
    at(dn.spot, 1.1, () => ({
      id: "donuts",
      title: "🍩 Donuts",
      hint: eaten >= donuts.length ? "All gone — more later" : "Grab one · a little speed boost",
      key: { x: dn.x, y: 1.6, z: dn.z },
    }));
    at(g, 1.6, () => ({
      id: "dog",
      title: "🐕 Biscuit",
      hint: g.mode === "fetch" || g.mode === "return" ? "Fetching…" : `Play fetch${fetches ? ` · ${fetches} fetched` : ""}`,
      key: { x: g.x, y: 1.1, z: g.z },
    }));
    if (!spots.length) return null;
    spots.sort((a, b) => a.d - b.d);
    return { d: spots[0].d, s: spots[0].s() };
  }

  function use(x: number, z: number): boolean {
    const s = near(x, z);
    if (!s) return false;
    if (!["vending", "hockey", "pinball", "donuts", "dog"].includes(s.id)) return useBefore(x, z);
    const now = performance.now();
    if (s.id === "vending") {
      if (now < vendBusy) return true;
      vendBusy = now + 1600;
      snacks++;
      store.set("snacks", snacks);
      candyMat.color.set(["#ef476f", "#ffd166", "#06d6a0", "#118ab2", "#8338ec"][snacks % 5]);
      candy.position.set(vd.x - 0.62, 1.2, vd.z);
      candy.visible = true;
      emit({ sound: "thunk", boostMs: 30_000, toast: `${SNACKS[snacks % SNACKS.length]} — a little quicker for half a minute` });
    } else if (s.id === "hockey") {
      if (match) return true;
      match = { until: now + 4000, you: 0, them: 0, v: new THREE.Vector2(2.2, 1.4) };
      puck.position.set(hk.x, HOCKEY_TOP, hk.z);
      puck.visible = true;
      emit({ sound: "click", toast: "🏒 Face-off! First to 3…" });
    } else if (s.id === "pinball") {
      if (pinball) return true;
      pinball = { until: now + 3500, score: 0 };
      emit({ sound: "click", toast: "🎰 Ball away!" });
    } else if (s.id === "donuts") {
      if (eaten >= donuts.length) {
        emit({ toast: "🍩 All gone — someone will bring more later" });
        return true;
      }
      donuts[eaten].visible = false;
      eaten++;
      if (eaten >= donuts.length) restockAt = now + 3 * 60_000;
      emit({ sound: "xp", boostMs: 45_000, toast: "🍩 Sprinkles! A little quicker for a bit" });
    } else if (s.id === "dog") {
      if (g.mode === "fetch" || g.mode === "return") return true;
      throwBall(x, z);
    }
    return true;
  }

  function throwBall(x: number, z: number): void {
    // Out onto the lawn, away from you.
    const a = Math.atan2(g.x - x, g.z - z) + (Math.random() - 0.5) * 1.2;
    const len = 4 + Math.random() * 3;
    const tx = Math.min(LAWN.maxX, Math.max(LAWN.minX, g.x + Math.sin(a) * len));
    const tz = Math.min(LAWN.maxZ, Math.max(LAWN.minZ, g.z + Math.cos(a) * len));
    throwFrom = { x, z };
    flight = { from: new THREE.Vector3(x, 1.2, z), to: new THREE.Vector3(tx, 0.07, tz), t: 0 };
    ball.position.copy(flight.from);
    ball.visible = true;
    g.mode = "fetch";
    emit({ sound: "click", toast: "🎾 Go get it, Biscuit!" });
  }

  function update(dt: number, now: number, visible = true): void {
    updateBefore(dt, now, visible);
    // The office's: these play out even unseen, so a match or a ball always ends.
    if (match && now >= match.until) endMatch();
    if (pinball && now >= pinball.until) endPinball();
    if (restockAt && now >= restockAt) {
      restockAt = 0;
      eaten = 0;
      for (const d of donuts) d.visible = true;
    }
    if (visible) {
      if (candy.visible) {
        candy.position.y = Math.max(0.3, candy.position.y - dt * 2.4);
        if (now > vendBusy + 4000) candy.visible = false;
      }
      if (match) {
        const p = puck.position;
        p.x += match.v.x * dt;
        p.z += match.v.y * dt;
        if (Math.abs(p.x - hk.x) > 0.8) {
          match.v.x *= -1;
          p.x = hk.x + Math.sign(p.x - hk.x) * 0.8;
          match.v.multiplyScalar(1.04);
        }
        if (Math.abs(p.z - hk.z) > 0.52) {
          match.v.y *= -1;
          p.z = hk.z + Math.sign(p.z - hk.z) * 0.52;
        }
      }
      flash.intensity = pinball ? (Math.sin(now * 0.03) > 0 ? 2.5 : 0.6) : 0;
    }
    if (grounds.visible) updateDog(dt, now);
    else if (flight || g.mode === "fetch" || g.mode === "return") {
      // Out of sight: the ball's fetched all the same.
      flight = null;
      ball.visible = false;
      landedFetch();
    }
  }

  function endMatch(): void {
    if (!match) return;
    const won = Math.random() < 0.55;
    const other = Math.floor(Math.random() * 3);
    puck.visible = false;
    match = null;
    if (won) {
      wins++;
      store.set("hockey", wins);
    }
    emit({ sound: won ? "achievement" : "thunk", toast: won ? `🏒 You win 3–${other}!` : `🏒 The table's ghost wins 3–${other}. Rematch?` });
  }

  function endPinball(): void {
    if (!pinball) return;
    const score = Math.round((2_000 + Math.random() ** 2 * 98_000) / 10) * 10;
    pinball = null;
    const best = store.get("pinball", 0);
    if (score > best) store.set("pinball", score);
    emit({ sound: score > best && best ? "achievement" : "bell", toast: `🎰 ${score.toLocaleString()} points${score > best && best ? " — a new best!" : ""}` });
  }

  function landedFetch(): void {
    fetches++;
    store.set("fetches", fetches);
    g.mode = "wag";
    g.until = performance.now() + 2500;
    emit({ sound: "squeak", toast: fetches % 10 === 0 ? `🐕 Biscuit's brought it back ${fetches} times. Best. Day. Ever.` : "🐕 Biscuit brings it back, tail going like mad" });
  }

  function updateDog(dt: number, now: number): void {
    const r = dog.root;
    const moveTo = (tx: number, tz: number, speed: number): boolean => {
      const dx = tx - g.x;
      const dz = tz - g.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.08) return true;
      const step = Math.min(d, speed * dt);
      g.x += (dx / d) * step;
      g.z += (dz / d) * step;
      r.position.set(g.x, 0, g.z);
      r.rotation.y += angleTo(r.rotation.y, Math.atan2(dx, dz)) * Math.min(1, dt * 8);
      return false;
    };
    if (flight) {
      flight.t = Math.min(1, flight.t + dt / 0.9);
      ball.position.lerpVectors(flight.from, flight.to, flight.t);
      ball.position.y += Math.sin(flight.t * Math.PI) * 1.6;
      if (flight.t >= 1) flight = null;
    }
    if (g.mode === "fetch") {
      dog.setPose("run", now);
      if (!flight && moveTo(ball.position.x, ball.position.z, 3.2)) g.mode = "return";
      return;
    }
    if (g.mode === "return") {
      dog.setPose("run", now);
      ball.position.set(g.x + Math.sin(r.rotation.y) * 0.32, 0.3, g.z + Math.cos(r.rotation.y) * 0.32);
      const home = throwFrom ?? DOG_ROUTE[0];
      // Stop a step short of you.
      const d = Math.hypot(home.x - g.x, home.z - g.z);
      if (d < 1.0 || moveTo(home.x, home.z, 2.6)) {
        ball.visible = false;
        landedFetch();
      }
      return;
    }
    if (g.mode === "wag" || g.mode === "sit") {
      dog.setPose(g.mode === "wag" ? "wag" : "sit", now);
      if (now >= g.until) g.mode = "walk";
      return;
    }
    if (g.rest > 0) {
      g.rest -= dt * 1000;
      dog.setPose("stand", now);
      if (g.rest <= 0) g.leg = (g.leg + 1 + Math.floor(Math.random() * (DOG_ROUTE.length - 1))) % DOG_ROUTE.length;
      return;
    }
    const goal = DOG_ROUTE[g.leg];
    dog.setPose("walk", now);
    if (moveTo(goal.x, goal.z, 0.9)) {
      if (Math.random() < 0.3) {
        g.mode = "sit";
        g.until = now + 4000 + Math.random() * 5000;
      }
      g.rest = 1200 + Math.random() * 2000;
    }
  }

  props.near = near;
  props.use = use;
  props.update = update;
  return { grounds, upstairs };
}

/** Biscuit: a sandy toon dog with a waggy tail. */
function buildDog(): { root: THREE.Group; setPose(p: "walk" | "run" | "stand" | "sit" | "wag", now: number): void } {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const fur = toon("#d9a066");
  const dark = toon("#8c5a3c");
  const torso = mesh(new THREE.SphereGeometry(0.2, 14, 10), fur, 0, 0.36, 0);
  torso.scale.set(0.8, 0.75, 1.45);
  body.add(torso);
  const head = new THREE.Group();
  head.position.set(0, 0.55, 0.3);
  head.add(mesh(new THREE.SphereGeometry(0.14, 12, 10), fur, 0, 0, 0));
  head.add(mesh(new THREE.BoxGeometry(0.12, 0.09, 0.14), fur, 0, -0.04, 0.13));
  head.add(mesh(new THREE.SphereGeometry(0.03, 8, 6), toon(INK), 0, -0.01, 0.21, false));
  for (const s of [-1, 1]) {
    const ear = mesh(new THREE.BoxGeometry(0.05, 0.14, 0.09), dark, s * 0.12, -0.02, -0.01, false);
    ear.rotation.z = s * 0.3;
    head.add(ear);
    head.add(mesh(new THREE.SphereGeometry(0.018, 6, 4), toon(INK), s * 0.055, 0.04, 0.12, false));
  }
  const tongue = mesh(new THREE.BoxGeometry(0.04, 0.01, 0.06), toon("#ff8fab"), 0, -0.09, 0.17, false);
  head.add(tongue);
  body.add(head);
  const legs: THREE.Mesh[] = [];
  for (const [lx, lz] of [
    [-0.09, 0.17],
    [0.09, 0.17],
    [-0.09, -0.17],
    [0.09, -0.17],
  ]) {
    const leg = mesh(new THREE.CylinderGeometry(0.04, 0.035, 0.26, 6), fur, lx, 0.13, lz, false);
    legs.push(leg);
    body.add(leg);
  }
  const tail = new THREE.Group();
  tail.position.set(0, 0.44, -0.27);
  const t = mesh(new THREE.CylinderGeometry(0.022, 0.03, 0.2, 6), dark, 0, 0.08, -0.04, false);
  t.rotation.x = -0.6;
  tail.add(t);
  body.add(tail);
  // A name tag over its head, so you know who's a good dog.
  const tag = textSprite("🐕 Biscuit", { bg: "#fffaf3", size: 28 });
  tag.position.set(0, 1.0, 0);
  tag.scale.multiplyScalar(0.7);
  root.add(tag);

  return {
    root,
    setPose(p, now) {
      const moving = p === "walk" || p === "run";
      const rate = p === "run" ? 0.03 : 0.016;
      legs.forEach((l, i) => {
        l.rotation.x = moving ? Math.sin(now * rate + (i === 0 || i === 3 ? 0 : Math.PI)) * 0.6 : 0;
      });
      const wag = p === "wag" || p === "run" ? 0.03 : p === "sit" ? 0.006 : 0.012;
      tail.rotation.y = Math.sin(now * wag) * (p === "wag" ? 0.9 : 0.5);
      tongue.visible = p === "run" || p === "wag";
      if (p === "sit") {
        body.rotation.x = -0.4;
        body.position.set(0, 0.02, -0.08);
        head.rotation.x = 0.35;
      } else {
        body.rotation.x = 0;
        body.position.set(0, p === "run" ? Math.abs(Math.sin(now * 0.03)) * 0.05 : 0, 0);
        head.rotation.x = p === "wag" ? Math.sin(now * 0.02) * 0.1 : 0;
      }
    },
  };
}
