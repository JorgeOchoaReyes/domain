import { parentPort, workerData } from "node:worker_threads";

/**
 * The voice model, in a thread of its own so the office never waits on it:
 * loads Whisper (transformers.js on onnxruntime-node) the first time it's
 * asked, downloading it once into the models folder, then turns 16 kHz
 * audio into text, one recording at a time. See whisper.ts.
 */

interface Data {
  model: string;
  dtype: string;
  cacheDir: string;
  /** The model's files are all here already: don't touch the network. */
  offline: boolean;
  /** Whisper's language for a multilingual model ("" lets it tell). */
  language: string;
}

type Asr = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;

const data = workerData as Data;
const port = parentPort!;
let asr: Promise<Asr> | null = null;

async function load(): Promise<Asr> {
  const t0 = Date.now();
  let tf: typeof import("@huggingface/transformers");
  try {
    tf = await import("@huggingface/transformers");
  } catch (e) {
    // transformers.js or onnxruntime can't run on this computer: no point trying again.
    throw Object.assign(new Error(`The voice engine can't run here (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`), { fatal: true });
  }
  tf.env.cacheDir = data.cacheDir;
  tf.env.allowLocalModels = false;
  let lastSent = 0;
  const make = (offline: boolean) => {
    tf.env.allowRemoteModels = !offline;
    return tf.pipeline("automatic-speech-recognition", data.model, {
      dtype: data.dtype as "q8",
      device: "cpu",
      progress_callback: (p: { status: string; loaded?: number; total?: number }) => {
        if (p.status !== "progress_total" || !p.total) return;
        const now = Date.now();
        if (now - lastSent < 250 && (p.loaded ?? 0) < p.total) return;
        lastSent = now;
        // Files already here count as loaded at once; only a real download is news.
        port.postMessage({ type: "progress", loaded: p.loaded ?? 0, total: p.total });
      },
    });
  };
  let pipe;
  try {
    pipe = await make(data.offline);
  } catch (e) {
    // Something's missing after all: fetch it.
    if (!data.offline) throw e;
    pipe = await make(false);
  }
  port.postMessage({ type: "ready", ms: Date.now() - t0 });
  return pipe as unknown as Asr;
}

const fail = (id: number, e: unknown, fatal = false) => port.postMessage({ id, error: e instanceof Error ? e.message : String(e), fatal });

port.on("message", async (m: { id: number; type: "load" } | { id: number; type: "run"; pcm: Float32Array }) => {
  let run: Asr;
  try {
    asr ??= load();
    run = await asr;
  } catch (e) {
    // Couldn't load (no network for the first download, say): the next try starts over.
    asr = null;
    return fail(m.id, e, (e as { fatal?: boolean })?.fatal === true);
  }
  if (m.type === "load") return port.postMessage({ id: m.id, text: "" });
  try {
    const opts: Record<string, unknown> = {};
    if (!/\.en$/.test(data.model)) {
      opts.task = "transcribe";
      if (data.language) opts.language = data.language;
    }
    // Past Whisper's 30-second window: in overlapping pieces.
    if (m.pcm.length > 30 * 16_000) Object.assign(opts, { chunk_length_s: 30, stride_length_s: 5 });
    const t0 = Date.now();
    const out = await run(m.pcm, opts);
    const text = Array.isArray(out) ? out.map((o) => o.text).join(" ") : out.text;
    port.postMessage({ id: m.id, text, ms: Date.now() - t0 });
  } catch (e) {
    fail(m.id, e);
  }
});
