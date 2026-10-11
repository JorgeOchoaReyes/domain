import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { drawnBy, isMergedPart, mergeStatic, pinsOf } from "../src/client/scene/mergeStatic.ts";

const wood = new THREE.MeshBasicMaterial({ color: "#c98b5a" });
const metal = new THREE.MeshBasicMaterial({ color: "#9aa3b2" });

/** A room with a table (a top and four legs) and a lamp, at an offset. */
function room() {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  root.position.set(10, 0, 5);
  scene.add(root);
  const table = new THREE.Group();
  table.position.set(1, 0, 1);
  table.rotation.y = 0.4;
  root.add(table);
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 0.8), wood);
  top.position.y = 0.75;
  table.add(top);
  const legs = [-1, 1].flatMap((sx) =>
    [-1, 1].map((sz) => {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.7, 0.06), metal);
      leg.position.set(sx * 0.7, 0.35, sz * 0.3);
      table.add(leg);
      return leg;
    }),
  );
  const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.05, 0.3), wood);
  shelf.position.set(0.5, 1.2, 0.2);
  root.add(shelf);
  return { scene, root, table, top, legs, shelf };
}

const merged = (root: THREE.Object3D) => root.children.filter((c) => c.name === "merged") as THREE.Mesh[];

test("meshes sharing a material are drawn as one, where they were", () => {
  const r = room();
  r.scene.updateMatrixWorld(true);
  const before = new THREE.Box3().setFromObject(r.root);
  mergeStatic([r.root]);
  const pieces = merged(r.root);
  // The wood (top + shelf) and the metal (four legs): two pieces instead of six meshes.
  assert.equal(pieces.length, 2);
  assert.deepEqual(pieces.map((p) => p.userData.parts).sort(), [2, 4]);
  for (const m of [r.top, ...r.legs, r.shelf]) {
    assert.equal(m.visible, false, "the original reports itself hidden");
    assert.ok(isMergedPart(m));
    assert.ok(pieces.includes(drawnBy(m) as THREE.Mesh));
  }
  // The originals stay put (for raycasts, measuring); the merged pieces cover the same space.
  assert.equal(r.top.parent, r.table);
  const after = new THREE.Box3();
  for (const p of pieces) after.expandByObject(p);
  assert.ok(after.min.distanceTo(before.min) < 1e-6 && after.max.distanceTo(before.max) < 1e-6);
});

test("moving a part, or what it hangs from, takes its piece apart", () => {
  const r = room();
  mergeStatic([r.root]);
  r.legs[0].position.y += 0.1;
  r.scene.updateMatrixWorld();
  assert.equal(isMergedPart(r.legs[0]), false);
  assert.equal(r.legs[0].visible, true);
  assert.equal(r.legs[1].visible, true, "its whole piece draws itself again");
  assert.equal(isMergedPart(r.top), true, "other pieces stay merged");

  const s = room();
  mergeStatic([s.root]);
  s.table.rotation.y += 0.5;
  s.scene.updateMatrixWorld();
  assert.equal(isMergedPart(s.top), false);
  assert.equal(isMergedPart(s.legs[0]), false);
  assert.equal(isMergedPart(s.shelf), false, "the shelf shared the top's piece");
});

test("hiding, swapping the material of, or removing a part takes its piece apart", () => {
  const a = room();
  mergeStatic([a.root]);
  a.shelf.visible = false;
  assert.equal(isMergedPart(a.top), false);
  assert.equal(a.shelf.visible, false);
  assert.equal(a.top.visible, true);

  const b = room();
  mergeStatic([b.root]);
  const red = new THREE.MeshBasicMaterial({ color: "red" });
  b.legs[2].material = red;
  assert.equal(b.legs[2].material, red);
  assert.equal(isMergedPart(b.legs[0]), false);

  const c = room();
  mergeStatic([c.root]);
  c.table.visible = false;
  assert.equal(isMergedPart(c.legs[0]), false, "hiding the table hides its legs again");
  assert.equal(c.table.visible, false);

  const d = room();
  mergeStatic([d.root]);
  d.shelf.removeFromParent();
  assert.equal(isMergedPart(d.top), false);
});

test("pinned and dynamic things are left alone; a hidden root is still merged", () => {
  const r = room();
  r.table.userData.dynamic = true;
  mergeStatic([r.root]);
  assert.equal(isMergedPart(r.top), false);
  assert.equal(r.top.visible, true);

  const s = room();
  s.root.visible = false;
  mergeStatic([s.root], new Set([s.shelf]));
  assert.equal(isMergedPart(s.legs[0]), true);
  assert.equal(isMergedPart(s.shelf), false);
});

test("a mirrored part keeps its faces pointing out", () => {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  scene.add(root);
  for (const sx of [1, -1]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), wood);
    m.position.x = 1.2 + sx * 0.6;
    m.scale.x = sx;
    root.add(m);
  }
  mergeStatic([root]);
  const [piece] = merged(root);
  const g = piece.geometry;
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const ix = g.index!;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < ix.count; i += 3) {
    a.fromBufferAttribute(pos, ix.getX(i));
    b.fromBufferAttribute(pos, ix.getX(i + 1));
    c.fromBufferAttribute(pos, ix.getX(i + 2));
    const face = new THREE.Triangle(a, b, c).getNormal(new THREE.Vector3());
    n.fromBufferAttribute(nor, ix.getX(i));
    assert.ok(face.dot(n) > 0.99, `triangle ${i / 3} faces the way its normal does`);
  }
});

test("pinsOf: what a builder hands back is pinned, its groups and roots aren't", () => {
  const root = new THREE.Group();
  const desk = new THREE.Group();
  const anchor = new THREE.Object3D();
  const face = new THREE.Mesh();
  const gong = new THREE.Object3D();
  const built = { group: root, desks: new Map([["d1", { group: desk, laptopAnchor: anchor }]]), board: { faces: [face] }, gong, colliders: [{ minX: 0 }] };
  const pins = pinsOf([built], [root]);
  assert.deepEqual([...pins].sort((x, y) => x.id - y.id), [anchor, face, gong].sort((x, y) => x.id - y.id));
});
