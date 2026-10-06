import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "../src/shared/protocol.ts";
import type { ServerCtx } from "../src/server/ctx.ts";
import { loadKey, parseVoices, voicesModule } from "../src/server/voices.ts";

const VOICES = { voices: [{ voice_id: "abc123", name: "Rachel", labels: { gender: "female", accent: "american" } }, { voice_id: "zz9", name: "Adam" }, { bad: true }] };

test("ElevenLabs voices: trimmed and sorted for the pickers", () => {
  assert.deepEqual(parseVoices(VOICES), [
    { id: "zz9", name: "Adam", about: "" },
    { id: "abc123", name: "Rachel", about: "female, american" },
  ]);
  assert.deepEqual(parseVoices({}), []);
});

test("the key is kept outside the project, speech comes back over the socket, and nothing works without a key", async () => {
  const home = mkdtempSync(join(tmpdir(), "voices-"));
  const env = { DOMAIN_PREFS: join(home, "prefs.json") };
  const sent: ServerMessage[] = [];
  const calls: { url: string; key: string | null }[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    const key = new Headers(init?.headers).get("xi-api-key");
    calls.push({ url, key });
    if (key !== "sk_good") return new Response("no", { status: 401 });
    if (url.endsWith("/voices")) return Response.json(VOICES);
    return new Response(new Uint8Array([1, 2, 3]));
  }) as typeof fetch;
  const ctx = { send: (_ws: unknown, m: ServerMessage) => sent.push(m), broadcast: (m: ServerMessage) => sent.push(m), log: { start: () => ({ done: () => {} }) } } as unknown as ServerCtx;
  const routes = voicesModule(ctx, env, fake);
  const ws = {} as never;
  const client = {} as never;
  const until = async (pred: () => boolean) => {
    for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 5));
  };

  routes.tts!({ t: "tts", id: "1", text: "hi", voice: "abc123" } as never, client, ws);
  assert.deepEqual(sent.pop(), { t: "ttsAudio", id: "1", error: "no ElevenLabs key" });

  routes.voicesKey!({ t: "voicesKey", key: "sk_bad" } as never, client, ws);
  await until(() => sent.some((m) => m.t === "voices"));
  const bad = sent.pop() as Extract<ServerMessage, { t: "voices" }>;
  assert.equal(bad.state.on, false);
  assert.match(bad.state.error ?? "", /didn't accept/);

  routes.voicesKey!({ t: "voicesKey", key: "sk_good" } as never, client, ws);
  await until(() => sent.some((m) => m.t === "voices"));
  const good = sent.pop() as Extract<ServerMessage, { t: "voices" }>;
  assert.equal(good.state.on, true);
  assert.equal(good.state.voices.length, 2);
  assert.equal(loadKey(env), "sk_good");
  assert.match(readFileSync(join(home, "elevenlabs.json"), "utf8"), /sk_good/);

  routes.tts!({ t: "tts", id: "2", text: "Hello there", voice: "abc123" } as never, client, ws);
  await until(() => sent.some((m) => m.t === "ttsAudio"));
  assert.deepEqual(sent.pop(), { t: "ttsAudio", id: "2", audio: Buffer.from([1, 2, 3]).toString("base64") });
  assert.match(calls.at(-1)!.url, /text-to-speech\/abc123/);

  routes.tts!({ t: "tts", id: "3", text: "x", voice: "../../etc" } as never, client, ws);
  assert.equal((sent.pop() as { error?: string }).error, "nothing to say", "a bad voice id never reaches the API");
});
