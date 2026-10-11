import type { AgentKind } from "./protocol.js";
import { AGENT_KINDS } from "./protocol.js";
import { isLeash, isModelName, type Leash } from "./policy.js";

/**
 * Your team: workers with names, faces and personalities you set once and
 * hire again and again. A character keeps its agent, model, leash, the
 * standing instructions it's given with every task (its persona), its voice,
 * its look, and which MCP servers it gets.
 */

export const BOT_COLORS = ["#f08a5d", "#5bc0eb", "#9b5de5", "#ffc145", "#06d6a0", "#ef476f", "#8d99ae", "#ff9ecf", "#3d5a80", "#a7c957"] as const;
export const FACES = ["smile", "grin", "cool", "sleepy", "wink", "focused"] as const;
export const HATS = ["none", "headset", "cap", "beanie", "crown", "party", "wizard", "headphones"] as const;
export const ACCESSORIES = ["none", "glasses", "bowtie", "scarf", "badge", "mustache"] as const;

export type Face = (typeof FACES)[number];
export type Hat = (typeof HATS)[number];
export type Accessory = (typeof ACCESSORIES)[number];

export interface CharacterLook {
  /** Body color (one of BOT_COLORS, or any #rrggbb). */
  color: string;
  face: Face;
  hat: Hat;
  accessory: Accessory;
}

export interface Character {
  id: string;
  name: string;
  agent: AgentKind;
  /** "" = the team policy's default for this agent. */
  model: string;
  leash: Leash;
  /** Standing instructions added to every task it's given. */
  persona: string;
  /** A speech-synthesis voice name ("" = picked for its agent). */
  voice: string;
  look: CharacterLook;
  /** Ids of the office's MCP servers this character gets. */
  mcp: string[];
  /** Skills it may not use (all the others its agent has are on). */
  skillsOff?: string[];
  /** The repo folder it works in when hired (when that repo is open; else where new hires work). */
  repo?: string;
  createdAt: number;
  /** How many times it's been hired (shown on its card). */
  hires: number;
}

/** What a worker at a desk shows: who it is, if it's one of your characters. */
export interface WorkerIdentity {
  characterId: string;
  name: string;
  look: CharacterLook;
  voice: string;
}

export const MAX_TEAM = 24;
/** How long a character's instructions may be (long enough for a detailed working method). */
export const MAX_PERSONA = 2000;

function pick<T extends string>(v: unknown, list: readonly T[], fallback: T): T {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : fallback;
}

function clean(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export function defaultLook(agent: AgentKind): CharacterLook {
  const color = { claude: "#f08a5d", codex: "#5bc0eb", opencode: "#9b5de5", gemini: "#ffc145" }[agent];
  return { color, face: "smile", hat: "headset", accessory: "none" };
}

export function coerceLook(raw: unknown, agent: AgentKind): CharacterLook {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const base = defaultLook(agent);
  const color = typeof o.color === "string" && /^#[0-9a-fA-F]{6}$/.test(o.color) ? o.color.toLowerCase() : base.color;
  return { color, face: pick(o.face, FACES, base.face), hat: pick(o.hat, HATS, base.hat), accessory: pick(o.accessory, ACCESSORIES, base.accessory) };
}

/** Clean an untrusted character (from a client or a saved file). Returns null if it has no usable name. */
export function coerceCharacter(raw: unknown): Character | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = clean(o.name, 24);
  if (!name) return null;
  const agent = pick(o.agent, AGENT_KINDS, "claude");
  const persona = typeof o.persona === "string" ? o.persona.replace(/\r/g, "").trim().slice(0, MAX_PERSONA) : "";
  return {
    id: typeof o.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(o.id) ? o.id : Math.random().toString(36).slice(2, 10),
    name,
    agent,
    model: typeof o.model === "string" && isModelName(o.model) ? o.model : "",
    leash: isLeash(o.leash) ? o.leash : "ask",
    persona,
    voice: clean(o.voice, 80),
    look: coerceLook(o.look, agent),
    mcp: Array.isArray(o.mcp) ? o.mcp.filter((x): x is string => typeof x === "string").slice(0, 20) : [],
    skillsOff: Array.isArray(o.skillsOff) ? o.skillsOff.filter((x): x is string => typeof x === "string" && x.length <= 64).slice(0, 100) : [],
    ...(typeof o.repo === "string" && o.repo.trim() && o.repo.length <= 1000 && !/[\u0000-\u001f]/.test(o.repo) ? { repo: o.repo.trim() } : {}),
    createdAt: typeof o.createdAt === "number" ? o.createdAt : Date.now(),
    hires: typeof o.hires === "number" && o.hires >= 0 ? Math.floor(o.hires) : 0,
  };
}

/**
 * The repo a new hire works in: the one you picked on the hire card (when
 * it's open), else the character's own (when that's open), else where new
 * hires work — with a note when the character's repo isn't open now.
 */
export function hireRepoChoice(
  asked: unknown,
  character: Pick<Character, "name" | "repo"> | null | undefined,
  find: (q: string) => string | null,
  fallback: string,
): { repo: string; note?: string } {
  const picked = typeof asked === "string" && asked ? find(asked) : null;
  if (picked) return { repo: picked };
  if (!character?.repo) return { repo: fallback };
  const own = find(character.repo);
  if (own) return { repo: own };
  const name = character.repo.split(/[\\/]/).filter(Boolean).pop() ?? character.repo;
  return { repo: fallback, note: `📦 ${character.name}'s repo, ${name}, isn't open — working in ${fallback.split(/[\\/]/).filter(Boolean).pop() ?? fallback} instead (＋ Add a repo to open it)` };
}

/** The line added to every task brief for this character. */
export function personaBrief(c: Pick<Character, "name" | "persona">): string {
  return c.persona ? ` You are ${c.name} on this team. Standing instructions from your manager: ${c.persona.replace(/\s*\n\s*/g, " ")}` : ` You are ${c.name} on this team.`;
}
