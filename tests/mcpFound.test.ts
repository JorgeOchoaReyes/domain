import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptable, adoptServer, findSeen, mcpModule, publicSeen, scanAgents } from "../src/server/mcp.ts";
import { Progress } from "../src/server/progress.ts";
import { OpLogger } from "../src/server/oplog.ts";
import { maskArgs, maskUrl, SECRET_MASK, type McpServer } from "../src/shared/mcp.ts";
import { mcpText } from "../src/cli/nou.ts";
import type { ServerCtx } from "../src/server/ctx.ts";
import type { ServerMessage } from "../src/shared/protocol.ts";

const SECRETS = ["sk-live-AAAA", "env-secret-BBBB", "Bearer header-CCCC", "argtoken-DDDD"];

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "domain-mcp-found-"));
  writeFileSync(
    join(h, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], env: { OPENAI_API_KEY: "sk-live-AAAA" } },
        search: { command: "search-mcp", args: ["--api-key", "argtoken-DDDD", "--path", "/srv/x"], env: { SEARCH_TOKEN: "env-secret-BBBB" } },
        remote: { type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer header-CCCC" } },
      },
    }),
  );
  return h;
}

test("secret-looking arguments and URL parts are masked; ordinary ones aren't", () => {
  assert.deepEqual(maskArgs(["--api-key", "abc", "--path", "/srv", "TOKEN=xyz", "ghp_123", "-y", "pkg"]), ["--api-key", SECRET_MASK, "--path", "/srv", `TOKEN=${SECRET_MASK}`, SECRET_MASK, "-y", "pkg"]);
  assert.equal(maskUrl("https://x.example/mcp?api_key=abc&v=2"), `https://x.example/mcp?api_key=${SECRET_MASK}&v=2`);
  assert.equal(maskUrl("https://u:pw@x.example/mcp"), `https://u:${SECRET_MASK}@x.example/mcp`);
  assert.equal(maskUrl("https://x.example/mcp"), "https://x.example/mcp");
});

test("found in your CLIs: the ones not office-wide yet, once per name, with env names but never values", () => {
  const h = home();
  try {
    const seen = scanAgents({ home: h, projectDir: tmpdir() });
    const office: McpServer[] = [{ id: "m", name: "memory", transport: "stdio", command: "npx", args: [], url: "", env: {}, enabled: true, everyone: true }];
    const left = adoptable([...seen, { ...seen[1], agent: "codex" }], office);
    assert.deepEqual(left.map((s) => `${s.agent}:${s.name}`), ["claude:search", "claude:remote"], "memory is everyone's already; search listed once");
    const shown = JSON.stringify(seen.map(publicSeen));
    for (const s of SECRETS) assert.ok(!shown.includes(s), `leaked ${s}`);
    const search = publicSeen(seen.find((s) => s.name === "search")!);
    assert.deepEqual(search.envKeys, ["SEARCH_TOKEN"]);
    assert.equal(search.target, `search-mcp --api-key ${SECRET_MASK} --path /srv/x`);
    assert.equal(findSeen(seen, "SEA")?.name, "search");
    assert.equal(findSeen(seen, "claude:remote")?.name, "remote");
    assert.equal(findSeen(seen, "nothing"), null);

    // Adopting copies it (with its env, kept on the server) for everyone; one the office has is just turned on for everyone.
    const copy = adoptServer(seen.find((s) => s.name === "search")!, [])!;
    assert.equal(copy.everyone, true);
    assert.equal(copy.env.SEARCH_TOKEN, "env-secret-BBBB");
    assert.deepEqual(copy.args, ["--api-key", "argtoken-DDDD", "--path", "/srv/x"]);
    const mine = adoptServer(seen.find((s) => s.name === "memory")!, [{ ...office[0], everyone: false, enabled: false }])!;
    assert.equal(mine.id, "m");
    assert.ok(mine.everyone && mine.enabled);
    // nou mcp shows names, never values.
    const text = mcpText([copy], seen.map(publicSeen));
    for (const s of SECRETS) assert.ok(!text.includes(s), `nou mcp leaked ${s}`);
    assert.match(text, /SEARCH_TOKEN=/);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test("mcpAdopt: added for everyone, its secrets never logged or sent", async () => {
  const h = home();
  const progress = new Progress(null);
  const log = new OpLogger();
  const logged: string[] = [];
  log.onEntry = (e) => logged.push(JSON.stringify(e));
  const sent: ServerMessage[] = [];
  const ctx = {
    cwd: tmpdir(),
    port: 0,
    simulate: true,
    progress,
    log,
    send: (_ws: unknown, m: ServerMessage) => sent.push(m),
    broadcast: (m: ServerMessage) => sent.push(m),
  } as unknown as ServerCtx;
  try {
    const routes = mcpModule(ctx, { home: h, projectDir: tmpdir() });
    routes.mcpScan!({ t: "mcpScan" } as never, {} as never, {} as never);
    routes.mcpAdopt!({ t: "mcpAdopt", name: "remote" } as never, {} as never, {} as never);
    const s = progress.mcp.find((x) => x.name === "remote")!;
    assert.ok(s && s.everyone && s.enabled && s.transport === "http");
    assert.equal(s.env.Authorization, "Bearer header-CCCC", "kept on the server");
    routes.mcpAdopt!({ t: "mcpAdopt", name: "nope" } as never, {} as never, {} as never);
    assert.ok(logged.some((l) => /None of your agent CLIs/.test(l)));
    // Let its health check (against nothing listening) finish.
    await new Promise((r) => setTimeout(r, 1500));
    const all = [...logged, ...sent.map((m) => JSON.stringify(m)), JSON.stringify(progress.snapshot())];
    for (const secret of SECRETS) assert.ok(!all.some((l) => l.includes(secret)), `leaked ${secret}`);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});
