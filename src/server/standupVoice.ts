import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { draftPrompt, parseDraft, simpleDraft, type StandupDraft, type TeamMember } from "../shared/standupDraft.js";

/**
 * The spoken stand-up's plan: a one-shot `claude -p` on a small, quick model
 * turns what you said into a summary, end-of-day goals and tasks. It runs in
 * a temp folder (so it doesn't load this project's context), with a time
 * limit; anything wrong — no Claude Code, not signed in, a bad answer — and
 * the plan comes from your own sentences instead.
 */

const TIMEOUT_MS = 60_000;

export async function draftStandup(
  spoken: string,
  openGoals: string[],
  opts: { simulate?: boolean; team?: TeamMember[]; run?: (prompt: string) => Promise<string> } = {},
): Promise<{ draft: StandupDraft; via: "claude" | "simple" }> {
  const text = spoken.replace(/\s+/g, " ").trim().slice(0, 6000);
  const team = opts.team ?? [];
  if (!opts.simulate && text) {
    try {
      const out = await (opts.run ?? runClaude)(draftPrompt(text, openGoals, team));
      const draft = parseDraft(out, text, team);
      if (draft) return { draft, via: "claude" };
    } catch {
      /* fall through to the plain plan */
    }
  }
  return { draft: simpleDraft(text, team), via: "simple" };
}

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Only a little JSON to write: no tools, MCP servers or settings to load.
    const win = process.platform === "win32";
    const args = ["-p", "--model", "haiku", "--output-format", "text", "--strict-mcp-config", "--setting-sources", "", "--tools", ""];
    // Through the Windows shell every argument needs its quotes (an empty one would vanish).
    const child = spawn("claude", win ? args.map((a) => `"${a}"`) : args, {
      cwd: tmpdir(),
      shell: win,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timed out"));
    }, TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      if (out.length > 100_000) child.kill();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out);
      else reject(new Error(`claude exited ${code}`));
    });
    child.stdin.end(prompt);
  });
}
