import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import type { AgentKind } from "../shared/protocol.js";
import { AGENT_LABELS } from "../shared/protocol.js";
import { coerceMcpServer, type McpHealth, type McpSeen, type McpServer } from "../shared/mcp.js";
import type { Routes, ServerCtx } from "./ctx.js";

/**
 * MCP servers: the tools workers can call.
 *
 * - Scan: read (never write) what each agent CLI already loads from its own
 *   config — Claude Code, Codex, Gemini CLI, OpenCode — user and project scope.
 * - Health: start a server (or POST to it) and ask it `initialize` and
 *   `tools/list`, so a broken or signed-out one is flagged.
 * - Launch: give the office's own servers to a worker for its session only,
 *   through each CLI's per-session mechanism, without touching your configs.
 *
 * Env values and headers can be secrets: they're never logged or sent to clients.
 */

// ---------------------------------------------------------------------------
// A small TOML reader — enough for Codex's config.toml: tables, dotted and
// quoted keys, strings (basic, literal, multi-line), arrays, inline tables,
// numbers, booleans and comments.
// ---------------------------------------------------------------------------

type TomlValue = string | number | boolean | TomlValue[] | { [k: string]: TomlValue };
type TomlTable = { [k: string]: TomlValue };

export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let current: TomlTable = root;
  let i = 0;
  const n = text.length;

  const ws = () => {
    while (i < n && (text[i] === " " || text[i] === "\t")) i++;
  };
  const wsAll = () => {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (text[i] === "#") {
        while (i < n && text[i] !== "\n") i++;
      } else break;
    }
  };
  const fail = (what: string): never => {
    throw new Error(`TOML: ${what} at ${i}`);
  };

  const basicString = (): string => {
    // At the opening quote(s).
    if (text.startsWith('"""', i)) {
      i += 3;
      if (text[i] === "\n") i++;
      else if (text.startsWith("\r\n", i)) i += 2;
      let out = "";
      while (i < n && !text.startsWith('"""', i)) {
        if (text[i] === "\\") out += escape();
        else out += text[i++];
      }
      i += 3;
      return out;
    }
    i++;
    let out = "";
    while (i < n && text[i] !== '"') {
      if (text[i] === "\n") fail("newline in string");
      if (text[i] === "\\") out += escape();
      else out += text[i++];
    }
    i++;
    return out;
  };
  const escape = (): string => {
    const c = text[i + 1];
    i += 2;
    const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", b: "\b", f: "\f" };
    if (c in map) return map[c];
    if (c === "u" || c === "U") {
      const len = c === "u" ? 4 : 8;
      const hex = text.slice(i, i + len);
      i += len;
      return String.fromCodePoint(parseInt(hex, 16));
    }
    if (c === "\n" || c === "\r") {
      // Line-ending backslash: trim following whitespace.
      while (i < n && /\s/.test(text[i])) i++;
      return "";
    }
    return c ?? "";
  };
  const literalString = (): string => {
    if (text.startsWith("'''", i)) {
      i += 3;
      if (text[i] === "\n") i++;
      const end = text.indexOf("'''", i);
      const s = text.slice(i, end < 0 ? n : end);
      i = end < 0 ? n : end + 3;
      return s;
    }
    i++;
    const end = text.indexOf("'", i);
    const s = text.slice(i, end < 0 ? n : end);
    i = end < 0 ? n : end + 1;
    return s;
  };
  const key = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      ws();
      if (text[i] === '"') parts.push(basicString());
      else if (text[i] === "'") parts.push(literalString());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
        if (!m) fail("key");
        parts.push(m![0]);
        i += m![0].length;
      }
      ws();
      if (text[i] === ".") {
        i++;
        continue;
      }
      return parts;
    }
  };
  const value = (): TomlValue => {
    ws();
    const c = text[i];
    if (c === '"') return basicString();
    if (c === "'") return literalString();
    if (c === "[") {
      i++;
      const arr: TomlValue[] = [];
      for (;;) {
        wsAll();
        if (text[i] === "]") {
          i++;
          return arr;
        }
        arr.push(value());
        wsAll();
        if (text[i] === ",") i++;
        else if (text[i] !== "]") fail("array");
      }
    }
    if (c === "{") {
      i++;
      const t: TomlTable = {};
      for (;;) {
        ws();
        if (text[i] === "}") {
          i++;
          return t;
        }
        const k = key();
        if (text[i] !== "=") fail("=");
        i++;
        setPath(t, k, value());
        ws();
        if (text[i] === ",") i++;
      }
    }
    const m = /^[^\s,\]}#]+/.exec(text.slice(i));
    if (!m) fail("value");
    i += m![0].length;
    const raw = m![0];
    if (raw === "true") return true;
    if (raw === "false") return false;
    const num = Number(raw.replace(/_/g, ""));
    return Number.isNaN(num) ? raw : num;
  };
  const setPath = (t: TomlTable, path: string[], v: TomlValue) => {
    let o = t;
    for (const p of path.slice(0, -1)) {
      if (typeof o[p] !== "object" || o[p] === null || Array.isArray(o[p])) o[p] = {};
      o = o[p] as TomlTable;
    }
    o[path[path.length - 1]] = v;
  };
  const table = (path: string[]): TomlTable => {
    let o = root;
    for (const p of path) {
      const next = o[p];
      if (Array.isArray(next)) o = next[next.length - 1] as TomlTable;
      else {
        if (typeof next !== "object" || next === null) o[p] = {};
        o = o[p] as TomlTable;
      }
    }
    return o;
  };

  while (i < n) {
    wsAll();
    if (i >= n) break;
    if (text.startsWith("[[", i)) {
      i += 2;
      const path = key();
      if (!text.startsWith("]]", i)) fail("]]");
      i += 2;
      const parent = table(path.slice(0, -1));
      const last = path[path.length - 1];
      if (!Array.isArray(parent[last])) parent[last] = [];
      const t: TomlTable = {};
      (parent[last] as TomlValue[]).push(t);
      current = t;
    } else if (text[i] === "[") {
      i++;
      const path = key();
      if (text[i] !== "]") fail("]");
      i++;
      current = table(path);
    } else {
      const k = key();
      if (text[i] !== "=") fail("=");
      i++;
      setPath(current, k, value());
    }
    // Rest of the line: only a comment allowed.
    ws();
    if (text[i] === "#") while (i < n && text[i] !== "\n") i++;
  }
  return root;
}

// ---------------------------------------------------------------------------
// Scanning what each agent already loads.
// ---------------------------------------------------------------------------

/** A server as an agent configures it — env included (kept on the server only). */
interface SeenFull extends McpSeen {
  command: string;
  args: string[];
  url: string;
  env: Record<string, string>;
}

export interface ScanPaths {
  home: string;
  projectDir: string;
}

function readJson(path: string): unknown {
  try {
    const raw = readFileSync(path, "utf8");
    // JSONC: drop comments and trailing commas (OpenCode allows them).
    const clean = raw.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, s) => s ?? "").replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const strMap = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(obj(v))) if (typeof x === "string") out[k] = x;
  return out;
};

function seen(agent: AgentKind, name: string, source: string, spec: { command?: unknown; args?: unknown; url?: unknown; env?: unknown }): SeenFull {
  const url = typeof spec.url === "string" ? spec.url : "";
  const command = typeof spec.command === "string" ? spec.command : "";
  const args = strs(spec.args);
  return {
    agent,
    name,
    source,
    transport: url && !command ? "http" : "stdio",
    target: url && !command ? url : [command, ...args].join(" "),
    command,
    args,
    url,
    env: strMap(spec.env),
  };
}

const samePath = (a: string, b: string) => resolve(a).replace(/\\/g, "/").toLowerCase() === resolve(b).replace(/\\/g, "/").toLowerCase();

/** Every MCP server the four agent CLIs load for this project (user and project scope). */
export function scanAgents(paths: ScanPaths): SeenFull[] {
  const { home, projectDir } = paths;
  const out: SeenFull[] = [];

  // Claude Code: ~/.claude.json (user + this project's entry), <project>/.mcp.json.
  const claude = obj(readJson(join(home, ".claude.json")));
  for (const [name, spec] of Object.entries(obj(claude.mcpServers))) out.push(seen("claude", name, "~/.claude.json", obj(spec)));
  for (const [path, proj] of Object.entries(obj(claude.projects))) {
    if (!samePath(path, projectDir)) continue;
    for (const [name, spec] of Object.entries(obj(obj(proj).mcpServers))) out.push(seen("claude", name, "~/.claude.json (this project)", obj(spec)));
  }
  for (const [name, spec] of Object.entries(obj(obj(readJson(join(projectDir, ".mcp.json"))).mcpServers))) {
    out.push(seen("claude", name, ".mcp.json", obj(spec)));
  }

  // Codex: ~/.codex/config.toml [mcp_servers.<name>].
  const codexHome = process.env.CODEX_HOME && samePath(home, homedir()) ? process.env.CODEX_HOME : join(home, ".codex");
  try {
    const toml = parseToml(readFileSync(join(codexHome, "config.toml"), "utf8"));
    for (const [name, spec] of Object.entries(obj(toml.mcp_servers))) out.push(seen("codex", name, "~/.codex/config.toml", obj(spec)));
  } catch {
    /* no config, or one we can't read */
  }

  // Gemini CLI: ~/.gemini/settings.json and <project>/.gemini/settings.json (httpUrl or url for remote).
  for (const [file, label] of [
    [join(home, ".gemini", "settings.json"), "~/.gemini/settings.json"],
    [join(projectDir, ".gemini", "settings.json"), ".gemini/settings.json"],
  ] as const) {
    for (const [name, spec] of Object.entries(obj(obj(readJson(file)).mcpServers))) {
      const s = obj(spec);
      out.push(seen("gemini", name, label, { ...s, url: s.httpUrl ?? s.url }));
    }
  }

  // OpenCode: ~/.config/opencode/opencode.json(c) and <project>/opencode.json(c); local = command array, remote = url.
  for (const [file, label] of [
    [join(home, ".config", "opencode", "opencode.json"), "~/.config/opencode/opencode.json"],
    [join(home, ".config", "opencode", "opencode.jsonc"), "~/.config/opencode/opencode.jsonc"],
    [join(projectDir, "opencode.json"), "opencode.json"],
    [join(projectDir, "opencode.jsonc"), "opencode.jsonc"],
  ] as const) {
    for (const [name, spec] of Object.entries(obj(obj(readJson(file)).mcp))) {
      const s = obj(spec);
      const cmd = strs(s.command);
      out.push(
        seen("opencode", name, label, s.type === "remote" ? { url: s.url, env: s.headers } : { command: cmd[0], args: cmd.slice(1), env: s.environment }),
      );
    }
  }
  return out;
}

export function publicSeen(s: SeenFull): McpSeen {
  return { agent: s.agent, name: s.name, source: s.source, transport: s.transport, target: s.target };
}

// ---------------------------------------------------------------------------
// Health checks.
// ---------------------------------------------------------------------------

export interface CheckSpec {
  transport: "stdio" | "http";
  command: string;
  args: string[];
  url: string;
  env: Record<string, string>;
}

export interface CheckResult {
  status: "ok" | "auth" | "error";
  detail: string;
  tools?: number;
  /** stderr / response tail (for the log; env values never appear in it from us). */
  output: string;
}

const PROTOCOL = "2025-06-18";
const initializeMsg = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "domain", version: "0.1.0" } },
});

/** Quote one argument for cmd.exe (Windows runs .cmd shims like npx through it). */
function winQuote(a: string): string {
  return /^[A-Za-z0-9_./:=@\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`;
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (platform() === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* already gone */
    }
  } else {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function checkStdio(spec: CheckSpec, timeoutMs: number): Promise<CheckResult> {
  return new Promise((done) => {
    let stderr = "";
    let buf = "";
    let finished = false;
    let child: ChildProcess;
    try {
      const win = platform() === "win32";
      child = win
        ? spawn([spec.command, ...spec.args].map(winQuote).join(" "), { shell: true, env: { ...process.env, ...spec.env }, windowsHide: true })
        : spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env } });
    } catch (e) {
      done({ status: "error", detail: `Couldn't start: ${(e as Error).message}`, output: "" });
      return;
    }
    const finish = (r: Omit<CheckResult, "output">) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      killTree(child);
      done({ ...r, output: stderr.slice(-3000) });
    };
    const timer = setTimeout(() => finish({ status: "error", detail: `No answer within ${Math.round(timeoutMs / 1000)}s` }), timeoutMs);
    const write = (m: object) => {
      try {
        child.stdin?.write(JSON.stringify(m) + "\n");
      } catch {
        /* closed */
      }
    };
    child.on("error", (e) => finish({ status: "error", detail: `Couldn't start: ${e.message}` }));
    child.on("exit", (code) => {
      if (!finished) {
        const last = stderr.trim().split("\n").pop() ?? "";
        const notFound = /not recognized|not found|ENOENT|cannot find/i.test(stderr);
        finish({ status: "error", detail: notFound ? `Command not found: ${spec.command}` : `Exited (${code})${last ? `: ${last.slice(0, 160)}` : ""}` });
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-6000);
    });
    child.stdin?.on("error", () => {});
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        let msg: { id?: number; result?: { tools?: unknown[] }; error?: { message?: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          if (msg.error) {
            finish({ status: "error", detail: msg.error.message ?? "initialize failed" });
            return;
          }
          write({ jsonrpc: "2.0", method: "notifications/initialized" });
          write({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        } else if (msg.id === 2) {
          const tools = Array.isArray(msg.result?.tools) ? msg.result!.tools!.length : 0;
          finish({ status: "ok", detail: `${tools} tool${tools === 1 ? "" : "s"}`, tools });
        }
      }
    });
    write(initializeMsg(1));
  });
}

/** Read a JSON-RPC message from a streamable-HTTP response (plain JSON or SSE). */
async function rpcBody(res: Response): Promise<{ result?: { tools?: unknown[] }; error?: { message?: string } } | null> {
  const text = await res.text();
  const type = res.headers.get("content-type") ?? "";
  try {
    if (type.includes("text/event-stream")) {
      for (const line of text.split("\n")) if (line.startsWith("data:")) return JSON.parse(line.slice(5).trim());
      return null;
    }
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function checkHttp(spec: CheckSpec, timeoutMs: number): Promise<CheckResult> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...spec.env };
  const post = (body: object, extra: Record<string, string> = {}) =>
    fetch(spec.url, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  try {
    const res = await post(initializeMsg(1));
    if (res.status === 401 || res.status === 403) {
      return { status: "auth", detail: "Needs sign-in", output: `HTTP ${res.status} ${res.statusText}` };
    }
    if (!res.ok) return { status: "error", detail: `HTTP ${res.status} ${res.statusText}`.trim(), output: "" };
    const init = await rpcBody(res);
    if (init?.error) return { status: "error", detail: init.error.message ?? "initialize failed", output: "" };
    const session = res.headers.get("mcp-session-id");
    const extra: Record<string, string> = session ? { "mcp-session-id": session } : {};
    try {
      await post({ jsonrpc: "2.0", method: "notifications/initialized" }, extra);
      const list = await rpcBody(await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, extra));
      const tools = Array.isArray(list?.result?.tools) ? list!.result!.tools!.length : undefined;
      return { status: "ok", detail: tools === undefined ? "Reachable" : `${tools} tool${tools === 1 ? "" : "s"}`, tools, output: "" };
    } catch {
      return { status: "ok", detail: "Reachable", output: "" };
    }
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    const why = err.name === "TimeoutError" ? `No answer within ${Math.round(timeoutMs / 1000)}s` : err.cause?.code ?? err.message;
    return { status: "error", detail: `Can't reach it: ${why}`, output: "" };
  }
}

export function checkServer(spec: CheckSpec, timeoutMs = 15_000): Promise<CheckResult> {
  if (spec.transport === "http") return checkHttp(spec, timeoutMs);
  if (!spec.command) return Promise.resolve({ status: "error", detail: "No command", output: "" });
  return checkStdio(spec, timeoutMs);
}

// ---------------------------------------------------------------------------
// Giving the office's servers to a worker for its session.
// ---------------------------------------------------------------------------

export interface McpLaunch {
  /** CLI arguments to add to the launch line (already safe to type into cmd.exe, PowerShell or bash). */
  args: string[];
  /** Environment variables for the worker's terminal. */
  env: Record<string, string>;
  /** Shown to the user when this CLI can't take them per session. */
  note?: string;
}

/** Quote a path for a command line typed into cmd.exe, PowerShell or bash: double quotes work in all three. */
function shellPath(p: string): string {
  if (/["$`%!]/.test(p)) throw new Error(`Unsafe characters in path: ${p}`);
  return /^[A-Za-z0-9_./:\\-]+$/.test(p) ? p : `"${p}"`;
}

const tomlStr = (s: string) => JSON.stringify(s); // JSON strings are valid TOML basic strings.
const tomlKey = (s: string) => (/^[A-Za-z0-9_-]+$/.test(s) ? s : tomlStr(s));

/** Where Gemini CLI's real system settings live (we layer on a copy of them). */
function geminiSystemSettings(): string {
  if (process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH) return process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  if (platform() === "win32") return "C:\\ProgramData\\gemini-cli\\settings.json";
  if (platform() === "darwin") return "/Library/Application Support/GeminiCli/settings.json";
  return "/etc/gemini-cli/settings.json";
}

/**
 * Write a worker's per-session MCP config and return how its CLI loads it:
 *
 * - Claude Code: `--mcp-config <.domain/mcp/<desk>/claude.json>` (adds to its own servers).
 * - Codex: a profile `$CODEX_HOME/domain-<id>.config.toml` layered on your
 *   config.toml with `-p domain-<id>` (Codex only reads profiles from its own
 *   home; a separate file owned by the office — your config.toml is untouched).
 * - Gemini CLI: `GEMINI_CLI_SYSTEM_SETTINGS_PATH` → `.domain/mcp/<desk>/gemini.json`
 *   (a copy of any real system settings plus these servers; Gemini merges
 *   `mcpServers` with your user and project settings).
 * - OpenCode: `OPENCODE_CONFIG` → `.domain/mcp/<desk>/opencode.json` (merged with your config).
 *
 * Files live under `<project>/.domain/mcp/<desk>/` (git-ignored there), never in
 * a worker's worktree. With no servers, nothing is written and nothing changes.
 */
export function mcpLaunch(agent: AgentKind, servers: McpServer[], opts: { projectDir: string; deskId: string; codexHome?: string }): McpLaunch {
  const list = servers.filter((s) => s.enabled);
  if (!list.length) return { args: [], env: {} };
  const dir = join(opts.projectDir, ".domain", "mcp", opts.deskId.replace(/[^A-Za-z0-9_-]/g, "_"));
  mkdirSync(dir, { recursive: true });
  // Configs may hold tokens: keep this folder out of git whatever the project's .gitignore says.
  writeFileSync(join(dir, ".gitignore"), "*\n");

  if (agent === "claude") {
    const mcpServers: Record<string, unknown> = {};
    for (const s of list) {
      mcpServers[s.name] =
        s.transport === "http" ? { type: "http", url: s.url, headers: s.env } : { type: "stdio", command: s.command, args: s.args, env: s.env };
    }
    const file = join(dir, "claude.json");
    writeFileSync(file, JSON.stringify({ mcpServers }, null, 2));
    return { args: ["--mcp-config", shellPath(file)], env: {} };
  }

  if (agent === "codex") {
    const home = opts.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const id = createHash("sha1").update(resolve(opts.projectDir)).digest("hex").slice(0, 6);
    const profile = `domain-${id}-${opts.deskId.replace(/[^A-Za-z0-9-]/g, "-")}`;
    const lines = ["# Written by domain for one worker's session. Safe to delete.", ""];
    for (const s of list) {
      lines.push(`[mcp_servers.${tomlKey(s.name)}]`);
      if (s.transport === "http") {
        lines.push(`url = ${tomlStr(s.url)}`);
        if (Object.keys(s.env).length) lines.push(`http_headers = { ${Object.entries(s.env).map(([k, v]) => `${tomlKey(k)} = ${tomlStr(v)}`).join(", ")} }`);
      } else {
        lines.push(`command = ${tomlStr(s.command)}`);
        lines.push(`args = [${s.args.map(tomlStr).join(", ")}]`);
        if (Object.keys(s.env).length) lines.push(`env = { ${Object.entries(s.env).map(([k, v]) => `${tomlKey(k)} = ${tomlStr(v)}`).join(", ")} }`);
      }
      lines.push("");
    }
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, `${profile}.config.toml`), lines.join("\n"));
    return { args: ["-p", profile], env: {} };
  }

  if (agent === "gemini") {
    const base = obj(readJson(geminiSystemSettings()));
    const mcpServers: Record<string, unknown> = { ...obj(base.mcpServers) };
    for (const s of list) {
      mcpServers[s.name] = s.transport === "http" ? { httpUrl: s.url, headers: s.env } : { command: s.command, args: s.args, env: s.env };
    }
    const file = join(dir, "gemini.json");
    writeFileSync(file, JSON.stringify({ ...base, mcpServers }, null, 2));
    return { args: [], env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: file } };
  }

  // OpenCode
  const mcp: Record<string, unknown> = {};
  for (const s of list) {
    mcp[s.name] =
      s.transport === "http"
        ? { type: "remote", url: s.url, headers: s.env, enabled: true }
        : { type: "local", command: [s.command, ...s.args], environment: s.env, enabled: true };
  }
  const file = join(dir, "opencode.json");
  writeFileSync(file, JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp }, null, 2));
  return { args: [], env: { OPENCODE_CONFIG: file } };
}

/** The office's servers a worker gets: a character's picks, or every server marked for everyone. */
export function serversFor(all: McpServer[], characterMcp: string[] | null): McpServer[] {
  return all.filter((s) => s.enabled && (characterMcp ? characterMcp.includes(s.id) || s.everyone : s.everyone));
}

// ---------------------------------------------------------------------------
// The module: scan, check, save, delete.
// ---------------------------------------------------------------------------

function display(spec: { transport: string; command: string; args: string[]; url: string }): string {
  return spec.transport === "http" ? spec.url : [spec.command, ...spec.args].join(" ");
}

export function mcpModule(ctx: ServerCtx, paths: Partial<ScanPaths> = {}): Routes {
  const scanPaths = (): ScanPaths => ({ home: paths.home ?? homedir(), projectDir: paths.projectDir ?? ctx.cwd });
  let lastSeen: SeenFull[] = [];
  const health = new Map<string, McpHealth>();
  const sendHealth = () => ctx.broadcast({ t: "mcpHealth", health: [...health.values()] });

  const scan = (): SeenFull[] => {
    const h = ctx.log.start("mcp", "Reading your agents' MCP settings", { topic: "mcp" });
    try {
      lastSeen = scanAgents(scanPaths());
      const by = new Map<string, number>();
      for (const s of lastSeen) by.set(s.agent, (by.get(s.agent) ?? 0) + 1);
      h.done(true, lastSeen.length ? [...by].map(([a, n]) => `${AGENT_LABELS[a as AgentKind]}: ${n} server${n === 1 ? "" : "s"}`).join("\n") : "None set up in any agent yet.");
    } catch (e) {
      h.done(false, (e as Error).message);
    }
    return lastSeen;
  };

  const check = async (key: string, name: string, spec: CheckSpec) => {
    // A server that uses your GitHub sign-in is checked with it (or says to sign in).
    if ((spec as McpServer).auth === "github") {
      const authed = withGithubAuth(spec as McpServer, ctx.githubToken?.() ?? null);
      if (!authed) {
        health.set(key, { key, status: "auth", detail: "Sign in to GitHub first (Office → Projects & GitHub)", checkedAt: Date.now() });
        sendHealth();
        return;
      }
      spec = authed;
    }
    health.set(key, { key, status: "checking", detail: "Checking…", checkedAt: Date.now() });
    sendHealth();
    const h = ctx.log.start("mcp", `Checking ${name}`, { command: display(spec), topic: `mcp:${key}` });
    const r = await checkServer(spec);
    health.set(key, { key, status: r.status, detail: r.detail, tools: r.tools, checkedAt: Date.now() });
    h.done(r.status === "ok", `${r.status === "ok" ? "✓" : r.status === "auth" ? "🔑" : "✗"} ${r.detail}${r.output ? `\n${r.output.trim()}` : ""}`);
    sendHealth();
  };

  return {
    mcpScan: (_msg, _client, ws) => {
      ctx.send(ws, { t: "mcpSeen", seen: scan().map(publicSeen) });
      ctx.send(ws, { t: "mcpHealth", health: [...health.values()] });
    },
    mcpCheck: (msg) => {
      const key = typeof msg.key === "string" ? msg.key : null;
      if (!lastSeen.length) scan();
      const managed = ctx.progress.mcp.filter((s) => !key || s.id === key);
      const theirs = lastSeen.filter((s) => !key || `${s.agent}:${s.name}` === key);
      for (const s of managed) void check(s.id, s.name, s);
      for (const s of theirs) void check(`${s.agent}:${s.name}`, `${s.name} (${AGENT_LABELS[s.agent]})`, s);
    },
    mcpSave: (msg) => {
      const s = coerceMcpServer(msg.server);
      if (!s) return;
      ctx.progress.saveMcp(s);
      const h = ctx.log.start("mcp", `Saved MCP server ${s.name}`, { command: display(s), topic: `mcp:${s.id}` });
      h.done(true, `${s.enabled ? "On" : "Off"}${s.everyone ? " · every new hire gets it" : ""}`);
      // Check it straight away so a broken one shows up now, not mid-task.
      if (s.enabled) void check(s.id, s.name, ctx.progress.mcp.find((x) => x.id === s.id) ?? s);
    },
    mcpDelete: (msg) => {
      if (typeof msg.id !== "string") return;
      const s = ctx.progress.mcp.find((x) => x.id === msg.id);
      ctx.progress.deleteMcp(msg.id);
      health.delete(msg.id);
      sendHealth();
      if (s) ctx.log.start("mcp", `Removed MCP server ${s.name}`, { topic: `mcp:${s.id}` }).done(true);
    },
  };
}

/** For a log line about a launch: which servers a worker got, without secrets. */
export function describeLaunch(agent: AgentKind, servers: McpServer[], launch: McpLaunch): string {
  const names = servers.filter((s) => s.enabled).map((s) => s.name).join(", ");
  const how = [...launch.args, ...Object.keys(launch.env).map((k) => `${k}=…`)].join(" ");
  return `${AGENT_LABELS[agent]} gets ${names}${how ? ` (${how})` : ""}`;
}

/** A server that uses your GitHub sign-in, with the sign-in's token as its header; null when not signed in. */
export function withGithubAuth(s: McpServer, token: string | null): McpServer | null {
  if (s.auth !== "github") return s;
  if (!token) return null;
  return { ...s, env: { ...s.env, Authorization: `Bearer ${token}` } };
}

/**
 * Remove the per-session MCP configs written for a desk (or every desk): they
 * can hold tokens, so they don't outlive the worker or the office.
 */
export function mcpCleanup(projectDir: string, deskId?: string, codexHome?: string): void {
  const base = join(projectDir, ".domain", "mcp");
  try {
    if (deskId) rmSync(join(base, deskId.replace(/[^A-Za-z0-9_-]/g, "_")), { recursive: true, force: true });
    else rmSync(base, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  const home = codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const id = createHash("sha1").update(resolve(projectDir)).digest("hex").slice(0, 6);
  const prefix = `domain-${id}-`;
  const desk = deskId?.replace(/[^A-Za-z0-9-]/g, "-");
  try {
    for (const f of readdirSync(home)) {
      if (f.startsWith(prefix) && f.endsWith(".config.toml") && (!desk || f === `${prefix}${desk}.config.toml`)) rmSync(join(home, f), { force: true });
    }
  } catch {
    /* no codex home */
  }
}
