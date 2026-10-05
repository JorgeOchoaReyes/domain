import type { AgentKind } from "./protocol.js";

/** A skill an agent CLI loads on its own (a SKILL.md in its skills folder). */
export interface SkillSeen {
  agent: AgentKind;
  name: string;
  description: string;
  /** "yours" (your home folder) or "project". */
  source: "yours" | "project";
}
