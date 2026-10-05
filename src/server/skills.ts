import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentKind } from "../shared/protocol.js";
import type { SkillSeen } from "../shared/skills.js";

/**
 * The skills each agent CLI loads on its own (a folder with a SKILL.md: a
 * name, a description, instructions): yours (in your home folder) and the
 * project's. All of them are on for a worker unless its character turns
 * some off — Claude Code then can't use them at all (they're blocked for that
 * session); the others are told not to.
 */

/** Where each agent looks for skills, under your home folder and the project. */
export function skillDirs(agent: AgentKind, home: string, project: string): string[] {
  switch (agent) {
    case "claude":
      return [join(home, ".claude", "skills"), join(project, ".claude", "skills")];
    case "codex":
      return [join(home, ".codex", "skills"), join(home, ".agents", "skills"), join(project, ".agents", "skills"), join(project, ".codex", "skills")];
    case "gemini":
      return [join(home, ".gemini", "skills"), join(project, ".gemini", "skills")];
    case "opencode":
      return [join(home, ".config", "opencode", "skills"), join(home, ".config", "opencode", "skill"), join(project, ".opencode", "skills")];
  }
}

/** A SKILL.md's name and description (its front matter), or null. */
export function parseSkill(text: string): { name: string; description: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, "m").exec(m[1])?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  const name = field("name");
  return name ? { name, description: field("description").slice(0, 240) } : null;
}

/** Find the SKILL.md files under a folder (a few levels down: skills can be grouped). */
function findSkills(dir: string, depth = 3): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  if (entries.includes("SKILL.md")) return [join(dir, "SKILL.md")];
  if (depth <= 0) return [];
  for (const e of entries) {
    const p = join(dir, e);
    try {
      if (statSync(p).isDirectory()) out.push(...findSkills(p, depth - 1));
    } catch {
      /* unreadable: skip */
    }
  }
  return out;
}

export function scanSkills(home: string, project: string, agents: readonly AgentKind[]): SkillSeen[] {
  const out: SkillSeen[] = [];
  for (const agent of agents) {
    const seen = new Set<string>();
    for (const dir of skillDirs(agent, home, project)) {
      for (const file of findSkills(dir)) {
        try {
          const s = parseSkill(readFileSync(file, "utf8"));
          if (!s || seen.has(s.name)) continue;
          seen.add(s.name);
          out.push({ agent, name: s.name, description: s.description, source: dir.startsWith(project) ? "project" : "yours" });
        } catch {
          /* unreadable: skip */
        }
      }
    }
  }
  return out;
}

/** A skill name that's safe to put on a command line. */
export const isSkillName = (s: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(s);

/** Claude Code: block the skills a character has turned off, for that session. */
export function skillBlockArgs(agent: AgentKind, off: string[]): string[] {
  const names = off.filter(isSkillName);
  if (agent !== "claude" || !names.length) return [];
  return ["--disallowed-tools", ...names.map((n) => `"Skill(${n})"`)];
}
