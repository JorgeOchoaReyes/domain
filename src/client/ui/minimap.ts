import { BUILDING, PITCH, PLAZA, ROOMS, STREET, WORLD_BOUNDS, roomAt, type RoomDef } from "../../shared/layout.js";
import { STATUS_BULB } from "../scene/characters.js";
import type { WorkerStatus } from "../../shared/protocol.js";

/**
 * The minimap in the bottom-right corner: the campus around you, north up,
 * with the rooms, the workers (as their status colors), other people and
 * you as an arrow. Click it to fast travel. It also announces the room you
 * walk into with a banner across the top.
 */

const SIZE = 172;
/** Meters shown across the map. */
const SPAN = 64;

export class Minimap {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private label: HTMLElement;
  private banner: HTMLElement;
  private room: RoomDef | null = null;
  private bannerTimer = 0;
  private last = 0;

  constructor(parent: HTMLElement, onClick: () => void) {
    this.el = document.createElement("div");
    this.el.className = "minimap panel";
    this.el.title = "Fast travel (T)";
    this.el.innerHTML = `<canvas></canvas><div class="mm-room"></div>`;
    this.canvas = this.el.querySelector("canvas")!;
    const dpr = Math.min(devicePixelRatio, 2);
    this.canvas.width = SIZE * dpr;
    this.canvas.height = SIZE * dpr;
    this.g = this.canvas.getContext("2d")!;
    this.g.scale(dpr, dpr);
    this.label = this.el.querySelector(".mm-room")!;
    this.el.addEventListener("click", onClick);
    parent.appendChild(this.el);

    this.banner = document.createElement("div");
    this.banner.className = "zone-banner";
    parent.appendChild(this.banner);
  }

  /** Where you are now; returns the room you're in. */
  update(
    me: { x: number; z: number; facing: number },
    workers: { x: number; z: number; status: string }[],
    peers: { x: number; z: number }[],
  ): RoomDef {
    const room = roomAt(me.x, me.z);
    if (room.id !== this.room?.id) {
      const first = this.room === null;
      this.room = room;
      this.label.textContent = `${room.icon} ${room.name}`;
      if (!first) this.announce(`${room.icon} ${room.name}`);
    }
    const now = performance.now();
    if (now - this.last < 66) return room;
    this.last = now;
    this.draw(me, workers, peers);
    return room;
  }

  private announce(text: string): void {
    this.banner.textContent = text;
    this.banner.classList.remove("show");
    void this.banner.offsetWidth;
    this.banner.classList.add("show");
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.banner.classList.remove("show"), 1800);
  }

  private draw(me: { x: number; z: number; facing: number }, workers: { x: number; z: number; status: string }[], peers: { x: number; z: number }[]): void {
    const g = this.g;
    const k = SIZE / SPAN;
    const cx = me.x;
    const cz = me.z;
    const X = (x: number) => SIZE / 2 + (x - cx) * k;
    const Z = (z: number) => SIZE / 2 + (z - cz) * k;
    const rect = (r: { minX: number; maxX: number; minZ: number; maxZ: number }) => [X(r.minX), Z(r.minZ), (r.maxX - r.minX) * k, (r.maxZ - r.minZ) * k] as const;

    g.clearRect(0, 0, SIZE, SIZE);
    // Grounds.
    g.fillStyle = "#a7d98b";
    g.fillRect(...rect(WORLD_BOUNDS));
    g.fillStyle = "#7bbf63";
    g.fillRect(...rect(PITCH));
    g.fillStyle = "#e3d8c4";
    g.fillRect(...rect(PLAZA));
    g.fillStyle = "#5c6070";
    g.fillRect(...rect({ minX: WORLD_BOUNDS.minX, maxX: WORLD_BOUNDS.maxX, minZ: STREET.minZ, maxZ: STREET.maxZ }));
    // The building and its rooms (your office drawn last, on top).
    g.fillStyle = "#3d405b";
    g.fillRect(...rect({ minX: BUILDING.minX - 0.3, maxX: BUILDING.maxX + 0.3, minZ: BUILDING.minZ - 0.3, maxZ: BUILDING.maxZ + 0.3 }));
    for (const r of [...ROOMS].reverse()) {
      g.fillStyle = r.color;
      const [x, y, w, h] = rect(r);
      g.fillRect(x + 0.6, y + 0.6, w - 1.2, h - 1.2);
    }
    g.font = "11px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    for (const r of ROOMS) {
      if (r.id === "hall") continue;
      g.fillText(r.icon, X((r.minX + r.maxX) / 2), Z((r.minZ + r.maxZ) / 2));
    }

    for (const w of workers) {
      g.beginPath();
      g.arc(X(w.x), Z(w.z), 3.2, 0, Math.PI * 2);
      g.fillStyle = STATUS_BULB[w.status as WorkerStatus] ?? "#999";
      g.fill();
      g.lineWidth = 1.2;
      g.strokeStyle = "#2b2d42";
      g.stroke();
    }
    for (const p of peers) {
      g.beginPath();
      g.arc(X(p.x), Z(p.z), 3.4, 0, Math.PI * 2);
      g.fillStyle = "#5bc0eb";
      g.fill();
      g.strokeStyle = "#fff";
      g.lineWidth = 1.5;
      g.stroke();
    }

    // You: an arrow pointing where you face (facing 0 looks down +z, which is down on the map).
    g.save();
    g.translate(SIZE / 2, SIZE / 2);
    g.rotate(-me.facing);
    g.beginPath();
    g.moveTo(0, 8);
    g.lineTo(5.5, -5);
    g.lineTo(0, -2.5);
    g.lineTo(-5.5, -5);
    g.closePath();
    g.fillStyle = "#ff8a5b";
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = "#2b2d42";
    g.stroke();
    g.restore();
  }
}
