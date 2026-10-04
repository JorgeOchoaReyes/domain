import type { AgentKind } from "../shared/protocol.js";

/**
 * Browser-native voice: text-to-speech for an agent's presentation, and
 * speech-to-text (dictation) for your spoken feedback. Both use the Web Speech
 * API, which is free and built into Chromium (so it Just Works in the Electron
 * app). Everything degrades gracefully when the API is missing.
 */

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
export function listVoices(): { name: string; lang: string }[] {
  if (ttsSupported() && !voiceList.length) loadVoices();
  const en = (v: SpeechSynthesisVoice) => (v.lang.toLowerCase().startsWith("en") ? 0 : 1);
  return [...voiceList].sort((a, b) => en(a) - en(b) || a.name.localeCompare(b.name)).map((v) => ({ name: v.name, lang: v.lang }));
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
