/**
 * Projects and GitHub: which folder the workers work in, the ones you've
 * opened before, and what GitHub knows about them. Shared by the server
 * (which clones, pushes and talks to GitHub) and the client (which shows it).
 */

/** The project the office is working on right now. */
export interface ProjectInfo {
  path: string;
  /** The folder's name. */
  name: string;
  isGit: boolean;
  /** The branch your checkout is on. */
  branch: string | null;
  /** Its GitHub remote, when `origin` points at github.com. */
  github: { owner: string; repo: string; url: string } | null;
  /** Uncommitted changes in your checkout (they hold up merging workers' branches). */
  dirty: boolean;
}

/**
 * Who works in which open repo: each worker's desk, its name, and the repo
 * folder it works in (the office's own project when it's that one).
 */
export interface RepoWorker {
  deskId: string;
  name: string;
  repo: string;
}

/** A project you've worked on before, newest first. */
export interface RecentProject {
  path: string;
  name: string;
  /** owner/repo when it's on GitHub. */
  github: string | null;
  openedAt: number;
}

/** Who you're signed in to GitHub as (through git's own credential manager). */
export interface GithubAccount {
  login: string;
  avatarUrl: string;
}

export interface GithubRepo {
  fullName: string;
  description: string;
  private: boolean;
  updatedAt: string;
  cloneUrl: string;
  defaultBranch: string;
}

export interface GithubIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  url: string;
}

export interface PullRequestInfo {
  number: number;
  url: string;
  title: string;
  state: "open" | "closed" | "merged";
  /** Its CI checks, rolled up. */
  checks: "pending" | "success" | "failure" | "none";
  /** owner/repo, when it was opened on another open repo than the office's own project. */
  repo?: string;
}

/** Whether shipping a goal opens one pull request for the goal, or one per agent (from each agent's own branch). */
export type PrPer = "goal" | "agent";

/** A pull request opened from one agent's own branch. */
export interface AgentPullRequest extends PullRequestInfo {
  deskId: string;
  /** The agent's name, as it was when the PR opened. */
  name: string;
  /** The branch on GitHub it was opened from. */
  head: string;
}

/** A commit, briefly. */
export interface CommitLine {
  sha: string;
  subject: string;
  /** "3 minutes ago". */
  when: string;
}

/**
 * Where the repo stands, at a glance: your branch against GitHub, what's
 * uncommitted, each agent's branch, and the open pull requests with their
 * checks. Asked for with { t: "repoStatus" }.
 */
export interface RepoStatus {
  at: number;
  isGit: boolean;
  branch: string | null;
  github: { owner: string; repo: string; url: string } | null;
  /** Your branch against its upstream on GitHub, as of `fetchedAt` (null: no upstream). */
  ahead: number | null;
  behind: number | null;
  fetchedAt: number | null;
  last: CommitLine | null;
  /** Uncommitted changes in your checkout (they hold up merging agents' work). */
  dirty: string[];
  /** Each agent's own branch: commits it has that yours doesn't, files it hasn't committed, its last commit. */
  agents: { deskId: string; name: string; branch: string; ahead: number; dirty: number; last: CommitLine | null }[];
  /** Open pull requests (null: not on GitHub, or not signed in). */
  pulls: (PullRequestInfo & { head: string })[] | null;
  pullsError?: string;
  /** The repo's folder and name (set when more than one repo is open). */
  path?: string;
  name?: string;
  /** The other repos open alongside the office's own project, each the same way. */
  others?: RepoStatus[];
}

/** What a tool did, shown in the Logs (and inline wherever it happened). */
export type OpTool = "git" | "github" | "mcp" | "check" | "deploy" | "agent";

export interface OpLog {
  id: string;
  at: number;
  tool: OpTool;
  /** One line a person reads: "Cloning acme/web". */
  title: string;
  /** The command it ran, when there was one (secrets never appear here). */
  command?: string;
  status: "running" | "ok" | "error";
  /** Its output so far (the tail). */
  output: string;
  /** What it was for, so a window can show just its own logs (e.g. "clone", "ship:<goalId>", "mcp:<id>"). */
  topic?: string;
  /** A link to look at (a PR, a repo). */
  url?: string;
}

/** "acme/web" from https://github.com/acme/web(.git) or git@github.com:acme/web(.git). */
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const m = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** A git repo found on this computer (by the office's scan of your usual code folders). */
export interface FoundRepo {
  /** The folder's name. */
  name: string;
  path: string;
  /** The branch it's on (null: detached, or unreadable). */
  branch: string | null;
  /** owner/repo when its origin is on GitHub. */
  github: string | null;
}

/** One entry in a numbered list of repos you could open: a folder on this computer, or one on GitHub (cloned first). */
export type RepoChoice = { kind: "local"; repo: FoundRepo } | { kind: "github"; repo: GithubRepo };

/** The numbered list `nou repo find` shows: this computer's first, then GitHub's (minus ones already here). */
export function repoChoices(local: FoundRepo[], github: GithubRepo[] | null): RepoChoice[] {
  const here = new Set(local.map((r) => r.github?.toLowerCase()).filter(Boolean));
  return [
    ...local.map((repo) => ({ kind: "local" as const, repo })),
    ...(github ?? []).filter((r) => !here.has(r.fullName.toLowerCase())).map((repo) => ({ kind: "github" as const, repo })),
  ];
}

/** Whether a repo matches what you typed (its name, folder, or owner/repo; any case). */
export function repoMatches(c: RepoChoice, text: string): boolean {
  const q = text.trim().toLowerCase();
  if (!q) return true;
  const keys = c.kind === "local" ? [c.repo.name, c.repo.path, c.repo.github ?? ""] : [c.repo.fullName, c.repo.description];
  return keys.some((k) => k.toLowerCase().includes(q));
}

export function choiceLabel(c: RepoChoice): string {
  return c.kind === "local" ? `${c.repo.name} (${c.repo.path})` : `${c.repo.fullName} (GitHub)`;
}

/**
 * The repo you mean: its number in the list (1-based), its name, its
 * owner/repo, or the start of one of those (any case). A string saying why
 * when it's none of them, or more than one.
 */
export function pickRepo(list: RepoChoice[], query: string): RepoChoice | string {
  const q = query.trim().toLowerCase();
  if (!q) return "Which repo? Give its name or number (nou repo find).";
  if (/^\d+$/.test(q)) {
    const n = Number(q);
    return list[n - 1] ?? `There's no repo number ${n} — nou repo find lists ${list.length}.`;
  }
  const keys = (c: RepoChoice) =>
    (c.kind === "local" ? [c.repo.name, c.repo.github ?? "", c.repo.github?.split("/")[1] ?? ""] : [c.repo.fullName, c.repo.fullName.split("/")[1] ?? ""])
      .filter(Boolean)
      .map((k) => k.toLowerCase());
  const many = (l: RepoChoice[]) => `“${query}” could be more than one: ${l.map(choiceLabel).join(", ")} — use its number.`;
  const exact = list.filter((c) => keys(c).includes(q));
  // The same name here and on GitHub: the one on this computer wins.
  const here = exact.filter((c) => c.kind === "local");
  if (exact.length === 1 || here.length === 1) return here[0] ?? exact[0];
  if (exact.length > 1) return many(exact);
  const starts = list.filter((c) => keys(c).some((k) => k.startsWith(q)));
  if (starts.length === 1) return starts[0];
  if (starts.length > 1) return many(starts);
  return `No repo called “${query}” on this computer${list.some((c) => c.kind === "github") ? " or on GitHub" : ""} — nou repo find lists them.`;
}

/** A name for a new repo's folder: letters, digits, dot, dash, underscore (null when nothing's left). */
export function repoFolderName(s: string): string | null {
  const n = s.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "").replace(/^[.-]+/, "").slice(0, 60);
  return n && n !== "." && n !== ".." ? n : null;
}
