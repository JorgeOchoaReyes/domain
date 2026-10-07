import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Each worker's own desk in git: a worktree under `.domain/worktrees/<desk>`
 * on its own branch (`domain/<agent>-<desk>-<id>`), cut from the branch your
 * project is on. Parallel workers never edit the same files on disk; their
 * work comes back to your branch when you approve it, one merge at a time.
 *
 * A worktree holds only what git tracks, so a worker's copy would have no
 * installed dependencies and its checks couldn't run. Each one gets links to
 * your checkout's dependency folders instead (node_modules, .venv) — only
 * where git ignores them, so they never end up in a commit.
 *
 * Every git call is synchronous and local. Nothing is pushed anywhere.
 */

/** Installed-dependency folders a worker's copy borrows from your checkout. */
const DEP_DIRS = ["node_modules", ".venv", "venv"];

export interface Workspace {
  path: string;
  branch: string;
}

export interface MergeResult {
  ok: boolean;
  /** "merged" | "nothing" (no new commits) | "dirty" (your checkout has uncommitted changes) | "conflict" | "error" */
  outcome: "merged" | "nothing" | "dirty" | "conflict" | "error";
  message: string;
}

export class Workspaces {
  /** The repository's top folder, or null when the project isn't a git repo with a commit. */
  readonly root: string | null;

  constructor(private readonly cwd: string) {
    this.root = this.detect();
  }

  get enabled(): boolean {
    return this.root !== null;
  }

  /** The branch your main checkout is on (what workers branch from and merge into). */
  base(): string | null {
    if (!this.root) return null;
    const b = this.git(this.root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return b && b !== "HEAD" ? b : null;
  }

  /** Give a desk its own worktree on a fresh branch. Returns null if that isn't possible here. */
  create(deskId: string, agent: string): Workspace | null {
    if (!this.root) return null;
    const id = Math.random().toString(36).slice(2, 6);
    const branch = `domain/${agent}-${deskId}-${id}`;
    const dir = join(this.root, ".domain", "worktrees");
    // The same folder for a desk each time (unless the last one was kept), so an
    // agent that asks whether to trust its folder only asks once per desk.
    const path = existsSync(join(dir, deskId)) ? join(dir, `${deskId}-${id}`) : join(dir, deskId);
    try {
      mkdirSync(dir, { recursive: true });
      this.ignoreDomainDir();
      this.gitOrThrow(this.root, ["worktree", "add", "-b", branch, path, "HEAD"]);
      // Keep the worker in the same subfolder of the repo the project is in.
      const sub = relative(this.root, this.cwd);
      const workDir = sub && !sub.startsWith("..") ? join(path, sub) : path;
      this.linkDeps(path);
      return { path: existsSync(workDir) ? workDir : path, branch };
    } catch {
      return null;
    }
  }

  /**
   * Who the office's own commits (merges, a worker's leftover changes) are by:
   * you, as git knows you — so GitHub, and anything that checks commit
   * authors (like Vercel), sees your account. Only when git has no identity
   * for you at all do they fall back to "domain".
   */
  private identity(cwd: string): string[] {
    const email = this.git(cwd, ["config", "user.email"])?.trim();
    const name = this.git(cwd, ["config", "user.name"])?.trim();
    if (email && name) return [];
    return ["-c", `user.name=${name || "domain"}`, "-c", `user.email=${email || "domain@localhost"}`];
  }

  /** Whether a worktree has uncommitted changes. */
  dirty(path: string): boolean {
    return (this.git(path, ["status", "--porcelain"]) ?? "").trim().length > 0;
  }

  /** Commit whatever a worker left uncommitted, so its branch holds all of its work. */
  commitAll(path: string, message: string): boolean {
    if (!this.dirty(path)) return false;
    try {
      this.gitOrThrow(path, ["add", "-A"]);
      this.gitOrThrow(path, [...this.identity(path), "commit", "-m", message, "--no-verify"]);
      return true;
    } catch {
      return false;
    }
  }

  /** Each file a worker's work touches against your branch, with lines added and removed (new files too). */
  diffFiles(path: string): { file: string; added: number; removed: number }[] {
    const base = this.base();
    if (!base) return [];
    const out: { file: string; added: number; removed: number }[] = [];
    for (const l of (this.git(path, ["diff", "--numstat", base]) ?? "").split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l);
      if (m && !m[3].startsWith(".domain/")) out.push({ file: m[3], added: Number(m[1]) || 0, removed: Number(m[2]) || 0 });
    }
    for (const f of (this.git(path, ["ls-files", "--others", "--exclude-standard"]) ?? "").split("\n").filter(Boolean).slice(0, 40)) {
      if (f.startsWith(".domain/")) continue;
      try {
        out.push({ file: f, added: readFileSync(join(path, f), "utf8").split("\n").length, removed: 0 });
      } catch {
        /* unreadable: skip it */
      }
    }
    return out;
  }

  /**
   * How many lines a worker's work adds and removes against your branch:
   * committed and uncommitted changes, plus the new files it hasn't added yet.
   * Null when it can't tell (no base, git failed, or too many new files to count).
   */
  diffLines(path: string): number | null {
    const base = this.base();
    if (!base) return null;
    const stat = this.git(path, ["diff", "--shortstat", base]);
    if (stat === null) return null;
    let n = 0;
    for (const m of stat.matchAll(/(\d+) (?:insertion|deletion)/g)) n += Number(m[1]);
    const untracked = this.git(path, ["ls-files", "--others", "--exclude-standard"]);
    if (untracked === null) return null;
    const files = untracked.split("\n").filter(Boolean);
    if (files.length > 40) return null;
    for (const f of files) {
      try {
        n += readFileSync(join(path, f), "utf8").split("\n").length;
      } catch {
        return null;
      }
    }
    return n;
  }

  /**
   * Bring your branch's latest into a worker's branch before its next task,
   * when its worktree is clean and it merges without conflicts.
   */
  sync(path: string): boolean {
    const base = this.base();
    if (!base || this.dirty(path)) return false;
    try {
      this.gitOrThrow(path, [...this.identity(path), "merge", "--no-edit", base]);
      return true;
    } catch {
      this.git(path, ["merge", "--abort"]);
      return false;
    }
  }

  /** Merge a worker's branch into your branch, in your main checkout. Never leaves a half-done merge behind. */
  merge(branch: string, title: string): MergeResult {
    const base = this.base();
    if (!this.root || !base) return { ok: false, outcome: "error", message: "No branch to merge into" };
    const ahead = Number(this.git(this.root, ["rev-list", "--count", `${base}..${branch}`]) ?? "0");
    if (!ahead) return { ok: true, outcome: "nothing", message: `${branch} has nothing new for ${base}` };
    if (this.trackedChanges(this.root)) {
      return { ok: false, outcome: "dirty", message: `Your checkout has uncommitted changes, so ${branch} wasn't merged into ${base}` };
    }
    try {
      this.gitOrThrow(this.root, [...this.identity(this.root), "merge", "--no-ff", "--no-verify", "-m", `Merge ${branch}: ${title}`, branch]);
      return { ok: true, outcome: "merged", message: `Merged ${branch} into ${base}` };
    } catch {
      this.git(this.root, ["merge", "--abort"]);
      return { ok: false, outcome: "conflict", message: `${branch} conflicts with ${base}` };
    }
  }

  /**
   * Clear a desk's worktree when its worker leaves. A branch with work that
   * never reached your branch is kept (only the folder goes), so nothing is lost.
   */
  remove(ws: Workspace): "removed" | "kept" {
    if (!this.root) return "kept";
    const base = this.base();
    const top = this.git(ws.path, ["rev-parse", "--show-toplevel"]) ?? ws.path;
    const unmerged = base ? Number(this.git(this.root, ["rev-list", "--count", `${base}..${ws.branch}`]) ?? "0") : 1;
    const dirty = this.dirty(top);
    if (dirty) return "kept";
    // The dependency links go first, so removing the folder can't reach through them.
    this.unlinkDeps(top);
    this.git(this.root, ["worktree", "remove", "--force", top]);
    if (!unmerged) {
      this.git(this.root, ["branch", "-D", ws.branch]);
      return "removed";
    }
    return "kept";
  }

  // --- internals ----------------------------------------------------------------

  /** Where dependency folders can be: the top, and each folder one level down (a monorepo's packages). */
  private depSpots(top: string): string[] {
    const spots = [""];
    try {
      for (const e of readdirSync(this.root!, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith(".") && !DEP_DIRS.includes(e.name)) spots.push(e.name);
      }
    } catch {
      /* unreadable */
    }
    return spots.filter((s) => existsSync(join(top, s)));
  }

  /** Link a new worktree's dependency folders to your checkout's, where git ignores them. */
  private linkDeps(path: string): void {
    for (const spot of this.depSpots(path)) {
      for (const name of DEP_DIRS) {
        const real = join(this.root!, spot, name);
        const link = join(path, spot, name);
        if (!existsSync(real) || existsSync(link)) continue;
        // Never something git would pick up and a worker could commit.
        // (Asked of your checkout, where the folder exists: git only matches "node_modules/" against a real folder.)
        if (this.git(this.root!, ["check-ignore", "-q", join(spot, name)]) === null) continue;
        try {
          symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
        } catch {
          /* no links on this filesystem: the worker installs its own */
        }
      }
    }
  }

  /** Remove those links (never what they point to). */
  private unlinkDeps(path: string): void {
    for (const spot of this.depSpots(path)) {
      for (const name of DEP_DIRS) {
        const link = join(path, spot, name);
        try {
          if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
        } catch {
          /* not there */
        }
      }
    }
  }

  private detect(): string | null {
    const top = this.git(this.cwd, ["rev-parse", "--show-toplevel"]);
    if (!top) return null;
    // A worktree needs a commit to branch from.
    if (!this.git(top, ["rev-parse", "--verify", "HEAD"])) return null;
    return resolve(top);
  }

  /** Changes to tracked files (untracked files don't block a merge we'd make). */
  private trackedChanges(dir: string): boolean {
    return (this.git(dir, ["status", "--porcelain", "--untracked-files=no"]) ?? "").trim().length > 0;
  }

  /** Keep .domain/ (and the worktrees in it) out of `git status`, locally, without touching .gitignore. */
  private ignoreDomainDir(): void {
    if (!this.root) return;
    const gitDir = this.git(this.root, ["rev-parse", "--git-common-dir"]);
    if (!gitDir) return;
    const exclude = join(resolve(this.root, gitDir), "info", "exclude");
    try {
      const have = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
      // Unanchored, so a project in a subfolder of the repo (and the sketches
      // handed to workers there) is covered too.
      if (!/^\.domain\/\s*$/m.test(have)) {
        mkdirSync(join(resolve(this.root, gitDir), "info"), { recursive: true });
        appendFileSync(exclude, `${have && !have.endsWith("\n") ? "\n" : ""}.domain/\n`);
      }
    } catch {
      /* best effort */
    }
  }

  private git(cwd: string, args: string[]): string | null {
    try {
      return this.gitOrThrow(cwd, args);
    } catch {
      return null;
    }
  }

  private gitOrThrow(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 60_000 }).trim();
  }
}
