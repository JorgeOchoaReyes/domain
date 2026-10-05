import type { AgentKind } from "./protocol.js";
import type { Leash } from "./policy.js";

/** A worker you let go — kept so you can bring them back. */
export interface Alumnus {
  id: string;
  /** When they left. */
  at: number;
  name: string;
  agent: AgentKind;
  model: string;
  leash: Leash;
  /** Their character, if they were one. */
  characterId?: string;
  /** Why you let them go (optional — the team learns from it). */
  reason?: string;
  /** Their desk, and their branch if it was kept (it had work not on yours). */
  desk: string;
  branch?: string;
  /** What they did while they were here. */
  tasksDone: number;
}
