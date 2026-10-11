import type { AgentKind } from "./protocol.js";

/**
 * Local models first: a model served on this computer (Ollama, LM Studio) is
 * free and private, so wherever you pick a model they're listed first, a
 * small task headed for a big cloud model gets a nudge, and autopilot hands
 * small tasks to workers on one.
 */

/** A model served on this computer: `ollama/<m>` or `lmstudio/<m>`. */
export function isLocalModel(model: string): boolean {
  return /^(?:ollama|lmstudio)\/./.test(model);
}

/**
 * The local models an agent can run: Codex and OpenCode take both servers;
 * Claude Code only Ollama's (through its Anthropic-compatible API); Gemini
 * CLI none.
 */
export function localFor(agent: AgentKind, local: readonly string[]): string[] {
  if (agent === "gemini") return [];
  return local.filter((m) => isLocalModel(m) && (agent !== "claude" || m.startsWith("ollama/")));
}

/**
 * The models to offer for an agent, local ones first: the ones on this
 * computer it can run, then "" (its default), then the rest of the team's list
 * and any extras (the one it's on now).
 */
export function modelChoices(agent: AgentKind, team: readonly string[], local: readonly string[], extra: readonly string[] = []): string[] {
  const all = [...new Set(["", ...team, ...extra, ...localFor(agent, local)])];
  return [...all.filter(isLocalModel), ...all.filter((m) => !isLocalModel(m))];
}

/** How a model reads in a picker: a local one says it's free and private. */
export function localBadge(model: string): string {
  return isLocalModel(model) ? "🖥 free · private" : "";
}

export type TaskSize = "small" | "medium" | "large";

const SMALL = /\b(?:typo|rename|readme|comment|docstring|copy ?edit|wording|bump|tweak|small|tiny|quick|one[- ]line|lint|format(?:ting)?|log(?:ging)? (?:line|message)|changelog|label|text|spelling|version)\b/i;
const LARGE = /\b(?:refactor|migrat\w*|architect\w*|redesign|rewrite|overhaul|across|every|whole|entire|all (?:the )?\w+s\b|framework|auth(?:entication)?|database|schema|performance|concurren\w*|security|integration|end[- ]to[- ]end|multi\w*)\b/i;

/**
 * How big a task looks, before anyone's done it: its time budget if it has
 * one, else its words — "Fix the typo in the README" is small, "Migrate auth
 * to the new database" is large.
 */
export function taskSize(title: string, minutes = 0, notes = ""): TaskSize {
  if (minutes && minutes <= 15) return "small";
  if (minutes >= 60) return "large";
  const text = `${title} ${notes}`;
  if (LARGE.test(text)) return "large";
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return SMALL.test(text) && words <= 25 ? "small" : "medium";
}

/**
 * For a task about to go to a cloud model: the local model that could do it
 * instead, when it's small and there is one this agent can run. Null when
 * there's nothing to suggest.
 */
export function suggestLocal(agent: AgentKind, model: string, size: TaskSize, local: readonly string[]): string | null {
  if (size !== "small" || isLocalModel(model)) return null;
  return localFor(agent, local)[0] ?? null;
}

/**
 * Whether a model can take a task this size: a local model takes small and
 * medium ones (a large one overwhelms a small model's context and focus) —
 * only small ones if it's slow here; a cloud model takes anything.
 */
export function fitsModel(model: string, size: TaskSize, tps?: number): boolean {
  if (!isLocalModel(model)) return true;
  // A slow one (measured on this computer) gets only small ones.
  if (tps !== undefined && tps < SLOW_TPS) return size === "small";
  return size !== "large";
}

/** What the office knows about a local model on this computer. */
export interface LocalModelInfo {
  /** The context window it runs with (Ollama's num_ctx; null: not set, so Ollama's small default applies). */
  ctx: number | null;
  /** The most it was trained for (null: unknown). */
  max: number | null;
  /** How fast it writes here, in tokens a second (measured when a worker's hired on it). */
  tps?: number;
}

/** An agent's instructions alone run to tens of thousands of tokens: a context window for one should be at least this. */
export const AGENT_CONTEXT = 32_768;

/** Below this many tokens a second, a local model is too slow for anything but small tasks. */
export const SLOW_TPS = 10;

/** What a speed means for the work it can take. */
export function speedVerdict(tps: number): string {
  return tps >= 25 ? "quick — fine for small and medium tasks" : tps >= SLOW_TPS ? "fine for small tasks, slow on bigger ones" : "slow — only small tasks go to it (or pick a smaller model)";
}
