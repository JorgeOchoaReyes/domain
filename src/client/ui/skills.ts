import type { ServerMessage } from "../../shared/protocol.js";
import type { SkillSeen } from "../../shared/skills.js";

/**
 * The skills each agent CLI has (from the server's scan of their skills
 * folders), for the hire window, the character editor and the workers.
 */

let seen: SkillSeen[] = [];
const listeners = new Set<() => void>();

export function ingestSkills(msg: ServerMessage): void {
  if (msg.t !== "skills") return;
  seen = msg.seen;
  for (const l of listeners) l();
}

export function skillsOf(agent: string): SkillSeen[] {
  return seen.filter((s) => s.agent === agent);
}

export function onSkillsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** "🎓 12 skills" with the names as a tooltip, for a compact line. */
export function skillsLine(names: string[]): { text: string; title: string } {
  return names.length
    ? { text: `🎓 ${names.length} skill${names.length === 1 ? "" : "s"}`, title: names.join(", ") }
    : { text: "🎓 no skills", title: "No skills in this agent's skills folders" };
}
