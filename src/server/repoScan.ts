import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { parseGithubRemote, type FoundRepo } from "../shared/project.js";

/**
 * Repos on this computer, found without typing a path: a quick, bounded look
 * through the folders code usually lives in (the project's own parent folder,
 * ~/projects, ~/code, ~/src, ~/dev, ~/Documents/GitHub, ~/source/repos,
 * ~/repos) for folders with a `.git`. It only reads: no git commands, just
 * `.git/HEAD` and `.git/config` for the branch and the GitHub remote.
 *
 * Bounded so it never stalls the office: three folders deep at most, a time
 * budget (1.5 s), never into node_modules, hidden folders (so not .git's
 * insides, nor .domain/.claude worktrees) or other build output — and cached
 * for a couple of minutes.
 */

export interface ScanOptions {
  /** Where to look. */
  roots: string[];
  /** How many folders below a root (the root is 0). */
  maxDepth?: number;
  /** Stop looking after this long (ms). */
  budgetMs?: number;
  /** The clock (tests). */
  now?: () => number;
}

export interface ScanResult {
  repos: FoundRepo[];
  /** It ran out of time before looking everywhere. */
  truncated: boolean;
  ms: number;
}

export const SCAN_DEPTH = 3;
export const SCAN_BUDGET_MS = 1500;

/** Folders never worth looking in (big, generated, or someone else's). */
const SKIP = new Set(
  ["node_modules", "bower_components", "vendor", "target", "dist", "build", "out", "venv", "env", "__pycache__", "site-packages", "Library", "AppData", "Application Data", "Pictures", "Music", "Videos", "Movies", "OneDrive", "$RECYCLE.BIN", "System Volume Information"].map((s) => s.toLowerCase()),
);

/** The office's own worktrees (and Claude Code's): never offered as repos to open. */
export function isOfficeWorktree(path: string): boolean {
  const p = resolve(path).replace(/\\/g, "/").toLowerCase() + "/";
  return /\/\.(domain|claude)\/worktrees\//.test(p);
}

/** Where code usually lives on this computer (DOMAIN_REPO_ROOTS replaces the list: folders separated like PATH). */
export function scanRoots(project: string, home = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const set = env.DOMAIN_REPO_ROOTS;
  const list = set
    ? set.split(delimiter).filter(Boolean)
    : [
        dirname(resolve(project)),
        join(home, "projects"),
        join(home, "code"),
        join(home, "src"),
        join(home, "dev"),
        join(home, "Documents", "GitHub"),
        join(home, "source", "repos"),
        join(home, "repos"),
      ];
  const out: string[] = [];
  for (const r of list.map((p) => resolve(p))) {
    // Inside the office's worktrees (the project is one): look next to the repo they belong to instead.
    const root = isOfficeWorktree(r) ? dirname(r.replace(/[\\/]\.(domain|claude)[\\/]worktrees([\\/].*)?$/i, "")) : r;
    if (!out.some((o) => o.toLowerCase() === root.toLowerCase()) && isFolder(root)) out.push(root);
  }
  return out;
}

function isFolder(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function read(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** The branch and GitHub remote of a folder with a `.git` (a folder, or a file pointing at one); null when it has none. */
export function readRepo(dir: string): FoundRepo | null {
  const dotGit = join(dir, ".git");
  if (!existsSync(dotGit)) return null;
  let gitDir = dotGit;
  let common = dotGit;
  if (!isFolder(dotGit)) {
    // A linked worktree or a submodule: ".git" says where its git folder is.
    const m = /^gitdir:\s*(.+)$/m.exec(read(dotGit) ?? "");
    if (!m) return null;
    gitDir = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(dir, m[1].trim());
    const c = read(join(gitDir, "commondir"))?.trim();
    common = c ? (isAbsolute(c) ? c : resolve(gitDir, c)) : gitDir;
  }
  const head = /^ref:\s*refs\/heads\/(.+)$/m.exec(read(join(gitDir, "HEAD")) ?? "");
  return { name: basename(dir), path: resolve(dir), branch: head ? head[1].trim() : null, github: originOf(read(join(common, "config")) ?? "") };
}

/** owner/repo from a git config's [remote "origin"] url, when it's on GitHub. */
export function originOf(config: string): string | null {
  let inOrigin = false;
  for (const line of config.split(/\r?\n/)) {
    const sec = /^\s*\[(.+)\]\s*$/.exec(line);
    if (sec) {
      inOrigin = /^remote\s+"origin"$/.test(sec[1].trim());
      continue;
    }
    const url = inOrigin ? /^\s*url\s*=\s*(.+)$/.exec(line) : null;
    if (url) {
      const gh = parseGithubRemote(url[1].trim());
      return gh ? `${gh.owner}/${gh.repo}` : null;
    }
  }
  return null;
}

/** Look for repos under the roots, breadth first (so the shallow ones are found first if time runs out). */
export function scanRepos(opts: ScanOptions): ScanResult {
  const now = opts.now ?? Date.now;
  const maxDepth = opts.maxDepth ?? SCAN_DEPTH;
  const budget = opts.budgetMs ?? SCAN_BUDGET_MS;
  const start = now();
  const repos: FoundRepo[] = [];
  const seen = new Set<string>();
  const queue: [string, number][] = opts.roots.map((r) => [resolve(r), 0]);
  let truncated = false;
  while (queue.length) {
    if (now() - start > budget) {
      truncated = true;
      break;
    }
    const [dir, depth] = queue.shift()!;
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (isOfficeWorktree(dir)) continue;
    const repo = readRepo(dir);
    if (repo) repos.push(repo);
    if (depth >= maxDepth) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // Real folders only (no links: no loops, no wandering off), and none that are hidden or generated.
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name.startsWith("$") || SKIP.has(e.name.toLowerCase())) continue;
      queue.push([join(dir, e.name), depth + 1]);
    }
  }
  repos.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.path.localeCompare(b.path));
  return { repos, truncated, ms: now() - start };
}

const CACHE_MS = 120_000;
let cache: { key: string; at: number; result: ScanResult } | null = null;

/** scanRepos, remembered for a couple of minutes (`fresh`: look again now). */
export function findRepos(opts: ScanOptions & { fresh?: boolean }): ScanResult {
  const key = opts.roots.join("|").toLowerCase();
  const now = Date.now();
  if (!opts.fresh && cache && cache.key === key && now - cache.at < CACHE_MS) return cache.result;
  const result = scanRepos(opts);
  cache = { key, at: now, result };
  return result;
}

/** The repos found, minus the ones already open and the office's own worktrees. */
export function notOpen(found: FoundRepo[], open: string[]): FoundRepo[] {
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, "").toLowerCase();
  const have = new Set(open.map(norm));
  return found.filter((r) => !have.has(norm(r.path)) && !isOfficeWorktree(r.path));
}
