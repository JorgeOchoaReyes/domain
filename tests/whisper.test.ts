import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_PCM_BYTES,
  SAMPLE_RATE,
  SilenceDetector,
  checkPcm,
  cleanTranscript,
  concatFloat,
  fallbackEngine,
  floatToInt16,
  insertAt,
  int16ToFloat,
  pcmBytes,
  pcmFromBytes,
  pickEngine,
  resample,
  rms,
  sizeLabel,
  type VoiceCaps,
} from "../src/shared/voice.ts";
import { Transcriber, modelOnDisk, whisperConfig, whisperModule, type WorkerLike, type WorkerReply } from "../src/server/whisper.ts";
import { allowed } from "../src/server/permissions.ts";
import type { ServerMessage } from "../src/shared/protocol.ts";
import type { ServerCtx } from "../src/server/ctx.ts";

test("PCM: float ↔ 16-bit, and bytes on the wire are little-endian", () => {
  const f = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]);
  const p = floatToInt16(f);
  assert.deepEqual([...p], [0, 16384, -16384, 32767, -32768, 32767, -32768], "clipped at full scale");
  const back = int16ToFloat(p);
  assert.ok(Math.abs(back[1] - 0.5) < 1e-4 && Math.abs(back[2] + 0.5) < 1e-4);
  const bytes = pcmBytes(new Int16Array([1, -2, 0x1234]));
  assert.deepEqual([...bytes], [1, 0, 0xfe, 0xff, 0x34, 0x12]);
  assert.deepEqual([...pcmFromBytes(bytes)], [1, -2, 0x1234]);
  assert.deepEqual([...pcmFromBytes(new Uint8Array([1, 0, 9]))], [1], "an odd last byte is dropped");
  // Through base64 like the socket carries it.
  const b64 = Buffer.from(pcmBytes(floatToInt16(f))).toString("base64");
  assert.deepEqual([...pcmFromBytes(Buffer.from(b64, "base64"))], [...p]);
  assert.deepEqual([...concatFloat([new Float32Array([1, 2]), new Float32Array([3])])], [1, 2, 3]);
});

test("resampling to 16 kHz keeps the length, the level and the tone", () => {
  const rate = 48_000;
  const sine = new Float32Array(rate).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate));
  const down = resample(sine, rate, SAMPLE_RATE);
  assert.equal(down.length, SAMPLE_RATE);
  assert.ok(Math.abs(rms(down) - rms(sine)) < 0.01, `level kept (${rms(down)} vs ${rms(sine)})`);
  // Still 440 Hz: count the zero crossings in one second (2 per cycle).
  let crossings = 0;
  for (let i = 1; i < down.length; i++) if (down[i - 1] < 0 !== down[i] < 0) crossings++;
  assert.ok(Math.abs(crossings - 880) <= 2, `${crossings} crossings`);
  const dc = resample(new Float32Array(44_100).fill(0.25), 44_100, SAMPLE_RATE);
  assert.ok(dc.every((v) => Math.abs(v - 0.25) < 1e-6), "44.1 kHz (an odd ratio) works too");
  const up = resample(new Float32Array([0, 1]), 8000, SAMPLE_RATE);
  assert.deepEqual([...up], [0, 0.5, 1, 1]);
  assert.equal(resample(sine, SAMPLE_RATE, SAMPLE_RATE).length, sine.length);
  assert.equal(rms(new Float32Array()), 0);
});

test("silence detection: a pause after speech ends it; noise, a click, or nothing doesn't", () => {
  const run = (frames: [number, number][]) => {
    const d = new SilenceDetector();
    let at = 0;
    for (const [level, ms] of frames) {
      for (let t = 0; t < ms; t += 100) {
        at += 100;
        const v = d.feed(level, 100);
        if (v !== "listen") return { v, at };
      }
    }
    return { v: "listen", at };
  };
  // Talking from the very first moment still counts as talking.
  assert.equal(run([[0.08, 2000], [0.003, 3000]]).v, "done");
  // A second of quiet room, two seconds of talking, then quiet: stops ~1.2 s into the quiet.
  const talk = run([[0.003, 1000], [0.08, 2000], [0.003, 5000]]);
  assert.equal(talk.v, "done");
  assert.ok(talk.at >= 4200 && talk.at <= 4300, `stopped at ${talk.at} ms`);
  // A short pause mid-sentence doesn't end it.
  assert.equal(run([[0.08, 1000], [0.003, 800], [0.08, 1000]]).v, "listen");
  // A click (100 ms) isn't speech: nobody talked, so it gives up after 8 s.
  const click = run([[0.003, 500], [0.2, 100], [0.003, 9000]]);
  assert.equal(click.v, "nothing");
  assert.equal(click.at, 8000);
  // Steady fan noise above the fixed threshold is the room, not you.
  assert.equal(run([[0.03, 9000]]).v, "nothing");
  // Talking on and on (syllables, the odd dip between words) hits the hard cap at a minute.
  const long = run(Array.from({ length: 320 }, (_, i): [number, number] => (i % 2 ? [0.004, 100] : [0.08, 300])));
  assert.deepEqual(long, { v: "max", at: 60_000 });
});

test("a transcribe request is checked: base64 of whole samples, half a second to a minute", () => {
  const b64 = (bytes: number) => Buffer.alloc(bytes).toString("base64");
  assert.equal(checkPcm(b64(SAMPLE_RATE * 2)), "");
  assert.equal(checkPcm(b64(MAX_PCM_BYTES)), "", "exactly a minute is fine");
  assert.match(checkPcm(b64(MAX_PCM_BYTES + 6)), /at most 60 seconds/);
  assert.match(checkPcm(b64(100)), /too short/);
  assert.match(checkPcm(b64(SAMPLE_RATE + 1)), /not audio/, "an odd number of bytes isn't 16-bit");
  assert.match(checkPcm("not base64!!"), /not audio/);
  assert.match(checkPcm(""), /nothing/);
  assert.match(checkPcm(42), /nothing/);
});

test("which way the 🎤 hears you: your choice if it can work here, else the fallback", () => {
  const browser: VoiceCaps = { desktop: false, webSpeech: true, record: true, osDictation: false, whisper: "absent" };
  const app: VoiceCaps = { desktop: true, webSpeech: true, record: true, osDictation: true, whisper: "ready" };
  assert.equal(pickEngine("whisper", browser), "whisper", "a model not downloaded yet still counts (it downloads)");
  assert.equal(pickEngine("whisper", app), "whisper");
  assert.equal(pickEngine("whisper", { ...app, whisper: "unknown" }), "whisper");
  // Whisper can't run on the server: the desktop app uses the OS's dictation, a browser its own.
  assert.equal(pickEngine("whisper", { ...app, whisper: "failed" }), "system");
  assert.equal(pickEngine("whisper", { ...browser, whisper: "failed" }), "browser");
  assert.equal(pickEngine("whisper", { ...browser, whisperRefused: true }), "browser", "a visitor");
  assert.equal(pickEngine("whisper", { ...browser, record: false }), "browser", "no microphone API (or blocked)");
  // The browser's recognition never in the desktop app (no speech service there).
  assert.equal(pickEngine("browser", app), "system");
  assert.equal(pickEngine("browser", browser), "browser");
  assert.equal(pickEngine("system", browser), "browser", "no OS dictation in a browser");
  assert.equal(pickEngine("system", app), "system");
  assert.equal(pickEngine("system", { ...app, osDictation: false }), "whisper", "Linux desktop app");
  assert.equal(pickEngine("whisper", { desktop: false, webSpeech: false, record: false, osDictation: false, whisper: "failed" }), null);
  assert.equal(fallbackEngine({ ...app, osDictation: false, whisper: "failed" }, "whisper"), null, "Linux app, no Whisper: nothing (the box says how)");
  assert.equal(fallbackEngine(browser, "whisper"), "browser");
});

test("dictated words go in at the caret, spaced, and Whisper's noise words are dropped", () => {
  assert.deepEqual(insertAt("", 0, 0, "Hello"), { value: "Hello", caret: 5 });
  assert.deepEqual(insertAt("Fix it", 6, 6, "today"), { value: "Fix it today", caret: 12 });
  assert.deepEqual(insertAt("Fix  bug", 4, 4, "the login"), { value: "Fix the login bug", caret: 13 });
  assert.deepEqual(insertAt("Fix XX bug", 4, 6, "the"), { value: "Fix the bug", caret: 7 }, "replaces a selection");
  assert.deepEqual(insertAt("Done.", 4, 4, "now"), { value: "Done now.", caret: 8 }, "no space before punctuation");
  assert.deepEqual(insertAt("abc", 99, 99, "d"), { value: "abc d", caret: 5 });
  assert.equal(insertAt("abc", 1, 1, "").value, "abc");
  assert.equal(cleanTranscript(" Add a dark mode toggle."), "Add a dark mode toggle.");
  assert.equal(cleanTranscript(" [BLANK_AUDIO]"), "");
  assert.equal(cleanTranscript("(music) Hi  there [Music]"), "Hi there");
  assert.equal(sizeLabel(79_586_556), "≈80 MB");
  assert.equal(sizeLabel(1_500_000_000), "≈1.5 GB");
  assert.equal(sizeLabel(undefined), "");
});

/** A stand-in for the Whisper worker thread. */
class FakeWorker extends EventEmitter implements WorkerLike {
  posted: { id: number; type: string; pcm?: Float32Array }[] = [];
  terminated = false;
  constructor(private script: (w: FakeWorker, m: { id: number; type: string; pcm?: Float32Array }) => void) {
    super();
  }
  postMessage(m: unknown): void {
    const msg = m as { id: number; type: string };
    this.posted.push(msg);
    setImmediate(() => this.script(this, msg));
  }
  reply(r: WorkerReply): void {
    this.emit("message", r);
  }
  terminate(): void {
    this.terminated = true;
    this.emit("exit", 0);
  }
}

const config = { model: "onnx-community/whisper-base.en", dtype: "q8", cacheDir: "/nowhere", language: "" };

test("the model downloads once (with progress), then transcribes; the model loads only when needed", async () => {
  const spawned: { w: FakeWorker; offline: boolean }[] = [];
  let onDisk = false;
  const t = new Transcriber({
    config,
    onDisk: () => onDisk,
    spawn: (_c, offline) => {
      const w = new FakeWorker((w, m) => {
        if (!offline) {
          w.reply({ type: "progress", loaded: 40e6, total: 80e6 });
          w.reply({ type: "progress", loaded: 80e6, total: 80e6 });
        }
        w.reply({ type: "ready", ms: 5 });
        w.reply({ id: m.id, text: m.type === "run" ? ` Add a dark mode toggle. [BLANK_AUDIO]` : "" });
      });
      spawned.push({ w, offline });
      return w;
    },
  });
  assert.equal(t.state.status, "absent");
  assert.equal(t.state.bytes, 79_586_556, "the size is known before the download");
  const states: string[] = [];
  t.onState = (s) => states.push(`${s.status}${s.progress !== undefined ? ` ${Math.round(s.progress * 100)}%` : ""}`);
  assert.equal(spawned.length, 0, "nothing loaded until someone talks");
  const text = await t.transcribe(new Float32Array(SAMPLE_RATE));
  assert.equal(text, "Add a dark mode toggle.");
  assert.deepEqual(states, ["downloading 0%", "downloading 50%", "downloading 100%", "ready"]);
  assert.equal(spawned[0].offline, false);
  assert.equal(spawned[0].w.posted[0].pcm?.length, SAMPLE_RATE);
  assert.equal(await t.transcribe(new Float32Array(SAMPLE_RATE)), "Add a dark mode toggle.");
  assert.equal(spawned.length, 1, "one worker, kept loaded");
  t.stop();
  assert.equal(spawned[0].w.terminated, true);
  // Next time the files are there: no network at all.
  onDisk = true;
  await t.prepare();
  assert.equal(spawned[1].offline, true);
  t.stop();
});

test("an engine that can't run here fails for good (so the 🎤 falls back); a failed download can be retried", async () => {
  let mode: "fatal" | "network" | "ok" = "network";
  const t = new Transcriber({
    config,
    onDisk: () => false,
    spawn: () =>
      new FakeWorker((w, m) => {
        if (mode === "ok") return w.reply({ id: m.id, text: "hi" });
        w.reply({ id: m.id, error: mode === "fatal" ? "The voice engine can't run here (no onnxruntime)" : "fetch failed", fatal: mode === "fatal" });
      }),
  });
  await assert.rejects(t.transcribe(new Float32Array(10)), /fetch failed/);
  assert.equal(t.state.status, "absent", "no network: still to download, not broken");
  assert.equal(t.state.error, "fetch failed");
  mode = "ok";
  assert.equal(await t.transcribe(new Float32Array(10)), "hi");
  t.stop();

  mode = "fatal";
  const broken = new Transcriber({ config, onDisk: () => true, spawn: () => new FakeWorker((w, m) => w.reply({ id: m.id, error: "The voice engine can't run here (no onnxruntime)", fatal: true })) });
  await assert.rejects(broken.transcribe(new Float32Array(10)), /can't run here/);
  assert.equal(broken.state.status, "failed");
  await assert.rejects(broken.transcribe(new Float32Array(10)), /can't run here/, "and it doesn't try again");
});

test("a worker that dies mid-way answers what was waiting, and the next one starts fresh; idle, the model is let go", async () => {
  const workers: FakeWorker[] = [];
  const t = new Transcriber({
    config,
    onDisk: () => true,
    idleMs: 30,
    spawn: () => {
      const w = new FakeWorker((w, m) => (workers.length > 1 ? w.reply({ id: m.id, text: "again" }) : undefined));
      workers.push(w);
      return w;
    },
  });
  const waiting = t.transcribe(new Float32Array(10));
  await new Promise((r) => setImmediate(r));
  workers[0].emit("exit", 1);
  await assert.rejects(waiting, /stopped/);
  assert.equal(await t.transcribe(new Float32Array(10)), "again");
  assert.equal(workers.length, 2);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(workers[1].terminated, true, "let go after a while unused");
});

test("the server's routes: one recording at a time each, payloads capped, the model's state for everyone", async () => {
  const sent: { to: unknown; m: ServerMessage }[] = [];
  const ctx = { send: (ws: unknown, m: ServerMessage) => sent.push({ to: ws, m }), broadcast: (m: ServerMessage) => sent.push({ to: "all", m }) } as unknown as ServerCtx;
  let release: () => void = () => {};
  let fail = false;
  const t = new Transcriber({
    config,
    onDisk: () => true,
    spawn: () =>
      new FakeWorker((w, m) => {
        if (m.type !== "run") return w.reply({ id: m.id, text: "" });
        if (fail) return w.reply({ id: m.id, error: "The voice engine can't run here", fatal: true });
        release = () => w.reply({ id: m.id, text: ` heard ${m.pcm!.length} samples` });
      }),
  });
  const routes = whisperModule(ctx, t);
  const a = {} as never;
  const b = {} as never;
  const pcm = Buffer.from(pcmBytes(floatToInt16(new Float32Array(SAMPLE_RATE).fill(0.1)))).toString("base64");
  const settle = () => new Promise((r) => setTimeout(r, 10));

  routes.whisperGet!({ t: "whisperGet" } as never, {} as never, a);
  assert.deepEqual(sent.pop()?.m, { t: "whisper", state: { model: config.model, status: "ready" } });

  routes.transcribe!({ t: "transcribe", id: "x".repeat(41), pcm } as never, {} as never, a);
  assert.equal(sent.length, 0, "a bad id is ignored");
  routes.transcribe!({ t: "transcribe", id: "big", pcm: Buffer.alloc(MAX_PCM_BYTES + 2).toString("base64") } as never, {} as never, a);
  assert.match((sent.pop()?.m as { error?: string }).error ?? "", /at most 60 seconds/);

  routes.transcribe!({ t: "transcribe", id: "1", pcm } as never, {} as never, a);
  routes.transcribe!({ t: "transcribe", id: "2", pcm } as never, {} as never, a);
  assert.deepEqual(sent.pop(), { to: a, m: { t: "transcribed", id: "2", error: "one recording at a time" } });
  await settle();
  release();
  await settle();
  assert.deepEqual(sent.pop(), { to: a, m: { t: "transcribed", id: "1", text: `heard ${SAMPLE_RATE} samples` } });
  // Someone else meanwhile isn't held up by your recording's slot.
  routes.transcribe!({ t: "transcribe", id: "3", pcm } as never, {} as never, b);
  await settle();
  release();
  await settle();
  assert.equal((sent.pop()?.m as { id?: string }).id, "3");

  fail = true;
  routes.transcribe!({ t: "transcribe", id: "4", pcm } as never, {} as never, a);
  await settle();
  const failed = sent.filter((s) => s.m.t === "transcribed").pop()!.m as { error?: string; fallback?: boolean };
  assert.equal(failed.fallback, true, "the 🎤 is told to use another way");
  assert.ok(sent.some((s) => s.to === "all" && s.m.t === "whisper" && s.m.state.status === "failed"), "everyone hears the model can't run");
  t.stop();
});

test("who may use the voice model: host and teammates talk, visitors don't; only the host downloads it from Settings", () => {
  assert.equal(allowed("host", "transcribe"), true);
  assert.equal(allowed("teammate", "transcribe"), true);
  assert.equal(allowed("visitor", "transcribe"), false);
  assert.equal(allowed("visitor", "whisperGet"), true);
  assert.equal(allowed("teammate", "whisperPrepare"), false);
  assert.equal(allowed("host", "whisperPrepare"), true);
});

test("the model's folder and name: ~/.domain/models by default, overridable, and found on disk", () => {
  const c = whisperConfig({});
  assert.equal(c.model, "onnx-community/whisper-base.en");
  assert.equal(c.dtype, "q8");
  assert.match(c.cacheDir, /\.domain[\\/]models$/);
  const o = whisperConfig({ DOMAIN_WHISPER_MODEL: "onnx-community/whisper-base", DOMAIN_MODELS: "/m", DOMAIN_WHISPER_LANG: "es", DOMAIN_WHISPER_DTYPE: "fp32" });
  assert.deepEqual(o, { model: "onnx-community/whisper-base", dtype: "fp32", cacheDir: "/m", language: "es" });

  const dir = mkdtempSync(join(tmpdir(), "models-"));
  const cfg = { ...c, cacheDir: dir };
  assert.equal(modelOnDisk(cfg), false);
  const m = join(dir, "onnx-community", "whisper-base.en");
  mkdirSync(join(m, "onnx"), { recursive: true });
  for (const f of ["config.json", "tokenizer.json", "preprocessor_config.json", "onnx/encoder_model_quantized.onnx"]) writeFileSync(join(m, f), "x");
  assert.equal(modelOnDisk(cfg), false, "half a download isn't the model");
  writeFileSync(join(m, "onnx/decoder_model_merged_quantized.onnx"), "x");
  assert.equal(modelOnDisk(cfg), true);
  assert.equal(new Transcriber({ config: cfg }).state.bytes, 5, "the size on disk, once it's there");
});
