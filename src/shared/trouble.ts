import type { AgentKind } from "./protocol.js";

/**
 * What's wrong with an agent, read off its screen once it's gone quiet: it
 * needs signing in, it can't reach its service, its service sent an error
 * (rate limit, overloaded, a 5xx), or it needs an update. Each comes with the
 * CLI's own line, so you see what it said — and the desk offers the fix.
 */
export type TroubleKind = "signin" | "offline" | "error" | "update";

export interface Trouble {
  kind: TroubleKind;
  /** The CLI's own words (one line, trimmed). */
  detail: string;
}

const PATTERNS: [TroubleKind, RegExp][] = [
  ["update", /update required|no longer supported|please (?:upgrade|update) (?:to|your)|unsupported (?:client )?version|requires a newer version/i],
  [
    "signin",
    /not (?:logged|signed) in|please (?:run )?\/?log ?in|run [`'"]?\w+ (?:auth )?login|invalid (?:api[ _-]?key|x-api-key|credentials)|authentication[_ ](?:failed|error)|\b401\b.*unauthori[sz]ed|unauthori[sz]ed.*\b401\b|o?auth token (?:has )?expired|token (?:has )?expired|api key (?:not found|is missing|not valid)|missing api key|select login method|sign in to continue/i,
  ],
  ["offline", /\b(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|getaddrinfo|fetch failed|network (?:error|is unreachable)|could not (?:connect|reach)|unable to connect|stream disconnected before completion/i],
  // Worded as errors only: "rate limiting" in an agent's summary of its work isn't trouble.
  ["error", /api error|overloaded_error|is overloaded|rate[ _-]limit(?:_error| reached| exceeded)|quota exceeded|usage limit reached|too many requests|\b429\b.*(?:error|too many)|\b50[0-4]\b.*(?:error|internal|unavailable|gateway)|internal server error|service unavailable/i],
];

/** The trouble on an agent's screen, if any — the newest line that says so. */
export function troubleFrom(screen: string[]): Trouble | null {
  // Only near the bottom, where a CLI leaves its last word.
  const lines = screen.filter((l) => l.trim()).slice(-12);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/[│┃║╭╮╰╯─━═]+/g, " ").replace(/\s+/g, " ").trim();
    // "…· Retrying in 5s": it's handling it.
    if (line.length < 4 || /retrying|retry in|will retry/i.test(line)) continue;
    for (const [kind, re] of PATTERNS) if (re.test(line)) return { kind, detail: line.slice(0, 160) };
  }
  return null;
}

/** Signing in from inside the CLI (a slash command), where it has one; else the shell command to run. */
export const SIGN_IN: Record<AgentKind, { slash?: string; shell: string }> = {
  claude: { slash: "/login", shell: "claude /login" },
  codex: { shell: "codex login" },
  gemini: { slash: "/auth", shell: "gemini" },
  opencode: { shell: "opencode auth login" },
};

/** What to do about it, in a few words. */
export function troubleHint(kind: TroubleKind): string {
  return kind === "signin"
    ? "it needs signing in"
    : kind === "offline"
      ? "it can't reach its service — check you're online, then restart it"
      : kind === "update"
        ? "it needs an update"
        : "its service sent an error — wait a moment, then restart it";
}
