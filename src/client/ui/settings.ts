import { TRACKS, type TrackId } from "../music.js";
import { esc, openModal } from "./modal.js";
import { downloadingText, prepareWhisper, setVoiceEngine, voiceCaps, voiceEngine, watchWhisper, whisperState } from "../voice.js";
import { sizeLabel, type VoiceEngine } from "../../shared/voice.js";

/**
 * Your settings, kept in this browser: how fast you walk and run, mouse
 * sensitivity, field of view, the first-person hand and head bob, the
 * minimap, and sound (effects, the background sound, music). Opened from the ⚙ button or with Esc when nothing
 * else is open (a pause menu). Changes apply live.
 */

export interface Settings {
  /** Walking speed multiplier. */
  walk: number;
  /** How much faster Shift makes you. */
  sprint: number;
  /** Mouse look sensitivity multiplier. */
  sensitivity: number;
  /** Field of view in degrees. */
  fov: number;
  invertY: boolean;
  hand: boolean;
  headBob: boolean;
  minimap: boolean;
  /** Follow the real time of day outside (off: always daytime). */
  dayNight: boolean;
  /** How it's drawn: high, balanced, or fast for slower machines. */
  graphics: "high" | "balanced" | "fast";
  /** Drop the graphics a level by itself when the game runs slow. */
  autoGraphics: boolean;
  /** Background music, how loud, and which track (the jukeboxes pick it too). */
  music: boolean;
  musicVolume: number;
  track: TrackId;
  /** The sound of the place (hum, murmur, keyboards, wind and birds), and how loud. */
  ambience: boolean;
  ambienceVolume: number;
  /** How loud the sound effects are (footsteps, doors, chimes…; the 🔊 switch mutes them). */
  fxVolume: number;
  /** Office hours in a window, or on the projector (you in your chair, the slides on the big screen). */
  reviewStyle: "window" | "projector";
}

export const DEFAULT_SETTINGS: Settings = {
  walk: 1,
  sprint: 1.65,
  sensitivity: 1,
  fov: 66,
  invertY: false,
  hand: true,
  headBob: true,
  minimap: true,
  dayNight: true,
  graphics: "balanced",
  autoGraphics: true,
  music: true,
  musicVolume: 0.35,
  track: "lofi",
  ambience: true,
  ambienceVolume: 0.5,
  fxVolume: 0.8,
  reviewStyle: "window",
};

const KEY = "domain.settings";

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings>;
    const s = { ...DEFAULT_SETTINGS };
    for (const k of Object.keys(s) as (keyof Settings)[]) {
      if (typeof raw[k] === typeof s[k]) (s as Record<string, unknown>)[k] = raw[k];
    }
    s.walk = clamp(s.walk, 0.5, 2);
    s.sprint = clamp(s.sprint, 1, 2.5);
    s.sensitivity = clamp(s.sensitivity, 0.3, 2.5);
    s.fov = clamp(s.fov, 50, 100);
    if (!["high", "balanced", "fast"].includes(s.graphics)) s.graphics = "balanced";
    s.musicVolume = clamp(s.musicVolume, 0, 1);
    s.ambienceVolume = clamp(s.ambienceVolume, 0, 1);
    s.fxVolume = clamp(s.fxVolume, 0, 1);
    if (s.reviewStyle !== "projector") s.reviewStyle = "window";
    if (!TRACKS.some((t) => t.id === s.track)) s.track = DEFAULT_SETTINGS.track;
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage blocked */
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
}

interface Slider {
  key: "walk" | "sprint" | "sensitivity" | "fov";
  label: string;
  min: number;
  max: number;
  step: number;
  show: (v: number) => string;
}

const SLIDERS: Slider[] = [
  { key: "walk", label: "🚶 Walk speed", min: 0.5, max: 2, step: 0.05, show: (v) => `${Math.round(v * 100)}%` },
  { key: "sprint", label: "🏃 Sprint boost (Shift)", min: 1, max: 2.5, step: 0.05, show: (v) => `×${v.toFixed(2)}` },
  { key: "sensitivity", label: "🖱 Mouse sensitivity", min: 0.3, max: 2.5, step: 0.05, show: (v) => `${Math.round(v * 100)}%` },
  { key: "fov", label: "🔭 Field of view", min: 50, max: 100, step: 1, show: (v) => `${Math.round(v)}°` },
];

const TOGGLES: { key: "invertY" | "hand" | "headBob" | "minimap" | "dayNight"; label: string }[] = [
  { key: "hand", label: "✋ Show your hand in first person" },
  { key: "headBob", label: "〰️ Head bob while walking" },
  { key: "invertY", label: "↕️ Invert mouse look (up/down)" },
  { key: "minimap", label: "🗺 Show the minimap" },
  { key: "dayNight", label: "🌗 Real-time day and night outside" },
];

export interface SettingsExtras {
  firstPerson: boolean;
  muted: boolean;
  setFirstPerson(on: boolean): void;
  setMuted(on: boolean): void;
  openHelp(): void;
}

export function openSettings(current: Settings, onChange: (s: Settings) => void, extras: SettingsExtras): void {
  const s = { ...current };
  const body = document.createElement("div");
  body.className = "settings";
  body.innerHTML = `
    <section>
      <h3>View</h3>
      <div class="st-views">
        <button class="st-view-card ${extras.firstPerson ? "on" : ""}" data-v="first">
          <span class="st-view-icon">👁</span><b>First person</b><span>See through your own eyes, with your hand in view</span>
        </button>
        <button class="st-view-card ${extras.firstPerson ? "" : "on"}" data-v="third">
          <span class="st-view-icon">🎥</span><b>Third person</b><span>A camera behind you, so you see your character</span>
        </button>
      </div>
      <p class="st-hint">Switch any time with <span class="key">V</span>, or scroll all the way in and out.</p>
    </section>
    <section>
      <h3>Movement & camera</h3>
      ${SLIDERS.map(
        (sl) => `<label class="st-row"><span class="st-label">${sl.label}</span>
          <input type="range" min="${sl.min}" max="${sl.max}" step="${sl.step}" value="${s[sl.key]}" data-k="${sl.key}" />
          <output data-o="${sl.key}">${esc(sl.show(s[sl.key]))}</output></label>`,
      ).join("")}
    </section>
    <section>
      <h3>Graphics</h3>
      <div class="st-views st-gfx">
        ${(
          [
            ["high", "✨", "High", "Outlines, sharp shadows, full resolution"],
            ["balanced", "⚖️", "Balanced", "The cartoon look, lighter on your computer"],
            ["fast", "⚡", "Fast", "Smoothest: no outlines or shadows"],
          ] as const
        )
          .map(([k, ic, name, sub]) => `<button class="st-view-card ${s.graphics === k ? "on" : ""}" data-g="${k}"><span class="st-view-icon">${ic}</span><b>${name}</b><span>${sub}</span></button>`)
          .join("")}
      </div>
      <label class="st-check"><input type="checkbox" class="st-autogfx" ${s.autoGraphics ? "checked" : ""} /> 🩺 Lower it by itself if the game runs slow</label>
    </section>
    <section>
      <h3>Display</h3>
      ${TOGGLES.map((t) => `<label class="st-check"><input type="checkbox" data-t="${t.key}" ${s[t.key] ? "checked" : ""} /> ${t.label}</label>`).join("")}
    </section>
    <section>
      <h3>Sound</h3>
      <label class="st-check"><input type="checkbox" class="st-sound" ${extras.muted ? "" : "checked"} /> 🔊 Sound effects — footsteps, doors, chimes</label>
      <label class="st-row"><span class="st-label">🔉 Effects volume</span>
        <input type="range" class="st-fx-vol" min="0" max="1" step="0.05" value="${s.fxVolume}" />
        <output class="st-fx-out">${Math.round(s.fxVolume * 100)}%</output></label>
      <label class="st-check"><input type="checkbox" class="st-amb" ${s.ambience ? "checked" : ""} /> 🏢 Background sound — the office's hum, keyboards, a phone down the hall; wind and birds outside</label>
      <label class="st-row"><span class="st-label">🔉 Background volume</span>
        <input type="range" class="st-amb-vol" min="0" max="1" step="0.05" value="${s.ambienceVolume}" />
        <output class="st-amb-out">${Math.round(s.ambienceVolume * 100)}%</output></label>
    </section>
    <section>
      <h3>Voice</h3>
      <p class="st-hint">How the 🎤 hears you, everywhere you can type.</p>
      <div class="st-views st-voice">
        ${(
          [
            ["whisper", "🖥", "On this computer (Whisper)", "Free and private, works offline — the audio never leaves this computer"],
            ["browser", "🌐", "Browser", "Chrome only; it sends your audio to Google"],
            ["system", "⌨️", "System dictation", "Windows voice typing (Win + H) or macOS dictation"],
          ] as const
        )
          .map(([k, ic, name, sub]) => `<button class="st-view-card ${voiceEngine() === k ? "on" : ""}" data-ve="${k}"><span class="st-view-icon">${ic}</span><b>${name}</b><span>${sub}</span></button>`)
          .join("")}
      </div>
      <div class="st-whisper"><span class="st-whisper-state"></span><button class="btn small st-whisper-get">⬇ Download now</button></div>
    </section>
    <section>
      <h3>Office hours</h3>
      <div class="st-views st-review">
        <button class="st-view-card ${s.reviewStyle === "window" ? "on" : ""}" data-rs="window"><span class="st-view-icon">🪟</span><b>In a window</b><span>Slides, the review board and the conversation side by side</span></button>
        <button class="st-view-card ${s.reviewStyle === "projector" ? "on" : ""}" data-rs="projector"><span class="st-view-icon">📽</span><b>On the projector</b><span>You in your chair, the slides on the big screen, a bar to decide</span></button>
      </div>
    </section>
    <section>
      <h3>Music</h3>
      <label class="st-check"><input type="checkbox" class="st-music" ${s.music ? "checked" : ""} /> 🎵 Background music</label>
      <label class="st-row"><span class="st-label">🔉 Music volume</span>
        <input type="range" class="st-music-vol" min="0" max="1" step="0.05" value="${s.musicVolume}" />
        <output class="st-music-out">${Math.round(s.musicVolume * 100)}%</output></label>
      <div class="st-tracks">${TRACKS.map((t) => `<button class="btn small st-track ${t.id === s.track ? "on" : ""}" data-track="${t.id}">${t.icon} ${esc(t.name)}</button>`).join("")}</div>
      <p class="st-hint">Or pick it at a jukebox — there's one in the game room and one by the lounge.</p>
    </section>`;
  const footer = document.createElement("div");
  footer.style.display = "contents";
  footer.innerHTML = `<button class="btn reset">Reset to defaults</button><button class="btn st-keys">⌨️ Controls</button><span class="grow">Saved on this device · Esc to resume</span><button class="btn primary done">Resume</button>`;
  const modal = openModal({ title: "Settings", icon: "⚙️", className: "settings-modal", body, footer });

  const emit = () => {
    saveSettings(s);
    onChange({ ...s });
  };
  body.querySelectorAll<HTMLInputElement>("input[type=range][data-k]").forEach((r) =>
    r.addEventListener("input", () => {
      const sl = SLIDERS.find((x) => x.key === r.dataset.k)!;
      s[sl.key] = Number(r.value);
      body.querySelector(`[data-o="${sl.key}"]`)!.textContent = sl.show(s[sl.key]);
      emit();
    }),
  );
  body.querySelectorAll<HTMLInputElement>("input[data-t]").forEach((c) =>
    c.addEventListener("change", () => {
      s[c.dataset.t as (typeof TOGGLES)[number]["key"]] = c.checked;
      emit();
    }),
  );
  body.querySelector<HTMLInputElement>(".st-sound")!.addEventListener("change", (e) => extras.setMuted(!(e.target as HTMLInputElement).checked));
  body.querySelectorAll<HTMLButtonElement>(".st-review .st-view-card").forEach((b) =>
    b.addEventListener("click", () => {
      s.reviewStyle = b.dataset.rs === "projector" ? "projector" : "window";
      body.querySelectorAll(".st-review .st-view-card").forEach((x) => x.classList.toggle("on", x === b));
      emit();
    }),
  );
  body.querySelector<HTMLInputElement>(".st-fx-vol")!.addEventListener("input", (e) => {
    s.fxVolume = Number((e.target as HTMLInputElement).value);
    body.querySelector(".st-fx-out")!.textContent = `${Math.round(s.fxVolume * 100)}%`;
    emit();
  });
  body.querySelector<HTMLInputElement>(".st-amb")!.addEventListener("change", (e) => {
    s.ambience = (e.target as HTMLInputElement).checked;
    emit();
  });
  body.querySelector<HTMLInputElement>(".st-amb-vol")!.addEventListener("input", (e) => {
    s.ambienceVolume = Number((e.target as HTMLInputElement).value);
    body.querySelector(".st-amb-out")!.textContent = `${Math.round(s.ambienceVolume * 100)}%`;
    emit();
  });
  body.querySelector<HTMLInputElement>(".st-music")!.addEventListener("change", (e) => {
    s.music = (e.target as HTMLInputElement).checked;
    emit();
  });
  body.querySelector<HTMLInputElement>(".st-music-vol")!.addEventListener("input", (e) => {
    s.musicVolume = Number((e.target as HTMLInputElement).value);
    body.querySelector(".st-music-out")!.textContent = `${Math.round(s.musicVolume * 100)}%`;
    emit();
  });
  body.querySelectorAll<HTMLButtonElement>(".st-track").forEach((b) =>
    b.addEventListener("click", () => {
      s.track = b.dataset.track as TrackId;
      s.music = true;
      body.querySelector<HTMLInputElement>(".st-music")!.checked = true;
      body.querySelectorAll(".st-track").forEach((x) => x.classList.toggle("on", x === b));
      emit();
    }),
  );
  body.querySelectorAll<HTMLButtonElement>(".st-gfx .st-view-card").forEach((b) =>
    b.addEventListener("click", () => {
      s.graphics = b.dataset.g as Settings["graphics"];
      body.querySelectorAll(".st-gfx .st-view-card").forEach((x) => x.classList.toggle("on", x === b));
      emit();
    }),
  );
  body.querySelector<HTMLInputElement>(".st-autogfx")!.addEventListener("change", (e) => {
    s.autoGraphics = (e.target as HTMLInputElement).checked;
    emit();
  });
  body.querySelectorAll<HTMLButtonElement>(".st-view-card[data-v]").forEach((b) =>
    b.addEventListener("click", () => {
      extras.setFirstPerson(b.dataset.v === "first");
      body.querySelectorAll(".st-view-card[data-v]").forEach((x) => x.classList.toggle("on", x === b));
    }),
  );
  // Voice: which way the 🎤 hears you, and the voice model's download.
  const caps = voiceCaps();
  const usable: Record<VoiceEngine, string> = {
    whisper: caps.whisper === "failed" ? "can't run on the office's computer" : !caps.record ? "this window can't record" : "",
    browser: caps.desktop ? "not in the desktop app" : !caps.webSpeech ? "not in this browser" : "",
    system: !caps.desktop ? "desktop app only" : !caps.osDictation ? "not on this computer" : "",
  };
  body.querySelectorAll<HTMLButtonElement>(".st-voice .st-view-card").forEach((b) => {
    const why = usable[b.dataset.ve as VoiceEngine];
    if (why) b.querySelector("span:last-child")!.textContent += ` (${why})`;
    b.addEventListener("click", () => {
      setVoiceEngine(b.dataset.ve as VoiceEngine);
      body.querySelectorAll(".st-voice .st-view-card").forEach((x) => x.classList.toggle("on", x === b));
    });
  });
  const wState = body.querySelector<HTMLElement>(".st-whisper-state")!;
  const wGet = body.querySelector<HTMLButtonElement>(".st-whisper-get")!;
  const showWhisper = () => {
    if (!wState.isConnected) return unwatch();
    const st = whisperState();
    const name = st ? st.model.split("/").pop() : "Whisper";
    const size = sizeLabel(st?.bytes);
    wState.textContent = !st
      ? "🧠 Voice model: asking the office…"
      : st.status === "ready"
        ? `🧠 ${name} · ${size ? `${size} · ` : ""}✓ on this computer`
        : st.status === "downloading"
          ? `🧠 ${name} · ${downloadingText(st.progress ?? 0, st.bytes)}`
          : st.status === "failed"
            ? `🧠 ${name} can't run here: ${st.error ?? "unknown error"} — the 🎤 uses another way`
            : `🧠 ${name} · ${size ? `${size}, ` : ""}not downloaded yet — it downloads once, the first time you talk${st.error ? ` (last try: ${st.error})` : ""}`;
    wGet.classList.toggle("hidden", !st || st.status === "ready" || st.status === "failed");
    wGet.disabled = st?.status === "downloading";
  };
  const unwatch = watchWhisper(showWhisper);
  showWhisper();
  wGet.addEventListener("click", () => {
    prepareWhisper();
    wGet.disabled = true;
  });
  footer.querySelector(".reset")!.addEventListener("click", () => {
    modal.close();
    Object.assign(s, DEFAULT_SETTINGS);
    emit();
    openSettings(s, onChange, extras);
  });
  footer.querySelector(".st-keys")!.addEventListener("click", () => {
    modal.close();
    extras.openHelp();
  });
  footer.querySelector(".done")!.addEventListener("click", () => modal.close());
}
