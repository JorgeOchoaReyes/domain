import * as THREE from "three";
import { Terminal } from "@xterm/headless";
import type { WorkerStatus } from "../../shared/protocol.js";
import { STATUS_BULB } from "./characters.js";
import { mesh, roundedBox, toon } from "./toon.js";

/**
 * A laptop on a desk whose screen shows its worker's terminal, live. Output is
 * fed into a headless xterm (so cursor moves and redraws come out right) and
 * painted onto the screen's canvas a few times a second while it changes.
 */

const COLS = 80;
const ROWS = 24;
const W = 512;
const H = 320;
const BAR = 18;
const BG = "#1e1f2e";
const FG = "#cdd6f4";
const BASE16 = [
  "#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de",
  "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8",
];

function paletteColor(n: number): string {
  if (n < 16) return BASE16[n];
  if (n < 232) {
    const i = n - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    return `rgb(${steps[Math.floor(i / 36)]},${steps[Math.floor(i / 6) % 6]},${steps[i % 6]})`;
  }
  const v = 8 + (n - 232) * 10;
  return `rgb(${v},${v},${v})`;
}

export class Laptop {
  readonly group = new THREE.Group();
  private term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 0 });
  private canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  private dirty = true;
  private nextPaint = 0;
  private status: WorkerStatus | null = null;
  private title = "";

  constructor() {
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;

    const shell = toon("#c9ced8");
    this.group.add(mesh(roundedBox(0.6, 0.03, 0.42, 0.03), shell, 0, 0.015, 0));
    this.group.add(mesh(roundedBox(0.5, 0.005, 0.22, 0.02), toon("#3d405b"), 0, 0.032, 0.03, false));
    const lid = new THREE.Group();
    lid.position.set(0, 0.03, -0.2);
    lid.rotation.x = -0.32;
    lid.add(mesh(roundedBox(0.6, 0.4, 0.02, 0.03), shell, 0, 0.2, 0));
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.344), new THREE.MeshBasicMaterial({ map: this.texture }));
    screen.position.set(0, 0.205, 0.012);
    lid.add(screen);
    this.group.add(lid);
  }

  /** Clear the screen (a new worker sat down, or its scrollback is coming). */
  reset(): void {
    this.term.reset();
    this.dirty = true;
  }

  write(data: string): void {
    this.term.write(data, () => {
      this.dirty = true;
    });
  }

  /** The title bar across the top shows who's working here and their status. */
  setHeader(status: WorkerStatus | null, title: string): void {
    if (status === this.status && title === this.title) return;
    this.status = status;
    this.title = title;
    this.dirty = true;
  }

  /** Repaint if something changed; `near` laptops refresh more often. */
  update(now: number, near: boolean): void {
    if (!this.dirty || now < this.nextPaint) return;
    this.nextPaint = now + (near ? 250 : 1200);
    this.dirty = false;
    this.paint();
  }

  dispose(): void {
    this.term.dispose();
    this.texture.dispose();
  }

  private paint(): void {
    const g = this.ctx;
    g.fillStyle = BG;
    g.fillRect(0, 0, W, H);
    if (!this.status) {
      // Nobody here: a sleepy screen.
      g.fillStyle = "#313244";
      g.fillRect(0, 0, W, H);
      g.fillStyle = "#6c7086";
      g.font = '700 30px Nunito, ui-rounded, system-ui, sans-serif';
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("💤 free desk", W / 2, H / 2);
      this.texture.needsUpdate = true;
      return;
    }
    g.fillStyle = STATUS_BULB[this.status];
    g.fillRect(0, 0, W, BAR);
    g.fillStyle = "#1d1d1d";
    g.font = '800 12px Nunito, ui-rounded, system-ui, sans-serif';
    g.textAlign = "left";
    g.textBaseline = "middle";
    g.fillText(this.title, 8, BAR / 2 + 1);

    const buf = this.term.buffer.active;
    const cw = W / COLS;
    const lh = (H - BAR - 4) / ROWS;
    g.font = `${Math.floor(lh * 0.92)}px ui-monospace, Consolas, Menlo, monospace`;
    g.textBaseline = "top";
    const cell = buf.getNullCell();
    for (let y = 0; y < ROWS; y++) {
      const line = buf.getLine(buf.viewportY + y);
      if (!line) continue;
      let run = "";
      let runColor = FG;
      let runX = 0;
      const flush = () => {
        if (run.trim()) {
          g.fillStyle = runColor;
          g.fillText(run, runX * cw, BAR + 2 + y * lh);
        }
        run = "";
      };
      for (let x = 0; x < COLS; x++) {
        const c = line.getCell(x, cell);
        if (!c) break;
        const ch = c.getChars() || " ";
        let color = FG;
        if (c.isFgPalette()) color = paletteColor(c.getFgColor());
        else if (c.isFgRGB()) {
          const v = c.getFgColor();
          color = `rgb(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255})`;
        }
        if (c.isDim()) color = "#7f849c";
        if (color !== runColor) {
          flush();
          runColor = color;
          runX = x;
        }
        if (!run) runX = x;
        run += ch;
      }
      flush();
    }
    this.texture.needsUpdate = true;
  }
}
