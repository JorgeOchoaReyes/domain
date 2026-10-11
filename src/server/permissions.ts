import type { ClientMessage } from "../shared/protocol.js";
import type { Role } from "./ctx.js";

/**
 * What a guest on your local network may do. Visitors walk around, watch and
 * read; teammates also run the work — hire, hand out tasks, type into
 * workers' terminals (which run on the host's computer), review and ship.
 * Some things stay with the host whatever the role: your GitHub sign-in and
 * repos, switching or cloning projects, opening the office to the network,
 * and adding or checking MCP servers (which start programs on this computer).
 */

type T = ClientMessage["t"];

const VISITOR: ReadonlySet<T> = new Set<T>(["join", "move", "open", "logs", "projectInfo", "ideasGet", "agentsGet", "chatGet", "historyGet", "skillsGet", "lessonsGet", "alumniGet", "voicesGet", "peopleSend", "demoGet"]);

const HOST_ONLY: ReadonlySet<T> = new Set<T>([
  "projectOpen",
  "projectClone",
  "githubSignIn",
  "githubRepos",
  "lanStart",
  "lanStop",
  "lanDiscover",
  "mcpSave",
  "mcpDelete",
  "mcpCheck",
  "mcpScan",
  "probe",
  "agentInstall",
  "trustWorkers",
  "voicesKey",
  // Presses keys on this computer.
  "dictate",
]);

export function allowed(role: Role, t: string): boolean {
  if (role === "host") return true;
  if (role === "visitor") return VISITOR.has(t as T);
  return !HOST_ONLY.has(t as T);
}
