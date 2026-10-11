import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowed, MINE_MESSAGES } from "../src/server/permissions.ts";
import { MyTerminals, mineModule, mineShells, revealCommand, type MineShell, type SpawnFn } from "../src/server/mine.ts";
import type { IPty } from "../src/server/ptyWorker.ts";
import type { ClientRec, ServerCtx } from "../src/server/ctx.ts";
import type { ServerMessage } from "../src/shared/protocol.ts";
import { lastLines } from "../src/shared/mine.ts";

/** A pretend terminal: remembers what was typed, and prints when told to. */
class FakePty implements IPty {
  written: string[] = [];
  killed = false;
  size = { cols: 0, rows: 0 };
  private data: ((d: string) => void)[] = [];
  private exit: ((e: { exitCode: number }) => void)[] = [];
  constructor(
    readonly file: string,
    readonly opts: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number },
  ) {
    this.size = { cols: opts.cols, rows: opts.rows };
  }
  onData(cb: (d: string) => void): void {
    this.data.push(cb);
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exit.push(cb);
  }
  write(d: string): void {
    this.written.push(d);
  }
  resize(cols: number, rows: number): void {
    this.size = { cols, rows };
  }
  kill(): void {
    this.killed = true;
  }
  print(d: string): void {
    for (const cb of this.data) cb(d);
  }
  quit(): void {
    for (const cb of this.exit) cb({ exitCode: 0 });
  }
}

const SHELLS: MineShell[] = [
  { id: "pwsh", label: "PowerShell", file: "pwsh.exe", args: ["-NoLogo"] },
  { id: "cmd", label: "Command Prompt", file: "cmd.exe", args: [] },
];

function setup(max = 6, scrollback?: number) {
  const root = mkdtempSync(join(tmpdir(), "mine-"));
  const project = join(root, "project");
  const repo = join(root, "other-repo");
  const outside = join(root, "elsewhere");
  for (const d of [project, repo, outside]) mkdirSync(d);
  const ptys: FakePty[] = [];
  const spawn: SpawnFn = (file, _args, opts) => {
    const p = new FakePty(file, opts);
    ptys.push(p);
    return p;
  };
  const terms = new MyTerminals({ folders: () => [project, repo], shells: SHELLS, agents: () => ["claude"], spawn, max, scrollback, env: { PATH: "x", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", HOME: "h" } });
  return { terms, ptys, project, repo, outside };
}

test("Mine is the host's alone: teammates and visitors may not send any of it", () => {
  assert.ok(MINE_MESSAGES.length >= 7);
  for (const t of MINE_MESSAGES) {
    assert.equal(allowed("host", t), true, t);
    assert.equal(allowed("teammate", t), false, t);
    assert.equal(allowed("visitor", t), false, t);
  }
});

test("a tab starts only in the project or an open repo, and only in a shell from the server's list", () => {
  const { terms, ptys, project, repo, outside } = setup();
  const a = terms.open({});
  assert.ok(!("error" in a));
  assert.equal(a.folder, project, "the project by default");
  assert.equal(a.shell, "pwsh", "the first shell by default");
  assert.equal(ptys[0].opts.cwd, project);
  const b = terms.open({ folder: repo + "/", shell: "cmd" });
  assert.ok(!("error" in b) && b.folder === repo && b.shell === "cmd");
  assert.ok("error" in terms.open({ folder: outside }), "an arbitrary folder");
  assert.ok("error" in terms.open({ folder: join(project, "..", "elsewhere") }), "climbing out of the project");
  assert.ok("error" in terms.open({ folder: 42 }));
  assert.ok("error" in terms.open({ shell: "C:/evil.exe" }), "a shell the server doesn't offer");
  assert.ok("error" in terms.open({ shell: "/bin/sh" }));
  assert.equal(ptys.length, 2, "nothing spawned for the refused ones");
});

test("your own agent session: the CLI typed into a plain shell, with none of the office's environment", () => {
  const { terms, ptys } = setup();
  const t = terms.open({ agent: "claude" });
  assert.ok(!("error" in t));
  assert.equal(t.agent, "claude");
  assert.match(t.title, /Claude Code \(mine\)/);
  assert.deepEqual(ptys[0].written, ["claude\r"]);
  const env = ptys[0].opts.env;
  assert.equal(env.CLAUDECODE, undefined, "a parent Claude Code's markers are gone");
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(env.PATH, "x");
  assert.ok(!Object.keys(env).some((k) => k.startsWith("DOMAIN_")), "not a worker: no desk, no report files");
  assert.ok("error" in terms.open({ agent: "codex" }), "an agent CLI that isn't installed");
  assert.ok("error" in terms.open({ agent: "rm -rf /" }));
});

test("tab lifecycle: output kept (capped) for coming back, typing and resizing, closing kills, at most N tabs", () => {
  const { terms, ptys } = setup(3, 100);
  const out: [string, string][] = [];
  let changes = 0;
  terms.onOutput = (id, d) => out.push([id, d]);
  terms.onChange = () => changes++;
  const t = terms.open({ cols: 120, rows: 40 }) as { id: string };
  assert.deepEqual(ptys[0].size, { cols: 120, rows: 40 });
  ptys[0].print("hello-from-mine\r\n");
  assert.deepEqual(out, [[t.id, "hello-from-mine\r\n"]]);
  assert.equal(terms.scrollback(t.id), "hello-from-mine\r\n");
  ptys[0].print("x".repeat(500));
  assert.equal(terms.scrollback(t.id)!.length, 100, "the scrollback is capped");

  assert.ok(terms.write(t.id, "echo hi\r"));
  assert.equal(ptys[0].written.at(-1), "echo hi\r");
  assert.ok(!terms.write(t.id, "x".repeat(70_000)), "too big a paste");
  assert.ok(!terms.write("nope", "ls\r"));
  assert.ok(terms.resize(t.id, 9999, 1));
  assert.deepEqual(ptys[0].size, { cols: 400, rows: 5 }, "sizes are clamped");

  terms.open({});
  terms.open({});
  const fourth = terms.open({});
  assert.ok("error" in fourth && /3 tabs/.test(fourth.error), "capped");

  // The shell exits by itself: the tab stays (ended) until you close it.
  ptys[1].quit();
  assert.equal(terms.tabs()[1].alive, false);
  assert.ok(!terms.write(terms.tabs()[1].id, "ls\r"));

  const before = changes;
  assert.ok(terms.close(t.id));
  assert.ok(ptys[0].killed, "closing a tab kills its shell");
  assert.equal(terms.tabs().length, 2);
  assert.ok(changes > before);
  assert.equal(terms.scrollback(t.id), null);

  terms.disposeAll();
  assert.ok(ptys.every((p) => p.killed), "the server stopping ends every tab");
  assert.equal(terms.tabs().length, 0);
});

test("the server's shells: PowerShell 7 if present, else Windows PowerShell; your $SHELL elsewhere", () => {
  const win7 = mineShells("win32", { COMSPEC: "C:\\Windows\\System32\\cmd.exe" }, (c) => (c === "pwsh" ? "C:\\pwsh\\pwsh.exe" : null), () => false);
  assert.equal(win7[0].id, "pwsh");
  assert.equal(win7[0].file, "C:\\pwsh\\pwsh.exe");
  assert.ok(win7.some((s) => s.id === "cmd"));
  const win5 = mineShells("win32", {}, (c) => (c === "powershell" ? "C:\\ps\\powershell.exe" : null), () => false);
  assert.equal(win5[0].id, "powershell");
  const gitBash = mineShells("win32", { ProgramFiles: "C:\\PF" }, () => null, (p) => p === join("C:\\PF", "Git", "bin", "bash.exe"));
  assert.ok(gitBash.some((s) => s.id === "gitbash"));
  const mac = mineShells("darwin", { SHELL: "/bin/zsh" }, (c) => (c === "bash" ? "/bin/bash" : null), (p) => p === "/bin/zsh" || p === "/bin/bash");
  assert.deepEqual(mac.map((s) => s.id), ["zsh", "bash"]);
});

test("opening a folder: VS Code or the file manager, with the folder as an argument", () => {
  assert.deepEqual(revealCommand("files", "C:\\p", "win32"), { file: "explorer.exe", args: ["C:\\p"], shell: false });
  assert.deepEqual(revealCommand("files", "/p", "darwin"), { file: "open", args: ["/p"], shell: false });
  assert.deepEqual(revealCommand("files", "/p", "linux"), { file: "xdg-open", args: ["/p"], shell: false });
  assert.equal(revealCommand("code", "/p", "linux", null), null, "no code on PATH: no button");
  assert.deepEqual(revealCommand("code", "/p", "linux", "/usr/bin/code"), { file: "/usr/bin/code", args: ["/p"], shell: false });
  assert.deepEqual(revealCommand("code", "C:\\my p", "win32", "C:\\VS\\bin\\code.cmd"), { file: '"C:\\VS\\bin\\code.cmd"', args: ['"C:\\my p"'], shell: true });
});

test("the module: only host clients get a tab's output; a teammate's messages do nothing", () => {
  const { terms, ptys, project } = setup();
  type Sock = { name: string; sent: ServerMessage[]; once: (e: string, cb: () => void) => void };
  const mk = (name: string): Sock => ({ name, sent: [], once: () => {} });
  const hostWs = mk("host");
  const otherHostTab = mk("host2");
  const mateWs = mk("mate");
  const visitorWs = mk("visitor");
  const clients = new Map<unknown, ClientRec>([
    [hostWs, { id: "1", name: "You", alive: true, joined: true, role: "host" }],
    [otherHostTab, { id: "4", name: "You", alive: true, joined: true, role: "host" }],
    [mateWs, { id: "2", name: "Mate", alive: true, joined: true, role: "teammate" }],
    [visitorWs, { id: "3", name: "Vis", alive: true, joined: true, role: "visitor" }],
  ]);
  const ctx = {
    cwd: project,
    simulate: true,
    clients: () => clients,
    send: (ws: Sock, m: ServerMessage) => ws.sent.push(m),
    broadcast: () => assert.fail("Mine never broadcasts"),
  } as unknown as ServerCtx;
  const routes = mineModule(ctx, terms);
  const call = (t: string, msg: Record<string, unknown>, ws: Sock) => routes[t]!({ t, ...msg } as never, clients.get(ws)!, ws as never);

  // A teammate (or visitor) gets nothing back and starts nothing, even if a message slips through.
  call("mineGet", {}, mateWs);
  call("mineOpen", {}, mateWs);
  call("mineGet", {}, visitorWs);
  call("mineOpen", {}, visitorWs);
  assert.equal(ptys.length, 0);
  assert.deepEqual(mateWs.sent, []);
  assert.deepEqual(visitorWs.sent, []);

  call("mineGet", {}, hostWs);
  call("mineOpen", { folder: project }, hostWs);
  assert.equal(ptys.length, 1);
  const opened = hostWs.sent.find((m) => m.t === "mine" && m.opened) as Extract<ServerMessage, { t: "mine" }>;
  assert.ok(opened?.opened);
  const id = opened.opened!;

  // The teammate tries to read and type into it.
  call("mineAttach", { tabId: id }, mateWs);
  call("mineInput", { tabId: id, data: "whoami\r" }, mateWs);
  call("mineClose", { tabId: id }, mateWs);
  assert.deepEqual(ptys[0].written, []);
  assert.ok(!ptys[0].killed);

  ptys[0].print("hello-from-mine\r\n");
  assert.ok(hostWs.sent.some((m) => m.t === "mineOutput" && m.data.includes("hello-from-mine")));
  assert.ok(!otherHostTab.sent.length, "a host page that never opened Mine isn't sent it either");
  for (const ws of [mateWs, visitorWs]) assert.ok(!ws.sent.some((m) => m.t.startsWith("mine")), `${ws.name} never sees it`);

  call("mineInput", { tabId: id, data: "echo hello-from-mine\r" }, hostWs);
  assert.deepEqual(ptys[0].written, ["echo hello-from-mine\r"]);
  call("mineAttach", { tabId: id }, hostWs);
  assert.ok(hostWs.sent.some((m) => m.t === "mineScrollback" && m.data.includes("hello-from-mine")));
  call("mineClose", { tabId: id }, hostWs);
  assert.ok(ptys[0].killed);
  terms.disposeAll();
});

test("handing a tab to the team: its last lines", () => {
  const text = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\r\n") + "\n\n\n";
  const got = lastLines(text, 40).split("\n");
  assert.equal(got.length, 40);
  assert.equal(got[0], "line 20");
  assert.equal(got.at(-1), "line 59");
});
