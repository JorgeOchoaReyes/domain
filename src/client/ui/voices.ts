import type { ClientMessage } from "../../shared/protocol.js";
import { elevenAuto, elevenState, setElevenAuto, speak, stopSpeaking, watchVoices } from "../voice.js";
import { esc, openModal } from "./modal.js";

/**
 * Voices: set up ElevenLabs (your API key, kept on this computer), choose
 * whether every worker without a voice of its own uses it, and hear the
 * voices. A character's own voice is picked in Your team.
 */
export function openVoices(send: (m: ClientMessage) => void, isHost: boolean): void {
  send({ t: "voicesGet" });
  const body = document.createElement("div");
  body.className = "voices";
  let saving = false;
  const render = () => {
    const s = elevenState();
    const status = saving
      ? "⏳ Checking the key…"
      : s.on
        ? `✅ Connected — ${s.voices.length} voice${s.voices.length === 1 ? "" : "s"}`
        : s.error
          ? `⚠️ ${esc(s.error)}`
          : "Not set up — workers use this computer's voices.";
    body.innerHTML = `
      <p class="ls-intro">Give workers lifelike voices with <b>ElevenLabs</b>. Paste your API key (elevenlabs.io → Profile → API keys). It stays on this computer, in <code>~/.domain/elevenlabs.json</code> — never in a project — and only this computer talks to ElevenLabs. Speech uses your ElevenLabs credits.</p>
      ${
        isHost
          ? `<form class="vc-key"><input type="password" autocomplete="off" spellcheck="false" placeholder="${s.on ? "•••••••• (saved) — paste a new key to replace it" : "sk_…"}" /><button class="btn primary" type="submit">Save</button>${s.on ? `<button class="btn vc-remove" type="button">Remove</button>` : ""}</form>`
          : `<p class="st-hint">Only the office's host can set the key.</p>`
      }
      <p class="vc-status">${status}</p>
      ${
        s.on
          ? `<label class="st-check"><input type="checkbox" class="vc-auto" ${elevenAuto() ? "checked" : ""} /> 🗣 Workers without a voice of their own use ElevenLabs too</label>
             <p class="st-hint">To give a character its own ElevenLabs voice, pick it in <b>Your team</b>.</p>
             <ul class="vc-list">${s.voices
               .map((v) => `<li><button class="btn small vc-play" data-id="${esc(v.id)}" title="Hear it">▶</button> <b>${esc(v.name)}</b> <span class="as-hint">${esc(v.about)}</span></li>`)
               .join("")}</ul>`
          : ""
      }`;
    const form = body.querySelector<HTMLFormElement>(".vc-key");
    form?.addEventListener("submit", (e) => {
      e.preventDefault();
      const key = form.querySelector("input")!.value.trim();
      if (!key) return;
      saving = true;
      send({ t: "voicesKey", key });
      render();
    });
    body.querySelector(".vc-remove")?.addEventListener("click", () => {
      saving = true;
      send({ t: "voicesKey", key: "" });
      render();
    });
    body.querySelector<HTMLInputElement>(".vc-auto")?.addEventListener("change", (e) => setElevenAuto((e.target as HTMLInputElement).checked));
    body.querySelectorAll<HTMLButtonElement>(".vc-play").forEach((b) =>
      b.addEventListener("click", () => {
        const v = s.voices.find((x) => x.id === b.dataset.id);
        speak(`Hi, I'm ${v?.name ?? "a new voice"}. Ready when you are!`, "claude", undefined, `el:${b.dataset.id}`);
      }),
    );
  };
  watchVoices(() => {
    saving = false;
    render();
  });
  openModal({
    title: "Voices",
    icon: "🗣",
    className: "voices-modal",
    body,
    onClose: () => {
      watchVoices(null);
      stopSpeaking();
    },
  });
  render();
}
