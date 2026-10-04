import { spawn } from "node:child_process";
import { AGENT_PACKAGES, type AgentsState } from "../shared/agents.js";
import { AGENT_LABELS, type AgentKind } from "../shared/protocol.js";
import type { Routes, ServerCtx } from "./ctx.js";
import { agentInstalled, findOnPath } from "./workerSession.js";

/**
 * The agent CLIs on this machine: which are installed, and installing a
 * missing one with npm (`npm install -g <package>`), its output streamed to
 * the logs. Installing is the host's to do (permissions.ts).
 */

const KINDS = Object.keys(AGENT_PACKAGES) as AgentKind[];

export interface AgentsDeps {
  /** Run the install; resolves to whether it worked. Tests swap it out. */
  install?: (pkg: string, onOutput: (text: string) => void) => Promise<boolean>;
  installed?: (agent: AgentKind) => boolean;
  hasNpm?: () => boolean;
}

export function npmInstall(pkg: string, onOutput: (text: string) => void): Promise<boolean> {
  return new Promise((done) => {
    // A fixed command with a package name from our own list: npm is a script on Windows, so it needs a shell.
    const child = spawn(`npm install -g ${pkg}`, { shell: true, windowsHide: true, env: { ...process.env, npm_config_fund: "false", npm_config_audit: "false" } });
    const take = (b: Buffer) => onOutput(b.toString("utf8").replace(/\r(?!\n)/g, "\n"));
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0));
  });
}

export function agentsModule(ctx: ServerCtx, deps: AgentsDeps = {}): Routes {
  const install = deps.install ?? npmInstall;
  const installed = deps.installed ?? agentInstalled;
  const hasNpm = deps.hasNpm ?? (() => findOnPath("npm") !== null);
  let installing: AgentKind | null = null;

  const state = (): AgentsState => ({
    installed: Object.fromEntries(KINDS.map((k) => [k, installed(k)])) as Record<AgentKind, boolean>,
    installing,
    npm: hasNpm(),
  });

  return {
    agentsGet: (_msg, _client, ws) => ctx.send(ws, { t: "agents", state: state() }),
    agentInstall: (msg) => {
      const agent = (msg as { agent?: unknown }).agent;
      if (typeof agent !== "string" || !(agent in AGENT_PACKAGES) || installing) return;
      const kind = agent as AgentKind;
      const pkg = AGENT_PACKAGES[kind];
      const op = ctx.log.start("agent", `Installing ${AGENT_LABELS[kind]}`, { command: `npm install -g ${pkg}`, topic: "agents" });
      if (!hasNpm()) {
        op.done(false, "npm isn't installed. Install Node.js from https://nodejs.org (it includes npm), then try again.");
        return;
      }
      installing = kind;
      ctx.broadcast({ t: "agents", state: state() });
      void install(pkg, (t) => op.append(t)).then((ok) => {
        installing = null;
        const found = installed(kind);
        if (ok && found) op.done(true, `${AGENT_LABELS[kind]} is installed — hire one at any desk.`);
        else if (ok) op.done(true, `Installed, but its command isn't on this app's PATH yet — restart the app.`);
        else op.done(false, `npm couldn't install ${pkg} — see the output above.`);
        ctx.broadcast({ t: "agents", state: state() });
      });
    },
  };
}
