import * as THREE from "three";
import type { World } from "./world.js";

/**
 * Local player controller: WASD movement relative to the camera, plus an
 * orbit camera you steer by dragging. It mutates the world's player group and
 * camera each frame. It owns no state the server needs beyond the transform,
 * which main.ts reads to send presence updates.
 */
export class Player {
  private keys = new Set<string>();
  private yaw = Math.PI; // camera orbit angle around the player
  private pitch = 0.5; // 0 = level, up to ~1.3 looking down
  private distance = 9;

  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  /** When false, movement keys are ignored (e.g. a menu is open). */
  enabled = true;

  private tmp = new THREE.Vector3();

  constructor(
    private world: World,
    private dom: HTMLElement,
  ) {
    this.bind();
    this.updateCamera();
  }

  private bind(): void {
    window.addEventListener("keydown", (e) => {
      if (isEditable(e.target)) return;
      this.keys.add(e.key.toLowerCase());
    });
    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.key.toLowerCase());
    });
    // Dropping key state on blur avoids "stuck" movement after tab switches.
    window.addEventListener("blur", () => this.keys.clear());

    this.dom.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement)?.closest(".interactive")) return;
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.dom.setPointerCapture(e.pointerId);
    });
    this.dom.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.yaw -= dx * 0.005;
      this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.005, 0.12, 1.3);
    });
    const endDrag = (e: PointerEvent) => {
      this.dragging = false;
      try {
        this.dom.releasePointerCapture(e.pointerId);
      } catch {
        /* capture may already be gone */
      }
    };
    this.dom.addEventListener("pointerup", endDrag);
    this.dom.addEventListener("pointercancel", endDrag);
    this.dom.addEventListener(
      "wheel",
      (e) => {
        this.distance = THREE.MathUtils.clamp(this.distance + Math.sign(e.deltaY) * 0.8, 4, 18);
      },
      { passive: true },
    );
  }

  /** Advance one frame. dt is in seconds. Returns true if the transform moved. */
  update(dt: number): boolean {
    const group = this.world.player;
    let moved = false;

    if (this.enabled) {
      const f = (this.has("w") || this.has("arrowup") ? 1 : 0) - (this.has("s") || this.has("arrowdown") ? 1 : 0);
      const r = (this.has("d") || this.has("arrowright") ? 1 : 0) - (this.has("a") || this.has("arrowleft") ? 1 : 0);

      if (f !== 0 || r !== 0) {
        const fwd = new THREE.Vector2(-Math.sin(this.yaw), -Math.cos(this.yaw));
        const right = new THREE.Vector2(Math.cos(this.yaw), -Math.sin(this.yaw));
        const move = new THREE.Vector2(fwd.x * f + right.x * r, fwd.y * f + right.y * r);
        if (move.lengthSq() > 0) {
          move.normalize();
          const speed = 5.5;
          const nx = group.position.x + move.x * speed * dt;
          const nz = group.position.z + move.y * speed * dt;
          const [cx, cz] = this.world.resolveCollision(nx, nz);
          if (cx !== group.position.x || cz !== group.position.z) moved = true;
          group.position.x = cx;
          group.position.z = cz;
          // Face the direction of travel.
          group.rotation.y = Math.atan2(-move.x, -move.y);
        }
      }
    }

    this.updateCamera();
    return moved;
  }

  private updateCamera(): void {
    const p = this.world.player.position;
    const cp = Math.cos(this.pitch);
    this.world.camera.position.set(
      p.x + Math.sin(this.yaw) * this.distance * cp,
      p.y + 1.2 + Math.sin(this.pitch) * this.distance,
      p.z + Math.cos(this.yaw) * this.distance * cp,
    );
    this.tmp.set(p.x, p.y + 1.3, p.z);
    this.world.camera.lookAt(this.tmp);
  }

  get facing(): number {
    return this.world.player.rotation.y;
  }

  get position(): THREE.Vector3 {
    return this.world.player.position;
  }

  private has(key: string): boolean {
    return this.keys.has(key);
  }
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable === true;
}
