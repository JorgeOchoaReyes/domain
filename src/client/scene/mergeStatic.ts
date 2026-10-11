import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import "./fastMatrices.js";

/**
 * Static furniture, drawn in far fewer pieces. The office is thousands of
 * little meshes (a desk is its top, four legs, a panel, a chair of eight
 * parts, a mug…), and every one costs a draw call in the scene, again in the
 * outline pass and again in the shadows — the CPU spent more time issuing
 * them than the GPU spent drawing.
 *
 * mergeStatic() bakes meshes that share a material into one mesh per
 * material, per area, per patch of floor (small things by the 2.5 m patch,
 * so hiding what's in the camera's way still hides only what's near it;
 * walls and floors by the 16 m patch, so whole wings still get culled).
 *
 * The originals stay where they were — same parents, same positions, world
 * matrices kept up to date, still there to raycast or measure — they just
 * report themselves hidden while their merged copy draws them. And if
 * anything ever changes one (moves it or what it hangs from, hides or shows
 * it, swaps its material, takes it away, hangs something on it), its merged
 * piece comes apart at once and the originals draw themselves again: an
 * animation nobody told us about still plays. Things known to move are kept
 * out to begin with (`pinned`, or `userData.dynamic`).
 */

/** Small things (the size the camera's see-through pass hides) are merged by this patch of floor… */
const SMALL = 3.6;
const CELL_SMALL = 2.5;
/** …and big ones (walls, floors, long counters) by this one. */
const CELL_LARGE = 16;

interface Chunk {
  mesh: THREE.Mesh;
  parts: { mesh: THREE.Mesh; material: THREE.Material }[];
  apart: boolean;
}

type Watched = THREE.Object3D & { __onMove?: () => void };

const chunkOf = new WeakMap<THREE.Object3D, Chunk>();
/** Chunks hanging below each in-between group (a desk, a chair) whose move or hide would take them apart. */
const below = new WeakMap<THREE.Object3D, Chunk[]>();

/** How it went: pieces merged, the meshes they draw, and how many came apart since. */
export const mergeStats = { meshes: 0, chunks: 0, apart: 0, lastApart: "", log: [] as string[] };

/** What draws this object on screen: its merged piece, or itself. */
export function drawnBy(o: THREE.Object3D): THREE.Object3D {
  const c = chunkOf.get(o);
  return c && !c.apart ? c.mesh : o;
}

/** Whether this mesh is drawn by a merged piece (and so reports itself hidden). */
export function isMergedPart(o: THREE.Object3D): boolean {
  const c = chunkOf.get(o);
  return !!c && !c.apart;
}

function mergeable(o: THREE.Object3D): o is THREE.Mesh {
  const m = o as THREE.Mesh;
  if (o.type !== "Mesh" || !m.isMesh || o.children.length || !o.visible || o.userData.dynamic) return false;
  const mat = m.material;
  if (!mat || Array.isArray(mat) || mat.transparent || mat.userData.noMerge) return false;
  const g = m.geometry;
  if (!g?.attributes.position || Object.keys(g.morphAttributes).length || g.drawRange.start !== 0 || g.drawRange.count !== Infinity) return false;
  return o.layers.mask === 1 && o.onBeforeRender === THREE.Object3D.prototype.onBeforeRender && o.onAfterRender === THREE.Object3D.prototype.onAfterRender;
}

function signature(g: THREE.BufferGeometry): string {
  const attrs = Object.keys(g.attributes)
    .sort()
    .map((k) => {
      const a = g.attributes[k] as THREE.BufferAttribute;
      return `${k}:${a.itemSize}:${a.normalized}:${a.array.constructor.name}`;
    });
  return `${g.index ? "i" : "n"}|${attrs.join(",")}`;
}

/** Reverse each triangle (a mirrored transform turns faces inside out). */
function flipWinding(g: THREE.BufferGeometry): void {
  if (g.index) {
    const ix = g.index;
    for (let i = 0; i + 2 < ix.count; i += 3) {
      const b = ix.getX(i + 1);
      ix.setX(i + 1, ix.getX(i + 2));
      ix.setX(i + 2, b);
    }
    return;
  }
  for (const a of Object.values(g.attributes) as THREE.BufferAttribute[]) {
    const n = a.itemSize;
    const arr = a.array;
    for (let v = 0; v + 2 < a.count; v += 3) {
      for (let k = 0; k < n; k++) {
        const t = arr[(v + 1) * n + k];
        arr[(v + 1) * n + k] = arr[(v + 2) * n + k];
        arr[(v + 2) * n + k] = t;
      }
    }
  }
}

/** Take a merged piece apart: its originals draw themselves again. */
function comeApart(c: Chunk, why: THREE.Object3D): void {
  if (c.apart) return;
  c.apart = true;
  // Hidden now, taken away after: this can happen mid-walk over its parent's children.
  c.mesh.visible = false;
  queueMicrotask(() => {
    c.mesh.removeFromParent();
    c.mesh.geometry.dispose();
  });
  for (const p of c.parts) {
    const m = p.mesh as THREE.Mesh & Watched;
    delete (m as { visible?: boolean }).visible;
    delete (m as { material?: THREE.Material }).material;
    m.visible = true;
    m.material = p.material;
    m.__onMove = undefined;
  }
  mergeStats.apart++;
  const path: string[] = [];
  for (let o: THREE.Object3D | null = why; o && path.length < 5; o = o.parent) path.push(o.name || o.type);
  const at = why.getWorldPosition(new THREE.Vector3());
  mergeStats.lastApart = `${path.join(" < ")} at ${at.x.toFixed(1)},${at.y.toFixed(1)},${at.z.toFixed(1)} (${c.parts.length} parts)`;
  if (mergeStats.log.length < 40) mergeStats.log.push(mergeStats.lastApart);
}

/** Watch an in-between group (a desk, a chair) for changes that the merged pieces below it can't follow. */
function watchBetween(o: THREE.Object3D, c: Chunk): void {
  let list = below.get(o);
  if (!list) {
    list = [];
    below.set(o, list);
    const all = list;
    const apart = () => {
      for (const x of all) comeApart(x, o);
    };
    let visible = o.visible;
    Object.defineProperty(o, "visible", {
      configurable: true,
      enumerable: true,
      get: () => visible,
      set: (v: boolean) => {
        if (v !== visible) apart();
        visible = v;
      },
    });
    (o as Watched).__onMove = apart;
    o.addEventListener("removed", apart);
  }
  if (!list.includes(c)) list.push(c);
}

/** Watch a merged original: any change and its piece comes apart. */
function watchPart(m: THREE.Mesh, c: Chunk, material: THREE.Material): void {
  chunkOf.set(m, c);
  Object.defineProperty(m, "visible", {
    configurable: true,
    enumerable: true,
    get: () => false,
    set: (v: boolean) => {
      comeApart(c, m);
      m.visible = v;
    },
  });
  Object.defineProperty(m, "material", {
    configurable: true,
    enumerable: true,
    get: () => material,
    set: (v: THREE.Material) => {
      comeApart(c, m);
      m.material = v;
    },
  });
  const apart = () => comeApart(c, m);
  (m as Watched).__onMove = apart;
  m.addEventListener("removed", apart);
  m.addEventListener("childadded", apart);
}

/**
 * Merge the static meshes under each root (an area, a floor) into one mesh
 * per material and patch of floor, added to that root. Subtrees in `pinned`
 * (and other roots inside a root) are left alone.
 */
export function mergeStatic(roots: THREE.Object3D[], pinned: Set<THREE.Object3D> = new Set()): void {
  const rootSet = new Set(roots);
  const rel = new THREE.Matrix4();
  const inv = new THREE.Matrix4();
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  const mid = new THREE.Vector3();
  for (const root of roots) {
    // Matrices up to date (and the fast matrices' change tracking primed, so only real moves count from here on).
    root.updateMatrixWorld(true);
    inv.copy(root.matrixWorld).invert();
    const groups = new Map<string, { leaf: THREE.Mesh; between: THREE.Object3D[] }[]>();
    const visit = (o: THREE.Object3D, between: THREE.Object3D[]): void => {
      if (pinned.has(o) || o.userData.dynamic || (o !== root && rootSet.has(o))) return;
      if (o !== root && mergeable(o)) {
        const g = o.geometry;
        if (!g.boundingBox) g.computeBoundingBox();
        rel.multiplyMatrices(inv, o.matrixWorld);
        box.copy(g.boundingBox!).applyMatrix4(rel);
        box.getSize(size);
        box.getCenter(mid);
        const cell = Math.max(size.x, size.z) <= SMALL ? CELL_SMALL : CELL_LARGE;
        const mat = o.material as THREE.Material;
        const key = [mat.uuid, o.castShadow, o.receiveShadow, o.renderOrder, o.frustumCulled, signature(g), cell, Math.floor(mid.x / cell), Math.floor(mid.z / cell)].join("|");
        let list = groups.get(key);
        if (!list) groups.set(key, (list = []));
        list.push({ leaf: o, between });
        return;
      }
      // Hidden things wait to be shown: leave them as they are (a root may be hidden: a floor you're not on).
      if (!o.visible && o !== root) return;
      const next = o === root ? between : [...between, o];
      for (const child of o.children) visit(child, next);
    };
    visit(root, []);

    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const geos: THREE.BufferGeometry[] = [];
      for (const { leaf } of list) {
        const g = leaf.geometry.clone();
        g.clearGroups();
        rel.multiplyMatrices(inv, leaf.matrixWorld);
        g.applyMatrix4(rel);
        if (rel.determinant() < 0) flipWinding(g);
        geos.push(g);
      }
      const merged = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();
      if (!merged) continue;
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      const first = list[0].leaf;
      const material = first.material as THREE.Material;
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = "merged";
      mesh.castShadow = first.castShadow;
      mesh.receiveShadow = first.receiveShadow;
      mesh.renderOrder = first.renderOrder;
      mesh.frustumCulled = first.frustumCulled;
      mesh.userData.parts = list.length;
      root.add(mesh);
      mesh.updateMatrixWorld(true);
      const chunk: Chunk = { mesh, parts: list.map(({ leaf }) => ({ mesh: leaf, material })), apart: false };
      for (const { leaf, between } of list) {
        watchPart(leaf, chunk, material);
        for (const b of between) watchBetween(b, chunk);
      }
      mergeStats.chunks++;
      mergeStats.meshes += list.length;
    }
  }
}

/**
 * Everything a builder handed back for the world to drive (a gong to swing,
 * a desk's anchors, a board's faces): kept out of merging. `group`s (the
 * desks themselves) and the roots are not pins.
 */
export function pinsOf(things: unknown[], roots: THREE.Object3D[] = []): Set<THREE.Object3D> {
  const pins = new Set<THREE.Object3D>();
  const seen = new Set<unknown>(roots);
  const walk = (v: unknown, depth: number): void => {
    if (!v || typeof v !== "object" || seen.has(v) || depth > 6) return;
    seen.add(v);
    if (v instanceof THREE.Object3D) {
      pins.add(v);
      return;
    }
    if (v instanceof THREE.Material || v instanceof THREE.Texture || v instanceof THREE.BufferGeometry || ArrayBuffer.isView(v)) return;
    if (typeof HTMLElement !== "undefined" && v instanceof HTMLElement) return;
    const values = v instanceof Map || v instanceof Set ? [...v.values()] : Array.isArray(v) ? v : Object.entries(v).filter(([k]) => k !== "group").map(([, x]) => x);
    for (const x of values) walk(x, depth + 1);
  };
  for (const t of things) walk(t, 0);
  return pins;
}
