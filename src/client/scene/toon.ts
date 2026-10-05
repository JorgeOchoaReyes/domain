import * as THREE from "three";

/**
 * The cartoon look: flat-banded toon materials, a few cheap shapes, and text
 * drawn to canvas for labels, name tags and speech-bubble cards.
 */

export const INK = "#2b2d42";
const FONT = 'Nunito, ui-rounded, "Segoe UI", system-ui, sans-serif';

let gradient: THREE.DataTexture | null = null;

/** Three-step ramp that gives MeshToonMaterial its flat banding. */
function gradientMap(): THREE.DataTexture {
  if (gradient) return gradient;
  const data = new Uint8Array([90, 90, 90, 255, 185, 185, 185, 255, 255, 255, 255, 255]);
  gradient = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.needsUpdate = true;
  return gradient;
}

const cache = new Map<string, THREE.MeshToonMaterial>();

export function toon(
  color: THREE.ColorRepresentation,
  opts: { emissive?: THREE.ColorRepresentation; opacity?: number } = {},
): THREE.MeshToonMaterial {
  const key = `${new THREE.Color(color).getHexString()}|${opts.emissive ?? ""}|${opts.opacity ?? 1}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const m = new THREE.MeshToonMaterial({ color, gradientMap: gradientMap() });
  if (opts.emissive !== undefined) m.emissive = new THREE.Color(opts.emissive);
  if ((opts.opacity ?? 1) < 1) {
    m.transparent = true;
    m.opacity = opts.opacity!;
  }
  cache.set(key, m);
  return m;
}

/** A fresh toon material, for things whose color changes. */
export function toonUnique(color: THREE.ColorRepresentation): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ color, gradientMap: gradientMap() });
}

export function mesh(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
  shadow = true,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

export function box(w: number, h: number, d: number): THREE.BoxGeometry {
  return new THREE.BoxGeometry(w, h, d);
}

/** A cheap rounded box: an extruded rounded rectangle, centered. */
export function roundedBox(w: number, h: number, d: number, r = 0.06): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const x = -w / 2;
  const y = -d / 2;
  r = Math.min(r, w / 2, d / 2);
  shape.moveTo(x + r, y);
  shape.lineTo(x + w - r, y);
  shape.quadraticCurveTo(x + w, y, x + w, y + r);
  shape.lineTo(x + w, y + d - r);
  shape.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  shape.lineTo(x + r, y + d);
  shape.quadraticCurveTo(x, y + d, x, y + d - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 4 });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -h / 2, 0);
  geo.computeVertexNormals();
  return geo;
}

/** Flat things (signs, screens, board faces) and unlit things don't get the toon outline. */
export function noOutline(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const flat = m.geometry instanceof THREE.PlaneGeometry || m.geometry instanceof THREE.CircleGeometry;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      if (flat || mat instanceof THREE.MeshBasicMaterial) mat.userData.outlineParameters = { visible: false };
    }
  });
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export interface TextOpts {
  color?: string;
  bg?: string;
  border?: string;
  size?: number;
}
const TEXT_SCALE = 0.0055;

function textCanvas(text: string, opts: TextOpts): HTMLCanvasElement {
  const size = opts.size ?? 48;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const font = `800 ${size}px ${FONT}`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + size;
  const h = Math.ceil(size * 1.6);
  canvas.width = w;
  canvas.height = h;
  ctx.font = font;
  if (opts.bg) {
    ctx.fillStyle = opts.bg;
    ctx.beginPath();
    ctx.roundRect(3, 3, w - 6, h - 6, h / 2 - 3);
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = opts.border ?? INK;
    ctx.stroke();
  }
  ctx.fillStyle = opts.color ?? INK;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, w / 2, h / 2 + size * 0.05);
  return canvas;
}

function canvasTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** A camera-facing pill label. */
export function textSprite(text: string, opts: TextOpts = {}): THREE.Sprite {
  const canvas = textCanvas(text, opts);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: canvasTexture(canvas), depthWrite: false, transparent: true }),
  );
  sprite.scale.set(canvas.width * TEXT_SCALE, canvas.height * TEXT_SCALE, 1);
  sprite.renderOrder = 10;
  return label(sprite);
}

/** A flat label facing +z, for mounting on a wall. */
export function textPlane(text: string, opts: TextOpts = {}): THREE.Mesh {
  const canvas = textCanvas(text, opts);
  const mat = new THREE.MeshBasicMaterial({ map: canvasTexture(canvas), transparent: true, alphaTest: 0.05 });
  return new THREE.Mesh(new THREE.PlaneGeometry(canvas.width * TEXT_SCALE, canvas.height * TEXT_SCALE), mat);
}

export interface CardOpts {
  /** A small pill across the top edge, e.g. "⌨️ WORKING". */
  chip?: { text: string; bg: string; color: string };
  title: string;
  body?: string;
  bg: string;
  border?: string;
}

/**
 * A speech-bubble card: a status pill, a bold title and a smaller body, with a
 * tail pointing down. Its position is the tip of the tail.
 */
export function cardSprite(o: CardOpts): THREE.Sprite {
  const R = 2;
  const maxW = 380 * R;
  const pad = 16 * R;
  const lw = 5 * R;
  const tail = 14 * R;
  const chipFont = `800 ${19 * R}px ${FONT}`;
  const chipH = 30 * R;
  const titleFont = `800 ${30 * R}px ${FONT}`;
  const titleLH = 36 * R;
  const bodyFont = `700 ${23 * R}px ${FONT}`;
  const bodyLH = 29 * R;

  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = titleFont;
  const title = wrap(ctx, o.title, maxW, 2);
  const titleW = Math.max(...title.map((l) => ctx.measureText(l).width));
  ctx.font = bodyFont;
  const body = o.body ? wrap(ctx, o.body, maxW, 2) : [];
  const bodyW = body.length ? Math.max(...body.map((l) => ctx.measureText(l).width)) : 0;
  ctx.font = chipFont;
  const chipW = o.chip ? ctx.measureText(o.chip.text).width + 24 * R : 0;

  const w = Math.ceil(Math.max(titleW, bodyW, chipW + 2 * pad) + 2 * pad);
  const top = o.chip ? chipH / 2 : lw;
  const titleY = top + (o.chip ? chipH / 2 + 6 * R : pad);
  const bodyY = titleY + title.length * titleLH + 4 * R;
  const bottom = bodyY + body.length * bodyLH + pad * 0.7;
  const h = Math.ceil(bottom + tail + lw);

  const canvas = ctx.canvas;
  canvas.width = w;
  canvas.height = h;
  const x0 = lw / 2;
  const x1 = w - lw / 2;
  const cx = w / 2;
  const r = 18 * R;
  ctx.beginPath();
  ctx.moveTo(x0 + r, top);
  ctx.arcTo(x1, top, x1, bottom, r);
  ctx.arcTo(x1, bottom, x0, bottom, r);
  ctx.lineTo(cx + tail, bottom);
  ctx.lineTo(cx, bottom + tail);
  ctx.lineTo(cx - tail, bottom);
  ctx.arcTo(x0, bottom, x0, top, r);
  ctx.arcTo(x0, top, x1, top, r);
  ctx.closePath();
  ctx.fillStyle = o.bg;
  ctx.fill();
  ctx.lineWidth = lw;
  ctx.lineJoin = "round";
  ctx.strokeStyle = o.border ?? INK;
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (o.chip) {
    ctx.beginPath();
    ctx.roundRect(cx - chipW / 2, lw / 2, chipW, chipH, chipH / 2);
    ctx.fillStyle = o.chip.bg;
    ctx.fill();
    ctx.lineWidth = 4 * R;
    ctx.stroke();
    ctx.font = chipFont;
    ctx.fillStyle = o.chip.color;
    ctx.fillText(o.chip.text, cx, lw / 2 + chipH / 2 + R);
  }
  ctx.font = titleFont;
  ctx.fillStyle = INK;
  title.forEach((l, i) => ctx.fillText(l, cx, titleY + (i + 0.5) * titleLH));
  ctx.font = bodyFont;
  ctx.fillStyle = "#5c5f77";
  body.forEach((l, i) => ctx.fillText(l, cx, bodyY + (i + 0.5) * bodyLH));

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: canvasTexture(canvas), depthWrite: false, transparent: true }),
  );
  sprite.scale.set((w / R) * TEXT_SCALE, (h / R) * TEXT_SCALE, 1);
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 10;
  return label(sprite);
}

/** Greedy word wrap to at most `maxLines`, ending in "…" when it doesn't fit. */
export function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const fits = (s: string) => ctx.measureText(s).width <= maxW;
  const lines: string[] = [];
  let line = "";
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (!fits(word)) {
      let n = word.length - 1;
      while (n > 1 && !fits(word.slice(0, n))) n--;
      if (line) lines.push(line);
      lines.push(word.slice(0, n));
      line = "";
      word = word.slice(n);
    }
    const next = line ? `${line} ${word}` : word;
    if (fits(next)) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last && !fits(`${last}…`)) last = last.slice(0, -1).trimEnd();
  kept[maxLines - 1] = `${last}…`;
  return kept;
}

export function disposeSprite(s: THREE.Sprite): void {
  LABELS.delete(s);
  s.material.map?.dispose();
  s.material.dispose();
}

/**
 * Floating labels (name tags, worker cards, the E key): they keep their size
 * in the world from afar, but up close they stop growing — standing at a desk
 * in first person, a card a metre away shouldn't fill the screen.
 */
export const LABELS = new Set<THREE.Sprite>();
/** Closer than this (metres), a label shrinks with the distance instead of growing. */
const LABEL_NEAR = 3.2;

export function label(sprite: THREE.Sprite): THREE.Sprite {
  sprite.userData.baseScale = sprite.scale.clone();
  LABELS.add(sprite);
  return sprite;
}

const at = new THREE.Vector3();
/** Size every label for how far it is from the camera (call once a frame). */
export function fitLabels(camera: THREE.Vector3): void {
  for (const s of LABELS) {
    const base = s.userData.baseScale as THREE.Vector3 | undefined;
    if (!base || !s.visible) continue;
    const k = Math.max(0.3, Math.min(1, s.getWorldPosition(at).distanceTo(camera) / LABEL_NEAR));
    s.scale.set(base.x * k, base.y * k, base.z);
  }
}
