/**
 * Background music, composed live with the Web Audio API — no recordings,
 * nothing to download or license. Each track is a short loop of drums, bass,
 * chords and a lead line, played by little synthesizers built from
 * oscillators and noise, scheduled a beat ahead so it never stutters.
 * The jukeboxes pick the track; Settings has the volume.
 */

export type TrackId = "lofi" | "disco" | "synthwave" | "ambient";

export interface Track {
  id: TrackId;
  name: string;
  icon: string;
  vibe: string;
  bpm: number;
  /** 0 = straight; up to ~0.3 = lazy, swung 16ths. */
  swing: number;
  /** One chord per bar, as MIDI notes (low to high). */
  chords: number[][];
  /** 16 steps per bar: what plays on each. */
  kick: string;
  snare: string;
  hat: string;
  openHat?: string;
  /** Bass per step: "r" root, "o" octave up, "f" fifth, "." rest. */
  bass: string;
  /** Lead per step: a digit picks a chord tone (0 = lowest), "." rest. */
  lead: string;
  pad: "keys" | "strings" | "saw" | "glass";
  /** Vinyl crackle (lo-fi). */
  crackle?: boolean;
  /** How long the lead's echo rings. */
  echo: number;
}

export const TRACKS: Track[] = [
  {
    id: "lofi",
    name: "Lo-fi focus",
    icon: "🎧",
    vibe: "Mellow beats to code to",
    bpm: 78,
    swing: 0.22,
    chords: [
      [53, 57, 60, 64], // Fmaj7
      [52, 55, 59, 62], // Em7
      [50, 53, 57, 60], // Dm7
      [48, 52, 55, 59], // Cmaj7
    ],
    kick: "x.....x...x.....",
    snare: "....x.......x...",
    hat: "x.x.x.x.x.x.x.x.",
    bass: "r.....r...f.....",
    lead: "....3.....2...1.",
    pad: "keys",
    crackle: true,
    echo: 0.35,
  },
  {
    id: "disco",
    name: "Disco fever",
    icon: "🪩",
    vibe: "Four on the floor — ship it!",
    bpm: 120,
    swing: 0,
    chords: [
      [57, 60, 64, 67], // Am7
      [50, 53, 57, 60], // Dm7
      [55, 59, 62, 65], // G7
      [48, 52, 55, 59], // Cmaj7
    ],
    kick: "x...x...x...x...",
    snare: "....x.......x...",
    hat: "x.x.x.x.x.x.x.x.",
    openHat: "..x...x...x...x.",
    bass: "r.o.r.o.r.o.r.o.",
    lead: "3.2.1.2.3...0...",
    pad: "strings",
    echo: 0.25,
  },
  {
    id: "synthwave",
    name: "Synthwave drive",
    icon: "🌆",
    vibe: "Neon night, heads down",
    bpm: 100,
    swing: 0,
    chords: [
      [57, 60, 64], // Am
      [53, 57, 60], // F
      [48, 52, 55], // C
      [55, 59, 62], // G
    ],
    kick: "x.......x.......",
    snare: "....x.......x...",
    hat: "..x...x...x...x.",
    bass: "rrrrrrrrrrrrrrrr",
    lead: "0120120120120121",
    pad: "saw",
    echo: 0.45,
  },
  {
    id: "ambient",
    name: "Ambient office",
    icon: "🌿",
    vibe: "Soft pads, no drums",
    bpm: 60,
    swing: 0,
    chords: [
      [48, 55, 59, 62, 64], // Cmaj9
      [45, 52, 55, 59, 60], // Am9
      [41, 48, 52, 55, 57], // Fmaj9
      [43, 50, 55, 57, 59], // G6/9
    ],
    kick: "................",
    snare: "................",
    hat: "................",
    bass: "r...............",
    lead: "..4.....2....3..",
    pad: "glass",
    echo: 0.6,
  },
];

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

export class Music {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private echoIn: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private timer = 0;
  private step = 0;
  private nextAt = 0;
  private track: Track = TRACKS[0];
  private on = false;
  private volume = 0.35;
  private lastKick = -1;

  /** The track playing (or that would). */
  get current(): Track {
    return this.track;
  }

  get playing(): boolean {
    return this.on;
  }

  /** Change what plays, how loud, and whether at all. Starting needs a click or key press first (browsers' rule). */
  set(opts: { on: boolean; track: TrackId; volume: number }): void {
    const t = TRACKS.find((x) => x.id === opts.track) ?? TRACKS[0];
    const changed = t !== this.track;
    this.track = t;
    this.volume = Math.max(0, Math.min(1, opts.volume));
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.volume * 0.5, this.ctx.currentTime, 0.1);
    if (opts.on && !this.on) this.start();
    else if (!opts.on && this.on) this.stop();
    else if (changed && this.on) {
      this.step = 0;
      this.nextAt = (this.ctx?.currentTime ?? 0) + 0.05;
    }
  }

  /** How hard the beat is hitting right now, 0..1 (for disco lights). */
  pulse(): number {
    if (!this.ctx || !this.on || this.lastKick < 0) return 0;
    const since = this.ctx.currentTime - this.lastKick;
    return since < 0 ? 0 : Math.max(0, 1 - since * 4);
  }

  private start(): void {
    try {
      this.ctx ??= new AudioContext();
    } catch {
      return;
    }
    const ctx = this.ctx;
    void ctx.resume();
    if (!this.master) {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 3;
      comp.connect(ctx.destination);
      this.master = ctx.createGain();
      this.master.gain.value = 0;
      this.master.connect(comp);
      // A feedback echo the lead and pads send into.
      this.echoIn = ctx.createGain();
      const delay = ctx.createDelay(1);
      const fb = ctx.createGain();
      const tone = ctx.createBiquadFilter();
      tone.type = "lowpass";
      tone.frequency.value = 2400;
      delay.delayTime.value = 0.375;
      fb.gain.value = 0.35;
      this.echoIn.connect(delay);
      delay.connect(tone);
      tone.connect(fb);
      fb.connect(delay);
      tone.connect(this.master);
      // White noise for drums and crackle.
      this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    this.master.gain.setTargetAtTime(this.volume * 0.5, ctx.currentTime, 0.4);
    this.on = true;
    this.step = 0;
    this.nextAt = ctx.currentTime + 0.1;
    clearInterval(this.timer);
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  private stop(): void {
    this.on = false;
    clearInterval(this.timer);
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
  }

  /** Queue every step that starts in the next ~120 ms. */
  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || !this.on) return;
    const t = this.track;
    const sixteenth = 60 / t.bpm / 4;
    // Fell behind (a hidden tab): skip ahead rather than play a burst.
    if (this.nextAt < ctx.currentTime - 0.2) this.nextAt = ctx.currentTime + 0.05;
    while (this.nextAt < ctx.currentTime + 0.12) {
      const s = this.step % 16;
      const bar = Math.floor(this.step / 16) % t.chords.length;
      const when = this.nextAt + (s % 2 === 1 ? t.swing * sixteenth : 0);
      this.playStep(t, s, bar, when, sixteenth);
      this.step++;
      this.nextAt += sixteenth;
    }
  }

  private playStep(t: Track, s: number, bar: number, when: number, sixteenth: number): void {
    const chord = t.chords[bar];
    if (t.kick[s] === "x") {
      this.kick(when);
      this.lastKick = when;
    }
    if (t.snare[s] === "x") t.id === "disco" ? this.clap(when) : this.snare(when);
    if (t.hat[s] === "x") this.hat(when, 0.04, 0.12);
    if (t.openHat?.[s] === "x") this.hat(when, 0.18, 0.1);
    const b = t.bass[s];
    if (b && b !== ".") {
      const root = chord[0] - 12;
      this.bass(b === "o" ? root + 12 : b === "f" ? root + 7 : root, when, sixteenth * (t.id === "synthwave" ? 0.9 : 1.8), t);
    }
    const l = t.lead[s];
    if (l && l !== ".") this.lead(chord[Number(l) % chord.length] + 12, when, sixteenth * 2.5, t);
    // A chord at the top of each bar (disco: short stabs on the offbeats instead).
    if (t.id === "disco") {
      if (s === 2 || s === 10) this.pad(chord, when, sixteenth * 1.2, t);
    } else if (s === 0) this.pad(chord, when, sixteenth * 16, t);
    if (t.crackle && Math.random() < 0.5) this.crackle(when + Math.random() * sixteenth);
  }

  // --- instruments ---------------------------------------------------------------

  private env(when: number, peak: number, attack: number, release: number, into: AudioNode): GainNode {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, when + attack + release);
    g.connect(into);
    return g;
  }

  private kick(when: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(140, when);
    o.frequency.exponentialRampToValueAtTime(45, when + 0.12);
    o.connect(this.env(when, 0.9, 0.002, 0.28, this.master!));
    o.start(when);
    o.stop(when + 0.32);
  }

  private noiseHit(when: number, filter: BiquadFilterType, freq: number, peak: number, release: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.value = freq;
    src.connect(f);
    f.connect(this.env(when, peak, 0.001, release, this.master!));
    src.start(when, Math.random() * 0.5);
    src.stop(when + release + 0.05);
  }

  private snare(when: number): void {
    this.noiseHit(when, "highpass", 1400, 0.35, 0.16);
    const o = this.ctx!.createOscillator();
    o.type = "triangle";
    o.frequency.value = 185;
    o.connect(this.env(when, 0.25, 0.001, 0.09, this.master!));
    o.start(when);
    o.stop(when + 0.12);
  }

  private clap(when: number): void {
    for (const d of [0, 0.012, 0.024]) this.noiseHit(when + d, "bandpass", 1300, 0.32, 0.08);
  }

  private hat(when: number, release: number, peak: number): void {
    this.noiseHit(when, "highpass", 7500, peak, release);
  }

  private crackle(when: number): void {
    this.noiseHit(when, "highpass", 3000, 0.03 + Math.random() * 0.04, 0.006);
  }

  private bass(note: number, when: number, length: number, t: Track): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = t.id === "lofi" || t.id === "ambient" ? "sine" : "sawtooth";
    o.frequency.value = hz(note);
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(t.id === "synthwave" ? 900 : 700, when);
    f.frequency.exponentialRampToValueAtTime(220, when + length);
    o.connect(f);
    f.connect(this.env(when, t.id === "ambient" ? 0.25 : 0.38, 0.005, length, this.master!));
    o.start(when);
    o.stop(when + length + 0.05);
  }

  private lead(note: number, when: number, length: number, t: Track): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = t.id === "synthwave" ? "square" : t.id === "disco" ? "sawtooth" : "triangle";
    o.frequency.value = hz(note);
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = t.id === "lofi" ? 1600 : 3200;
    o.connect(f);
    const peak = t.id === "synthwave" ? 0.07 : 0.12;
    const out = this.env(when, peak, 0.004, length, this.master!);
    f.connect(out);
    // Send some into the echo.
    const send = ctx.createGain();
    send.gain.value = t.echo;
    out.connect(send);
    send.connect(this.echoIn!);
    o.start(when);
    o.stop(when + length + 0.05);
  }

  private pad(chord: number[], when: number, length: number, t: Track): void {
    const ctx = this.ctx!;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = t.pad === "saw" ? 1500 : t.pad === "glass" ? 2600 : 1900;
    const attack = t.pad === "glass" ? 1.2 : t.pad === "strings" ? 0.01 : 0.02;
    const peak = (t.pad === "strings" ? 0.07 : 0.05) / Math.sqrt(chord.length);
    const out = this.env(when, peak * 3, attack, length, this.master!);
    f.connect(out);
    if (t.pad === "glass") {
      const send = ctx.createGain();
      send.gain.value = 0.5;
      out.connect(send);
      send.connect(this.echoIn!);
    }
    for (const n of chord) {
      for (const detune of t.pad === "keys" ? [0] : [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = t.pad === "keys" ? "triangle" : t.pad === "glass" ? "sine" : "sawtooth";
        o.frequency.value = hz(n);
        o.detune.value = detune;
        o.connect(f);
        o.start(when);
        o.stop(when + attack + length + 0.1);
      }
    }
  }
}
