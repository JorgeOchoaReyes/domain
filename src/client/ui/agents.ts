import type { AgentsState } from "../../shared/agents.js";
import type { AgentKind, ClientMessage, ServerMessage } from "../../shared/protocol.js";

/**
 * Which agent CLIs this machine has, for the hire card (an Install button on
 * a missing one) and for Arnold (a nudge when none is installed yet).
 */

let state: AgentsState | null = null;
let send: ((m: ClientMessage) => void) | null = null;
const listeners = new Set<() => void>();

export function setAgentsSender(fn: (m: ClientMessage) => void): void {
  send = fn;
}

export function ingestAgents(msg: ServerMessage): void {
  if (msg.t !== "agents") return;
  state = msg.state;
  for (const l of listeners) l();
}

export function agentsState(): AgentsState | null {
  return state;
}

/** Installed, or not known yet (then assume so: the terminal says if it isn't). */
export function isInstalled(agent: AgentKind): boolean {
  return state ? state.installed[agent] : true;
}

export function installAgent(agent: AgentKind): void {
  send?.({ t: "agentInstall", agent });
}

/** Hear about changes; returns the way to stop. */
export function onAgentsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
