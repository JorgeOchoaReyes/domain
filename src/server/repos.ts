import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { samePath } from "./prefs.js";

/**
 * The repos the office works in at once. The office's own project (the
 * folder it started in) is always open; other repos open alongside it, with
 * no restart, each with its own worktrees, checks, merges and pull requests.
 * Each worker works in one of them — the one it was hired into, or moved to,
 * or the one a task names — and new hires go to the one you pick.
 *
 * Kept in the project's .domain/repos.json ({ repos, hireRepo }). An office
 * that never opened another repo has no such file, and works as it always did.
 */

interface Saved {
  repos: string[];
  hireRepo?: string;
}

export const MAX_OPEN_REPOS = 12;

function isFolder(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export class OpenRepos {
  /** The office's own project. */
  readonly main: string;
  private extra: string[] = [];
  private hire: string | null = null;

  /** Called when the list or the hire repo changes. */
  onChange: (() => void) | null = null;

  /** `file`: where the list is kept (null: only for this run). */
  constructor(
    main: string,
    private readonly file: string | null = null,
  ) {
    this.main = resolve(main);
    this.load();
  }

  /** Every open repo's folder: the project first, then the others in the order they were opened. */
  all(): string[] {
    return [this.main, ...this.extra];
  }

  /** The repos open alongside the project. */
  others(): string[] {
    return [...this.extra];
  }

  isMain(path: string | null | undefined): boolean {
    return !path || samePath(path, this.main);
  }

  /**
   * The open repo you mean: its folder, its folder's name, or the start of
   * that name (any case). Null when none (or more than one) matches.
   */
  find(query: string | null | undefined): string | null {
    const q = (query ?? "").trim();
    if (!q) return null;
    const all = this.all();
    const byPath = all.find((p) => samePath(p, q));
    if (byPath) return byPath;
    const lower = q.toLowerCase();
    const exact = all.filter((p) => basename(p).toLowerCase() === lower);
    if (exact.length === 1) return exact[0];
    const starts = all.filter((p) => basename(p).toLowerCase().startsWith(lower));
    return starts.length === 1 ? starts[0] : null;
  }

  /** Open a folder alongside the project. Returns its path, or null when it isn't a folder (or too many are open). */
  add(path: string): string | null {
    const target = resolve(path);
    if (!isFolder(target)) return null;
    const have = this.all().find((p) => samePath(p, target));
    if (have) return have;
    if (this.extra.length >= MAX_OPEN_REPOS) return null;
    this.extra.push(target);
    this.save();
    return target;
  }

  /** Close an open repo (the project itself stays open). */
  remove(path: string): boolean {
    const target = this.find(path);
    if (!target || this.isMain(target)) return false;
    this.extra = this.extra.filter((p) => !samePath(p, target));
    if (this.hire && samePath(this.hire, target)) this.hire = null;
    this.save();
    return true;
  }

  /** Where new hires work (the project unless you picked another). */
  get hireRepo(): string {
    return this.hire ?? this.main;
  }

  setHireRepo(path: string): boolean {
    const target = this.find(path);
    if (!target) return false;
    this.hire = this.isMain(target) ? null : target;
    this.save();
    return true;
  }

  /** The repo a hire goes to: the one asked for (if it's open), else where new hires work. */
  forHire(asked?: unknown): string {
    return (typeof asked === "string" ? this.find(asked) : null) ?? this.hireRepo;
  }

  private load(): void {
    if (!this.file) return;
    let raw: Partial<Saved>;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Saved>;
    } catch {
      return;
    }
    const seen: string[] = [];
    for (const p of Array.isArray(raw.repos) ? raw.repos : []) {
      // A folder that's gone (moved, deleted) just isn't open any more.
      if (typeof p !== "string" || !isFolder(p) || samePath(p, this.main) || seen.some((s) => samePath(s, p))) continue;
      seen.push(resolve(p));
    }
    this.extra = seen.slice(0, MAX_OPEN_REPOS);
    if (typeof raw.hireRepo === "string") this.hire = this.extra.find((p) => samePath(p, raw.hireRepo!)) ?? null;
  }

  private save(): void {
    this.onChange?.();
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ repos: this.extra, ...(this.hire ? { hireRepo: this.hire } : {}) } satisfies Saved, null, 2));
      renameSync(tmp, this.file);
    } catch {
      /* best effort */
    }
  }
}
