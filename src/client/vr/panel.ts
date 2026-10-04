import * as THREE from "three";
import { wrap } from "../scene/toon.js";

/**
 * A floating card in VR: a title, a few lines of text and big buttons, drawn
 * on a canvas. Point a controller's laser at a button and pull the trigger.
 * HTML windows don't exist inside the headset, so everything you do in VR
 * goes through these.
 */

export interface PanelButton {
  label: string;
  /** Tint: good (green), bad (pink), or a plain button. */
  tone?: "good" | "bad" | "plain";
  /** Keep the panel open after it runs (e.g. paging through slides). */
  stay?: boolean;
  run: () => void;
}

export interface PanelSpec {
  title: string;
  lines?: string[];
  buttons: PanelButton[];
  /** Buttons per row (default: 2). */
  cols?: number;
}

const W = 1024;
const F = 'Nunito, ui-rounded, "Segoe UI", system-ui, sans-serif';
const INK = "#2b2d42";
const PAD = 40;
const BTN_H = 108;
const GAP = 22;

export class VrPanel {
  readonly mesh: THREE.Mesh;
  private canvas = document.createElement("canvas");
  private g: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  private spec: PanelSpec = { title: "", buttons: [] };
  /** Button rects in canvas pixels. */
  private rects: { x: number; y: number; w: number; h: number }[] = [];
  private hover = -1;
  /** Width in meters; the height follows the content. */
  private widthM = 0.9;

  constructor() {
    this.canvas.width = W;
    this.canvas.height = 640;
    this.g = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    const mat = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    mat.userData.outlineParameters = { visible: false };
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    this.mesh.renderOrder = 2000;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  get open(): boolean {
    return this.mesh.visible;
  }

  show(spec: PanelSpec): void {
    this.spec = spec;
    this.hover = -1;
    this.paint();
    this.mesh.visible = true;
  }

  hide(): void {
    this.mesh.visible = false;
  }

  /** Which button a hit at (u, v) on the panel lands on (-1: none). Also highlights it. */
  pointAt(uv: THREE.Vector2 | null): number {
    let i = -1;
    if (uv) {
      const x = uv.x * W;
      const y = (1 - uv.y) * this.canvas.height;
      i = this.rects.findIndex((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
    }
    if (i !== this.hover) {
      this.hover = i;
      this.paint();
    }
    return i;
  }

  /** Press a button; returns whether the panel should stay open (it asked to, or it opened another). */
  press(i: number): boolean {
    const b = this.spec.buttons[i];
    if (!b) return true;
    const before = this.spec;
    b.run();
    return !!b.stay || this.spec !== before;
  }

  private paint(): void {
    const g = this.g;
    const cols = this.spec.cols ?? 2;
    // Measure: title, wrapped lines, button rows.
    g.font = `800 34px ${F}`;
    const lines = (this.spec.lines ?? []).flatMap((l) => wrap(g, l, W - PAD * 2, 3));
    const rows = Math.ceil(this.spec.buttons.length / cols);
    const H = PAD + 70 + lines.length * 46 + (lines.length ? 24 : 0) + rows * (BTN_H + GAP) + PAD - GAP;
    if (this.canvas.height !== H) {
      this.canvas.height = H;
      // A new size needs a new GPU texture.
      this.texture.dispose();
    }
    g.clearRect(0, 0, W, H);
    g.fillStyle = "#fffaf3";
    g.strokeStyle = INK;
    g.lineWidth = 10;
    g.beginPath();
    g.roundRect(5, 5, W - 10, H - 10, 40);
    g.fill();
    g.stroke();
    g.textBaseline = "middle";
    g.textAlign = "left";
    g.fillStyle = INK;
    g.font = `900 48px ${F}`;
    g.fillText(this.spec.title, PAD, PAD + 30, W - PAD * 2);
    let y = PAD + 82;
    g.font = `800 34px ${F}`;
    g.fillStyle = "#5c5f77";
    for (const l of lines) {
      g.fillText(l, PAD, y);
      y += 46;
    }
    if (lines.length) y += 24;
    const bw = (W - PAD * 2 - GAP * (cols - 1)) / cols;
    this.rects = this.spec.buttons.map((b, i) => {
      const r = { x: PAD + (i % cols) * (bw + GAP), y: y + Math.floor(i / cols) * (BTN_H + GAP) - 10, w: bw, h: BTN_H };
      const bg = b.tone === "good" ? "#8ff0c8" : b.tone === "bad" ? "#ffc2d1" : "#ffffff";
      g.fillStyle = i === this.hover ? "#ffd166" : bg;
      g.lineWidth = 6;
      g.beginPath();
      g.roundRect(r.x, r.y, r.w, r.h, 26);
      g.fill();
      g.stroke();
      g.fillStyle = INK;
      g.textAlign = "center";
      g.font = `900 38px ${F}`;
      g.fillText(b.label, r.x + r.w / 2, r.y + r.h / 2 + 2, r.w - 24);
      g.textAlign = "left";
      return r;
    });
    this.texture.needsUpdate = true;
    this.mesh.scale.set(this.widthM, (this.widthM * H) / W, 1);
  }
}
