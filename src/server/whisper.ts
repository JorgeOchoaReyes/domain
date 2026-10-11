import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { WebSocket } from "ws";
import type { Routes, ServerCtx } from "./ctx.js";
import { DEFAULT_WHISPER_MODEL, checkPcm, cleanTranscript, int16ToFloat, pcmFromBytes, type WhisperState } from "../shared/voice.js";

/**
 * Speech to text on this computer: the 🎤 button records you and sends the
 * audio here, and Whisper (transformers.js on onnxruntime — no compiler, no
 * GPU, no account) turns it into words. Free and private, like a local
 * model: the audio never leaves the computer, and after the model's one
 * download (≈80 MB, into ~/.domain/models, shared by the desktop app and
 * the dev server) it works offline.
 *
 * The model runs in a worker thread, so the office never waits on it; it's
 * loaded the first time someone talks (or Settings → Voice → Download now),
 * and let go again after a while unused. One recording at a time each.
 */

/** The size of the default model's download (quantized), to say before it starts. */
const KNOWN_BYTES: Record<string, number> = {
  "onnx-community/whisper-base.en|q8": 79_586_556,
  "onnx-community/whisper-base|q8": 79_600_000,
  "onnx-community/whisper-tiny.en|q8": 41_000_000,
  "onnx-community/whisper-tiny|q8": 41_000_000,
};

/** Unused this long, the model's let go (it loads again in a second or two). */
const IDLE_MS = 10 * 60_000;

export interface WhisperConfig {
  model: string;
  dtype: string;
  cacheDir: string;
  language: string;
}

export function whisperConfig(env: NodeJS.ProcessEnv = process.env): WhisperConfig {
  return {
    model: env.DOMAIN_WHISPER_MODEL?.trim() || DEFAULT_WHISPER_MODEL,
    dtype: env.DOMAIN_WHISPER_DTYPE?.trim() || "q8",
    cacheDir: env.DOMAIN_MODELS?.trim() || join(homedir(), ".domain", "models"),
    language: env.DOMAIN_WHISPER_LANG?.trim() || "",
  };
}

/** The ONNX file suffix transformers.js uses for each dtype. */
const SUFFIX: Record<string, string> = { fp32: "", fp16: "_fp16", q8: "_quantized", int8: "_int8", uint8: "_uint8", q4: "_q4", q4f16: "_q4f16", bnb4: "_bnb4" };

/** Whether the model's files are all in the models folder already. */
export function modelOnDisk(c: WhisperConfig): boolean {
  const dir = join(c.cacheDir, ...c.model.split("/"));
  const sfx = SUFFIX[c.dtype] ?? "_quantized";
  return ["config.json", "tokenizer.json", "preprocessor_config.json", `onnx/encoder_model${sfx}.onnx`, `onnx/decoder_model_merged${sfx}.onnx`].every((f) => existsSync(join(dir, f)));
}

function bytesOnDisk(dir: string): number {
  let n = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? bytesOnDisk(join(dir, e.name)) : statSync(join(dir, e.name)).size;
  } catch {
    /* not there */
  }
  return n;
}

/** The part of a worker thread this uses (tests stand in for it). */
export interface WorkerLike {
  postMessage(m: unknown, transfer?: ArrayBuffer[]): void;
  on(e: "message", f: (m: WorkerReply) => void): unknown;
  on(e: "error" | "exit", f: (x: unknown) => void): unknown;
  terminate(): unknown;
}

export type WorkerReply =
  | { type: "progress"; loaded: number; total: number }
  | { type: "ready"; ms: number }
  | { id: number; text: string; ms?: number }
  | { id: number; error: string; fatal: boolean };

const here = dirname(fileURLToPath(import.meta.url));

/** The worker thread, built (dist) or from source (tsx, which carries over into workers). */
function realWorker(c: WhisperConfig, offline: boolean): WorkerLike {
  const js = join(here, "whisperWorker.js");
  const file = existsSync(js) ? js : join(here, "whisperWorker.ts");
  const w = new Worker(file, { workerData: { ...c, offline } });
  // Never what keeps the office running when it's closing.
  w.unref();
  return w as unknown as WorkerLike;
}

export interface TranscriberDeps {
  config: WhisperConfig;
  spawn?: (c: WhisperConfig, offline: boolean) => WorkerLike;
  onDisk?: (c: WhisperConfig) => boolean;
  idleMs?: number;
  /** Timings, for the log. */
  onTiming?: (what: "load" | "run", ms: number) => void;
}

/** One Whisper, loaded on demand, its state for the 🎤 buttons and Settings. */
export class Transcriber {
  private worker: WorkerLike | null = null;
  private seq = 0;
  private waiting = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>();
  private idle: ReturnType<typeof setTimeout> | null = null;
  private s: WhisperState;
  private c: WhisperConfig;
  /** Run when the state changes (downloading, ready, failed…). */
  onState: (s: WhisperState) => void = () => {};

  constructor(private deps: TranscriberDeps) {
    this.c = deps.config;
    const onDisk = (deps.onDisk ?? modelOnDisk)(this.c);
    const bytes = onDisk ? bytesOnDisk(join(this.c.cacheDir, ...this.c.model.split("/"))) : KNOWN_BYTES[`${this.c.model}|${this.c.dtype}`];
    this.s = { model: this.c.model, status: onDisk ? "ready" : "absent", ...(bytes ? { bytes } : {}) };
  }

  get state(): WhisperState {
    return { ...this.s };
  }

  private set(patch: Partial<WhisperState>): void {
    const next = { ...this.s, ...patch };
    for (const k of Object.keys(next) as (keyof WhisperState)[]) if (next[k] === undefined) delete next[k];
    this.s = next;
    this.onState(this.state);
  }

  private start(): WorkerLike {
    if (this.worker) return this.worker;
    const onDisk = (this.deps.onDisk ?? modelOnDisk)(this.c);
    if (!onDisk) this.set({ status: "downloading", progress: 0, error: undefined });
    const w = (this.deps.spawn ?? realWorker)(this.c, onDisk);
    this.worker = w;
    w.on("message", (m: WorkerReply) => {
      if ("type" in m) {
        if (m.type === "progress" && this.s.status === "downloading") this.set({ bytes: m.total, progress: Math.min(1, m.loaded / m.total) });
        if (m.type === "ready") {
          this.deps.onTiming?.("load", m.ms);
          this.set({ status: "ready", progress: undefined, error: undefined, bytes: this.s.bytes });
        }
        return;
      }
      const p = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      if ("error" in m) {
        if (m.fatal) this.set({ status: "failed", error: m.error, progress: undefined });
        else if (this.s.status === "downloading") this.set({ status: "absent", error: m.error, progress: undefined });
        p?.reject(new Error(m.error));
      } else {
        if (m.ms !== undefined) this.deps.onTiming?.("run", m.ms);
        p?.resolve(m.text);
      }
    });
    const gone = (why: unknown) => {
      if (this.worker !== w) return;
      this.worker = null;
      const err = new Error(why instanceof Error ? why.message : "the voice model stopped");
      for (const p of this.waiting.values()) p.reject(err);
      this.waiting.clear();
      if (this.s.status === "downloading") this.set({ status: "absent", progress: undefined, error: err.message });
    };
    w.on("error", gone);
    w.on("exit", gone);
    return w;
  }

  private ask(m: { type: "load" } | { type: "run"; pcm: Float32Array }): Promise<string> {
    if (this.s.status === "failed") return Promise.reject(new Error(this.s.error ?? "the voice model can't run here"));
    const w = this.start();
    const id = ++this.seq;
    this.touch();
    return new Promise<string>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      if (m.type === "run") w.postMessage({ id, ...m }, [m.pcm.buffer as ArrayBuffer]);
      else w.postMessage({ id, ...m });
    }).finally(() => this.touch());
  }

  /** Let go of the model after a while unused (the files stay). */
  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (this.waiting.size) return this.touch();
      this.stop();
    }, this.deps.idleMs ?? IDLE_MS);
    (this.idle as { unref?: () => void }).unref?.();
  }

  /** Download (once) and load the model. */
  prepare(): Promise<void> {
    return this.ask({ type: "load" }).then(() => undefined);
  }

  /** 16 kHz mono samples to words. */
  async transcribe(pcm: Float32Array): Promise<string> {
    return cleanTranscript(await this.ask({ type: "run", pcm }));
  }

  stop(): void {
    const w = this.worker;
    this.worker = null;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    for (const p of this.waiting.values()) p.reject(new Error("stopped"));
    this.waiting.clear();
    if (w) void w.terminate();
  }
}

/**
 * The 🎤's messages: "transcribe" (audio in, words back as "transcribed"),
 * "whisperGet" (how the model is), "whisperPrepare" (download it now).
 * Visitors can't transcribe (permissions.ts); everyone hears how the model is.
 */
export function whisperModule(ctx: ServerCtx, t: Transcriber = new Transcriber({ config: whisperConfig(), onTiming: (what, ms) => console.log(`[voice] Whisper ${what === "load" ? "loaded" : "transcribed"} in ${ms} ms`) })): Routes {
  const busy = new WeakSet<WebSocket>();
  t.onState = (state) => ctx.broadcast({ t: "whisper", state });
  const str = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
  return {
    whisperGet: (_m, _c, ws) => ctx.send(ws, { t: "whisper", state: t.state }),
    whisperPrepare: (_m, _c, ws) => {
      t.prepare().catch(() => ctx.send(ws, { t: "whisper", state: t.state }));
    },
    transcribe: (msg, _client, ws) => {
      const id = str(msg.id, 40);
      if (!id) return;
      const why = checkPcm(msg.pcm);
      if (why) return ctx.send(ws, { t: "transcribed", id, error: why });
      if (busy.has(ws)) return ctx.send(ws, { t: "transcribed", id, error: "one recording at a time" });
      busy.add(ws);
      const pcm = int16ToFloat(pcmFromBytes(Buffer.from(msg.pcm as string, "base64")));
      t.transcribe(pcm)
        .then((text) => ctx.send(ws, { t: "transcribed", id, text }))
        .catch((e: unknown) => ctx.send(ws, { t: "transcribed", id, error: e instanceof Error ? e.message : String(e), ...(t.state.status === "failed" ? { fallback: true } : {}) }))
        .finally(() => busy.delete(ws));
    },
  };
}
