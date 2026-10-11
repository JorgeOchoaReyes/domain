import { spawn as spawnProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { WebSocket } from "ws";
import { AGENT_KINDS, AGENT_LABELS, type AgentKind, type ServerMessage } from "../shared/protocol.js";
import { MAX_MINE_TABS, MINE_MAX_INPUT, MINE_SCROLLBACK, type MineFolder, type MineShellChoice, type MineState, type MineTab } from "../shared/mine.js";
import type { ClientRec, Routes, ServerCtx } from "./ctx.js";
import { samePath } from "./prefs.js";
import { spawnPty, workerEnv, type IPty } from "./ptyWorker.js";
import { AGENT_COMMAND, agentInstalled, findOnPath } from "./workerSession.js";

/**
 * 💻 Mine: the host's own terminals, on the laptop. Each tab is a real shell
 * on this computer, started in the project or an open repo — or your own agent
 * CLI in one ("Claude Code (mine)"): a plain interactive session, not a
 * worker (no desk, no brief, no report files, not in the monitor or review).
 *
 * This is a real shell on the host's computer, so:
 * - only the host may use any of it (permissions.ts, and each route checks the
 *   role again);
 * - its output is never broadcast: it goes only to host clients that asked;
 * - the folder must be the project or an open repo, the shell one from the
 *   server's own list, and input and sizes are capped.
 *
 * Tabs live on the server (with a capped scrollback), so they survive closing
 * the laptop and reloading the page; they end when you close them or the
 * server stops.
 */

export interface MineShell extends MineShellChoice {
  file: string;
  args: string[];
}

/** The shells this computer offers, the first being the default. */
export function mineShells(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, onPath: (cmd: string) => string | null = findOnPath, exists: (p: string) => boolean = existsSync): MineShell[] {
  const out: MineShell[] = [];
  if (platform === "win32") {
    const pwsh = onPath("pwsh");
    if (pwsh) out.push({ id: "pwsh", label: "PowerShell", file: pwsh, args: ["-NoLogo"] });
    else out.push({ id: "powershell", label: "Windows PowerShell", file: onPath("powershell") ?? "powershell.exe", args: ["-NoLogo"] });
    out.push({ id: "cmd", label: "Command Prompt", file: env.COMSPEC || "cmd.exe", args: [] });
    // Git Bash, where Git for Windows puts it (not System32's bash, which is WSL).
    for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs")]) {
      const bash = root && join(root, "Git", "bin", "bash.exe");
      if (bash && exists(bash)) {
        out.push({ id: "gitbash", label: "Git Bash", file: bash, args: ["--login", "-i"] });
        break;
      }
    }
    return out;
  }
  const seen = new Set<string>();
  const add = (file: string | null | undefined) => {
    if (!file || !exists(file)) return;
    const name = basename(file);
    if (seen.has(name)) return;
    seen.add(name);
    out.push({ id: name, label: name, file, args: name === "sh" ? ["-i"] : ["-l", "-i"] });
  };
  add(env.SHELL);
  for (const name of ["bash", "zsh", "fish", "sh"]) add(onPath(name));
  if (!out.length) out.push({ id: "sh", label: "sh", file: "/bin/sh", args: ["-i"] });
  return out;
}

export type SpawnFn = (file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }) => IPty | null;

export interface MyTerminalsOptions {
  /** The folders a tab may start in: the project first, then the open repos. */
  folders: () => string[];
  shells: MineShell[];
  /** Agent CLIs you could run your own session of (installed here). */
  agents: () => AgentKind[];
  spawn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
  max?: number;
  scrollback?: number;
}

interface Live {
  tab: MineTab;
  pty: IPty;
  buf: string;
}

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : dflt);

export class MyTerminals {
  private live = new Map<string, Live>();
  private readonly spawn: SpawnFn;
  readonly max: number;
  private readonly cap: number;
  /** A tab printed something. */
  onOutput: ((tabId: string, data: string) => void) | null = null;
  /** Tabs came, went or ended. */
  onChange: (() => void) | null = null;

  constructor(private readonly opts: MyTerminalsOptions) {
    this.spawn = opts.spawn ?? ((f, a, o) => spawnPty(f, a, o));
    this.max = opts.max ?? MAX_MINE_TABS;
    this.cap = opts.scrollback ?? MINE_SCROLLBACK;
  }

  /** The folder asked for, if it's the project or an open repo (as the server knows it); null otherwise. */
  folder(asked: unknown): string | null {
    const all = this.opts.folders();
    if (asked === undefined || asked === null || asked === "") return all[0] ?? null;
    if (typeof asked !== "string" || asked.length > 1024) return null;
    return all.find((p) => samePath(p, asked)) ?? null;
  }

  shell(asked: unknown): MineShell | null {
    if (asked === undefined || asked === null || asked === "") return this.opts.shells[0] ?? null;
    return this.opts.shells.find((s) => s.id === asked) ?? null;
  }

  tabs(): MineTab[] {
    return [...this.live.values()].map((l) => ({ ...l.tab }));
  }

  /** Open a tab. Returns it, or why not. */
  open(req: { shell?: unknown; agent?: unknown; folder?: unknown; cols?: unknown; rows?: unknown }): MineTab | { error: string } {
    if (this.live.size >= this.max) return { error: `You have ${this.max} tabs open — close one first` };
    const folder = this.folder(req.folder);
    if (!folder) return { error: "That folder isn't the project or an open repo" };
    const shell = this.shell(req.shell);
    if (!shell) return { error: "That shell isn't one this computer offers" };
    let agent: AgentKind | null = null;
    if (req.agent !== undefined && req.agent !== null && req.agent !== "") {
      if (!AGENT_KINDS.includes(req.agent as AgentKind) || !this.opts.agents().includes(req.agent as AgentKind)) return { error: "That agent CLI isn't installed here" };
      agent = req.agent as AgentKind;
    }
    const cols = clampInt(req.cols, 20, 400, 100);
    const rows = clampInt(req.rows, 5, 200, 30);
    let pty: IPty | null;
    try {
      pty = this.spawn(shell.file, shell.args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: folder,
        // Your own environment — minus a parent Claude Code session's markers — and nothing of the office's.
        env: { ...workerEnv(this.opts.env ?? process.env), TERM: "xterm-256color" },
      });
    } catch (e) {
      return { error: `Couldn't start ${shell.label}: ${(e as Error).message}` };
    }
    if (!pty) return { error: "No terminal backend on this computer" };
    const tab: MineTab = { id: randomUUID().slice(0, 8), title: agent ? `${AGENT_LABELS[agent]} (mine)` : shell.label, shell: shell.id, agent, folder, alive: true, startedAt: Date.now() };
    const l: Live = { tab, pty, buf: "" };
    this.live.set(tab.id, l);
    pty.onData((data) => {
      l.buf += data;
      if (l.buf.length > this.cap) l.buf = l.buf.slice(l.buf.length - this.cap);
      if (this.live.get(tab.id) === l) this.onOutput?.(tab.id, data);
    });
    pty.onExit(() => {
      if (this.live.get(tab.id) !== l || !l.tab.alive) return;
      l.tab.alive = false;
      this.onChange?.();
    });
    // Your own session: just the CLI, typed into the shell (so you're back at a prompt when you quit it).
    if (agent) pty.write(`${AGENT_COMMAND[agent]}\r`);
    this.onChange?.();
    return { ...tab };
  }

  scrollback(id: unknown): string | null {
    return typeof id === "string" ? (this.live.get(id)?.buf ?? null) : null;
  }

  write(id: unknown, data: unknown): boolean {
    const l = typeof id === "string" ? this.live.get(id) : undefined;
    if (!l || !l.tab.alive || typeof data !== "string" || !data || data.length > MINE_MAX_INPUT) return false;
    l.pty.write(data);
    return true;
  }

  resize(id: unknown, cols: unknown, rows: unknown): boolean {
    const l = typeof id === "string" ? this.live.get(id) : undefined;
    if (!l || !l.tab.alive || typeof cols !== "number" || typeof rows !== "number") return false;
    try {
      l.pty.resize(clampInt(cols, 20, 400, 100), clampInt(rows, 5, 200, 30));
    } catch {
      /* gone */
    }
    return true;
  }

  /** Close a tab: its shell (and whatever runs in it) is killed. */
  close(id: unknown): boolean {
    const l = typeof id === "string" ? this.live.get(id) : undefined;
    if (!l) return false;
    this.live.delete(l.tab.id);
    try {
      l.pty.kill();
    } catch {
      /* already gone */
    }
    this.onChange?.();
    return true;
  }

  /** The server's stopping: every tab ends. */
  disposeAll(): void {
    for (const id of [...this.live.keys()]) {
      const l = this.live.get(id)!;
      this.live.delete(id);
      try {
        l.pty.kill();
      } catch {
        /* gone */
      }
    }
  }
}

/** Open a folder in VS Code or the file manager (never through a shell with anything the client typed). */
export function revealCommand(how: "code" | "files", folder: string, platform: NodeJS.Platform = process.platform, code: string | null = findOnPath("code")): { file: string; args: string[]; shell: boolean } | null {
  if (how === "code") {
    if (!code) return null;
    // VS Code's launcher on Windows is a .cmd, which only runs through a shell: the folder is
    // one the server knows (the project or an open repo), quoted (Windows paths can't hold a ").
    return platform === "win32" && /\.(cmd|bat)$/i.test(code) ? { file: `"${code}"`, args: [`"${folder}"`], shell: true } : { file: code, args: [folder], shell: false };
  }
  if (platform === "win32") return { file: "explorer.exe", args: [folder], shell: false };
  if (platform === "darwin") return { file: "open", args: [folder], shell: false };
  return { file: "xdg-open", args: [folder], shell: false };
}

/** Who gets a tab's output: host clients that asked for Mine, and nobody else. */
export function mineAudience(subscribers: Iterable<WebSocket>, clients: Map<WebSocket, ClientRec>): WebSocket[] {
  const out: WebSocket[] = [];
  for (const ws of subscribers) if (clients.get(ws)?.role === "host") out.push(ws);
  return out;
}

export function mineModule(ctx: ServerCtx, terms?: MyTerminals): Routes {
  const folders = () => ctx.repos?.all() ?? [ctx.cwd];
  const shells = mineShells();
  const installed = () => AGENT_KINDS.filter((a) => agentInstalled(a));
  let agentsSeen: AgentKind[] = installed();
  const my = terms ?? new MyTerminals({ folders, shells, agents: () => (agentsSeen = installed()) });
  const code = findOnPath("code") !== null;
  /** Host clients looking at Mine (they asked): the only ones its output goes to. */
  const subscribers = new Set<WebSocket>();
  const isHost = (c: ClientRec) => c.role === "host";

  const state = (): MineState => ({
    tabs: my.tabs(),
    shells: shells.map(({ id, label }) => ({ id, label })),
    agents: agentsSeen.map((id) => ({ id, label: `${AGENT_LABELS[id]} (mine)` })),
    folders: folders().map((path, i): MineFolder => ({ path, name: basename(path), main: i === 0 })),
    code,
    max: my.max,
  });
  const toHosts = (msg: ServerMessage) => {
    for (const ws of mineAudience(subscribers, ctx.clients())) ctx.send(ws, msg);
  };
  my.onOutput = (tabId, data) => toHosts({ t: "mineOutput", tabId, data });
  my.onChange = () => toHosts({ t: "mine", state: state() });
  const subscribe = (ws: WebSocket) => {
    if (subscribers.has(ws)) return;
    subscribers.add(ws);
    ws.once("close", () => subscribers.delete(ws));
  };
  const warn = (ws: WebSocket, text: string) => ctx.send(ws, { t: "loop", goalId: "", event: "warn", text: `💻 ${text}` });
  process.once("exit", () => my.disposeAll());

  return {
    mineGet: (_msg, client, ws) => {
      if (!isHost(client)) return;
      subscribe(ws);
      agentsSeen = installed();
      ctx.send(ws, { t: "mine", state: state() });
    },
    mineOpen: (msg, client, ws) => {
      if (!isHost(client)) return;
      subscribe(ws);
      const got = my.open({ shell: msg.shell, agent: msg.agent, folder: msg.folder, cols: msg.cols, rows: msg.rows });
      if ("error" in got) {
        warn(ws, got.error);
        return;
      }
      ctx.send(ws, { t: "mine", state: state(), opened: got.id });
    },
    mineAttach: (msg, client, ws) => {
      if (!isHost(client)) return;
      subscribe(ws);
      const data = my.scrollback(msg.tabId);
      if (data !== null) ctx.send(ws, { t: "mineScrollback", tabId: msg.tabId as string, data });
    },
    mineInput: (msg, client) => {
      if (isHost(client)) my.write(msg.tabId, msg.data);
    },
    mineResize: (msg, client) => {
      if (isHost(client)) my.resize(msg.tabId, msg.cols, msg.rows);
    },
    mineClose: (msg, client) => {
      if (isHost(client)) my.close(msg.tabId);
    },
    mineReveal: (msg, client, ws) => {
      if (!isHost(client)) return;
      const folder = my.folder(msg.folder);
      const how = msg.how === "code" ? "code" : msg.how === "files" ? "files" : null;
      if (!folder || !how) return;
      const run = revealCommand(how, folder);
      if (!run) return warn(ws, "VS Code's `code` command isn't on your PATH");
      // A simulated office (the tests) never opens windows on your desktop.
      if (ctx.simulate) return warn(ws, `(simulated) would open ${basename(folder)} ${how === "code" ? "in VS Code" : "in your file manager"}`);
      try {
        const child = spawnProcess(run.file, run.args, { cwd: folder, detached: true, stdio: "ignore", shell: run.shell, windowsHide: true });
        child.on("error", () => warn(ws, `Couldn't open ${basename(folder)}`));
        child.unref();
      } catch {
        warn(ws, `Couldn't open ${basename(folder)}`);
      }
    },
  };
}
