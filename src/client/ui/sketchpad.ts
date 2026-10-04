/**
 * A whiteboard you draw on with the mouse, pen or a finger: a few marker
 * colors, an eraser and a wipe. Used by the review board and the idea boards.
 */

export const PENS = ["#2b2d42", "#ef476f", "#3a86ff", "#06d6a0", "#ff8a5b"];
const PAPER = "#fbfdff";

/** The pen, eraser and clear buttons, to go next to the canvas. */
export function sketchTools(): string {
  return `${PENS.map((c, i) => `<button class="pen ${i === 0 ? "sel" : ""}" data-c="${c}" style="background:${c}" aria-label="pen"></button>`).join("")}
    <button class="pen eraser" data-c="erase" title="Eraser">🧽</button>
    <button class="btn small clear" title="Clear the board">Clear</button>`;
}

export class Sketchpad {
  /** Whether anything has been drawn since the last wipe. */
  ink = false;
  /** Whether it changed since it was opened or loaded. */
  dirty = false;
  private g: CanvasRenderingContext2D;

  /**
   * `tools` holds the buttons from sketchTools(); `onChange` hears about
   * strokes (throttled) and gets null on a wipe.
   */
  constructor(
    readonly canvas: HTMLCanvasElement,
    tools: HTMLElement,
    private onChange?: (c: HTMLCanvasElement | null) => void,
  ) {
    const c = canvas;
    this.g = c.getContext("2d")!;
    this.wipe();
    let pen = PENS[0];
    let drawing = false;
    let lx = 0;
    let ly = 0;
    let lastPush = 0;
    const at = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * c.width, ((e.clientY - r.top) / r.height) * c.height];
    };
    const push = (force = false) => {
      const now = performance.now();
      if (force || now - lastPush > 120) {
        lastPush = now;
        this.onChange?.(c);
      }
    };
    c.addEventListener("pointerdown", (e) => {
      drawing = true;
      [lx, ly] = at(e);
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointermove", (e) => {
      if (!drawing) return;
      const [x, y] = at(e);
      const g = this.g;
      g.lineCap = "round";
      g.lineJoin = "round";
      g.strokeStyle = pen === "erase" ? PAPER : pen;
      g.lineWidth = pen === "erase" ? 40 : 6;
      g.beginPath();
      g.moveTo(lx, ly);
      g.lineTo(x, y);
      g.stroke();
      lx = x;
      ly = y;
      if (pen !== "erase") this.ink = true;
      this.dirty = true;
      push();
    });
    const end = () => {
      if (!drawing) return;
      drawing = false;
      push(true);
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    tools.querySelectorAll<HTMLButtonElement>(".pen").forEach((b) =>
      b.addEventListener("click", () => {
        pen = b.dataset.c!;
        tools.querySelectorAll(".pen").forEach((x) => x.classList.toggle("sel", x === b));
      }),
    );
    tools.querySelector(".clear")?.addEventListener("click", () => {
      this.wipe();
      this.dirty = true;
      this.onChange?.(null);
    });
  }

  wipe(): void {
    this.g.fillStyle = PAPER;
    this.g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ink = false;
  }

  /** Start from a picture (e.g. an idea's sketch, to add to it). */
  load(src: string): void {
    const img = new Image();
    img.onload = () => {
      this.g.drawImage(img, 0, 0, this.canvas.width, this.canvas.height);
      this.ink = true;
      this.onChange?.(this.canvas);
    };
    img.src = src;
  }

  /** The full drawing as a PNG data URL (null when blank). */
  png(): string | null {
    return this.ink ? this.canvas.toDataURL("image/png") : null;
  }

  /** A small JPEG of the drawing for lists and boards (null when blank). */
  thumb(): string | null {
    return this.ink ? canvasThumb(this.canvas) : null;
  }
}

/** A small JPEG of a drawing (about 320×180), for lists and boards. */
export function canvasThumb(c: HTMLCanvasElement, w = 320, h = 180): string {
  const t = document.createElement("canvas");
  t.width = w;
  t.height = h;
  t.getContext("2d")!.drawImage(c, 0, 0, w, h);
  return t.toDataURL("image/jpeg", 0.72);
}
