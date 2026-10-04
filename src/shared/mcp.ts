import type { AgentKind } from "./protocol.js";

/**
 * MCP servers: the tools your workers can call. The office keeps its own list
 * (added once, given to the workers you choose) and shows the ones each agent
 * CLI already loads from its own config, with a health check for each.
 */

export interface McpServer {
  id: string;
  name: string;
  transport: "stdio" | "http";
  /** stdio: the program and its arguments. */
  command: string;
  args: string[];
  /** http: the server's URL. */
  url: string;
  /** Environment for a stdio server, or headers for an http one (values may be secrets: never logged). */
  env: Record<string, string>;
  /** Off: no worker gets it. */
  enabled: boolean;
  /** Every new hire gets it (characters can still opt out). */
  everyone: boolean;
  /**
   * "github": authenticated with your GitHub sign-in (the same one git uses).
   * No token is stored with the server: the office adds it when a worker
   * starts or a check runs.
   */
  auth?: "github";
}

/** GitHub's own MCP server: issues, pull requests, code search, actions. */
export const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";

/** A server an agent CLI already loads from its own config (read-only here). */
export interface McpSeen {
  agent: AgentKind;
  name: string;
  /** Where it's configured, e.g. "~/.claude.json" or ".mcp.json". */
  source: string;
  transport: "stdio" | "http";
  /** The command or URL (no env values, no headers). */
  target: string;
}

export interface McpHealth {
  /** A managed server's id, or "<agent>:<name>" for one an agent loads itself. */
  key: string;
  status: "ok" | "auth" | "error" | "checking";
  /** "12 tools", "needs sign-in", the error. */
  detail: string;
  tools?: number;
  checkedAt: number;
}

/** What a secret looks like to clients; saving it unchanged keeps the stored value. */
export const SECRET_MASK = "••••••";

function clean(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export function coerceMcpServer(raw: unknown): McpServer | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = clean(o.name, 40).replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  if (!name) return null;
  const transport = o.transport === "http" ? "http" : "stdio";
  const command = clean(o.command, 400);
  const url = clean(o.url, 500);
  if (transport === "stdio" && !command) return null;
  if (transport === "http" && !/^https?:\/\//i.test(url)) return null;
  const env: Record<string, string> = {};
  if (o.env && typeof o.env === "object") {
    for (const [k, v] of Object.entries(o.env as Record<string, unknown>).slice(0, 30)) {
      if (/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(k) && typeof v === "string") env[k] = v.slice(0, 2000);
    }
  }
  return {
    id: typeof o.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(o.id) ? o.id : Math.random().toString(36).slice(2, 10),
    name,
    transport,
    command: transport === "stdio" ? command : "",
    args: transport === "stdio" && Array.isArray(o.args) ? o.args.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 400)).slice(0, 40) : [],
    url: transport === "http" ? url : "",
    env,
    enabled: o.enabled !== false,
    everyone: o.everyone === true,
    ...(o.auth === "github" && transport === "http" ? { auth: "github" as const } : {}),
  };
}
