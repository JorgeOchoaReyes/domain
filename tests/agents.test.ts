import { test } from "node:test";
import assert from "node:assert/strict";
import { agentsModule, cliVersionOf } from "../src/server/agents.ts";
import { OpLogger } from "../src/server/oplog.ts";
import type { ServerCtx } from "../src/server/ctx.ts";
import type { AgentKind, ServerMessage } from "../src/shared/protocol.ts";
import { compareVersions, updateTarget, type AgentsState } from "../src/shared/agents.ts";

const ws = {} as never;
const client = { id: "c1", name: "Ann", alive: true, joined: true, role: "host" as const };

type Desk = { id: string; worker: { agent: AgentKind; status: string } | null };

function setup(opts: { npm?: boolean; works?: boolean; desks?: Desk[]; current?: string; latest?: string; have?: AgentKind[]; own?: AgentKind[] } = {}) {
  const have = new Set<AgentKind>(opts.have ?? ["codex"]);
  const sent: AgentsState[] = [];
  const logs: { title: string; status: string; output: string }[] = [];
  const log = new OpLogger();
  log.onEntry = (e) => {
    if (e.status !== "running") logs.push({ title: e.title, status: e.status, output: (e as { output?: string }).output ?? "" });
  };
  const installs: string[] = [];
  let finish: (() => void) | null = null;
  const desks: Desk[] = opts.desks ?? [];
  const paused: string[] = [];
  const restarted: string[] = [];
  const pins: Record<string, string> = {};
  let current = opts.current ?? "1.0.0";
  const ctx = {
    log,
    office: {
      snapshot: () => ({ desks }),
      pause: (d: string) => {
        paused.push(d);
        desks.find((x) => x.id === d)!.worker!.status = "asleep";
        return true;
      },
      restart: (d: string) => {
        restarted.push(d);
        desks.find((x) => x.id === d)!.worker!.status = "working";
        return true;
      },
    },
    send: (_ws: unknown, m: ServerMessage) => m.t === "agents" && sent.push(m.state),
    broadcast: (m: ServerMessage) => m.t === "agents" && sent.push(m.state),
  } as unknown as ServerCtx;
  const routes = agentsModule(ctx, {
    manual: true,
    versionOf: async (a) => (have.has(a) ? { version: current, via: opts.own?.includes(a) ? ("own" as const) : ("npm" as const) } : null),
    selfUpdate: (command, out) => {
      installs.push(command);
      out("updated\n");
      current = opts.latest ?? current;
      return Promise.resolve(true);
    },
    latestOf: async () => opts.latest ?? "1.0.0",
    pins: () => pins,
    pin: (a, v) => (v ? (pins[a] = v) : delete pins[a]),
    installed: (a) => have.has(a),
    hasNpm: () => opts.npm !== false,
    install: (pkg, out) =>
      new Promise((done) => {
        installs.push(pkg);
        out("added 12 packages\n");
        finish = () => {
          if (opts.works !== false) {
            have.add("claude");
            current = pkg.split("@").at(-1)!.replace(/^[a-z-]+\/.*$/, current);
          }
          done(opts.works !== false);
        };
      }),
  });
  return { routes, sent, logs, installs, paused, restarted, pins, desks, finish: () => finish?.() };
}

test("which agent CLIs are installed", () => {
  const { routes, sent } = setup();
  routes.agentsGet!({ t: "agentsGet" } as never, client, ws);
  assert.deepEqual(sent[0].installed, { claude: false, codex: true, gemini: false, opencode: false });
  assert.equal(sent[0].installing, null);
  assert.equal(sent[0].npm, true);
});

test("installing a missing one runs npm, shows it's busy, then says it's there", async () => {
  const { routes, sent, logs, installs, finish } = setup();
  routes.agentInstall!({ t: "agentInstall", agent: "claude" } as never, client, ws);
  assert.deepEqual(installs, ["@anthropic-ai/claude-code"]);
  assert.equal(sent.at(-1)?.installing, "claude");
  // A second install while one runs is ignored; so is an unknown agent.
  routes.agentInstall!({ t: "agentInstall", agent: "codex" } as never, client, ws);
  routes.agentInstall!({ t: "agentInstall", agent: "rm -rf /" } as never, client, ws);
  assert.equal(installs.length, 1);
  finish();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sent.at(-1)?.installing, null);
  assert.equal(sent.at(-1)?.installed.claude, true);
  assert.equal(logs.at(-1)?.status, "ok");
  assert.match(logs.at(-1)!.title, /Installing Claude Code/);
});

test("no npm: says to get Node.js instead of trying", () => {
  const { routes, installs, logs } = setup({ npm: false });
  routes.agentInstall!({ t: "agentInstall", agent: "gemini" } as never, client, ws);
  assert.equal(installs.length, 0);
  assert.equal(logs.at(-1)?.status, "error");
});

const tick = () => new Promise((r) => setTimeout(r, 0));

test("versions: finds what's installed and the newest, and says once when there's an update", async () => {
  const { routes, sent, logs } = setup({ current: "0.157.0", latest: "0.158.2" });
  routes.agentsCheck!({ t: "agentsCheck" } as never, client, ws);
  await tick();
  assert.deepEqual(sent.at(-1)?.versions.codex, { current: "0.157.0", latest: "0.158.2", pinned: null, via: "npm" });
  assert.match(logs.at(-1)!.title, /Codex 0\.158\.2 is out/);
  const n = logs.length;
  routes.agentsCheck!({ t: "agentsCheck" } as never, client, ws);
  await tick();
  assert.equal(logs.length, n);
});

test("an update waits for busy workers, pauses the free ones, installs, and restarts them", async () => {
  const desks: Desk[] = [
    { id: "desk-1", worker: { agent: "codex", status: "working" } },
    { id: "desk-2", worker: { agent: "codex", status: "idle" } },
    { id: "desk-3", worker: { agent: "claude", status: "working" } },
  ];
  const { routes, sent, installs, paused, restarted, finish } = setup({ desks, current: "0.157.0", latest: "0.158.2" });
  routes.agentsCheck!({ t: "agentsCheck" } as never, client, ws);
  await tick();
  routes.agentUpdate!({ t: "agentUpdate", agent: "codex" } as never, client, ws);
  // desk-1 is mid-task: nothing yet.
  assert.deepEqual(installs, []);
  assert.deepEqual(sent.at(-1)?.queued, ["codex"]);
  desks[0].worker!.status = "idle";
  // Asking again while queued doesn't queue it twice; it runs now that everyone's free.
  routes.agentUpdate!({ t: "agentUpdate", agent: "codex" } as never, client, ws);
  assert.deepEqual(installs, ["@openai/codex@0.158.2"]);
  assert.deepEqual(paused, ["desk-1", "desk-2"]);
  assert.equal(sent.at(-1)?.updating, "codex");
  finish();
  await tick();
  await tick();
  assert.deepEqual(restarted, ["desk-1", "desk-2"]);
  assert.equal(sent.at(-1)?.updating, null);
  assert.equal(sent.at(-1)?.versions.codex?.current, "0.158.2");
});

test("pinning a version: updates install that one, and a bad version is refused", async () => {
  const { routes, sent, installs, pins, finish } = setup({ current: "0.158.2", latest: "0.158.2" });
  routes.agentPin!({ t: "agentPin", agent: "codex", version: "0.157.0; rm -rf /" } as never, client, ws);
  assert.deepEqual(pins, {});
  routes.agentPin!({ t: "agentPin", agent: "codex", version: "0.157.0" } as never, client, ws);
  assert.deepEqual(pins, { codex: "0.157.0" });
  routes.agentsCheck!({ t: "agentsCheck" } as never, client, ws);
  await tick();
  assert.equal(sent.at(-1)?.versions.codex?.pinned, "0.157.0");
  routes.agentUpdate!({ t: "agentUpdate", agent: "codex" } as never, client, ws);
  assert.deepEqual(installs, ["@openai/codex@0.157.0"]);
  finish();
  await tick();
  routes.agentPin!({ t: "agentPin", agent: "codex", version: null } as never, client, ws);
  assert.deepEqual(pins, {});
});

test("updateTarget and compareVersions", () => {
  assert.equal(compareVersions("0.158.0", "0.157.9"), 1);
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), -1);
  assert.equal(compareVersions("2.0.10", "2.0.9"), 1);
  const npm = "npm" as const;
  assert.equal(updateTarget({ current: "1.0.0", latest: "1.1.0", pinned: null, via: npm }), "1.1.0");
  assert.equal(updateTarget({ current: "1.1.0", latest: "1.1.0", pinned: null, via: npm }), null);
  assert.equal(updateTarget({ current: "1.1.0", latest: "1.2.0", pinned: "1.1.0", via: npm }), null);
  assert.equal(updateTarget({ current: "1.2.0", latest: "1.2.0", pinned: "1.1.0", via: npm }), "1.1.0");
  assert.equal(updateTarget({ current: null, latest: "1.2.0", pinned: null, via: npm }), null);
});

test("a CLI with its own installer: Claude Code updates itself; others are left to theirs", async () => {
  const { routes, sent, installs, logs } = setup({ have: ["claude", "codex"], own: ["claude", "codex"], current: "2.1.0", latest: "2.2.0" });
  routes.agentsCheck!({ t: "agentsCheck" } as never, client, ws);
  await tick();
  assert.equal(sent.at(-1)?.versions.claude?.via, "own");
  // Only the one the office can update is offered.
  assert.equal(logs.filter((l) => /is out/.test(l.title)).length, 1);
  routes.agentUpdate!({ t: "agentUpdate", agent: "codex" } as never, client, ws);
  assert.deepEqual(installs, []);
  routes.agentUpdate!({ t: "agentUpdate", agent: "claude" } as never, client, ws);
  assert.deepEqual(installs, ["claude update"]);
  await tick();
  await tick();
  assert.equal(sent.at(-1)?.versions.claude?.current, "2.2.0");
  assert.equal(logs.at(-1)?.status, "ok");
});

test("cliVersionOf reads a CLI's --version", async () => {
  assert.equal(await cliVersionOf("node"), process.version.slice(1));
});
