import * as THREE from "three";

/**
 * Cheaper world matrices. three.js recomputes every object's matrix every
 * frame (compose the local matrix, multiply by the parent's), moving or not —
 * and the office is thousands of objects that almost never move. This does
 * the same work only where something changed:
 *
 * - an object's local matrix is recomposed only when its position, rotation
 *   or scale changed since the last time;
 * - its world matrix is recomputed only when that happened, or its parent's
 *   world matrix changed;
 * - a hidden object's children are skipped altogether unless something above
 *   them moved — what moved inside while hidden is caught up when it shows.
 *
 * The results are exactly three's (see tests/matrices.test.ts). Installed
 * once, for every Object3D, by importing this module.
 */

type Tracked = THREE.Object3D & { __prs?: Float64Array };

function changed(o: Tracked): boolean {
  const p = o.position;
  const q = o.quaternion;
  const s = o.scale;
  let c = o.__prs;
  if (c && c[0] === p.x && c[1] === p.y && c[2] === p.z && c[3] === q.x && c[4] === q.y && c[5] === q.z && c[6] === q.w && c[7] === s.x && c[8] === s.y && c[9] === s.z) return false;
  c ??= o.__prs = new Float64Array(10);
  c[0] = p.x;
  c[1] = p.y;
  c[2] = p.z;
  c[3] = q.x;
  c[4] = q.y;
  c[5] = q.z;
  c[6] = q.w;
  c[7] = s.x;
  c[8] = s.y;
  c[9] = s.z;
  return true;
}

export function installFastMatrices(): void {
  const proto = THREE.Object3D.prototype as THREE.Object3D & { __fastMatrices?: boolean };
  if (proto.__fastMatrices) return;
  proto.__fastMatrices = true;
  proto.updateMatrixWorld = function (this: Tracked, force?: boolean): void {
    if (this.matrixAutoUpdate && changed(this)) {
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.matrixWorldNeedsUpdate = true;
    }
    if (this.matrixWorldNeedsUpdate || force) {
      if (this.matrixWorldAutoUpdate === true) {
        if (this.parent === null) this.matrixWorld.copy(this.matrix);
        else this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix);
      }
      this.matrixWorldNeedsUpdate = false;
      force = true;
    }
    // Hidden, and nothing above it moved: its children can wait until it shows.
    if (!this.visible && !force) return;
    const children = this.children;
    for (let i = 0, l = children.length; i < l; i++) children[i].updateMatrixWorld(force);
  };
}

installFastMatrices();
