import * as THREE from "three";
import { TEAM_PODS } from "../../shared/layout.js";
import type { PodSeat } from "../../shared/pods.js";
import { textPlane } from "./toon.js";

/**
 * Whose pod is whose, on the team floor: a name plate hung over each pod's
 * sign ("Ana's pod", dimmed while they're away), seen from both sides.
 */
export class PodSigns {
  readonly group = new THREE.Group();
  private plates = new Map<string, { key: string; meshes: THREE.Mesh[] }>();

  set(seats: readonly PodSeat[], me: string): void {
    for (const pod of TEAM_PODS) {
      const seat = seats.find((s) => s.pod === pod.name);
      const text = !seat ? "" : seat.person === me ? `⭐ Your pod, ${seat.person}` : `🧑 ${seat.person}'s pod${seat.here ? "" : " (away)"}`;
      const key = `${text}|${seat?.here}`;
      const old = this.plates.get(pod.name);
      if (old?.key === key) continue;
      for (const m of old?.meshes ?? []) {
        this.group.remove(m);
        m.geometry.dispose();
        const mat = m.material as THREE.MeshBasicMaterial;
        mat.map?.dispose();
        mat.dispose();
      }
      const meshes: THREE.Mesh[] = [];
      if (text) {
        const bg = seat!.person === me ? "#ffd166" : seat!.here ? "#fffaf3" : "#d9d9d9";
        for (const rot of [0, Math.PI]) {
          const plate = textPlane(text, { bg, size: 56, color: seat!.here ? undefined : "#666666" });
          plate.position.set(pod.x, 3.6, pod.z);
          plate.rotation.y = rot;
          plate.scale.setScalar(0.6);
          this.group.add(plate);
          meshes.push(plate);
        }
      }
      this.plates.set(pod.name, { key, meshes });
    }
  }
}
