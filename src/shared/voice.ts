/**
 * Speech to text on this computer: the pieces the 🎤 button (in the page) and
 * the transcriber (on the server) share. Free and private, like a local
 * model — what you say never leaves the computer the office runs on. Audio
 * travels as 16 kHz mono 16-bit PCM (what Whisper hears), base64 in a JSON
 * message like every other one.
 */

/** What Whisper hears: 16 kHz, mono. */
export const SAMPLE_RATE = 16_000;
/** The longest one recording can be. */
export const MAX_SECONDS = 60;
/** The most PCM one "transcribe" may carry (60 s of 16-bit samples). */
export const MAX_PCM_BYTES = SAMPLE_RATE * MAX_SECONDS * 2;
/** Its base64 length. */
export const MAX_PCM_B64 = Math.ceil(MAX_PCM_BYTES / 3) * 4;

/** The model unless DOMAIN_WHISPER_MODEL says otherwise: Whisper base, English, quantized (≈80 MB). */
export const DEFAULT_WHISPER_MODEL = "onnx-community/whisper-base.en";

/** Where the voice model is: not here yet, coming down, here (ready), or it can't run here. */
export type WhisperStatus = "absent" | "downloading" | "ready" | "failed";

export interface WhisperState {
  model: string;
  status: WhisperStatus;
  /** The download's size in bytes (known, or once it's started). */
  bytes?: number;
  /** How far the download is, 0..1. */
  progress?: number;
  /** Why it can't run (status "failed"). */
  error?: string;
}

/** How the 🎤 turns speech into text. */
export type VoiceEngine = "whisper" | "browser" | "system";

export const VOICE_ENGINES: readonly VoiceEngine[] = ["whisper", "browser", "system"];

export function isVoiceEngine(v: unknown): v is VoiceEngine {
  return typeof v === "string" && (VOICE_ENGINES as readonly string[]).includes(v);
}

/** What this window and computer can do. */
export interface VoiceCaps {
  /** The desktop app (its built-in browser has no speech service). */
  desktop: boolean;
  /** The browser's speech recognition (Chrome: sends audio to Google). */
  webSpeech: boolean;
  /** A microphone API to record with (getUserMedia + Web Audio). */
  record: boolean;
  /** The office can start the computer's dictation (Windows, or the Mac app). */
  osDictation: boolean;
  /** The transcriber on the server, as far as we know. */
  whisper: WhisperStatus | "unknown";
  /** The server said no to transcribing for us (a visitor), or the mic was blocked. */
  whisperRefused?: boolean;
}

/** Whether on-device Whisper can be used from here. */
function whisperOk(c: VoiceCaps): boolean {
  return c.record && c.whisper !== "failed" && !c.whisperRefused;
}

/**
 * When the chosen way can't work: the desktop app falls back to the
 * computer's dictation, a browser to its own speech recognition — and
 * either to Whisper if that's the one left. Null: no way to talk here.
 */
export function fallbackEngine(c: VoiceCaps, not: VoiceEngine | null = null): VoiceEngine | null {
  const order: VoiceEngine[] = c.desktop ? ["system", "whisper", "browser"] : ["browser", "whisper", "system"];
  for (const e of order) if (e !== not && engineWorks(e, c)) return e;
  return null;
}

function engineWorks(e: VoiceEngine, c: VoiceCaps): boolean {
  if (e === "whisper") return whisperOk(c);
  // The desktop app's built-in browser has the API but no speech service behind it.
  if (e === "browser") return c.webSpeech && !c.desktop;
  return c.desktop && c.osDictation;
}

/** The way the 🎤 works now: the one you chose, if it can here, else the fallback. */
export function pickEngine(choice: VoiceEngine, c: VoiceCaps): VoiceEngine | null {
  return engineWorks(choice, c) ? choice : fallbackEngine(c, choice);
}

// --- audio --------------------------------------------------------------------

/** Float samples (-1..1) to 16-bit PCM. */
export function floatToInt16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i] || 0));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** 16-bit PCM to float samples (-1..1). */
export function int16ToFloat(p: Int16Array): Float32Array {
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i++) out[i] = p[i] / 0x8000;
  return out;
}

/**
 * Resample mono audio (when the microphone won't give 16 kHz itself):
 * averaging the samples each output one covers when going down (a cheap
 * low-pass, so there's no aliasing hiss), linear in between going up.
 */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || !input.length) return input.slice();
  const ratio = from / to;
  const n = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(n);
  if (ratio > 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * ratio);
      const b = Math.min(input.length, Math.max(a + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = a; j < b; j++) sum += input[j];
      out[i] = sum / (b - a);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const x = i * ratio;
      const a = Math.floor(x);
      const b = Math.min(input.length - 1, a + 1);
      out[i] = input[a] + (input[b] - input[a]) * (x - a);
    }
  }
  return out;
}

/** How loud a stretch of samples is (root mean square). */
export function rms(f: Float32Array): number {
  if (!f.length) return 0;
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i] * f[i];
  return Math.sqrt(s / f.length);
}

/** Join recorded chunks into one. */
export function concatFloat(chunks: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** The bytes of 16-bit PCM, little-endian (what goes over the wire, base64'd). */
export function pcmBytes(p: Int16Array): Uint8Array {
  const out = new Uint8Array(p.length * 2);
  for (let i = 0; i < p.length; i++) {
    out[i * 2] = p[i] & 0xff;
    out[i * 2 + 1] = (p[i] >> 8) & 0xff;
  }
  return out;
}

/** PCM bytes back to samples (an odd last byte is dropped). */
export function pcmFromBytes(b: Uint8Array): Int16Array {
  const n = b.length >> 1;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = (b[i * 2] | (b[i * 2 + 1] << 8)) << 16 >> 16;
  return out;
}

/**
 * Whether a "transcribe" can be taken: base64 of a whole number of samples,
 * at least a quarter second, no more than a minute. Returns why not, or "".
 */
export function checkPcm(b64: unknown): string {
  if (typeof b64 !== "string" || !b64) return "nothing to hear";
  if (b64.length > MAX_PCM_B64) return `too long — at most ${MAX_SECONDS} seconds`;
  if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return "not audio";
  const bytes = (b64.length / 4) * 3 - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  if (bytes % 2 !== 0) return "not audio";
  if (bytes < SAMPLE_RATE / 2) return "too short to hear";
  return "";
}

// --- when to stop listening ---------------------------------------------------

export interface SilenceOptions {
  /** Louder than this (RMS) is speech. */
  threshold: number;
  /** Stop after this long quiet, once there's been speech. */
  silenceMs: number;
  /** Speech shorter than this doesn't count (a click, a cough). */
  minSpeechMs: number;
  /** Stop after this long whatever happens. */
  maxMs: number;
  /** With no speech at all, give up after this long. */
  noSpeechMs: number;
}

export const SILENCE: SilenceOptions = { threshold: 0.012, silenceMs: 1200, minSpeechMs: 250, maxMs: MAX_SECONDS * 1000, noSpeechMs: 8000 };

export type SilenceVerdict = "listen" | "done" | "max" | "nothing";

/**
 * A simple voice-activity check, fed the loudness of each stretch of audio
 * as it's recorded: it says when you've stopped talking (a pause after
 * speech), when the hard cap is reached, or when nobody said anything.
 * The threshold follows the room: it rises over steady background noise.
 */
export class SilenceDetector {
  private elapsed = 0;
  private speech = 0;
  private quiet = 0;
  private floor = 0;
  constructor(private o: SilenceOptions = SILENCE) {}

  get heardSpeech(): boolean {
    return this.speech >= this.o.minSpeechMs;
  }

  feed(level: number, ms: number): SilenceVerdict {
    this.elapsed += ms;
    // Background noise: follow quiet stretches quickly, loud ones barely.
    // (It starts no higher than the threshold: you may be talking already when it starts.)
    this.floor = this.floor === 0 ? Math.min(level, this.o.threshold) || 1e-6 : this.floor + (level - this.floor) * (level < this.floor ? 0.3 : 0.02);
    const loud = level > Math.max(this.o.threshold, this.floor * 2.5);
    if (loud) {
      this.speech += ms;
      this.quiet = 0;
    } else this.quiet += ms;
    if (this.elapsed >= this.o.maxMs) return "max";
    if (this.heardSpeech && this.quiet >= this.o.silenceMs) return "done";
    if (!this.heardSpeech && this.elapsed >= this.o.noSpeechMs) return "nothing";
    return "listen";
  }
}

/** Whisper's words, tidied: no leading space, no "[BLANK_AUDIO]" or "(music)" when nothing was said. */
export function cleanTranscript(text: string): string {
  return text
    .replace(/\[(?:BLANK_AUDIO|blank_audio|Silence|silence|MUSIC|Music|music|inaudible|INAUDIBLE)\]/g, " ")
    .replace(/\((?:music|Music|silence|inaudible|wind blowing|static)\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Put dictated words into a box at the caret (or over the selection), with
 * a space either side where it needs one. Returns the new text and where the
 * caret goes.
 */
export function insertAt(value: string, start: number, end: number, words: string): { value: string; caret: number } {
  const a = Math.max(0, Math.min(start, value.length));
  const b = Math.max(a, Math.min(end, value.length));
  const before = value.slice(0, a);
  const after = value.slice(b);
  if (!words) return { value, caret: b };
  const pre = before && !/\s$/.test(before) ? " " : "";
  const post = after && !/^[\s.,!?;:]/.test(after) ? " " : "";
  const text = before + pre + words + post + after;
  return { value: text, caret: before.length + pre.length + words.length };
}

/** "≈80 MB" for a byte count. */
export function sizeLabel(bytes: number | undefined): string {
  if (!bytes) return "";
  return bytes >= 1e9 ? `≈${(bytes / 1e9).toFixed(1)} GB` : `≈${Math.max(1, Math.round(bytes / 1e6))} MB`;
}
