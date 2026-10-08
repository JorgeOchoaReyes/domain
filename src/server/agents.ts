import { spawn } from "node:child_process";
import { AGENT_PACKAGES, SELF_UPDATE, VERSION_RE, canUpdate, updateTarget, type AgentVersion, type AgentsState } from "../shared/agents.js";
import { AGENT_LABELS, type AgentKind } from "../shared/protocol.js";
import type { Routes, ServerCtx } from "./ctx.js";
import { loadPrefs, pinAgent } from "./prefs.js";
import { AGENT_COMMAND, agentInstalled, findOnPath } from "./workerSession.js";

/**
 * The agent CLIs on this machine: which are installed, and installing a
 * missing one with npm (`npm install -g <package>`), its output streamed to
 * the logs. Installing is the host's to do (permissions.ts).
 *
 * Updates too: every few hours it looks up each CLI's version and the newest
 * on npm, and offers the update (an out-of-date CLI can stop working — Codex
 * 0.157 hung at "model: loading"). An update you ask for waits until none of
 * that agent's workers is busy, pauses the free ones (a running CLI holds its
 * files on Windows), installs, and starts them again in their conversations.
 * Pin a version and updates install that one instead. A CLI installed with
 * its own installer is updated its own way (`claude update`), when it has one.
 */

const KINDS = Object.keys(AGENT_PACKAGES) as AgentKind[];
/** How often to look for new versions. */
const CHECK_EVERY = 6 * 60 * 60 * 1000;
/** How often a queued update looks again for its workers being free. */
const RETRY_EVERY = 15_000;

export interface AgentsDeps {
  /** Run the install; resolves to whether it worked. Tests swap it out. */
  install?: (pkg: string, onOutput: (text: string) => void) => Promise<boolean>;
  /** Run a CLI's own update command (`claude update`). */
  selfUpdate?: (command: string, onOutput: (text: string) => void) => Promise<boolean>;
  installed?: (agent: AgentKind) => boolean;
  hasNpm?: () => boolean;
  /** The installed version of an agent's CLI, and how it was installed (null: couldn't tell). */
  versionOf?: (agent: AgentKind) => Promise<{ version: string; via: AgentVersion["via"] } | null>;
  /** The newest version on npm (null: couldn't tell). */
  latestOf?: (pkg: string) => Promise<string | null>;
  /** Versions you've pinned, and pinning one. */
  pins?: () => Record<string, string>;
  pin?: (agent: AgentKind, version: string | null) => void;
  now?: () => number;
  /** Don't look things up on a timer (tests). */
  manual?: boolean;
}

export function npmInstall(pkg: string, onOutput: (text: string) => void): Promise<boolean> {
  return runShell(`npm install -g ${pkg}`, onOutput);
}

/** Run a fixed command of ours (npm is a script on Windows, so it needs a shell), its output streamed. */
export function runShell(command: string, onOutput: (text: string) => void): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn(command, { shell: true, windowsHide: true, env: { ...process.env, npm_config_fund: "false", npm_config_audit: "false" } });
    const take = (b: Buffer) => onOutput(b.toString("utf8").replace(/\r(?!\n)/g, "\n"));
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0));
  });
}

/** What a command prints (null if it failed or took too long). */
function shellOut(command: string): Promise<string | null> {
  return new Promise((done) => {
    const child = spawn(command, { shell: true, windowsHide: true });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      done(null);
    }, 30_000);
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.on("error", () => {
      clearTimeout(timer);
      done(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0 || out ? out : null);
    });
  });
}

/** The installed version of a global package, from `npm ls -g`. */
export async function npmVersionOf(pkg: string): Promise<string | null> {
  const out = await shellOut(`npm ls -g ${pkg} --json --depth=0`);
  try {
    const v = (JSON.parse(out ?? "") as { dependencies?: Record<string, { version?: string }> }).dependencies?.[pkg]?.version;
    return typeof v === "string" && VERSION_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** The newest version of a package on npm. */
export async function npmLatestOf(pkg: string): Promise<string | null> {
  const v = (await shellOut(`npm view ${pkg} version`))?.trim() ?? "";
  return VERSION_RE.test(v) ? v : null;
}

/** The version a CLI says it is (`codex --version` → "codex-cli 0.160.0"). */
export async function cliVersionOf(command: string): Promise<string | null> {
  return /(\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]+)?)/.exec((await shellOut(`${command} --version`)) ?? "")?.[1] ?? null;
}

/** Installed with npm, or else with its own installer (it still says its version). */
export async function agentVersionOf(agent: AgentKind): Promise<{ version: string; via: AgentVersion["via"] } | null> {
  const npm = await npmVersionOf(AGENT_PACKAGES[agent]);
  if (npm) return { version: npm, via: "npm" };
  const own = await cliVersionOf(AGENT_COMMAND[agent]);
  return own ? { version: own, via: "own" } : null;
}

/** A worker on a task, asking you something or presenting: not to be stopped for an update. */
const BUSY = new Set(["booting", "working", "waiting", "presenting"]);

export function agentsModule(ctx: ServerCtx, deps: AgentsDeps = {}): Routes {
  const install = deps.install ?? npmInstall;
  const installed = deps.installed ?? agentInstalled;
  const hasNpm = deps.hasNpm ?? (() => findOnPath("npm") !== null);
  const versionOf = deps.versionOf ?? agentVersionOf;
  const selfUpdate = deps.selfUpdate ?? runShell;
  const latestOf = deps.latestOf ?? npmLatestOf;
  const pins = deps.pins ?? (() => loadPrefs().pins ?? {});
  const pin = deps.pin ?? pinAgent;
  const now = deps.now ?? Date.now;
  let installing: AgentKind | null = null;
  let updating: AgentKind | null = null;
  let queued: AgentKind[] = [];
  let found: Partial<Record<AgentKind, Omit<AgentVersion, "pinned">>> = {};
  let checkedAt = 0;
  let checking: Promise<void> | null = null;
  /** Updates already announced (agent@version), so each is offered once. */
  const announced = new Set<string>();

  const versions = (): AgentsState["versions"] => {
    const p = pins();
    const out: AgentsState["versions"] = {};
    for (const k of KINDS) if (found[k] || p[k]) out[k] = { current: found[k]?.current ?? null, latest: found[k]?.latest ?? null, pinned: p[k] ?? null, via: found[k]?.via ?? "npm" };
    return out;
  };
  const state = (): AgentsState => ({
    installed: Object.fromEntries(KINDS.map((k) => [k, installed(k)])) as Record<AgentKind, boolean>,
    installing,
    npm: hasNpm(),
    versions: versions(),
    updating,
    queued: [...queued],
    checkedAt,
  });
  const tell = () => ctx.broadcast({ t: "agents", state: state() });

  /** Look up every installed CLI's version and the newest on npm; say once when there's an update. */
  const check = (): Promise<void> => {
    if (checking) return checking;
    if (!hasNpm()) return Promise.resolve();
    checking = (async () => {
      const next: typeof found = {};
      await Promise.all(
        KINDS.filter((k) => installed(k)).map(async (k) => {
          const [mine, latest] = await Promise.all([versionOf(k), latestOf(AGENT_PACKAGES[k])]);
          next[k] = { current: mine?.version ?? null, latest, via: mine?.via ?? "npm" };
        }),
      );
      found = next;
      checkedAt = now();
      const v = versions();
      for (const k of KINDS) {
        const to = updateTarget(v[k]);
        if (!to || v[k]?.pinned || !canUpdate(k, v[k]) || announced.has(`${k}@${to}`)) continue;
        announced.add(`${k}@${to}`);
        ctx.log.start("agent", `${AGENT_LABELS[k]} ${to} is out (you have ${v[k]?.current}) — update it in Office → Agent CLIs`, { topic: "agents" }).done(true);
      }
      tell();
    })().finally(() => (checking = null));
    return checking;
  };

  const busyWorkers = (agent: AgentKind) => ctx.office.snapshot().desks.filter((d) => d.worker?.agent === agent && BUSY.has(d.worker.status));
  const runningDesks = (agent: AgentKind) => ctx.office.snapshot().desks.filter((d) => d.worker?.agent === agent && d.worker.status !== "asleep").map((d) => d.id);

  /** Run the next queued update whose workers are all free. */
  const tryUpdates = (): void => {
    if (installing || updating) return;
    const agent = queued.find((k) => busyWorkers(k).length === 0);
    if (!agent) return;
    queued = queued.filter((k) => k !== agent);
    const v = versions()[agent];
    const to = updateTarget(v) ?? "latest";
    const pkg = `${AGENT_PACKAGES[agent]}@${to}`;
    const own = v?.via === "own" ? SELF_UPDATE[agent] : undefined;
    const label = AGENT_LABELS[agent];
    const op = ctx.log.start("agent", `Updating ${label} to ${to}`, { command: own ?? `npm install -g ${pkg}`, topic: "agents" });
    updating = agent;
    // Free workers stop for it (Windows won't replace a running CLI's files), and start again after.
    const paused = runningDesks(agent).filter((d) => ctx.office.pause(d, `⬆ Waiting for ${label} to update…`));
    if (paused.length) op.append(`Paused ${paused.length} free ${label} worker${paused.length === 1 ? "" : "s"} while it updates.\n`);
    tell();
    void (own ? selfUpdate(own, (t) => op.append(t)) : install(pkg, (t) => op.append(t))).then(async (ok) => {
      updating = null;
      const mine = await versionOf(agent);
      const current = mine?.version ?? null;
      found[agent] = { current, latest: found[agent]?.latest ?? null, via: mine?.via ?? v?.via ?? "npm" };
      for (const d of paused) ctx.office.restart(d, ok ? `${label} was just updated to ${current ?? to}, so you were restarted.` : `Your CLI was stopped for an update that didn't go through; you're back on the same version.`, "🔄 Back from the update…");
      if (ok) op.done(true, `${label} is on ${current ?? to}${paused.length ? ` — ${paused.length} worker${paused.length === 1 ? "" : "s"} restarted on it` : ""}.`);
      else op.done(false, `${own ? `\`${own}\`` : "npm"} couldn't update ${label} — see the output above. If it says a file is busy or locked, quit ${label} in any terminal outside the office and try again.`);
      tell();
      tryUpdates();
    });
  };

  if (!deps.manual) {
    setTimeout(() => void check(), 20_000).unref?.();
    setInterval(() => void check(), CHECK_EVERY).unref?.();
    setInterval(tryUpdates, RETRY_EVERY).unref?.();
  }

  return {
    agentsGet: (_msg, _client, ws) => {
      ctx.send(ws, { t: "agents", state: state() });
      if (now() - checkedAt > CHECK_EVERY) void check();
    },
    agentsCheck: () => void check(),
    agentInstall: (msg) => {
      const agent = (msg as { agent?: unknown }).agent;
      if (typeof agent !== "string" || !(agent in AGENT_PACKAGES) || installing || updating) return;
      const kind = agent as AgentKind;
      const pkg = AGENT_PACKAGES[kind];
      const op = ctx.log.start("agent", `Installing ${AGENT_LABELS[kind]}`, { command: `npm install -g ${pkg}`, topic: "agents" });
      if (!hasNpm()) {
        op.done(false, "npm isn't installed. Install Node.js from https://nodejs.org (it includes npm), then try again.");
        return;
      }
      installing = kind;
      tell();
      void install(pkg, (t) => op.append(t)).then((ok) => {
        installing = null;
        const found = installed(kind);
        if (ok && found) op.done(true, `${AGENT_LABELS[kind]} is installed — hire one at any desk.`);
        else if (ok) op.done(true, `Installed, but its command isn't on this app's PATH yet — restart the app.`);
        else op.done(false, `npm couldn't install ${pkg} — see the output above.`);
        tell();
        void check();
      });
    },
    agentUpdate: (msg) => {
      const agent = (msg as { agent?: unknown }).agent;
      if (typeof agent !== "string" || !(agent in AGENT_PACKAGES)) return;
      const kind = agent as AgentKind;
      if (versions()[kind]?.via !== "own" && !hasNpm()) return;
      if (updating === kind || !installed(kind) || (found[kind] && !canUpdate(kind, versions()[kind]))) return;
      // Asked again while it waits: just look again whether its workers are free.
      if (queued.includes(kind)) return tryUpdates();
      queued.push(kind);
      const busy = busyWorkers(kind).length;
      if (busy) {
        ctx.log.start("agent", `${AGENT_LABELS[kind]} will update once its ${busy} busy worker${busy === 1 ? " is" : "s are"} free`, { topic: "agents" }).done(true);
      }
      tell();
      tryUpdates();
    },
    agentPin: (msg) => {
      const { agent, version } = msg as { agent?: unknown; version?: unknown };
      if (typeof agent !== "string" || !(agent in AGENT_PACKAGES)) return;
      if (version !== null && (typeof version !== "string" || !VERSION_RE.test(version))) return;
      pin(agent as AgentKind, version);
      ctx.log.start("agent", version ? `${AGENT_LABELS[agent as AgentKind]} stays on ${version} — updates install that version` : `${AGENT_LABELS[agent as AgentKind]} follows the newest version again`, { topic: "agents" }).done(true);
      tell();
    },
  };
}
