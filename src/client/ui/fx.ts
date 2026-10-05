/**
 * Celebration: confetti over the screen, and little synthesized sounds (no
 * audio files) for XP, level-ups, a task shipping and a session's bell. All of
 * it respects "reduce motion" and a mute switch remembered in the browser.
 */

let muted = (() => {
  try {
    return localStorage.getItem("domain.muted") === "1";
  } catch {
    return false;
  }
})();

export function isMuted(): boolean {
  return muted;
}
export function setMuted(m: boolean): void {
  muted = m;
  try {
    localStorage.setItem("domain.muted", m ? "1" : "0");
  } catch {
    /* storage blocked */
  }
}

const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

// --- sound -----------------------------------------------------------------------

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  if (muted) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, at: number, dur: number, type: OscillatorType = "sine", gain = 0.12): void {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + at;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}

let noise: AudioBuffer | null = null;
/** A short soft burst of filtered noise: a footstep or a landing. */
function thud(freq: number, dur: number, gain: number): void {
  const a = audio();
  if (!a) return;
  if (!noise) {
    noise = a.createBuffer(1, Math.floor(a.sampleRate * 0.2), a.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t = a.currentTime;
  const src = a.createBufferSource();
  src.buffer = noise;
  const f = a.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = freq * (0.85 + Math.random() * 0.3);
  const g = a.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(a.destination);
  src.start(t);
  src.stop(t + dur + 0.02);
}

export const sound = {
  /** A soft footstep. */
  step(): void {
    thud(520, 0.07, 0.05);
  },
  /** Landing from a jump. */
  land(): void {
    thud(300, 0.14, 0.09);
  },
  /** A quick bright blip: XP earned. */
  xp(): void {
    tone(880, 0, 0.12, "triangle", 0.08);
    tone(1320, 0.07, 0.16, "triangle", 0.07);
  },
  /** A rising arpeggio: level up. */
  levelUp(): void {
    [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.09, 0.32, "triangle", 0.1));
  },
  /** A sparkly two-note chime: achievement. */
  achievement(): void {
    tone(1175, 0, 0.4, "sine", 0.09);
    tone(1568, 0.12, 0.5, "sine", 0.08);
  },
  /**
   * A gong: the mallet's strike, then a ring of out-of-tune overtones that
   * shimmer and fade. (Most of it sits well above the bass, so laptop
   * speakers carry it.)
   */
  gong(): void {
    const a = audio();
    if (!a) return;
    thud(2400, 0.12, 0.5);
    for (const [f, g, d] of [
      [98, 0.16, 4.2],
      [196.6, 0.16, 3.8],
      [294.2, 0.14, 3.4],
      [417, 0.12, 3],
      [589, 0.09, 2.6],
      [834, 0.06, 2],
      [1181, 0.04, 1.5],
      [1663, 0.025, 1.1],
    ] as const) {
      tone(f, 0, d, "sine", g);
      // A twin a hair off pitch: the two beat against each other, the gong's shimmer.
      tone(f * 1.004, 0.01, d * 0.9, "sine", g * 0.6);
    }
  },
  /** A soft bell: a focus session started or ended. */
  bell(): void {
    tone(988, 0, 1.2, "sine", 0.08);
    tone(1480, 0.02, 0.9, "sine", 0.04);
  },
  click(): void {
    tone(660, 0, 0.05, "square", 0.03);
  },
  /** Something needs you: a bright two-note ding, easy to hear over music. */
  chime(): void {
    tone(1319, 0, 0.35, "sine", 0.1);
    tone(1760, 0.16, 0.5, "sine", 0.09);
  },
};

// --- confetti ---------------------------------------------------------------------

const COLORS = ["#ff8a5b", "#ffd166", "#06d6a0", "#5bc0eb", "#ef476f", "#9b5de5"];
let layer: HTMLCanvasElement | null = null;
let pieces: { x: number; y: number; vx: number; vy: number; r: number; vr: number; s: number; c: string }[] = [];
let running = false;

export function confetti(amount = 140): void {
  if (reduceMotion()) return;
  if (!layer) {
    layer = document.createElement("canvas");
    layer.className = "confetti";
    document.body.appendChild(layer);
  }
  layer.width = innerWidth;
  layer.height = innerHeight;
  for (let i = 0; i < amount; i++) {
    const fromLeft = i % 2 === 0;
    pieces.push({
      x: fromLeft ? -10 : innerWidth + 10,
      y: innerHeight * (0.55 + Math.random() * 0.3),
      vx: (fromLeft ? 1 : -1) * (6 + Math.random() * 9),
      vy: -(10 + Math.random() * 10),
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
      s: 6 + Math.random() * 7,
      c: COLORS[i % COLORS.length],
    });
  }
  if (!running) {
    running = true;
    requestAnimationFrame(step);
  }
}

function step(): void {
  const g = layer!.getContext("2d")!;
  g.clearRect(0, 0, layer!.width, layer!.height);
  pieces = pieces.filter((p) => p.y < innerHeight + 40);
  for (const p of pieces) {
    p.vy += 0.38;
    p.vx *= 0.985;
    p.x += p.vx;
    p.y += p.vy;
    p.r += p.vr;
    g.save();
    g.translate(p.x, p.y);
    g.rotate(p.r);
    g.fillStyle = p.c;
    g.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
    g.restore();
  }
  if (pieces.length) requestAnimationFrame(step);
  else {
    running = false;
    g.clearRect(0, 0, layer!.width, layer!.height);
  }
}

// --- floating "+XP" ------------------------------------------------------------------

/** A "+25 XP" that floats up from the player card. */
export function floatXp(xp: number, anchor: HTMLElement | null): void {
  if (!anchor || xp <= 0) return;
  const r = anchor.getBoundingClientRect();
  const el = document.createElement("div");
  el.className = "xp-float";
  el.textContent = `+${xp} XP`;
  el.style.left = `${r.left + r.width / 2}px`;
  el.style.top = `${r.bottom + 4}px`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1600);
}
