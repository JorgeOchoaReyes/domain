import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkServer, mcpLaunch, mcpModule, parseToml, scanAgents, serversFor } from "../src/server/mcp.ts";
import { Progress } from "../src/server/progress.ts";
import { OpLogger } from "../src/server/oplog.ts";
import { SECRET_MASK, type McpServer } from "../src/shared/mcp.ts";
import type { ServerCtx } from "../src/server/ctx.ts";
import type { ServerMessage } from "../src/shared/protocol.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));

const server = (over: Partial<McpServer> = {}): McpServer => ({
  id: "s1",
  name: "fs",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
  url: "",
  env: { TOKEN: "sekret" },
  enabled: true,
  everyone: true,
  ...over,
});

test("the TOML reader handles Codex configs: tables, quoting, arrays, inline tables, comments", () => {
  const toml = parseToml(`
model = "o3" # a comment
[mcp_servers.fs]
command = "npx"
args = [
  "-y", # the flag
  '@modelcontextprotocol/server-filesystem',
  "C:\\\\work",
]
env = { API_KEY = "x=1", "QUOTED KEY" = 'lit\\eral' }

[mcp_servers."my server"]
url = "https://example.com/mcp"
enabled = false
startup_timeout_sec = 20

[mcp_servers.fs.env]
EXTRA = """multi
line"""
`);
  const servers = toml.mcp_servers as Record<string, Record<string, unknown>>;
  assert.equal(toml.model, "o3");
  assert.equal(servers.fs.command, "npx");
  assert.deepEqual(servers.fs.args, ["-y", "@modelcontextprotocol/server-filesystem", "C:\\work"]);
  assert.deepEqual(servers.fs.env, { API_KEY: "x=1", "QUOTED KEY": "lit\\eral", EXTRA: "multi\nline" });
  assert.equal(servers["my server"].url, "https://example.com/mcp");
  assert.equal(servers["my server"].enabled, false);
  assert.equal(servers["my server"].startup_timeout_sec, 20);
});

test("scanning reads what each agent already loads, user and project scope, without secrets", () => {
  const home = mkdtempSync(join(tmpdir(), "domain-mcp-home-"));
  const project = mkdtempSync(join(tmpdir(), "domain-mcp-proj-"));
  try {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], env: { SECRET: "x" } } },
        projects: { [project.replace(/\\/g, "/")]: { mcpServers: { local: { type: "http", url: "https://p.example/mcp" } } }, "/elsewhere": { mcpServers: { nope: { command: "x" } } } },
      }),
    );
    writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "uvx", args: ["mcp-server-fetch"] } } }));
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), `[mcp_servers.cekura]\nurl = "https://api.cekura.ai/mcp"\n\n[mcp_servers.fs]\ncommand = "npx"\nargs = ["-y", "fs"]\n[mcp_servers.fs.env]\nTOKEN = "hidden"\n`);
    mkdirSync(join(home, ".gemini"));
    writeFileSync(join(home, ".gemini", "settings.json"), JSON.stringify({ mcpServers: { remote: { httpUrl: "https://g.example/mcp", headers: { Authorization: "Bearer t" } } } }));
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(
      join(home, ".config", "opencode", "opencode.json"),
      `{ // JSONC comment\n "mcp": { "pw": { "type": "local", "command": ["npx", "-y", "@playwright/mcp"], "environment": { "K": "v" } }, }, }`,
    );

    const seen = scanAgents({ home, projectDir: project });
    const by = (agent: string, name: string) => seen.find((s) => s.agent === agent && s.name === name);
    assert.equal(by("claude", "memory")?.target, "npx -y @modelcontextprotocol/server-memory");
    assert.equal(by("claude", "local")?.transport, "http");
    assert.equal(by("claude", "local")?.source, "~/.claude.json (this project)");
    assert.equal(by("claude", "nope"), undefined, "other projects' servers aren't this project's");
    assert.equal(by("claude", "shared")?.source, ".mcp.json");
    assert.equal(by("codex", "cekura")?.target, "https://api.cekura.ai/mcp");
    assert.equal(by("codex", "fs")?.target, "npx -y fs");
    assert.equal(by("gemini", "remote")?.transport, "http");
    assert.equal(by("opencode", "pw")?.target, "npx -y @playwright/mcp");
    // What clients get never carries env values or headers.
    const json = JSON.stringify(seen.map(({ agent, name, source, transport, target }) => ({ agent, name, source, transport, target })));
    for (const secret of ["hidden", "Bearer t", '"x"']) assert.ok(!json.includes(secret), `leaked ${secret}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("a health check talks MCP to a stdio server and counts its tools", async () => {
  const ok = await checkServer({ transport: "stdio", command: process.execPath, args: [FIXTURE], url: "", env: {} });
  assert.equal(ok.status, "ok", ok.detail);
  assert.equal(ok.tools, 2);
  assert.equal(ok.detail, "2 tools");

  const missing = await checkServer({ transport: "stdio", command: "definitely-not-a-real-mcp-cmd", args: [], url: "", env: {} }, 8000);
  assert.equal(missing.status, "error");
});

test("a health check flags an http server that wants you signed in, and one that works", async () => {
  const http = createServer((req, res) => {
    if (req.url === "/locked") {
      res.writeHead(401).end();
      return;
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const msg = JSON.parse(body || "{}");
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("mcp-session-id", "abc");
      const result = msg.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {} } : { tools: [{ name: "a" }, { name: "b" }, { name: "c" }] };
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`);
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  const port = (http.address() as { port: number }).port;
  try {
    const auth = await checkServer({ transport: "http", command: "", args: [], url: `http://127.0.0.1:${port}/locked`, env: {} });
    assert.equal(auth.status, "auth");
    const ok = await checkServer({ transport: "http", command: "", args: [], url: `http://127.0.0.1:${port}/mcp`, env: { Authorization: "Bearer x" } });
    assert.equal(ok.status, "ok", ok.detail);
    assert.equal(ok.tools, 3);
    const down = await checkServer({ transport: "http", command: "", args: [], url: "http://127.0.0.1:1/mcp", env: {} }, 3000);
    assert.equal(down.status, "error");
  } finally {
    http.close();
  }
});

test("each agent gets the office's servers for its session, from files under .domain/mcp/<desk>", () => {
  const project = mkdtempSync(join(tmpdir(), "domain-mcp-launch-"));
  const codexHome = mkdtempSync(join(tmpdir(), "domain-codex-home-"));
  try {
    const servers = [server(), server({ id: "s2", name: "remote", transport: "http", command: "", args: [], url: "https://r.example/mcp", env: { Authorization: "Bearer t" } })];
    const dir = join(project, ".domain", "mcp", "desk-1");

    const claude = mcpLaunch("claude", servers, { projectDir: project, deskId: "desk-1" });
    assert.equal(claude.args[0], "--mcp-config");
    const claudeCfg = JSON.parse(readFileSync(join(dir, "claude.json"), "utf8"));
    assert.deepEqual(Object.keys(claudeCfg.mcpServers), ["fs", "remote"]);
    assert.equal(claudeCfg.mcpServers.remote.type, "http");
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "*\n", "kept out of git");

    const codex = mcpLaunch("codex", servers, { projectDir: project, deskId: "desk-1", codexHome });
    assert.equal(codex.args[0], "-p");
    assert.match(codex.args[1], /^domain-[0-9a-f]{6}-desk-1$/);
    const profile = parseToml(readFileSync(join(codexHome, `${codex.args[1]}.config.toml`), "utf8"));
    const ms = profile.mcp_servers as Record<string, Record<string, unknown>>;
    assert.deepEqual(ms.fs.args, ["-y", "@modelcontextprotocol/server-filesystem", "."]);
    assert.deepEqual(ms.fs.env, { TOKEN: "sekret" });
    assert.equal(ms.remote.url, "https://r.example/mcp");
    assert.ok(codex.args.every((a) => !/["'\s]/.test(a)), "nothing to quote on the launch line");

    const gemini = mcpLaunch("gemini", servers, { projectDir: project, deskId: "desk-1" });
    assert.deepEqual(gemini.args, []);
    const gem = JSON.parse(readFileSync(gemini.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, "utf8"));
    assert.equal(gem.mcpServers.remote.httpUrl, "https://r.example/mcp");

    const open = mcpLaunch("opencode", servers, { projectDir: project, deskId: "desk-1" });
    const oc = JSON.parse(readFileSync(open.env.OPENCODE_CONFIG, "utf8"));
    assert.deepEqual(oc.mcp.fs.command, ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."]);
    assert.equal(oc.mcp.remote.type, "remote");

    // Nothing to give: nothing written, nothing changed.
    assert.deepEqual(mcpLaunch("claude", [], { projectDir: project, deskId: "desk-2" }), { args: [], env: {} });
    assert.equal(existsSync(join(project, ".domain", "mcp", "desk-2")), false);
    assert.deepEqual(mcpLaunch("claude", [server({ enabled: false })], { projectDir: project, deskId: "desk-3" }), { args: [], env: {} });
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("who gets which servers: a character's picks, or everything marked for everyone", () => {
  const all = [server({ id: "a", everyone: true }), server({ id: "b", everyone: false }), server({ id: "c", everyone: true, enabled: false })];
  assert.deepEqual(serversFor(all, null).map((s) => s.id), ["a"]);
  assert.deepEqual(serversFor(all, ["b"]).map((s) => s.id), ["a", "b"]);
});

test("secrets stay on the server: masked to clients, kept when saved back masked, never logged", () => {
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
  const routes = mcpModule(ctx, { home: mkdtempSync(join(tmpdir(), "domain-mcp-empty-")), projectDir: tmpdir() });

  routes.mcpSave!({ t: "mcpSave", server: server({ enabled: false }) } as never, {} as never, {} as never);
  assert.equal(progress.mcp[0].env.TOKEN, "sekret");
  const snap = progress.snapshot();
  assert.equal(snap.mcp[0].env.TOKEN, SECRET_MASK, "clients see the mask");
  // The client saves the server back with the mask (e.g. after toggling "everyone").
  routes.mcpSave!({ t: "mcpSave", server: { ...snap.mcp[0], everyone: false } } as never, {} as never, {} as never);
  assert.equal(progress.mcp[0].env.TOKEN, "sekret", "the stored secret is kept");
  assert.equal(progress.mcp[0].everyone, false);
  assert.ok(!logged.some((l) => l.includes("sekret")), "never in the log");
  assert.ok(!sent.some((m) => JSON.stringify(m).includes("sekret")), "never sent");

  routes.mcpDelete!({ t: "mcpDelete", id: "s1" } as never, {} as never, {} as never);
  assert.equal(progress.mcp.length, 0);
});

test("GitHub tools use your sign-in: added at launch, never stored, left out when signed out", async () => {
  const { withGithubAuth, mcpLaunch, mcpCleanup } = await import("../src/server/mcp.ts");
  const { coerceMcpServer, GITHUB_MCP_URL } = await import("../src/shared/mcp.ts");
  const { mkdtempSync, existsSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const s = coerceMcpServer({ name: "github", transport: "http", url: GITHUB_MCP_URL, env: {}, enabled: true, everyone: true, auth: "github" })!;
  assert.equal(s.auth, "github");
  assert.deepEqual(s.env, {}, "no token is stored with the server");
  assert.equal(withGithubAuth(s, null), null, "signed out: left out");
  const authed = withGithubAuth(s, "gho_test")!;
  assert.equal(authed.env.Authorization, "Bearer gho_test");
  // A stdio server isn't touched.
  const plain = coerceMcpServer({ name: "fs", transport: "stdio", command: "npx", args: [] })!;
  assert.equal(withGithubAuth(plain, null), plain);

  const dir = mkdtempSync(join(tmpdir(), "domain-mcp-gh-"));
  const codexHome = join(dir, "codexhome");
  try {
    mcpLaunch("claude", [authed], { projectDir: dir, deskId: "desk-1" });
    mcpLaunch("codex", [authed], { projectDir: dir, deskId: "desk-1", codexHome });
    const file = join(dir, ".domain", "mcp", "desk-1", "claude.json");
    assert.match(readFileSync(file, "utf8"), /Bearer gho_test/);
    mcpCleanup(dir, "desk-1", codexHome);
    assert.ok(!existsSync(file), "the worker's config (with the token) goes when it leaves");
    const { readdirSync } = await import("node:fs");
    assert.deepEqual(readdirSync(codexHome).filter((f) => f.endsWith(".config.toml")), [], "and so does its Codex profile");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
