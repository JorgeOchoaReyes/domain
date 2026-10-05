import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkill, scanSkills, skillBlockArgs } from "../src/server/skills.ts";

const skill = (dir: string, name: string, description: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nDo the thing.\n`);
};

test("a SKILL.md's name and description", () => {
  assert.deepEqual(parseSkill("---\nname: code-review\ndescription: Review the diff\n---\nbody"), { name: "code-review", description: "Review the diff" });
  assert.equal(parseSkill("no front matter"), null);
});

test("each agent's skills, from your folder and the project's (grouped folders too)", () => {
  const home = mkdtempSync(join(tmpdir(), "skills-home-"));
  const project = mkdtempSync(join(tmpdir(), "skills-proj-"));
  skill(join(home, ".claude", "skills", "synced", "abc", "pdf"), "pdf", "Read and write PDFs");
  skill(join(project, ".claude", "skills", "deploy"), "deploy", "Ship it");
  skill(join(home, ".agents", "skills", "code-review"), "code-review", "Two-axis review");
  skill(join(home, ".codex", "skills", ".system", "imagegen"), "imagegen", "Make images");
  const seen = scanSkills(home, project, ["claude", "codex", "gemini"]);
  const of = (a: string) => seen.filter((s) => s.agent === a).map((s) => `${s.name}/${s.source}`).sort();
  assert.deepEqual(of("claude"), ["deploy/project", "pdf/yours"]);
  assert.deepEqual(of("codex"), ["code-review/yours", "imagegen/yours"]);
  assert.deepEqual(of("gemini"), []);
});

test("Claude Code blocks a character's turned-off skills for its session; others are told instead", () => {
  assert.deepEqual(skillBlockArgs("claude", ["pdf", "deploy"]), ["--disallowed-tools", '"Skill(pdf)"', '"Skill(deploy)"']);
  assert.deepEqual(skillBlockArgs("claude", ["bad name; rm -rf"]), [], "only safe names on a command line");
  assert.deepEqual(skillBlockArgs("codex", ["pdf"]), []);
});
