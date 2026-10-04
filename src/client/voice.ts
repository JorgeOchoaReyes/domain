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

export function ttsSupported(): boolean {
  return typeof speechSynthesis !== "undefined";
}

/** Speak text in an agent's voice, cancelling anything already speaking. */
export function speak(text: string, agent: AgentKind): void {
  if (!ttsSupported() || !text.trim()) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = voiceFor(agent);
  if (v) u.voice = v;
  u.pitch = AGENT_PITCH[agent] ?? 1;
  u.rate = 1.02;
  speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  if (ttsSupported()) speechSynthesis.cancel();
}

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
  onerror: ((e: unknown) => void) | null;
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
    rec.onerror = () => this.stop();
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
