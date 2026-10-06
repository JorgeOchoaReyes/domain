import type { AgentKind, ClientMessage, ServerMessage, VoicesState } from "../shared/protocol.js";

/**
 * Browser-native voice: text-to-speech for an agent's presentation, and
 * speech-to-text (dictation) for your spoken feedback. Both use the Web Speech
 * API, which is free and built into Chromium (so it Just Works in the Electron
 * app). Everything degrades gracefully when the API is missing.
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
}

/** Feed every server message through here. */
export function ingestVoices(msg: ServerMessage): void {
  if (msg.t === "voices") {
    eleven = msg.state;
    onVoices?.();
  } else if (msg.t === "ttsAudio") {
    waiting.get(msg.id)?.(msg.audio ?? null);
    waiting.delete(msg.id);
  }
}

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

// --- speech to text (dictation) ---------------------------------------------

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
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function sttSupported(): boolean {
  return recognitionCtor() !== null;
}

/**
 * A single dictation session. Calls onText with the running transcript (final
 * words plus the current interim guess) so a textarea can update live.
 */
export class Dictation {
  private rec: SpeechRecognitionLike | null = null;
  private finalText = "";
  private active = false;

  constructor(
    private onText: (text: string) => void,
    private onStop: () => void,
    /** Why it failed, e.g. "network" (no speech service) or "not-allowed" (no mic). */
    private onError: (error: string) => void = () => {},
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  start(seed = ""): void {
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

  stop(): void {
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
}

/** The desktop app: its built-in browser has no speech service, but the OS has dictation. */
const DESKTOP = typeof navigator !== "undefined" && /Electron/.test(navigator.userAgent);
const MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform || navigator.userAgent);

/** How to start the OS's own dictation, in the desktop app. */
export function osDictationHint(): string {
  return MAC ? "press Fn twice (or 🌐 D) and speak" : "press Win + H and speak";
}

/** A 🎤 button's HTML (empty when there's no way to dictate here). */
export function micButton(cls = ""): string {
  if (!DESKTOP && !sttSupported()) return "";
  return `<button type="button" class="btn mic ${cls}" title="${DESKTOP ? `Dictate: ${osDictationHint()}` : "Dictate — click again to stop"}">🎤</button>`;
}

/**
 * Wire a 🎤 button to a text field: click to dictate into it (after what's
 * there), click again to stop. It stops by itself when the field goes away.
 */
export function wireMic(button: HTMLButtonElement | null, field: HTMLInputElement | HTMLTextAreaElement, onError?: (error: string) => void): void {
  if (!button) return;
  if (DESKTOP) {
    // The OS dictates into whatever has focus: put the cursor in the box and say how.
    button.addEventListener("click", () => {
      field.focus();
      field.placeholder = `🎤 ${osDictationHint()[0].toUpperCase()}${osDictationHint().slice(1)} — it types here`;
      button.classList.add("live");
      setTimeout(() => button.classList.remove("live"), 4000);
    });
    return;
  }
  const d = new Dictation(
    (text) => {
      if (!field.isConnected) return d.stop();
      field.value = text;
      field.dispatchEvent(new Event("input"));
    },
    () => button.classList.remove("live"),
    (err) => {
      field.placeholder = err === "not-allowed" ? "🎤 The microphone is blocked — allow it to dictate" : "🎤 Couldn't hear you — try again, or type it";
      onError?.(err);
    },
  );
  button.addEventListener("click", () => {
    if (d.isActive) return d.stop();
    button.classList.add("live");
    d.start(field.value);
  });
}

