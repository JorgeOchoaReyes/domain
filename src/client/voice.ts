import type { AgentKind, ClientMessage, ServerMessage, VoicesState } from "../shared/protocol.js";
import {
  MAX_SECONDS,
  SAMPLE_RATE,
  SilenceDetector,
  concatFloat,
  fallbackEngine,
  floatToInt16,
  insertAt,
  isVoiceEngine,
  pcmBytes,
  pickEngine,
  resample,
  rms,
  sizeLabel,
  type VoiceCaps,
  type VoiceEngine,
  type WhisperState,
} from "../shared/voice.js";

/**
 * Voice: text-to-speech for an agent's presentation (the browser's Web Speech
 * voices), and speech-to-text for the 🎤 — by default recorded here and
 * transcribed on the office's computer with Whisper (free, private, offline
 * after one download), else the browser's recognition or the computer's own
 * dictation (see below). Everything degrades gracefully when something's missing.
 *
 * With an ElevenLabs API key (Office → Voices), workers can speak in
 * ElevenLabs voices instead: a character's voice "el:<id>", or every worker
 * with no voice of its own. The server makes the speech (it holds the key);
 * if that fails for any reason, the browser's voice says it instead.
 */

// --- ElevenLabs ---------------------------------------------------------------

let eleven: VoicesState = { on: false, voices: [] };
let sendMsg: ((m: ClientMessage) => void) | null = null;
const waiting = new Map<string, (audio: string | null) => void>();
let onVoices: (() => void) | null = null;
const AUTO_KEY = "domain.elevenAuto";

/** Plug voices into the connection: ask what's there now. */
export function useVoices(send: (m: ClientMessage) => void): void {
  sendMsg = send;
  send({ t: "voicesGet" });
  send({ t: "whisperGet" });
}

/** Feed every server message through here. */
export function ingestVoices(msg: ServerMessage): void {
  if (msg.t === "voices") {
    eleven = msg.state;
    onVoices?.();
  } else if (msg.t === "ttsAudio") {
    waiting.get(msg.id)?.(msg.audio ?? null);
    waiting.delete(msg.id);
  } else if (msg.t === "whisper") {
    whisper = msg.state;
    for (const f of [...whisperWatchers]) f();
  } else if (msg.t === "transcribed") {
    transcribing.get(msg.id)?.(msg);
  } else if (msg.t === "dictated") {
    const f = onDictated;
    onDictated = null;
    f?.(msg.ok, msg.error);
  }
}

/** The 🎤 waiting to hear whether the computer's dictation started. */
let onDictated: ((ok: boolean, error?: string) => void) | null = null;

export function elevenState(): VoicesState {
  return eleven;
}

/** Run when the ElevenLabs state changes (one listener: the open Voices window). */
export function watchVoices(fn: (() => void) | null): void {
  onVoices = fn;
}

/** Whether workers without a voice of their own use ElevenLabs (when it's set up). */
export function elevenAuto(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== "0";
  } catch {
    return true;
  }
}
export function setElevenAuto(on: boolean): void {
  try {
    localStorage.setItem(AUTO_KEY, on ? "1" : "0");
  } catch {
    /* storage blocked */
  }
}

/** The ElevenLabs voice to use, if any: the one chosen, else one per agent when auto is on. */
function elevenVoice(agent: AgentKind, voiceName: string): string | null {
  if (!eleven.on || !eleven.voices.length) return null;
  if (voiceName.startsWith("el:")) return eleven.voices.some((v) => `el:${v.id}` === voiceName) ? voiceName.slice(3) : null;
  if (voiceName || !elevenAuto()) return null;
  const order: AgentKind[] = ["claude", "codex", "opencode", "gemini"];
  return eleven.voices[Math.max(0, order.indexOf(agent)) % eleven.voices.length].id;
}

let audio: HTMLAudioElement | null = null;
let ttsSeq = 0;

function elevenAudio(text: string, voice: string): Promise<string | null> {
  if (!sendMsg) return Promise.resolve(null);
  const id = `tts-${Date.now()}-${++ttsSeq}`;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    setTimeout(() => {
      if (waiting.delete(id)) resolve(null);
    }, 15_000);
    sendMsg!({ t: "tts", id, text: text.slice(0, 1200), voice });
  });
}

// --- text to speech ---------------------------------------------------------

let voiceList: SpeechSynthesisVoice[] = [];
function loadVoices(): void {
  if (typeof speechSynthesis === "undefined") return;
  voiceList = speechSynthesis.getVoices();
}
if (typeof speechSynthesis !== "undefined") {
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
}

const AGENT_PITCH: Record<AgentKind, number> = {
  claude: 1.05,
  codex: 0.9,
  opencode: 1.15,
  gemini: 0.8,
};

/** Pick a stable per-agent English voice so each agent sounds distinct. */
function voiceFor(agent: AgentKind): SpeechSynthesisVoice | null {
  const english = voiceList.filter((v) => v.lang.toLowerCase().startsWith("en"));
  const pool = english.length ? english : voiceList;
  if (!pool.length) return null;
  const order: AgentKind[] = ["claude", "codex", "opencode", "gemini"];
  const idx = order.indexOf(agent);
  return pool[idx % pool.length] ?? pool[0];
}

/** The voices this browser can speak with (English first), for picking a character's voice. */
export function listVoices(): { name: string; lang: string; label?: string }[] {
  if (ttsSupported() && !voiceList.length) loadVoices();
  const en = (v: SpeechSynthesisVoice) => (v.lang.toLowerCase().startsWith("en") ? 0 : 1);
  const el = eleven.on ? eleven.voices.map((v) => ({ name: `el:${v.id}`, lang: v.about ? `ElevenLabs · ${v.about}` : "ElevenLabs", label: v.name })) : [];
  return [...el, ...[...voiceList].sort((a, b) => en(a) - en(b) || a.name.localeCompare(b.name)).map((v) => ({ name: v.name, lang: v.lang }))];
}

/** A voice's name to show (ElevenLabs voices are kept as "el:<id>"). */
export function voiceLabel(name: string): string {
  return name.startsWith("el:") ? (eleven.voices.find((v) => `el:${v.id}` === name)?.name ?? "ElevenLabs voice") : name;
}

export function ttsSupported(): boolean {
  return typeof speechSynthesis !== "undefined";
}

/**
 * Speak text in an agent's voice — or a character's own, by voice name —
 * cancelling anything already speaking. `onEnd` runs when it finishes (not
 * when it is cancelled).
 */
export function speak(text: string, agent: AgentKind, onEnd?: () => void, voiceName = ""): void {
  const el = text.trim() ? elevenVoice(agent, voiceName) : null;
  if (el) {
    stopSpeaking();
    const token = {};
    elToken = token;
    void elevenAudio(text, el).then((mp3) => {
      if (elToken !== token) return; // cancelled meanwhile
      if (!mp3) return speakBrowser(text, agent, onEnd, voiceName.startsWith("el:") ? "" : voiceName);
      const a = new Audio(`data:audio/mpeg;base64,${mp3}`);
      audio = a;
      a.onended = () => {
        if (audio === a) {
          audio = null;
          onEnd?.();
        }
      };
      a.play().catch(() => {
        if (audio === a) {
          audio = null;
          speakBrowser(text, agent, onEnd, "");
        }
      });
    });
    return;
  }
  speakBrowser(text, agent, onEnd, voiceName.startsWith("el:") ? "" : voiceName);
}

/** The ElevenLabs request in flight (a newer speak or a stop cancels it). */
let elToken: object | null = null;

function speakBrowser(text: string, agent: AgentKind, onEnd?: () => void, voiceName = ""): void {
  if (!ttsSupported() || !text.trim()) {
    if (onEnd) setTimeout(onEnd, 1500);
    return;
  }
  current = null;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (onEnd) {
    // Some engines never fire onend (or have no voices at all), so a timer
    // sized to the text backs it up. Whichever comes first wins.
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(backup);
      onEnd();
    };
    const backup = setTimeout(() => {
      if (current === u) finish();
    }, 2500 + text.split(/\s+/).length * 420);
    u.onend = () => {
      if (current === u) finish();
    };
    u.onerror = () => {
      settled = true;
      clearTimeout(backup);
    };
  }
  current = u;
  const v = (voiceName && voiceList.find((x) => x.name === voiceName)) || voiceFor(agent);
  if (v) u.voice = v;
  u.pitch = AGENT_PITCH[agent] ?? 1;
  u.rate = 1.02;
  speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  elToken = null;
  if (audio) {
    audio.pause();
    audio = null;
  }
  current = null;
  if (ttsSupported()) speechSynthesis.cancel();
}

/** The utterance speaking now; a cancelled one stops counting. */
let current: SpeechSynthesisUtterance | null = null;

// --- speech to text -----------------------------------------------------------
//
// Three ways the 🎤 can hear you, picked in Settings → Voice:
// - "whisper" (the default): record here, transcribe on the office's computer with
//   Whisper — free, private, offline after a one-time model download; the same in the
//   desktop app (Windows, macOS, Linux) and any browser.
// - "browser": the browser's speech recognition (Chrome; it sends the audio to Google).
// - "system": the computer's own dictation (Win+H, or macOS Start Dictation), desktop app only.
// When the chosen way can't work here, the next one that can steps in (shared/voice.ts).

/** The desktop app: its built-in browser has no speech service, but the OS has dictation. */
const DESKTOP = typeof navigator !== "undefined" && /Electron/.test(navigator.userAgent);
const MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform || navigator.userAgent);
const WINDOWS = typeof navigator !== "undefined" && /Win/.test(navigator.platform || navigator.userAgent);

const ENGINE_KEY = "domain.voiceEngine";

/** How you chose to talk (Settings → Voice). */
export function voiceEngine(): VoiceEngine {
  try {
    const v = localStorage.getItem(ENGINE_KEY);
    return isVoiceEngine(v) ? v : "whisper";
  } catch {
    return "whisper";
  }
}
export function setVoiceEngine(e: VoiceEngine): void {
  try {
    localStorage.setItem(ENGINE_KEY, e);
  } catch {
    /* storage blocked */
  }
}

let whisper: WhisperState | null = null;
const whisperWatchers = new Set<() => void>();
/** The server said no to transcribing for us (a visitor), or the voice model can't run there. */
let whisperRefused = false;
/** The microphone is blocked for this page. */
let micBlocked = false;

/** The voice model on the office's computer, as last heard (null: not heard yet). */
export function whisperState(): WhisperState | null {
  return whisper;
}
/** Run when the voice model's state changes; returns how to stop. */
export function watchWhisper(fn: () => void): () => void {
  whisperWatchers.add(fn);
  return () => whisperWatchers.delete(fn);
}
/** Download the voice model now (Settings → Voice → Download now). */
export function prepareWhisper(): void {
  sendMsg?.({ t: "whisperPrepare" });
}

function canRecord(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof AudioContext !== "undefined" && typeof window !== "undefined" && window.isSecureContext !== false;
}

/** What this window can do, for picking how the 🎤 hears you. */
export function voiceCaps(): VoiceCaps {
  return {
    desktop: DESKTOP,
    webSpeech: recognitionCtor() !== null,
    record: canRecord() && !micBlocked && sendMsg !== null,
    osDictation: DESKTOP && (WINDOWS || MAC),
    whisper: whisper?.status ?? "unknown",
    whisperRefused,
  };
}

/** The way the 🎤 hears you right now. */
export function activeEngine(): VoiceEngine | null {
  return pickEngine(voiceEngine(), voiceCaps());
}

// Minimal typings for the vendor-prefixed Web Speech recognition API.
interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  item(i: number): { transcript: string };
  [i: number]: { transcript: string };
}
interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    item(i: number): SpeechRecognitionResultLike;
    [i: number]: SpeechRecognitionResultLike;
  };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Whether there's any way to dictate into a box here (not counting the OS's own). */
export function sttSupported(): boolean {
  return canRecord() || (recognitionCtor() !== null && !DESKTOP);
}

// --- recording ----------------------------------------------------------------

/** The page's side of recording: 16 kHz mono chunks, each with how loud it was. */
const WORKLET = `class DomainMic extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.n = 0; this.size = Math.round(sampleRate / 10); }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) { this.buf.push(ch.slice(0)); this.n += ch.length; }
    if (this.n >= this.size) {
      const out = new Float32Array(this.n); let at = 0;
      for (const b of this.buf) { out.set(b, at); at += b.length; }
      this.buf = []; this.n = 0;
      this.port.postMessage(out, [out.buffer]);
    }
    return true;
  }
}
registerProcessor("domain-mic", DomainMic);`;

class MicRecorder {
  private chunks: Float32Array[] = [];
  private constructor(
    private stream: MediaStream,
    private ctx: AudioContext,
    private nodes: AudioNode[],
  ) {}

  /** Ask for the microphone and start recording; `onChunk` hears each tenth of a second. */
  static async open(onChunk: (level: number, ms: number) => void): Promise<MicRecorder> {
    // The microphone as it is: Whisper copes with a noisy room, but the browser's echo
    // cancellation garbles speech while the page plays sound (the office's music) — so
    // that's turned down instead, while you talk.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    } catch {
      // This browser won't record at 16 kHz itself: record at its rate and resample.
      ctx = new AudioContext();
    }
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    mute.connect(ctx.destination);
    const rec = new MicRecorder(stream, ctx, [src, mute]);
    const take = (raw: Float32Array) => {
      const f = ctx.sampleRate === SAMPLE_RATE ? raw : resample(raw, ctx.sampleRate, SAMPLE_RATE);
      rec.chunks.push(f);
      onChunk(rms(f), (f.length / SAMPLE_RATE) * 1000);
    };
    let node: AudioNode;
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const w = new AudioWorkletNode(ctx, "domain-mic", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      w.port.onmessage = (e) => take(e.data as Float32Array);
      node = w;
    } catch {
      // No AudioWorklet: the older way.
      const sp = ctx.createScriptProcessor(4096, 1, 1);
      sp.onaudioprocess = (e) => take(new Float32Array(e.inputBuffer.getChannelData(0)));
      node = sp;
    }
    src.connect(node);
    node.connect(mute);
    rec.nodes.push(node);
    ducking?.(true);
    return rec;
  }

  /** Stop, let go of the microphone, and hand over what was said (16 kHz mono). */
  stop(): Float32Array {
    ducking?.(false);
    for (const n of this.nodes) n.disconnect();
    for (const t of this.stream.getTracks()) t.stop();
    void this.ctx.close().catch(() => {});
    return concatFloat(this.chunks);
  }
}

let ducking: ((on: boolean) => void) | null = null;
/** Turn the office's own sound down while the 🎤 records (and back up after). */
export function duckWhileListening(fn: (on: boolean) => void): void {
  ducking = fn;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const transcribing = new Map<string, (r: { text?: string; error?: string; fallback?: boolean }) => void>();
let sttSeq = 0;

/** Where a Whisper recording is, for the 🎤 and its box. */
export type MicPhase =
  | { phase: "listening"; ms: number; level: number }
  | { phase: "transcribing" }
  | { phase: "downloading"; progress: number; bytes?: number };

interface WhisperHandlers {
  onPhase(p: MicPhase): void;
  /** The words (maybe "": nothing heard). */
  onText(text: string): void;
  /** Why it failed; `fallback`: Whisper can't be used from here, another way should take over. */
  onFail(error: string, fallback: boolean): void;
}

/** What the box says while the voice model downloads. */
export function downloadingText(progress: number, bytes?: number): string {
  const size = sizeLabel(bytes);
  return `⬇ Downloading the voice model (${size ? `${size}, ` : ""}once)… ${Math.round(progress * 100)}%`;
}

/**
 * Record until you stop (a second click, Enter), pause after talking, or a
 * minute's up; then the office's computer turns it into words.
 */
class WhisperSession {
  private rec: MicRecorder | null = null;
  private vad = new SilenceDetector();
  private ms = 0;
  private done = false;
  private opening = true;
  private wantStop = false;
  private unwatch: (() => void) | null = null;
  private id = "";
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private h: WhisperHandlers) {
    void MicRecorder.open((level, ms) => this.chunk(level, ms))
      .then((rec) => {
        this.opening = false;
        if (this.done) return void rec.stop();
        this.rec = rec;
        this.h.onPhase({ phase: "listening", ms: 0, level: 0 });
        if (this.wantStop) this.finish();
      })
      .catch((e: unknown) => {
        this.opening = false;
        if (this.done) return;
        this.done = true;
        const name = (e as { name?: string })?.name ?? "";
        if (name === "NotAllowedError" || name === "SecurityError") {
          micBlocked = true;
          this.h.onFail("not-allowed", true);
        } else this.h.onFail(name === "NotFoundError" ? "No microphone found" : "Couldn't start the microphone", true);
      });
  }

  get recording(): boolean {
    return !this.done && (this.opening || this.rec !== null);
  }

  private chunk(level: number, ms: number): void {
    if (this.done || !this.rec) return;
    this.ms += ms;
    const v = this.vad.feed(level, ms);
    this.h.onPhase({ phase: "listening", ms: this.ms, level });
    if (v === "done" || v === "max") this.finish();
    else if (v === "nothing") {
      this.cancel();
      this.h.onFail("Didn't hear anything — try again, a little closer", false);
    }
  }

  /** Stop recording and transcribe what was said. */
  finish(): void {
    if (this.done) return;
    if (this.opening) {
      this.wantStop = true;
      return;
    }
    this.done = true;
    const samples = this.rec?.stop() ?? new Float32Array();
    this.rec = null;
    if (samples.length < SAMPLE_RATE / 2 || !this.vad.heardSpeech) return this.h.onText("");
    const pcm = toBase64(pcmBytes(floatToInt16(samples.subarray(0, SAMPLE_RATE * MAX_SECONDS))));
    const id = (this.id = `stt-${Date.now()}-${++sttSeq}`);
    const phase = () => {
      const s = whisper;
      this.h.onPhase(s && (s.status === "downloading" || s.status === "absent") ? { phase: "downloading", progress: s.progress ?? 0, bytes: s.bytes } : { phase: "transcribing" });
      // Give up if nothing comes back — but a download takes as long as it takes.
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => answer({ error: "The voice model didn't answer — try again" }), s?.status === "downloading" ? 120_000 : 60_000);
    };
    const answer = (r: { text?: string; error?: string; fallback?: boolean }) => {
      if (!transcribing.delete(id)) return;
      this.cleanup();
      if (r.fallback) whisperRefused = true;
      if (r.error !== undefined) this.h.onFail(r.error, r.fallback === true);
      else this.h.onText(r.text ?? "");
    };
    transcribing.set(id, answer);
    this.unwatch = watchWhisper(phase);
    phase();
    if (!sendMsg) return answer({ error: "Not connected to the office", fallback: true });
    sendMsg({ t: "transcribe", id, pcm });
  }

  /** Stop and throw it away. */
  cancel(): void {
    if (this.done && !this.unwatch) return;
    this.done = true;
    this.rec?.stop();
    this.rec = null;
    this.cleanup();
    transcribing.delete(this.id);
  }

  private cleanup(): void {
    this.unwatch?.();
    this.unwatch = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * A single dictation session for a box that shows the words itself:
 * `onText` gets the box's whole new text (what was there, then what you
 * said). With Whisper that's once, when you stop; with the browser's speech
 * recognition, live as you speak. `onStatus` (optional) hears where a
 * Whisper recording is.
 */
export class Dictation {
  private rec: SpeechRecognitionLike | null = null;
  private session: WhisperSession | null = null;
  private finalText = "";
  private active = false;

  constructor(
    private onText: (text: string) => void,
    private onStop: () => void,
    /** Why it failed, e.g. "network" (no speech service), "not-allowed" (no mic), or words to show. */
    private onError: (error: string) => void = () => {},
    private onStatus: (p: MicPhase | null) => void = () => {},
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  start(seed = "", engine: VoiceEngine | null = activeEngine()): void {
    if (this.active) return;
    if (engine === "whisper") return this.startWhisper(seed);
    if (engine === "browser" || (engine === null && recognitionCtor())) return this.startBrowser(seed);
    this.onError(DESKTOP ? "network" : "unsupported");
    this.onStop();
  }

  private startWhisper(seed: string): void {
    this.active = true;
    const end = () => {
      this.session = null;
      this.onStatus(null);
      if (this.active) {
        this.active = false;
        this.onStop();
      }
    };
    this.session = new WhisperSession({
      onPhase: (p) => this.onStatus(p),
      onText: (text) => {
        if (text) this.onText(seed ? `${seed.trimEnd()} ${text}` : text);
        end();
      },
      onFail: (err, fallback) => {
        this.session = null;
        this.onStatus(null);
        this.active = false;
        // Whisper can't be used from here: the browser's own recognition, if it can.
        if (fallback && err !== "not-allowed" && recognitionCtor() && !DESKTOP) return this.startBrowser(seed);
        this.onError(err);
        this.onStop();
      },
    });
  }

  private startBrowser(seed: string): void {
    const Ctor = recognitionCtor();
    if (!Ctor || this.active) return;
    this.finalText = seed ? seed.trimEnd() + " " : "";
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const chunk = r[0]?.transcript ?? "";
        if (r.isFinal) this.finalText += chunk + " ";
        else interim += chunk;
      }
      this.onText((this.finalText + interim).trim());
    };
    rec.onerror = (e) => {
      const err = e?.error ?? "error";
      if (err !== "no-speech" && err !== "aborted") this.onError(err);
      this.stop();
    };
    rec.onend = () => {
      if (this.active) {
        this.active = false;
        this.onStop();
      }
    };
    this.rec = rec;
    this.active = true;
    try {
      rec.start();
    } catch {
      this.active = false;
    }
  }

  /** Stop listening: Whisper then transcribes what was said (onStop comes after the words). */
  stop(): void {
    if (this.session) {
      if (this.session.recording) this.session.finish();
      return;
    }
    if (!this.rec) return;
    this.active = false;
    try {
      this.rec.stop();
    } catch {
      /* already stopped */
    }
    this.rec = null;
    this.onStop();
  }

  /** Stop and throw away anything not yet transcribed. */
  cancel(): void {
    if (this.session) {
      this.session.cancel();
      this.session = null;
      this.onStatus(null);
      if (this.active) {
        this.active = false;
        this.onStop();
      }
      return;
    }
    this.stop();
  }
}

/** How to start the OS's own dictation, in the desktop app. */
export function osDictationHint(): string {
  return MAC ? "press Fn twice (or 🌐 D) and speak" : "press Win + H and speak";
}

/** A 🎤 button's HTML (empty when there's no way to dictate here). */
export function micButton(cls = ""): string {
  if (!DESKTOP && !sttSupported()) return "";
  return `<button type="button" class="btn mic ${cls}" title="Dictate — click again (or Enter) to finish, Esc to cancel">🎤</button>`;
}

/** What the box says while the computer's dictation is on. */
function listeningText(): string {
  return MAC ? "🎤 Listening — speak now (macOS dictation) · Fn or click 🎤 again to stop" : "🎤 Listening — speak now (Windows voice typing) · click 🎤 again to stop";
}

/** A little card by the 🎤 saying what it's doing (fixed, so a scrolling box can't clip it). */
class MicChip {
  private el: HTMLDivElement | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(private button: HTMLElement) {}

  show(html: string, cls = "", forMs = 0): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (!this.button.isConnected) return this.hide();
    if (!this.el) {
      this.el = document.createElement("div");
      this.el.className = "mic-chip";
      this.el.setAttribute("role", "status");
      document.body.appendChild(this.el);
    }
    this.el.className = `mic-chip ${cls}`;
    this.el.innerHTML = html;
    const r = this.button.getBoundingClientRect();
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const top = r.top - h - 8 >= 4 ? r.top - h - 8 : r.bottom + 8;
    this.el.style.top = `${Math.round(top)}px`;
    this.el.style.left = `${Math.round(Math.max(4, Math.min(window.innerWidth - w - 4, r.right - w)))}px`;
    if (forMs) this.hideTimer = setTimeout(() => this.hide(), forMs);
  }

  hide(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.el?.remove();
    this.el = null;
  }
}

/** The chip's words for a Whisper recording's phase. */
export function phaseText(p: MicPhase): string {
  if (p.phase === "listening") return `● Listening… ${Math.floor(p.ms / 1000)}s`;
  if (p.phase === "downloading") return downloadingText(p.progress, p.bytes);
  return "✨ Transcribing…";
}

/**
 * Wire a 🎤 button to a text field: click to dictate into it — the words go
 * where the caret was — and click again (or Enter) to finish; Esc cancels. It
 * stops by itself after a pause, after a minute, or when the field goes away.
 */
export function wireMic(button: HTMLButtonElement | null, field: HTMLInputElement | HTMLTextAreaElement, onError?: (error: string) => void): void {
  if (!button) return;
  const before = field.placeholder;
  const chip = new MicChip(button);
  // Where the words go: the caret (or selection) as you left it, else the end.
  let caret: [number, number] | null = null;
  const keep = () => {
    if (document.activeElement === field) caret = [field.selectionStart ?? field.value.length, field.selectionEnd ?? field.value.length];
  };
  for (const e of ["keyup", "click", "select", "input", "blur"]) field.addEventListener(e, keep);

  let session: WhisperSession | null = null;
  let browser: Dictation | null = null;
  const live = (on: boolean, busy = false) => {
    button.classList.toggle("live", on && !busy);
    button.classList.toggle("busy", busy);
    if (!on) {
      field.placeholder = before;
      button.style.removeProperty("--lvl");
    }
  };
  const fail = (msg: string) => {
    live(false);
    chip.show(esc(msg), "warn", 5000);
    if (!field.value) field.placeholder = msg;
    setTimeout(() => field.placeholder === msg && (field.placeholder = before), 5000);
  };

  // --- the computer's own dictation (desktop app) ---
  let osLive = false;
  const osStop = () => {
    osLive = false;
    live(false);
  };
  field.addEventListener("blur", () => osLive && setTimeout(() => document.activeElement !== field && osStop(), 300));
  const systemDictation = (note = "") => {
    field.focus();
    const end = field.value.length;
    field.setSelectionRange(end, end);
    if ((WINDOWS || MAC) && sendMsg) {
      if (osLive) {
        // macOS dictation stops itself (Fn, Done, or a pause); Windows' Win+H toggles.
        if (WINDOWS) sendMsg({ t: "dictate" });
        return osStop();
      }
      osLive = true;
      live(true);
      field.placeholder = listeningText();
      if (note) chip.show(esc(note), "warn", 5000);
      onDictated = (ok, error) => {
        if (ok || !osLive) return;
        osLive = false;
        fail(`🎤 ${error ?? osDictationHint()}`);
      };
      sendMsg({ t: "dictate" });
      return;
    }
    const how = osDictationHint();
    fail(`🎤 ${note ? `${note} — ` : ""}${how[0].toUpperCase()}${how.slice(1)} — it types here`);
  };

  // --- the browser's speech recognition ---
  const browserDictation = (note = "") => {
    if (note) chip.show(esc(note), "warn", 5000);
    browser ??= new Dictation(
      (text) => {
        if (!field.isConnected) return browser?.stop();
        field.value = text;
        field.dispatchEvent(new Event("input"));
      },
      () => live(false),
      (err) => {
        fail(err === "not-allowed" ? "🎤 The microphone is blocked — allow it to dictate" : "🎤 Couldn't hear you — try again, or type it");
        onError?.(err);
      },
    );
    if (browser.isActive) return browser.stop();
    live(true);
    browser.start(field.value, "browser");
  };

  // --- Whisper, on the office's computer ---
  const insert = (words: string) => {
    if (!field.isConnected || !words) return;
    const [a, b] = caret ?? [field.value.length, field.value.length];
    const max = field.maxLength > 0 ? field.maxLength : Infinity;
    const next = insertAt(field.value, a, b, words);
    field.value = next.value.slice(0, max);
    field.focus();
    const at = Math.min(next.caret, field.value.length);
    field.setSelectionRange(at, at);
    caret = [at, at];
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const whisperDictation = () => {
    live(true);
    chip.show("🎤 Starting the microphone…");
    session = new WhisperSession({
      onPhase: (p) => {
        if (!field.isConnected || !button.isConnected) {
          session?.cancel();
          session = null;
          live(false);
          return chip.hide();
        }
        const text = phaseText(p);
        if (p.phase === "listening") {
          live(true);
          const lvl = Math.min(1, Math.sqrt(p.level) * 4);
          button.style.setProperty("--lvl", lvl.toFixed(2));
          chip.show(`<span class="mic-dot"></span><b>Listening…</b> ${Math.floor(p.ms / 1000)}s<span class="mic-meter"><span style="width:${Math.round(lvl * 100)}%"></span></span><span class="mic-tip">🎤 or Enter to finish · Esc cancels</span>`, "listening");
        } else {
          live(true, true);
          chip.show(`<span class="mic-spin"></span>${esc(text)}`, p.phase);
        }
        if (!field.value) field.placeholder = text;
      },
      onText: (text) => {
        session = null;
        live(false);
        if (text) {
          chip.hide();
          insert(text);
        } else chip.show("🎤 Didn't catch anything — try again", "warn", 3500);
      },
      onFail: (err, fallback) => {
        session = null;
        live(false);
        chip.hide();
        if (fallback) {
          // Whisper can't be used from here (no model engine, a visitor, a blocked mic): the next way.
          const next = fallbackEngine(voiceCaps(), "whisper");
          const why = err === "not-allowed" ? "The microphone is blocked for this page" : `On-device voice isn't available (${err})`;
          if (next === "system") return systemDictation(`${why} — using your computer's dictation`);
          if (next === "browser" && err !== "not-allowed") return browserDictation(`${why} — using the browser's speech recognition`);
          fail(`🎤 ${err === "not-allowed" ? "The microphone is blocked — allow it to dictate" : why}`);
        } else fail(`🎤 ${err}`);
        onError?.(err);
      },
    });
  };

  // Enter finishes, Esc cancels — before the box (or the window) acts on them.
  field.addEventListener(
    "keydown",
    (ev) => {
      const e = ev as KeyboardEvent;
      if (!session) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        session.cancel();
        session = null;
        live(false);
        chip.show("🎤 Cancelled", "", 1500);
      } else if (e.key === "Enter" && !e.shiftKey && session.recording) {
        e.preventDefault();
        e.stopImmediatePropagation();
        session.finish();
      }
    },
    { capture: true },
  );

  button.addEventListener("click", () => {
    if (session) {
      if (session.recording) session.finish();
      return;
    }
    if (osLive) return systemDictation();
    if (browser?.isActive) return browser.stop();
    keep();
    const engine = activeEngine();
    if (engine === "whisper") return whisperDictation();
    if (engine === "browser") return browserDictation();
    if (engine === "system") return systemDictation();
    fail(DESKTOP ? `🎤 ${osDictationHint()}` : "🎤 Voice input isn't available in this window — type it");
  });
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
