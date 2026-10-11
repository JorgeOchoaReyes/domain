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
