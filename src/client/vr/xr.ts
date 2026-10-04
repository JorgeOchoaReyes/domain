import * as THREE from "three";
import type { World } from "../scene/world.js";
import type { Player } from "../scene/player.js";
import { VrPanel, type PanelSpec } from "./panel.js";

/**
 * VR: the office in a headset, over WebXR. You stand where your avatar
 * stands (the camera rides a rig that follows it), walk with the left stick
 * the way you're looking, snap-turn with the right, and point with laser
 * pointers. The trigger presses what the laser is on (a panel's button, an
 * idea board to draw on) or, pointed at nothing, uses what's in front of you
 * like E; A/X does that too, B/Y opens the menu, and holding a grip talks.
 * Windows that would open on the monitor open as floating panels instead
 * (see flows.ts).
 */

export interface VrHooks {
  /** Use what's in front of you (E). */
  interact(): void;
  /** The menu B/Y opens. */
  menu(): PanelSpec;
  /** Surfaces the laser draws on (the idea boards). */
  drawables(): THREE.Object3D[];
  /** A stroke on one of them: where it hit, and whether it starts, goes on or ends. */
  draw(hit: THREE.Intersection, phase: "start" | "move" | "end"): void;
  /** A grip pressed or let go: hold to talk. */
  talk(down: boolean): void;
  /** Entered or left VR. */
  changed(on: boolean): void;
}

/** Snap turns: 30° a flick. */
const SNAP = Math.PI / 6;
const LASER = 6;

interface Hand {
  ray: THREE.Group;
  laser: THREE.Line;
  dot: THREE.Mesh;
  source: XRInputSource | null;
  /** Last frame's buttons, to catch presses. */
  was: boolean[];
  snapped: boolean;
  drawing: boolean;
}

export class VR {
  presenting = false;
  /** The panel you're using (a worker, the review, the menu…). */
  readonly panel = new VrPanel();
  private notice = new VrPanel();
  private noticeUntil = 0;
  private rig = new THREE.Group();
  private hands: Hand[] = [];
  private raycaster = new THREE.Raycaster();
  private session: XRSession | null = null;
  private v = new THREE.Vector3();
  private m = new THREE.Matrix4();

  /** Whether this browser and a headset can do VR. */
  static async supported(): Promise<boolean> {
    try {
      return !!navigator.xr && (await navigator.xr.isSessionSupported("immersive-vr"));
    } catch {
      return false;
    }
  }

  constructor(
    private world: World,
    private player: Player,
    private hooks: VrHooks,
  ) {
    world.scene.add(this.rig, this.panel.mesh, this.notice.mesh);
    const r = world.renderer;
    for (const i of [0, 1]) {
      const ray = r.xr.getController(i);
      const laser = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
        new THREE.LineBasicMaterial({ color: "#ffd166", transparent: true, opacity: 0.85 }),
      );
      laser.scale.z = LASER;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), new THREE.MeshBasicMaterial({ color: "#ffd166", depthTest: false }));
      dot.renderOrder = 2100;
      dot.visible = false;
      ray.add(laser);
      world.scene.add(dot);
      const hand: Hand = { ray, laser, dot, source: null, was: [], snapped: false, drawing: false };
      ray.addEventListener("connected", (e) => (hand.source = (e as unknown as { data: XRInputSource }).data));
      ray.addEventListener("disconnected", () => (hand.source = null));
      this.rig.add(ray);
      // Something to hold: a small controller in the grip.
      const grip = r.xr.getControllerGrip(i);
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.035, 0.13), new THREE.MeshBasicMaterial({ color: i ? "#3a86ff" : "#ef476f" }));
      body.position.z = 0.03;
      grip.add(body);
      this.rig.add(grip);
      this.hands.push(hand);
    }
  }

  async enter(): Promise<void> {
    if (this.presenting || !navigator.xr) return;
    const session = await navigator.xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor", "bounded-floor"] });
    const r = this.world.renderer;
    r.xr.enabled = true;
    r.xr.setReferenceSpaceType("local-floor");
    await r.xr.setSession(session);
    this.session = session;
    this.presenting = true;
    session.addEventListener("end", () => this.ended());
    // The headset moves the camera around the rig, which follows your avatar.
    this.rig.add(this.world.camera);
    this.world.camera.position.set(0, 0, 0);
    this.world.camera.rotation.set(0, 0, 0);
    this.player.xr = true;
    this.world.setXR(true);
    this.hooks.changed(true);
  }

  exit(): void {
    void this.session?.end();
  }

  private ended(): void {
    this.presenting = false;
    this.session = null;
    this.world.renderer.xr.enabled = false;
    this.world.scene.add(this.world.camera);
    this.player.xr = false;
    this.player.heading = null;
    this.player.stick.x = this.player.stick.y = 0;
    this.world.setXR(false);
    this.world.resize();
    this.panel.hide();
    this.notice.hide();
    for (const h of this.hands) h.dot.visible = false;
    this.hooks.changed(false);
  }

  /** Open a panel in front of you (one already open nearby stays put, so it doesn't chase your head). */
  open(spec: PanelSpec, low = false): void {
    // Placed on the next frame, once the rig has caught up with you (a button may have just teleported you).
    this.placing = { low, wasOpen: this.placing?.wasOpen ?? this.panel.open };
    this.panel.show(spec);
  }
  private placing: { low: boolean; wasOpen: boolean } | null = null;

  close(): void {
    this.panel.hide();
  }

  /** A few words floating in front of you for a while (toasts, in VR). */
  notify(text: string): void {
    if (!this.presenting) return;
    this.notice.show({ title: text.slice(0, 90), buttons: [] });
    this.place(this.notice.mesh, 1.4, 0.38);
    this.notice.mesh.scale.multiplyScalar(0.7);
    this.noticeUntil = performance.now() + 4500;
  }

  /** Put a panel `dist` in front of your eyes, `dy` above or below them, facing you. */
  private place(mesh: THREE.Object3D, dist: number, dy: number): void {
    const cam = this.world.camera;
    const head = cam.getWorldPosition(new THREE.Vector3());
    cam.getWorldDirection(this.v).setY(0).normalize();
    mesh.position.copy(head).addScaledVector(this.v, dist);
    mesh.position.y += dy;
    mesh.lookAt(head.x, mesh.position.y, head.z);
  }

  /** Each frame, before the player moves: read the controllers, aim the lasers, keep the rig on you. */
  update(): void {
    if (!this.presenting) return;
    const p = this.player.position;
    this.rig.position.set(p.x, p.y, p.z);
    this.rig.rotation.y = this.player.yawAngle;
    this.rig.updateMatrixWorld();
    const cam = this.world.camera;
    cam.getWorldDirection(this.v);
    this.player.heading = Math.atan2(-this.v.x, -this.v.z);
    if (this.placing) {
      // Low: down by your waist, out of the way of what you're looking at (a board you draw on).
      const { low, wasOpen } = this.placing;
      this.placing = null;
      const near = wasOpen && this.panel.mesh.position.distanceTo(cam.getWorldPosition(this.v)) < 2;
      if (!near) this.place(this.panel.mesh, low ? 0.85 : 1.15, low ? -0.62 : -0.2);
    }
    this.player.stick.x = this.player.stick.y = 0;

    for (const h of this.hands) {
      const src = h.source;
      const pad = src?.gamepad;
      h.laser.visible = !!src;
      if (!src || !pad) {
        h.dot.visible = false;
        continue;
      }
      // Sticks: left walks, right snap-turns.
      const ax = pad.axes[2] ?? pad.axes[0] ?? 0;
      const ay = pad.axes[3] ?? pad.axes[1] ?? 0;
      if (src.handedness === "left") {
        this.player.stick.x = ax;
        this.player.stick.y = -ay;
      } else {
        if (!h.snapped && Math.abs(ax) > 0.7) {
          this.player.turn(-Math.sign(ax) * SNAP);
          h.snapped = true;
        } else if (Math.abs(ax) < 0.3) h.snapped = false;
      }
      const down = pad.buttons.map((b) => b.pressed);
      const was = h.was;
      const pressed = (i: number) => !!down[i] && !was[i];
      const released = (i: number) => !down[i] && !!was[i];
      h.was = down;

      // What the laser is on: a panel first, then a board to draw on.
      this.m.identity().extractRotation(h.ray.matrixWorld);
      this.raycaster.ray.origin.setFromMatrixPosition(h.ray.matrixWorld);
      this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.m);
      this.raycaster.far = LASER;
      const targets: THREE.Object3D[] = [];
      if (this.panel.open) targets.push(this.panel.mesh);
      targets.push(...this.hooks.drawables());
      const hit = this.raycaster.intersectObjects(targets, false)[0] ?? null;
      h.laser.scale.z = hit ? hit.distance : LASER;
      h.dot.visible = !!hit;
      if (hit) h.dot.position.copy(hit.point);

      const onPanel = hit?.object === this.panel.mesh;
      const button = this.panel.open ? this.panel.pointAt(onPanel && hit?.uv ? hit.uv : null) : -1;
      if (h.drawing) {
        if (hit && !onPanel && down[0]) this.hooks.draw(hit, "move");
        if (released(0) || !hit || onPanel) {
          h.drawing = false;
          if (hit) this.hooks.draw(hit, "end");
        }
      } else if (pressed(0)) {
        if (onPanel) {
          if (button >= 0 && !this.panel.press(button)) this.panel.hide();
        } else if (hit) {
          h.drawing = true;
          this.hooks.draw(hit, "start");
        } else this.hooks.interact();
      }
      if (pressed(4)) this.hooks.interact();
      if (pressed(5)) {
        if (this.panel.open) this.panel.hide();
        else this.open(this.hooks.menu());
      }
      if (pressed(1)) this.hooks.talk(true);
      if (released(1)) this.hooks.talk(false);
    }

    if (this.notice.open && performance.now() > this.noticeUntil) this.notice.hide();
    // Walk away from a panel and it closes.
    if (this.panel.open && !this.placing && this.panel.mesh.position.distanceTo(cam.getWorldPosition(this.v)) > 4) this.panel.hide();
  }
}
