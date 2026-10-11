import type { LocalModelInfo } from "../shared/localModels.js";

/**
 * Local models, end to end: the context window an Ollama model runs with (and
 * making a copy of it with a bigger one), and how fast a local model runs on
 * this computer — measured once when a worker's hired on it, so the office
 * knows what to hand it.
 */

export function ollamaBase(env: NodeJS.ProcessEnv = process.env): string {
  const h = env.OLLAMA_HOST;
  return (h ? (/^https?:\/\//.test(h) ? h : `http://${h}`) : "http://127.0.0.1:11434").replace(/\/+$/, "");
}

function lmBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.LMSTUDIO_URL ?? "http://127.0.0.1:1234").replace(/\/+$/, "");
}

async function post(url: string, body: unknown, ms: number): Promise<unknown> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/**
 * An Ollama model's context window: the one it's set to run with (`num_ctx`
 * in its parameters; null when it isn't set, so Ollama's default — far too
 * small for an agent — applies) and the most it was trained for.
 */
export async function ollamaShow(name: string, env: NodeJS.ProcessEnv = process.env): Promise<Pick<LocalModelInfo, "ctx" | "max"> | null> {
  const j = (await post(`${ollamaBase(env)}/api/show`, { model: name }, 5000)) as { parameters?: string; model_info?: Record<string, unknown> } | null;
  if (!j) return null;
  const ctx = /^num_ctx\s+(\d+)/m.exec(j.parameters ?? "")?.[1];
  const max = Object.entries(j.model_info ?? {}).find(([k, v]) => k.endsWith(".context_length") && typeof v === "number")?.[1] as number | undefined;
  return { ctx: ctx ? Number(ctx) : null, max: max ?? null };
}

/** Context windows you can ask a copy for. */
export const COPY_CONTEXTS = [16_384, 32_768, 65_536, 131_072] as const;

/** The name a copy with this context gets: "qwen3:8b" → "qwen3:8b-32k" (an earlier "-24k" is replaced). */
export function copyName(name: string, ctx: number): string {
  return `${name.replace(/-\d+k$/i, "")}-${Math.round(ctx / 1024)}k`;
}

/**
 * Make a copy of an Ollama model that runs with a bigger context window —
 * the same weights (nothing's downloaded), just its own num_ctx. Returns the
 * copy's name, or null if Ollama said no.
 */
export async function ollamaCopy(name: string, ctx: number, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const to = copyName(name, ctx);
  const j = (await post(`${ollamaBase(env)}/api/create`, { model: to, from: name, parameters: { num_ctx: ctx }, stream: false }, 120_000)) as { status?: string } | null;
  return j && (!j.status || j.status === "success") ? to : null;
}

/**
 * How fast a local model writes on this computer, in tokens a second (null
 * if it couldn't be measured). Loading the model isn't counted: Ollama
 * reports the time spent writing; LM Studio is timed from the request.
 */
export async function speedOf(model: string, env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
  const [provider, ...rest] = model.split("/");
  const name = rest.join("/");
  const prompt = "Write three short sentences about a tidy desk.";
  if (provider === "ollama") {
    const j = (await post(`${ollamaBase(env)}/api/generate`, { model: name, prompt, stream: false, think: false, options: { num_predict: 64 } }, 180_000)) as { eval_count?: number; eval_duration?: number } | null;
    if (!j?.eval_count || !j.eval_duration) return null;
    return Math.round((j.eval_count / (j.eval_duration / 1e9)) * 10) / 10;
  }
  if (provider === "lmstudio") {
    // Once to load it, then timed.
    await post(`${lmBase(env)}/v1/chat/completions`, { model: name, messages: [{ role: "user", content: "Hi" }], max_tokens: 1 }, 180_000);
    const t0 = Date.now();
    const j = (await post(`${lmBase(env)}/v1/chat/completions`, { model: name, messages: [{ role: "user", content: prompt }], max_tokens: 64 }, 180_000)) as { usage?: { completion_tokens?: number } } | null;
    const n = j?.usage?.completion_tokens;
    return n ? Math.round((n / ((Date.now() - t0) / 1000)) * 10) / 10 : null;
  }
  return null;
}
