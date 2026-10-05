import { test } from "node:test";
import assert from "node:assert/strict";
import { agentsModule } from "../src/server/agents.ts";
import { OpLogger } from "../src/server/oplog.ts";
import type { ServerCtx } from "../src/server/ctx.ts";
import type { AgentKind, ServerMessage } from "../src/shared/protocol.ts";
import type { AgentsState } from "../src/shared/agents.ts";

const ws = {} as never;
const client = { id: "c1", name: "Ann", alive: true, joined: true, role: "host" as const };

function setup(opts: { npm?: boolean; works?: boolean } = {}) {
  const have = new Set<AgentKind>(["codex"]);
  const sent: AgentsState[] = [];
  const logs: { title: string; status: string; output: string }[] = [];
  const log = new OpLogger();
  log.onEntry = (e) => {
    if (e.status !== "running") logs.push({ title: e.title, status: e.status, output: (e as { output?: string }).output ?? "" });
  };
  const installs: string[] = [];
  let finish: (() => void) | null = null;
  const ctx = {
    log,
    send: (_ws: unknown, m: ServerMessage) => m.t === "agents" && sent.push(m.state),
    broadcast: (m: ServerMessage) => m.t === "agents" && sent.push(m.state),
  } as unknown as ServerCtx;
  const routes = agentsModule(ctx, {
    installed: (a) => have.has(a),
    hasNpm: () => opts.npm !== false,
    install: (pkg, out) =>
      new Promise((done) => {
        installs.push(pkg);
        out("added 12 packages\n");
        finish = () => {
          if (opts.works !== false) have.add("claude");
          done(opts.works !== false);
        };
      }),
  });
  return { routes, sent, logs, installs, finish: () => finish?.() };
}

test("which agent CLIs are installed", () => {
  const { routes, sent } = setup();
  routes.agentsGet!({ t: "agentsGet" } as never, client, ws);
  assert.deepEqual(sent[0], { installed: { claude: false, codex: true, gemini: false, opencode: false }, installing: null, npm: true });
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
