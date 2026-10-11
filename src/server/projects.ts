import { AGENT_LABELS } from "../shared/protocol.js";
import type { RepoStatus } from "../shared/project.js";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { WebSocket } from "ws";
import type { Goal } from "../shared/progress.js";
import type { GithubIssue, ProjectInfo, RepoWorker } from "../shared/project.js";
import { parseGithubRemote } from "../shared/project.js";
import type { ClientRec, Routes, ServerCtx } from "./ctx.js";
import { GitHub, SignInNeeded } from "./github.js";
import { loadPrefs, prefsPath, rememberProject, samePath, savePrefs } from "./prefs.js";

/**
 * Projects and GitHub: which folder the office works in, the ones you've
 * opened before, cloning a repo to start fresh, your GitHub sign-in, turning
 * issues into tasks, and shipping a goal as a pull request (then following
 * its checks). Every git command and GitHub call lands in the Logs.
 *
 * Other repos can be open alongside the project (no restart): each worker
 * works in one, and the Repo view, a goal's pull request and its checks
 * follow the repo the work was done in.
 */

export interface ProjectDeps {
  github?: GitHub;
  /** Where prefs live (tests use a temp file). */
  prefsFile?: string;
  /** Where clones go. */
  projectsDir?: string;
  /** A native folder picker (the desktop app provides one). */
  pickFolder?: () => Promise<string | null>;
  /** Poll open pull requests this often (ms); 0 = never. */
  pollMs?: number;
}

export interface ProjectsApi {
  routes: Routes;
  /** A repo's info: the project's, or another open repo's (by folder). */
  info(path?: string): Promise<ProjectInfo>;
  /** Check open pull requests now (it also runs every minute). */
  poll(): Promise<void>;
  /** Stop polling. */
  dispose(): void;
}

/** Run git and resolve with stdout (trimmed), or null when it fails. */
function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((done) =>
    execFile("git", args, { cwd, windowsHide: true, timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout) =>
      done(err ? null : stdout.toString().trim()),
    ),
  );
}

/**
 * Run git with its output streamed into an oplog entry; resolves with
 * whether it exited 0 and everything it printed.
 */
function gitLogged(ctx: ServerCtx, cwd: string, args: string[], title: string, topic: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((done) => {
    const op = ctx.log.start("git", title, { command: `git ${args.join(" ")}`, topic });
    let output = "";
    const child = spawn("git", args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    const take = (b: Buffer) => {
      const t = b.toString("utf8");
      output += t;
      // Progress lines end in \r: show each update on its own line.
      op.append(t.replace(/\r(?!\n)/g, "\n"));
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (e) => {
      op.done(false, e.message);
      done({ ok: false, output: e.message });
    });
    child.on("close", (code) => {
      op.done(code === 0, code === 0 ? "Done." : `git exited with ${code}`);
      done({ ok: code === 0, output });
    });
  });
}

/** A clone URL from what you typed: owner/repo, a GitHub URL, git@github.com:…, or any https/file git URL. */
export function normalizeCloneUrl(input: string): string | null {
  const s = input.trim();
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) return `https://github.com/${s.replace(/\.git$/, "")}.git`;
  const ssh = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(s);
  if (ssh) return `https://github.com/${ssh[1]}/${ssh[2]}.git`;
  if (/^https:\/\/[^\s"'`]+$/.test(s)) return s;
  if (/^file:\/\/[^\s"'`]+$/.test(s)) return s;
  return null;
}

/** The folder name for a clone: the repo's name, made unique in `dir`. */
export function cloneTarget(dir: string, url: string): string {
  const base = (/([^/\\:]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? "project").replace(/[^A-Za-z0-9_.-]/g, "-") || "project";
  let target = join(dir, base);
  for (let n = 2; existsSync(target); n++) target = join(dir, `${base}-${n}`);
  return target;
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "work"
  );
}

function isFolder(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function createProjects(ctx: ServerCtx, deps: ProjectDeps = {}): ProjectsApi {
  const prefsFile = deps.prefsFile ?? prefsPath();
  // The project's GitHub owner (from its origin), once looked up.
  let owner: string | null = null;
  // Git's credential manager can hold several GitHub accounts: use the one you
  // signed in as last, or the repo's owner, rather than a picker nobody sees.
  const github = deps.github ?? new GitHub({ log: ctx.log, username: () => loadPrefs(prefsFile).githubLogin ?? owner });
  // Other modules (MCP) borrow the sign-in to authenticate workers' GitHub tools.
  ctx.githubToken = () => github.token;
  const projectsDir = deps.projectsDir ?? process.env.DOMAIN_PROJECTS_DIR ?? join(homedir(), "Documents", "domain", "projects");
  const pickFolder =
    deps.pickFolder ?? (globalThis as { __domainPickFolder?: () => Promise<string | null> }).__domainPickFolder ?? null;
  let lastIssues: GithubIssue[] = [];
  let busy = false;

  /** Whether a folder is the project itself (not another open repo). */
  const isMain = (path: string) => samePath(path, ctx.cwd);

  async function info(at: string = ctx.cwd): Promise<ProjectInfo> {
    const path = resolve(at);
    const top = await git(path, ["rev-parse", "--show-toplevel"]);
    if (top === null) return { path, name: basename(path), isGit: false, branch: null, github: null, dirty: false };
    const [branch, remote, status] = await Promise.all([
      git(path, ["rev-parse", "--abbrev-ref", "HEAD"]),
      git(path, ["remote", "get-url", "origin"]),
      git(path, ["status", "--porcelain", "--untracked-files=no"]),
    ]);
    const gh = remote ? parseGithubRemote(remote) : null;
    if (isMain(path)) owner = gh?.owner ?? null;
    return {
      path,
      name: basename(path),
      isGit: true,
      branch: branch && branch !== "HEAD" ? branch : null,
      github: gh ? { ...gh, url: `https://github.com/${gh.owner}/${gh.repo}` } : null,
      dirty: !!status,
    };
  }

  // --- where the repo stands ----------------------------------------------------------------
  /** When each repo was last fetched from GitHub. */
  const fetched = new Map<string, number>();
  /** A commit, briefly (null when there isn't one). */
  const commit = async (cwd: string, ref = "HEAD") => {
    const l = await git(cwd, ["log", "-1", "--format=%h%x09%s%x09%cr", ref]);
    if (!l) return null;
    const [sha, subject, when] = l.split("\t");
    return { sha, subject: subject ?? "", when: when ?? "" };
  };
  async function repoStatus(at: string = ctx.cwd): Promise<RepoStatus> {
    const cwd = resolve(at);
    // With other repos open: each one's own status too, all named.
    const others = isMain(cwd) ? (ctx.repos?.others() ?? []) : [];
    const named = others.length || !isMain(cwd) ? { path: cwd, name: basename(cwd) } : {};
    const more = others.length ? { others: await Promise.all(others.map((p) => repoStatus(p))) } : {};
    const i = await info(cwd);
    let fetchedAt = fetched.get(cwd) ?? null;
    const empty: RepoStatus = { at: Date.now(), isGit: false, branch: null, github: null, ahead: null, behind: null, fetchedAt, last: null, dirty: [], agents: [], pulls: null, ...named, ...more };
    if (!i.isGit) return empty;
    // What GitHub has, every couple of minutes at most (never asking you to sign in from here).
    if (i.github && (!fetchedAt || Date.now() - fetchedAt > 120_000)) {
      const ok = await new Promise<boolean>((done) =>
        execFile("git", ["fetch", "--quiet", "origin"], { cwd, windowsHide: true, timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } }, (err) => done(!err)),
      );
      if (ok) fetched.set(cwd, (fetchedAt = Date.now()));
    }
    // Against its upstream — or, without one set, the same branch on origin.
    const counts =
      (await git(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])) ??
      (i.branch ? await git(cwd, ["rev-list", "--left-right", "--count", `origin/${i.branch}...HEAD`]) : null);
    const [behind, ahead] = counts ? counts.split(/\s+/).map(Number) : [null, null];
    const dirty = ((await git(cwd, ["status", "--porcelain"])) ?? "")
      .split("\n")
      .filter((l) => l.trim() && !/\.domain\//.test(l))
      .map((l) => l.slice(3))
      .slice(0, 20);
    const base = i.branch;
    const agents: RepoStatus["agents"] = [];
    for (const d of ctx.office?.snapshot().desks ?? []) {
      const w = d.worker;
      // Only the agents working in this repo.
      if (!w?.branch || !base || !samePath(ctx.office.repoOf(d.id), cwd)) continue;
      const n = await git(cwd, ["rev-list", "--count", `${base}..${w.branch}`]);
      const st = await git(ctx.office.workdir(d.id), ["status", "--porcelain"]);
      agents.push({
        deskId: d.id,
        name: w.identity?.name ?? `${AGENT_LABELS[w.agent]} · ${d.label}`,
        branch: w.branch,
        ahead: Number(n ?? 0),
        dirty: (st ?? "").split("\n").filter((l) => l.trim() && !/\.domain\//.test(l)).length,
        last: await commit(cwd, w.branch),
      });
    }
    let pulls: RepoStatus["pulls"] = null;
    let pullsError: string | undefined;
    if (i.github && github.account) {
      try {
        pulls = await github.openPulls(i.github.owner, i.github.repo);
      } catch (e) {
        pullsError = e instanceof Error ? e.message : String(e);
      }
    }
    return { at: Date.now(), isGit: true, branch: i.branch, github: i.github, ahead, behind, fetchedAt, last: await commit(cwd), dirty, agents, pulls, ...(pullsError ? { pullsError } : {}), ...named, ...more };
  }

  /** Who works in which repo. */
  function workers(): RepoWorker[] {
    if (!ctx.office) return [];
    return ctx.office
      .snapshot()
      .desks.filter((d) => d.worker)
      .map((d) => ({ deskId: d.id, name: d.worker!.identity?.name ?? `${AGENT_LABELS[d.worker!.agent]} · ${d.label}`, repo: ctx.office.repoOf(d.id) }));
  }

  async function projectMessage() {
    const i = await info();
    const repos = ctx.repos;
    return {
      t: "project" as const,
      info: i,
      recent: loadPrefs(prefsFile).recent,
      account: github.account,
      ...(repos ? { repos: await Promise.all(repos.others().map((p) => info(p))), hireRepo: repos.hireRepo, workers: workers() } : {}),
    };
  }

  async function sendProject(ws: WebSocket): Promise<void> {
    ctx.send(ws, await projectMessage());
  }

  /** The open repos changed (or who works where): everyone sees it. */
  async function broadcastProject(): Promise<void> {
    ctx.broadcast(await projectMessage());
  }

  const fail = (title: string, why: string) => ctx.log.start("git", title, { topic: "project" }).done(false, why);

  /** Open another repo alongside the project: no restart, and it's in Recent. */
  async function addRepo(path: string): Promise<void> {
    if (!ctx.repos) return void fail("Open a repo alongside", "This office works on one project at a time.");
    const target = ctx.repos.add(path);
    if (!target) return void fail(`Can't open ${resolve(path)}`, "That folder doesn't exist (or a dozen repos are open already).");
    const remote = await git(target, ["remote", "get-url", "origin"]);
    const gh = remote ? parseGithubRemote(remote) : null;
    rememberProject(target, gh ? `${gh.owner}/${gh.repo}` : null, { file: prefsFile });
    ctx.log.start("git", `Opened ${basename(target)} alongside ${basename(resolve(ctx.cwd))}`, { topic: "project" }).done(true, target);
    await broadcastProject();
  }

  function closeRepo(path: string): void {
    const target = ctx.repos?.find(path);
    if (!ctx.repos || !target || isMain(target)) return;
    const busy = workers().filter((w) => samePath(w.repo, target));
    if (busy.length) return void fail(`Close ${basename(target)}`, `${busy.map((w) => w.name).join(", ")} still work${busy.length === 1 ? "s" : ""} there — move them to another repo (or let them go) first.`);
    ctx.repos.remove(target);
    ctx.log.start("git", `Closed ${basename(target)}`, { topic: "project" }).done(true, "Its worktrees and branches are kept; open it again any time.");
    void broadcastProject();
  }

  /** Move a worker to another open repo: it restarts there, on a branch of its own. */
  function moveWorker(deskId: string, repo: string): void {
    const target = ctx.repos?.find(repo);
    if (!target) return void fail("Move a worker", `“${repo}” isn't an open repo.`);
    const r = ctx.office.moveToRepo(deskId, target, ctx.progress.policy.isolate);
    if (!r?.moved) return;
    const name = workers().find((w) => w.deskId === deskId)?.name ?? deskId;
    ctx.broadcast({ t: "loop", goalId: "", event: "warn", text: `📦 ${name} now works in ${basename(target)}` });
    if (r.kept) ctx.broadcast({ t: "loop", goalId: "", event: "mergeFailed", text: `🌿 Kept ${r.kept} — it has work that isn't on its repo's branch yet` });
    void broadcastProject();
  }

  /** Record where we are now, so it's in Recent. */
  void info().then((i) => rememberProject(i.path, i.github ? `${i.github.owner}/${i.github.repo}` : null, { file: prefsFile }));

  /** Switch the office to `path`: remember it, tell everyone, restart on it. */
  async function open(path: string, ws: WebSocket): Promise<void> {
    const target = resolve(path);
    if (!isFolder(target)) {
      ctx.log.start("git", `Can't open ${target}`, { topic: "project" }).done(false, "That folder doesn't exist.");
      return;
    }
    const remote = await git(target, ["remote", "get-url", "origin"]);
    const gh = remote ? parseGithubRemote(remote) : null;
    rememberProject(target, gh ? `${gh.owner}/${gh.repo}` : null, { current: true, file: prefsFile });
    if (resolve(target) === resolve(ctx.cwd)) {
      void sendProject(ws);
      return;
    }
    ctx.broadcast({ t: "projectSwitching", path: target, name: basename(target) });
    if (!ctx.relaunch(target)) {
      ctx.log
        .start("git", `Switch to ${basename(target)}`, { topic: "project" })
        .done(false, `Switching projects restarts the office, which only the desktop app can do by itself.\nRestart the server with DOMAIN_CWD="${target}" to work there.`);
    }
  }

  async function clone(input: string, ws: WebSocket, add = false): Promise<void> {
    const url = normalizeCloneUrl(input);
    if (!url) {
      ctx.log.start("git", "Clone", { topic: "clone" }).done(false, `“${input}” isn't a repository URL. Try owner/repo or https://github.com/owner/repo.`);
      return;
    }
    if (busy) return;
    busy = true;
    try {
      mkdirSync(projectsDir, { recursive: true });
      const target = cloneTarget(projectsDir, url);
      const r = await gitLogged(ctx, projectsDir, ["clone", "--progress", url, target], `Cloning ${url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")}`, "clone");
      if (r.ok) await (add && ctx.repos ? addRepo(target) : open(target, ws));
    } finally {
      busy = false;
    }
  }

  async function signedInAccount(ws: WebSocket, interactive: boolean): Promise<boolean> {
    try {
      if (!owner) await info();
      const account = await github.signIn(interactive);
      if (account) {
        const p = loadPrefs(prefsFile);
        if (p.githubLogin !== account.login) savePrefs({ ...p, githubLogin: account.login }, prefsFile);
      }
      ctx.send(ws, { t: "githubAccount", account, error: account ? undefined : interactive ? "Sign-in didn't finish." : undefined });
      return !!account;
    } catch (e) {
      ctx.send(ws, { t: "githubAccount", account: null, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  /**
   * The repo a goal ships from: the one asked for, else the one its tasks were
   * done in (when they agree), else the project.
   */
  function shipRepo(goal: Goal, asked?: unknown): string {
    const repos = ctx.repos;
    if (!repos) return ctx.cwd;
    const want = typeof asked === "string" ? repos.find(asked) : null;
    if (want) return want;
    const used: string[] = [];
    for (const t of goal.tasks) {
      const r = t.brief?.repo ? repos.find(t.brief.repo) : null;
      if (r && !used.some((u) => samePath(u, r))) used.push(r);
    }
    return used.length === 1 ? used[0] : ctx.cwd;
  }

  async function shipPR(goalId: string, client: ClientRec, ws: WebSocket, asked?: unknown): Promise<void> {
    const goal = ctx.progress.getGoal(goalId);
    const topic = `ship:${goalId}`;
    const fail = (why: string) => ctx.log.start("github", `Pull request for “${goal?.title ?? "goal"}”`, { topic }).done(false, why);
    if (!goal || goal.shippedAt) return;
    const at = shipRepo(goal, asked);
    const i = await info(at);
    if (!i.github) return void fail("This project has no GitHub remote (origin). Add one, or ship another way.");
    if (!i.branch) return void fail("Your checkout isn't on a branch.");
    try {
      if (!github.account && !(await github.signIn(false))) throw new SignInNeeded();
      const { owner, repo } = i.github;
      const base = await github.defaultBranch(owner, repo, topic);
      let head = `domain/${slugify(goal.title)}`;
      let pushed = await gitLogged(ctx, at, ["push", "origin", `HEAD:refs/heads/${head}`], `Pushing ${i.branch} to ${owner}/${repo} as ${head}`, topic);
      if (!pushed.ok && /rejected|non-fast-forward|fetch first/i.test(pushed.output)) {
        head = `${head}-${Date.now().toString(36).slice(-4)}`;
        pushed = await gitLogged(ctx, at, ["push", "origin", `HEAD:refs/heads/${head}`], `Pushing as ${head} instead`, topic);
      }
      if (!pushed.ok) return;
      const session = ctx.progress.snapshot().session;
      const intention = session?.goalId === goal.id && session.intention ? `\n\n> ${session.intention}` : "";
      const tasks = goal.tasks.map((t) => `- [${t.status === "done" ? "x" : " "}] ${t.title}`).join("\n");
      const body = `${goal.why ? `${goal.why}\n\n` : ""}**Tasks**\n${tasks}${intention}\n\n_Opened from the office in domain by ${client.name}._`;
      const opened = await github.createPull(owner, repo, { title: goal.title, head, base, body }, topic);
      // On another open repo: the PR says which, so its checks are followed there.
      const pr = isMain(at) ? opened : { ...opened, repo: `${owner}/${repo}` };
      ctx.log.start("github", `Opened pull request #${pr.number}`, { topic }).done(true, pr.url, pr.url);
      ctx.progress.setPr(goal.id, pr);
      ctx.broadcast({ t: "pr", goalId: goal.id, pr });
      ctx.progress.shipped(client.name, goal.id, { mode: "manual", url: pr.url, note: `Pull request #${pr.number} on GitHub` });
      ctx.broadcast({ t: "loop", goalId: goal.id, event: "shipped", text: `🚢 Opened pull request #${pr.number} for “${goal.title}”` });
    } catch (e) {
      if (e instanceof SignInNeeded) {
        fail("Sign in to GitHub first (Projects → Sign in with GitHub).");
        ctx.send(ws, { t: "githubAccount", account: null, error: e.message });
      }
      // Other errors are already in the log.
    }
  }

  /** Follow open pull requests: state and checks. */
  const poll = async () => {
    if (!github.account) return;
    const i = await info().catch(() => null);
    for (const g of ctx.progress.snapshot().goals) {
      if (!g.pr || g.pr.state !== "open") continue;
      // Its own repo's (another open repo's), or the project's.
      const [owner, repo] = g.pr.repo ? g.pr.repo.split("/") : [i?.github?.owner, i?.github?.repo];
      if (!owner || !repo) continue;
      try {
        const status = await github.pullStatus(owner, repo, g.pr.number, `ship:${g.id}`);
        const now = g.pr.repo ? { ...status, repo: g.pr.repo } : status;
        if (now.state !== g.pr.state || now.checks !== g.pr.checks) {
          ctx.progress.setPr(g.id, now);
          ctx.broadcast({ t: "pr", goalId: g.id, pr: now });
        }
      } catch {
        /* logged */
      }
    }
  };
  const pollMs = deps.pollMs ?? 60_000;
  const timer = pollMs ? setInterval(() => void poll(), pollMs) : null;
  timer?.unref?.();

  const routes: Routes = {
    repoStatus: (_m, _c, ws) => void repoStatus().then((status) => ctx.send(ws, { t: "repoStatus", status })),
    projectInfo: (_m, _c, ws) => {
      void sendProject(ws);
      // Quietly check whether git already holds a GitHub sign-in.
      if (!github.account) void signedInAccount(ws, false);
    },
    projectOpen: (m, _c, ws) => {
      const path = typeof m.path === "string" ? m.path.trim() : "";
      if (path) return void open(path, ws);
      // No path: ask with the native folder picker (the desktop app has one).
      if (!pickFolder) {
        ctx.log.start("git", "Open a folder", { topic: "project" }).done(false, "Type the folder's path — the folder picker is in the desktop app.");
        return;
      }
      void pickFolder().then((p) => {
        if (p) void open(p, ws);
      });
    },
    projectClone: (m, _c, ws) => {
      if (typeof m.url === "string") void clone(m.url, ws, m.add === true);
    },
    repoAdd: (m) => {
      const path = typeof m.path === "string" ? m.path.trim() : "";
      if (path) return void addRepo(path);
      if (!pickFolder) return void fail("Open a repo alongside", "Type the folder's path — the folder picker is in the desktop app.");
      void pickFolder().then((p) => {
        if (p) void addRepo(p);
      });
    },
    repoClose: (m) => {
      if (typeof m.path === "string") closeRepo(m.path);
    },
    repoHire: (m) => {
      if (typeof m.path === "string" && ctx.repos?.setHireRepo(m.path)) void broadcastProject();
    },
    workerRepo: (m) => {
      if (typeof m.deskId === "string" && typeof m.repo === "string") moveWorker(m.deskId, m.repo);
    },
    githubSignIn: (_m, _c, ws) => void signedInAccount(ws, true),
    githubRepos: (_m, _c, ws) =>
      void github
        .repos()
        .then((repos) => ctx.send(ws, { t: "githubRepos", repos }))
        .catch((e: Error) => ctx.send(ws, { t: "githubRepos", repos: [], error: e.message })),
    githubIssues: (_m, _c, ws) =>
      void info().then(async (i) => {
        if (!i.github) return ctx.send(ws, { t: "githubIssues", issues: [], error: "This project isn't on GitHub (no origin remote)." });
        try {
          lastIssues = await github.issues(i.github.owner, i.github.repo);
          ctx.send(ws, { t: "githubIssues", issues: lastIssues });
        } catch (e) {
          ctx.send(ws, { t: "githubIssues", issues: [], error: e instanceof Error ? e.message : String(e) });
        }
      }),
    issuesImport: (m, client) => {
      const numbers = Array.isArray(m.numbers) ? m.numbers.filter((n): n is number => typeof n === "number").slice(0, 40) : [];
      const picked = lastIssues.filter((i) => numbers.includes(i.number));
      if (!picked.length) return;
      const titles = picked.map((i) => `#${i.number} ${i.title}`.slice(0, 160));
      const goalId = typeof m.goalId === "string" ? m.goalId : null;
      if (goalId && ctx.progress.getGoal(goalId)) for (const t of titles) ctx.progress.addTask(goalId, t);
      else ctx.progress.createGoal(client.name, "GitHub issues", "Open issues from GitHub", titles, "build");
      ctx.log.start("github", `Imported ${titles.length} issue${titles.length === 1 ? "" : "s"} as tasks`, { topic: "issues" }).done(true, titles.join("\n"));
    },
    shipPR: (m, client, ws) => {
      if (typeof m.goalId === "string") void shipPR(m.goalId, client, ws, m.repo);
    },
  };

  return { routes, info, poll, dispose: () => timer && clearInterval(timer) };
}

/** The server module: Projects and GitHub. */
export function projectModule(ctx: ServerCtx): Routes {
  return createProjects(ctx).routes;
}
