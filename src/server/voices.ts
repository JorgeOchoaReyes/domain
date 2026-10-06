import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WebSocket } from "ws";
import type { VoiceInfo, VoicesState } from "../shared/protocol.js";
import type { Routes, ServerCtx } from "./ctx.js";
import { prefsPath } from "./prefs.js";

/**
 * ElevenLabs voices. With your API key, workers can speak in ElevenLabs
 * voices instead of the browser's. The key stays on this computer, in
 * ~/.domain/elevenlabs.json (next to prefs.json, never in a project, so it
 * can't be committed), or comes from ELEVENLABS_API_KEY; the browser never
 * sees it. Speech is made here and sent over the socket as MP3.
 */

const API = "https://api.elevenlabs.io/v1";
const MAX_TEXT = 1200;

export function keyPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(prefsPath(env)), "elevenlabs.json");
}

export function loadKey(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const raw = JSON.parse(readFileSync(keyPath(env), "utf8")) as { key?: unknown };
    if (typeof raw.key === "string" && raw.key.trim()) return raw.key.trim();
  } catch {
    /* none saved */
  }
  return env.ELEVENLABS_API_KEY?.trim() ?? "";
}

export function saveKey(key: string, env: NodeJS.ProcessEnv = process.env): void {
  const file = keyPath(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ key }, null, 2), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows */
  }
}

/** ElevenLabs' voices list, trimmed to what the voice pickers show. */
export function parseVoices(raw: unknown): VoiceInfo[] {
  const list = (raw as { voices?: unknown })?.voices;
  if (!Array.isArray(list)) return [];
  return list
    .filter((v): v is { voice_id: string; name: string; labels?: Record<string, string> } => !!v && typeof v.voice_id === "string" && typeof v.name === "string")
    .map((v) => ({ id: v.voice_id, name: v.name, about: [v.labels?.gender, v.labels?.accent, v.labels?.description].filter(Boolean).join(", ") }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 200);
}

export function voicesModule(ctx: ServerCtx, env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): Routes {
  let key = loadKey(env);
  let state: VoicesState = { on: false, voices: [] };

  const refresh = async (): Promise<void> => {
    if (!key) {
      state = { on: false, voices: [] };
      return;
    }
    try {
      const r = await fetcher(`${API}/voices`, { headers: { "xi-api-key": key } });
      if (!r.ok) throw new Error(r.status === 401 ? "ElevenLabs didn't accept that API key." : `ElevenLabs answered ${r.status}.`);
      state = { on: true, voices: parseVoices(await r.json()) };
    } catch (e) {
      state = { on: false, voices: [], error: e instanceof Error ? e.message : String(e) };
    }
  };
  const ready = refresh();
  const tell = (ws?: WebSocket) => (ws ? ctx.send(ws, { t: "voices", state }) : ctx.broadcast({ t: "voices", state }));

  return {
    voicesGet: (_m, _c, ws) => void ready.then(() => tell(ws)),
    voicesKey: (m) => {
      const next = typeof m.key === "string" ? m.key.trim().slice(0, 200) : "";
      key = next;
      try {
        saveKey(next, env);
      } catch {
        /* still used for this run */
      }
      ctx.log.start("agent", next ? "ElevenLabs API key saved" : "ElevenLabs API key removed").done(true);
      void refresh().then(() => tell());
    },
    tts: (m, _c, ws) => {
      const id = typeof m.id === "string" ? m.id.slice(0, 40) : "";
      const text = typeof m.text === "string" ? m.text.trim().slice(0, MAX_TEXT) : "";
      const voice = typeof m.voice === "string" && /^[A-Za-z0-9]{1,64}$/.test(m.voice) ? m.voice : "";
      if (!id) return;
      if (!key || !text || !voice) return ctx.send(ws, { t: "ttsAudio", id, error: key ? "nothing to say" : "no ElevenLabs key" });
      void (async () => {
        try {
          const r = await fetcher(`${API}/text-to-speech/${voice}?output_format=mp3_44100_64`, {
            method: "POST",
            headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
            body: JSON.stringify({ text, model_id: "eleven_flash_v2_5" }),
          });
          if (!r.ok) throw new Error(`ElevenLabs answered ${r.status}`);
          ctx.send(ws, { t: "ttsAudio", id, audio: Buffer.from(await r.arrayBuffer()).toString("base64") });
        } catch (e) {
          ctx.send(ws, { t: "ttsAudio", id, error: e instanceof Error ? e.message : String(e) });
        }
      })();
    },
  };
}
