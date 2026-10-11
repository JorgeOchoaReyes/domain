// The office's own speech to text, on a WAV file: the same Whisper the 🎤 uses (worker
// thread, model in ~/.domain/models — downloaded the first time), with how long it took.
//
//   npx tsx scripts/voice/transcribe.ts some.wav [expected words]
//
// The WAV should be 16-bit PCM; any rate (it's resampled to 16 kHz) and channels (mixed down).
// With expected words it exits 1 unless the transcript has them all.
import { readFileSync } from "node:fs";
import { Transcriber, whisperConfig } from "../../src/server/whisper.ts";
import { SAMPLE_RATE, int16ToFloat, pcmFromBytes, resample } from "../../src/shared/voice.ts";

const [file, expected] = process.argv.slice(2);
if (!file) {
  console.error("usage: tsx scripts/voice/transcribe.ts <file.wav> [expected words]");
  process.exit(2);
}

/** A WAV's samples as mono float at its own rate. */
function readWav(buf: Buffer): { rate: number; samples: Float32Array } {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let at = 12;
  let rate = 0;
  let channels = 1;
  let bits = 16;
  while (at + 8 <= buf.length) {
    const id = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(at + 10);
      rate = buf.readUInt32LE(at + 12);
      bits = buf.readUInt16LE(at + 22);
    } else if (id === "data") {
      if (bits !== 16) throw new Error(`${bits}-bit WAV: only 16-bit PCM`);
      const all = int16ToFloat(pcmFromBytes(new Uint8Array(buf.buffer, buf.byteOffset + at + 8, Math.min(size, buf.length - at - 8))));
      const mono = new Float32Array(Math.floor(all.length / channels));
      for (let i = 0; i < mono.length; i++) {
        let s = 0;
        for (let c = 0; c < channels; c++) s += all[i * channels + c];
        mono[i] = s / channels;
      }
      return { rate, samples: mono };
    }
    at += 8 + size + (size & 1);
  }
  throw new Error("no audio in the WAV");
}

const wav = readWav(readFileSync(file));
const pcm = resample(wav.samples, wav.rate, SAMPLE_RATE);
const config = whisperConfig();
const t = new Transcriber({ config, onTiming: (what, ms) => console.log(`  worker ${what}: ${ms} ms`) });
let lastPct = -1;
t.onState = (s) => {
  const pct = Math.round((s.progress ?? 0) * 100);
  if (s.status === "downloading" && pct !== lastPct && pct % 10 === 0) console.log(`  downloading ${config.model}: ${pct}% of ${((s.bytes ?? 0) / 1e6).toFixed(1)} MB`);
  lastPct = pct;
};
console.log(`${file}: ${(pcm.length / SAMPLE_RATE).toFixed(1)} s · model ${config.model} (${config.dtype}) in ${config.cacheDir} · ${t.state.status}`);
const t0 = Date.now();
await t.prepare();
console.log(`load: ${Date.now() - t0} ms`);
let text = "";
for (const pass of ["cold", "warm"]) {
  const t1 = Date.now();
  text = await t.transcribe(pcm.slice());
  console.log(`${pass}: ${Date.now() - t1} ms → "${text}"`);
}
t.stop();
if (expected) {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean);
  const missing = norm(expected).filter((w) => !norm(text).includes(w));
  console.log(missing.length ? `MISSING: ${missing.join(" ")}` : "all expected words heard");
  process.exit(missing.length ? 1 : 0);
}
