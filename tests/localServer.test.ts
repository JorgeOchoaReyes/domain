import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { copyName, ollamaBase, ollamaCopy, ollamaShow, speedOf } from "../src/server/localModels.ts";

test("a bigger-context copy's name", () => {
  assert.equal(copyName("qwen3:8b", 32_768), "qwen3:8b-32k");
  assert.equal(copyName("qwen3:8b-24k", 65_536), "qwen3:8b-64k");
  assert.equal(ollamaBase({ OLLAMA_HOST: "0.0.0.0:11434" }), "http://0.0.0.0:11434");
});

test("making a copy asks Ollama for the same weights with a bigger num_ctx", async () => {
  let got: unknown = null;
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d)).on("end", () => {
      got = { url: req.url, body: JSON.parse(b) };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "success" }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  try {
    assert.equal(await ollamaCopy("qwen3:8b", 32_768, { OLLAMA_HOST: `127.0.0.1:${port}` }), "qwen3:8b-32k");
    assert.deepEqual(got, { url: "/api/create", body: { model: "qwen3:8b-32k", from: "qwen3:8b", parameters: { num_ctx: 32_768 }, stream: false } });
  } finally {
    srv.close();
  }
});

// Against a real Ollama (DOMAIN_LIVE_OLLAMA=1, and one running here): it loads a model, so it's opt-in.
const tags = !process.env.DOMAIN_LIVE_OLLAMA ? null : await fetch(`${ollamaBase()}/api/tags`, { signal: AbortSignal.timeout(1500) })
  .then((r) => r.json() as Promise<{ models?: { name: string; capabilities?: string[] }[] }>)
  .catch(() => null);
const model = tags?.models?.find((m) => m.capabilities?.includes("completion"))?.name;

test("Ollama: a model's context window, and how fast it writes here", { skip: !model && "set DOMAIN_LIVE_OLLAMA=1 with Ollama running", timeout: 240_000 }, async () => {
  const show = await ollamaShow(model!);
  assert.ok(show, "it answered");
  assert.ok(show.max === null || show.max > 1000);
  assert.ok(show.ctx === null || show.ctx > 1000);
  const tps = await speedOf(`ollama/${model}`);
  assert.ok(tps !== null && tps > 0, `measured ${tps}`);
  console.log(`# ${model}: ctx ${show.ctx} (max ${show.max}), ${tps} tokens/s`);
});
