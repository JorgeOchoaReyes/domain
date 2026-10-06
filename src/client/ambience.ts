import { sharedAudio } from "./ui/fx.js";

/**
 * The sound of the place, made live with the Web Audio API like the music —
 * nothing recorded. Indoors: the air handling's low hum, a far-off murmur of
 * people, and now and then a phone ringing down the hall or a printer
 * working. Outdoors: wind, and birds in the daytime. And the keyboards of
 * the workers who are busy, from where they sit (louder as you get close,
 * left or right as they are to you). Settings has its volume.
 */

/** What the ambience needs to know each frame. */
export interface Surroundings {
  x: number;
  z: number;
  /** Which way you're looking, flat (unit vector). */
  look: { x: number; z: number };
  indoors: boolean;
  /** 0 = night … 1 = full day (the birds sleep at night). */
  daylight: number;
  /** Where the workers are, and what they're doing. */
  workers: { x: number; z: number; status: string }[];
}

/** How far away a keyboard can still be heard (m). */
const TYPING_RANGE = 9;
/** At most this many keyboards at once (the nearest). */
const MAX_TYPISTS = 4;

export class Ambience {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private inside: GainNode | null = null;
  private outside: GainNode | null = null;
  private keys: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private on = false;
  private volume = 0.5;
  private nextEvent = 0;
  private nextBird = 0;
  private lastIndoors: boolean | null = null;
  /** Per typist: when its next key lands (audio time). */
  private typing = new Map<string, number>();
  /** A pause between bursts of typing, per typist. */
  private resting = new Map<string, number>();

  get playing(): boolean {
    return this.on;
  }

  /** On or off, and how loud. Starting needs a click or key press first (browsers' rule). */
  set(opts: { on: boolean; volume: number }): void {
    this.volume = Math.max(0, Math.min(1, opts.volume));
    const on = opts.on && this.volume > 0;
    if (on && !this.on) this.start();
    else if (!on && this.on) this.stop();
    else if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.2);
  }

  private start(): void {
    const ctx = sharedAudio();
    if (!ctx) return;
    this.ctx = ctx;
    if (!this.master) this.build(ctx);
    this.master!.gain.setTargetAtTime(this.volume, ctx.currentTime, 1.2);
    this.on = true;
    this.nextEvent = ctx.currentTime + 20 + Math.random() * 40;
  }

  private stop(): void {
    this.on = false;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
  }

  /** The beds that always run (silent until faded in): the building's hum and murmur, the wind. */
  private build(ctx: AudioContext): void {
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);
    this.inside = ctx.createGain();
    this.inside.gain.value = 0;
    this.inside.connect(this.master);
    this.outside = ctx.createGain();
    this.outside.gain.value = 0;
    this.outside.connect(this.master);
    this.keys = ctx.createGain();
    this.keys.gain.value = 1;
    this.keys.connect(this.master);

    // Four seconds of brown-ish noise, looped: the raw stuff of air.
    const len = ctx.sampleRate * 4;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    const loop = (into: AudioNode, type: BiquadFilterType, freq: number, q: number, gain: number): { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode } => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = freq;
      filter.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = gain;
      src.connect(filter).connect(g).connect(into);
      src.start(0, Math.random() * 3);
      return { src, filter, gain: g };
    };
    const lfo = (rate: number, depth: number, param: AudioParam) => {
      const o = ctx.createOscillator();
      o.frequency.value = rate;
      const g = ctx.createGain();
      g.gain.value = depth;
      o.connect(g).connect(param);
      o.start();
    };

    // Indoors: the air handling (a low rush and a faint mains hum)…
    loop(this.inside, "lowpass", 220, 0.7, 0.22);
    const hum = ctx.createOscillator();
    hum.frequency.value = 120;
    const humGain = ctx.createGain();
    humGain.gain.value = 0.006;
    hum.connect(humGain).connect(this.inside);
    hum.start();
    // …and people talking somewhere else: a voice-band murmur that swells and fades.
    const murmur = loop(this.inside, "bandpass", 480, 1.1, 0.05);
    lfo(0.13, 0.025, murmur.gain.gain);
    lfo(0.31, 120, murmur.filter.frequency);

    // Outdoors: wind that gusts.
    const wind = loop(this.outside, "bandpass", 600, 0.6, 0.12);
    lfo(0.07, 0.07, wind.gain.gain);
    lfo(0.11, 350, wind.filter.frequency);
    loop(this.outside, "lowpass", 160, 0.7, 0.1);
  }

  /** Per frame: crossfade in and out, keyboards near you, and the odd far-off sound. */
  update(s: Surroundings): void {
    const ctx = this.ctx;
    if (!ctx || !this.on || ctx.state !== "running") return;
    const now = ctx.currentTime;
    if (s.indoors !== this.lastIndoors) {
      this.lastIndoors = s.indoors;
      this.inside!.gain.setTargetAtTime(s.indoors ? 1 : 0.15, now, 0.6);
      this.outside!.gain.setTargetAtTime(s.indoors ? 0.12 : 1, now, 0.6);
    }

    // Keyboards: the nearest busy workers, each typing in bursts.
    const busy = s.workers
      .map((w, i) => ({ ...w, key: `${i}`, d: Math.hypot(w.x - s.x, w.z - s.z) }))
      .filter((w) => w.status === "working" && w.d < TYPING_RANGE)
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_TYPISTS);
    const heard = new Set(busy.map((w) => w.key));
    for (const k of [...this.typing.keys()]) if (!heard.has(k)) this.typing.delete(k);
    for (const w of busy) {
      // (Fell behind — a hidden tab — and it picks up from now, not with a burst.)
      let at = Math.max(this.typing.get(w.key) ?? now + Math.random() * 0.3, now - 0.05);
      while (at < now + 0.12) {
        if ((this.resting.get(w.key) ?? 0) > at) {
          at = this.resting.get(w.key)!;
          continue;
        }
        // Left or right of where you look: right = (-look.z, look.x).
        const dx = (w.x - s.x) / Math.max(w.d, 0.01);
        const dz = (w.z - s.z) / Math.max(w.d, 0.01);
        const pan = Math.max(-1, Math.min(1, dx * -s.look.z + dz * s.look.x));
        this.key(Math.max(at, now), 0.09 / (1 + w.d * w.d * 0.18), pan);
        at += 0.07 + Math.random() * 0.16;
        // Every so often a pause to think.
        if (Math.random() < 0.025) this.resting.set(w.key, at + 0.8 + Math.random() * 2.5);
      }
      this.typing.set(w.key, at);
    }

    // Birds in the daytime, outdoors.
    if (!s.indoors && s.daylight > 0.45 && now > this.nextBird) {
      this.bird(now);
      this.nextBird = now + 2.5 + Math.random() * 7;
    }
    // Indoors, now and then: a phone down the hall, or the printer.
    if (s.indoors && now > this.nextEvent) {
      if (Math.random() < 0.55) this.phone(now);
      else this.printer(now);
      this.nextEvent = now + 45 + Math.random() * 90;
    }
  }

  // --- the sounds -----------------------------------------------------------------

  private panned(pan: number, into: AudioNode): AudioNode {
    const ctx = this.ctx!;
    if (!ctx.createStereoPanner) return into;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(into);
    return p;
  }

  /** One key: a click of bright noise and a little thock under it. */
  private key(when: number, gain: number, pan: number): void {
    const ctx = this.ctx!;
    const out = this.panned(pan, this.keys!);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = "bandpass";
    hp.frequency.value = 2600 + Math.random() * 1800;
    hp.Q.value = 1.4;
    const g = ctx.createGain();
    // The brown noise is quiet up high: make up for it.
    g.gain.setValueAtTime(gain * 9, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.03);
    src.connect(hp).connect(g).connect(out);
    src.start(when, Math.random() * 3);
    src.stop(when + 0.05);
    const o = ctx.createOscillator();
    o.frequency.value = 180 + Math.random() * 60;
    const og = ctx.createGain();
    og.gain.setValueAtTime(gain * 0.5, when);
    og.gain.exponentialRampToValueAtTime(0.0001, when + 0.04);
    o.connect(og).connect(out);
    o.start(when);
    o.stop(when + 0.05);
  }

  /** A little bird: a few quick whistled sweeps, somewhere off to one side. */
  private bird(now: number): void {
    const ctx = this.ctx!;
    const out = this.panned(Math.random() * 1.6 - 0.8, this.outside!);
    const base = 2400 + Math.random() * 1600;
    const n = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      const t = now + i * (0.09 + Math.random() * 0.06);
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(base, t);
      o.frequency.exponentialRampToValueAtTime(base * (1.2 + Math.random() * 0.4), t + 0.05);
      o.frequency.exponentialRampToValueAtTime(base * 0.9, t + 0.08);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.018, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + 0.1);
    }
  }

  /** A desk phone ringing in another room: two trills, muffled by the walls. */
  private phone(now: number): void {
    const ctx = this.ctx!;
    const wall = ctx.createBiquadFilter();
    wall.type = "lowpass";
    wall.frequency.value = 1400;
    wall.connect(this.panned(Math.random() * 1.4 - 0.7, this.inside!));
    for (const start of [0, 3]) {
      const t = now + start;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.012, t + 0.02);
      g.gain.setValueAtTime(0.012, t + 1.6);
      g.gain.linearRampToValueAtTime(0, t + 1.65);
      // The trill: the ring switched on and off 20 times a second.
      const trill = ctx.createGain();
      trill.gain.value = 0.5;
      const sq = ctx.createOscillator();
      sq.type = "square";
      sq.frequency.value = 20;
      const depth = ctx.createGain();
      depth.gain.value = 0.5;
      sq.connect(depth).connect(trill.gain);
      for (const f of [440, 480]) {
        const o = ctx.createOscillator();
        o.frequency.value = f;
        o.connect(trill);
        o.start(t);
        o.stop(t + 1.7);
      }
      trill.connect(g).connect(wall);
      sq.start(t);
      sq.stop(t + 1.7);
    }
  }

  /** The printer: a few seconds of rhythmic whirr, then the paper drops. */
  private printer(now: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = 1100;
    f.Q.value = 2;
    const g = ctx.createGain();
    const len = 2.5 + Math.random() * 2;
    g.gain.setValueAtTime(0, now);
    for (let t = 0; t < len; t += 0.25) {
      g.gain.linearRampToValueAtTime(0.09, now + t + 0.05);
      g.gain.linearRampToValueAtTime(0.03, now + t + 0.2);
    }
    g.gain.linearRampToValueAtTime(0, now + len + 0.1);
    src.connect(f).connect(g).connect(this.panned(Math.random() * 1.4 - 0.7, this.inside!));
    src.start(now, Math.random() * 3);
    src.stop(now + len + 0.2);
  }
}
