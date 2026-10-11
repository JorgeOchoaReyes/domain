import * as THREE from "three";
import { POOL } from "../../shared/layout.js";
import { BALL_COLORS, POCKETS, POOL_TABLE, PoolGame } from "../../shared/pool.js";
import { dist, store, type PropSpot, type Props } from "./props.js";
import { box, INK, mesh, roundedBox, toon } from "./toon.js";
import { openPool } from "../ui/pool.js";

/**
 * The pool table in the game room. Its balls are a live PoolGame: E at the
 * table opens it in a window (you play top-down; the balls here follow), and
 * workers on a break who walk up to it take turns shooting while nobody else
 * is playing — you'll see the balls roll and drop as they do.
 *
 * It hooks into the props like the second batch does (near/use/update), so
 * the floating E, the hint and the key work without anything else knowing.
 */

export interface PoolScene {
  /** The table and all on it (the world merges its static parts: see mergeStatic). */
  group: THREE.Group;
  game: PoolGame;
  /** How many workers are standing at the table on a break (they shoot when it's theirs). */
  setPlayers(n: number): void;
}

/** The felt's height. */
const TOP = 0.8;
const FELT = "#1f7a4d";

export function addPool(props: Props): PoolScene {
  const game = new PoolGame();
  const group = new THREE.Group();
  group.position.set(POOL.x, 0, POOL.z);
  props.group.add(group);
  props.colliders.push({ minX: POOL.x - POOL.length / 2, maxX: POOL.x + POOL.length / 2, minZ: POOL.z - POOL.width / 2, maxZ: POOL.z + POOL.width / 2 });

  // --- the table ---------------------------------------------------------------------------
  const L = POOL_TABLE.length;
  const W = POOL_TABLE.width;
  const wood = toon("#6b3e26");
  group.add(mesh(roundedBox(POOL.length, 0.16, POOL.width, 0.05), wood, 0, TOP - 0.09, 0));
  group.add(mesh(box(POOL.length - 0.3, 0.42, POOL.width - 0.3), toon("#4a2a19"), 0, TOP - 0.38, 0));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) group.add(mesh(box(0.14, TOP - 0.12, 0.14), wood, sx * (POOL.length / 2 - 0.2), (TOP - 0.12) / 2, sz * (POOL.width / 2 - 0.2)));
  const felt = new THREE.Mesh(new THREE.PlaneGeometry(L, W), toon(FELT));
  felt.rotation.x = -Math.PI / 2;
  felt.position.y = TOP + 0.001;
  group.add(felt);
  // Cushions round the felt, the wooden rail outside them.
  const cushion = toon("#17603b");
  const railW = (POOL.length - L) / 2;
  for (const s of [-1, 1]) {
    group.add(mesh(box(L, 0.045, 0.04), cushion, 0, TOP + 0.02, s * (W / 2 + 0.02), false));
    group.add(mesh(box(0.04, 0.045, W), cushion, s * (L / 2 + 0.02), TOP + 0.02, 0, false));
    group.add(mesh(box(POOL.length, 0.05, railW - 0.04), wood, 0, TOP + 0.025, s * (POOL.width / 2 - (railW - 0.04) / 2), false));
    group.add(mesh(box(railW - 0.04, 0.05, POOL.width), wood, s * (POOL.length / 2 - (railW - 0.04) / 2), TOP + 0.025, 0, false));
  }
  // The pockets: black cups over the corners and the middles of the long sides.
  const pocketMat = new THREE.MeshBasicMaterial({ color: "#0b0a10" });
  for (const p of POCKETS) {
    const cup = new THREE.Mesh(new THREE.CircleGeometry(POOL_TABLE.pocketR, 20), pocketMat);
    cup.rotation.x = -Math.PI / 2;
    cup.position.set(p.x, TOP + 0.052, p.z);
    group.add(cup);
  }
  // Diamonds on the rails, and the head spot.
  const pearl = new THREE.MeshBasicMaterial({ color: "#f4f1de" });
  for (let i = 1; i < 8; i++) {
    if (i === 4) continue;
    for (const s of [-1, 1]) {
      const d = new THREE.Mesh(new THREE.CircleGeometry(0.012, 8), pearl);
      d.rotation.x = -Math.PI / 2;
      d.position.set(-L / 2 + (i * L) / 8, TOP + 0.052, s * (POOL.width / 2 - railW / 2));
      group.add(d);
    }
  }
  // A lamp over it.
  const shade = mesh(new THREE.CylinderGeometry(0.1, 0.32, 0.2, 20, 1, true), toon("#2a9d8f", { emissive: "#0b3d36" }), 0, 2.75, 0, false);
  group.add(shade);
  group.add(mesh(new THREE.CylinderGeometry(0.008, 0.008, 3.6, 6), toon(INK), 0, 4.65, 0, false));
  group.add(mesh(new THREE.SphereGeometry(0.06, 12, 8), new THREE.MeshBasicMaterial({ color: "#fff3c4" }), 0, 2.7, 0, false));
  // A rack hanging on the table's end, and a spare cue across the rail.
  const spare = mesh(new THREE.CylinderGeometry(0.008, 0.014, 1.45, 8).rotateZ(Math.PI / 2), toon("#d9a066"), 0, TOP + 0.06, POOL.width / 2 - railW / 2, false);
  group.add(spare);

  // --- the balls ---------------------------------------------------------------------------
  const R = POOL_TABLE.ballR;
  const ballGeo = new THREE.SphereGeometry(R, 14, 10);
  const balls = game.balls.map((b) => {
    const m = mesh(ballGeo, toon(BALL_COLORS[b.n] ?? "#ffffff"), 0, TOP + R, 0, false);
    m.userData.dynamic = true;
    group.add(m);
    return m;
  });
  // The cue a worker shoots with, while it lines up.
  const cue = new THREE.Group();
  const stick = mesh(new THREE.CylinderGeometry(0.007, 0.014, 1.4, 8), toon("#d9a066"), 0, 0.7, 0, false);
  cue.add(stick);
  cue.add(mesh(new THREE.CylinderGeometry(0.0075, 0.0075, 0.02, 8), toon("#5bc0eb"), 0, 0.01, 0, false));
  cue.visible = false;
  cue.userData.dynamic = true;
  group.add(cue);

  const place = () => {
    game.balls.forEach((b, i) => {
      const m = balls[i];
      m.visible = !b.potted;
      m.position.set(b.x, TOP + R, b.z);
    });
  };
  place();

  // --- playing -----------------------------------------------------------------------------
  let players = 0;
  let playing = false;
  let best = store.get("poolBest", 0);
  /** A worker lining up a shot: when it strikes, and the shot. */
  let lining: { at: number; angle: number; power: number } | null = null;
  let restAt = 0;

  const distToTable = (x: number, z: number) => Math.hypot(Math.max(0, Math.abs(x - POOL.x) - POOL.length / 2), Math.max(0, Math.abs(z - POOL.z) - POOL.width / 2));

  const nearBefore = props.near;
  const useBefore = props.use;
  const updateBefore = props.update;

  const spot = (): PropSpot => ({
    id: "pool",
    title: "🎱 Pool",
    hint: players && !game.cleared && game.shots > 0 ? "Workers are mid-game — rack up your own" : `Rack 'em up · clear the table${best ? ` · best ${best} shots` : ""}`,
    key: { x: POOL.x, y: 1.5, z: POOL.z },
  });

  props.near = (x, z) => {
    const theirs = nearBefore(x, z);
    const d = distToTable(x, z);
    if (d > 0.85) return theirs;
    if (theirs && dist(x, z, theirs.key) < d) return theirs;
    return spot();
  };

  props.use = (x, z) => {
    const s = props.near(x, z);
    if (s?.id !== "pool") return useBefore(x, z);
    playing = true;
    lining = null;
    cue.visible = false;
    game.rack();
    place();
    openPool(game, {
      best,
      onCleared: (shots) => {
        if (!best || shots < best) {
          best = shots;
          store.set("poolBest", best);
          return true;
        }
        return false;
      },
      onClose: () => {
        playing = false;
        restAt = performance.now() + 4000;
      },
    });
    return true;
  };

  props.update = (dt, now, visible = true) => {
    updateBefore(dt, now, visible);
    if (playing) {
      // The window steps the game; the table here just follows.
      if (visible) place();
      return;
    }
    if (game.moving) {
      game.step(dt);
      if (visible) place();
      return;
    }
    // Workers at the table: one lines up, then shoots; a cleared table is racked again.
    if (!players || now < restAt) return;
    if (game.cleared) {
      game.rack();
      place();
      restAt = now + 2500;
      return;
    }
    if (!lining) {
      const shot = game.pickShot(Math.random, 0.7);
      lining = { at: now + 1400, ...shot };
    }
    const c = game.cue;
    const pull = Math.max(0, Math.min(1, (lining.at - now) / 1400));
    const back = 0.04 + 0.12 * Math.sin(pull * Math.PI);
    const dx = Math.cos(lining.angle);
    const dz = Math.sin(lining.angle);
    cue.visible = visible;
    cue.position.set(c.x - dx * (R + back), TOP + R + 0.015, c.z - dz * (R + back));
    // The stick lies along the shot, its tip at the cue ball, tilted up a touch at the butt.
    cue.rotation.set(0, 0, 0);
    cue.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(-dx, 0.12, -dz).normalize());
    if (now >= lining.at) {
      game.shoot(lining.angle, lining.power);
      lining = null;
      cue.visible = false;
      restAt = now + 1200;
    }
  };

  return {
    group,
    game,
    setPlayers(n) {
      players = n;
      if (!n && lining) {
        lining = null;
        cue.visible = false;
      }
    },
  };
}
