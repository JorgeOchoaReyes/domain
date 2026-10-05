import * as THREE from "three";
import type { Look } from "../../shared/protocol.js";
import { SHIRT_COLORS, SKIN_TONES } from "../../shared/protocol.js";
import { toon, toonUnique } from "./toon.js";

/**
 * Your arm in first person, Minecraft style: a blocky sleeve and hand in the
 * lower right of the view, in your shirt and skin colors. It sways as you
 * walk, swings when you use something, and holds a coffee while the boost
 * lasts. It hangs off the camera and draws over the world, so it never
 * clips into a wall you're standing against.
 */
export class Hand {
  readonly group = new THREE.Group();
  private arm = new THREE.Group();
  private sleeve: THREE.MeshToonMaterial;
  private skin: THREE.MeshToonMaterial;
  private cup: THREE.Group;
  private swingT = 1;
  private walkT = 0;
  private sway = 0;
  private lastYaw = 0;
  private turn = 0;

  constructor(look: Look) {
    this.sleeve = toonUnique(SHIRT_COLORS[look.shirt]);
    this.skin = toonUnique(SKIN_TONES[look.skin]);
    // The arm points forward and up into the view from the bottom-right corner.
    const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.085, 0.3), this.sleeve);
    sleeve.position.z = 0.1;
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.1), this.skin);
    hand.position.z = -0.1;
    this.arm.add(sleeve, hand);

    // A coffee cup, held while the coffee boost lasts.
    this.cup = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.055, 0.15, 14), toon("#fffaf3"));
    const sleeveBand = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.064, 0.06, 14), toon("#c98b5a"));
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.074, 0.074, 0.025, 14), toon("#3d405b"));
    lid.position.y = 0.085;
    this.cup.add(body, sleeveBand, lid);
    this.cup.position.set(-0.02, 0.075, -0.13);
    this.cup.scale.setScalar(0.6);
    this.cup.visible = false;
    this.arm.add(this.cup);

    this.arm.rotation.set(0.35, 0.28, 0.05);
    this.group.add(this.arm);
    this.group.position.set(0.26, -0.24, -0.46);
    // Draw last and over everything so it never sinks into walls. The toon
    // outline pass would paint over a mesh that writes no depth, so instead
    // each block gets its own ink shell: its back faces, a touch bigger,
    // drawn just before it.
    const ink = new THREE.MeshBasicMaterial({ color: "#2b2d42", side: THREE.BackSide, depthTest: false, depthWrite: false });
    ink.userData.outlineParameters = { visible: false };
    const meshes: THREE.Mesh[] = [];
    this.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    for (const m of meshes) {
      const mat = m.material as THREE.Material;
      const own = mat === this.sleeve || mat === this.skin ? mat : mat.clone();
      own.depthTest = false;
      own.depthWrite = false;
      own.userData.outlineParameters = { visible: false };
      m.material = own;
      m.renderOrder = 1000;
      m.frustumCulled = false;
      const shell = new THREE.Mesh(m.geometry, ink);
      shell.scale.setScalar(1.09);
      shell.renderOrder = 999;
      shell.frustumCulled = false;
      m.add(shell);
    }
  }

  setLook(look: Look): void {
    this.sleeve.color.set(SHIRT_COLORS[look.shirt]);
    this.skin.color.set(SKIN_TONES[look.skin]);
  }

  /** Use something: a quick punch-forward swing. */
  swing(): void {
    this.swingT = 0;
  }

  update(dt: number, speed: number, yaw: number, holding: boolean, bob: boolean): void {
    this.cup.visible = holding;
    // Walking sways the arm in a little figure-eight.
    const moving = Math.min(1, speed / 5.5);
    this.walkT += dt * (4 + speed * 1.6);
    this.sway = THREE.MathUtils.lerp(this.sway, bob ? moving : 0, Math.min(1, dt * 8));
    // Turning drags the arm behind the view a touch.
    const dy = Math.atan2(Math.sin(yaw - this.lastYaw), Math.cos(yaw - this.lastYaw));
    this.lastYaw = yaw;
    this.turn = THREE.MathUtils.lerp(this.turn, THREE.MathUtils.clamp(dy / Math.max(dt, 1e-3), -6, 6) * 0.012, Math.min(1, dt * 10));

    this.swingT = Math.min(1, this.swingT + dt * 4.2);
    const s = Math.sin(this.swingT * Math.PI);
    this.group.position.set(
      0.26 + Math.cos(this.walkT) * 0.016 * this.sway + this.turn - s * 0.05,
      -0.24 - Math.abs(Math.sin(this.walkT)) * 0.02 * this.sway + s * 0.04,
      -0.46 - s * 0.12,
    );
    this.arm.rotation.set(0.35 - s * 0.9, 0.28 + s * 0.35, 0.05 + this.turn * 2);
  }
}
