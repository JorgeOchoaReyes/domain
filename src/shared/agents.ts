import type { AgentKind } from "./protocol.js";

/**
 * The agent CLIs and how to get them: each is an npm package that puts its
 * command on your PATH. The office checks which are installed and can
 * install a missing one for you.
 */
export const AGENT_PACKAGES: Record<AgentKind, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  gemini: "@google/gemini-cli",
  opencode: "opencode-ai",
};

export interface AgentsState {
  /** Which agent CLIs are on your PATH. */
  installed: Record<AgentKind, boolean>;
  /** The one being installed right now, if any. */
  installing: AgentKind | null;
  /** Whether npm is there to install with (it comes with Node.js). */
  npm: boolean;
}
