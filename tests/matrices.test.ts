import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

// Three's own matrix update, kept before the fast one replaces it, to compare against.
const original = THREE.Object3D.prototype.updateMatrixWorld;
const { installFastMatrices } = await import("../src/client/scene/fastMatrices.ts");
installFastMatrices();

/** A small scene: a room with a table and a cup on it, a fan that spins, a hidden cupboard with a box in it. */
function scene() {
  const s = new THREE.Scene();
  const room = new THREE.Group();
  room.position.set(10, 0, 5);
  const table = new THREE.Object3D();
  table.position.set(1, 0.7, 2);
  table.rotation.y = 0.3;
  const cup = new THREE.Object3D();
  cup.position.set(0.2, 0.05, -0.1);
  const fan = new THREE.Object3D();
  fan.position.set(0, 3, 0);
  const cupboard = new THREE.Group();
  cupboard.position.set(-2, 0, 0);
  cupboard.visible = false;
  const box = new THREE.Object3D();
  box.position.set(0, 1, 0);
  s.add(room);
  room.add(table, fan, cupboard);
  table.add(cup);
  cupboard.add(box);
  return { s, room, table, cup, fan, cupboard, box };
}

/** The world matrix three's own update would give, computed from scratch. */
function truth(o: THREE.Object3D): THREE.Matrix4 {
  const chain: THREE.Object3D[] = [];
  for (let x: THREE.Object3D | null = o; x; x = x.parent) chain.unshift(x);
  const m = new THREE.Matrix4();
  for (const x of chain) m.multiply(new THREE.Matrix4().compose(x.position, x.quaternion, x.scale));
  return m;
}
const same = (o: THREE.Object3D, label: string) =>
  assert.ok(o.matrixWorld.equals(truth(o)) || o.matrixWorld.elements.every((v, i) => Math.abs(v - truth(o).elements[i]) < 1e-9), label);

test("world matrices come out exactly as three's own, frame after frame, as things move", () => {
  const { s, room, table, cup, fan } = scene();
  s.updateMatrixWorld();
  for (const o of [room, table, cup, fan]) same(o, "first frame");
  // A spinning fan; the table slides (the cup on it goes too); then the whole room moves.
  for (let f = 0; f < 5; f++) {
    fan.rotation.y += 0.5;
    if (f === 2) table.position.x += 1;
    if (f === 3) room.position.z -= 4;
    s.updateMatrixWorld();
    for (const o of [room, table, cup, fan]) same(o, `frame ${f}`);
  }
});

test("a hidden cupboard's contents are skipped while hidden, and caught up the moment it shows", () => {
  const { s, cupboard, box, room } = scene();
  s.updateMatrixWorld();
  same(box, "computed once at the start, hidden or not");
  // Something inside moves while it's hidden: no need to compute it yet…
  box.position.y = 2;
  s.updateMatrixWorld();
  assert.ok(!box.matrixWorld.equals(truth(box)), "skipped while hidden");
  // …but if the room itself moves, everything in it follows, hidden or not.
  room.position.x += 1;
  s.updateMatrixWorld();
  same(box, "follows its parent even while hidden");
  box.position.y = 3;
  cupboard.visible = true;
  s.updateMatrixWorld();
  same(box, "caught up when shown");
});

test("the same as three's own update, on a big random scene", () => {
  const build = () => {
    const s = new THREE.Scene();
    let rnd = 1;
    const r = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647) * 4 - 2;
    const all: THREE.Object3D[] = [s];
    for (let i = 0; i < 300; i++) {
      const o = new THREE.Object3D();
      o.position.set(r(), r(), r());
      o.rotation.set(r(), r(), r());
      o.scale.setScalar(1 + r() * 0.2);
      all[Math.floor(Math.abs(r()) * 0.5 * all.length) % all.length].add(o);
      all.push(o);
    }
    return all;
  };
  const fast = build();
  const slow = build();
  for (let f = 0; f < 4; f++) {
    for (const all of [fast, slow]) for (let i = 1; i < all.length; i += 7) all[i].rotation.y += 0.1 * (f + 1);
    fast[0].updateMatrixWorld();
    original.call(slow[0]);
    // three's original, applied over the whole tree.
    slow[0].traverse((o) => o !== slow[0] && original.call(o, true));
    for (let i = 0; i < fast.length; i++) assert.ok(fast[i].matrixWorld.elements.every((v, k) => Math.abs(v - slow[i].matrixWorld.elements[k]) < 1e-9), `object ${i}, frame ${f}`);
  }
});
