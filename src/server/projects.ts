import { AGENT_LABELS } from "../shared/protocol.js";
import type { AgentPullRequest, PrPer, RepoStatus } from "../shared/project.js";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { WebSocket } from "ws";
import type { GithubIssue, ProjectInfo } from "../shared/project.js";
import { parseGithubRemote } from "../shared/project.js";
import type { ClientRec, Routes, ServerCtx } from "./ctx.js";
import { GitHub, SignInNeeded } from "./github.js";
import { loadPrefs, prefsPath, rememberProject, savePrefs } from "./prefs.js";

/**
 * Projects and GitHub: which folder the office works in, the ones you've
 * opened before, cloning a repo to start fresh, your GitHub sign-in, turning
 * issues into tasks, and shipping a goal as a pull request (then following
 * its checks). Every git command and GitHub call lands in the Logs.
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
  info(): Promise<ProjectInfo>;
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

  async function info(): Promise<ProjectInfo> {
    const path = resolve(ctx.cwd);
    const top = await git(path, ["rev-parse", "--show-toplevel"]);
    if (top === null) return { path, name: basename(path), isGit: false, branch: null, github: null, dirty: false };
    const [branch, remote, status] = await Promise.all([
      git(path, ["rev-parse", "--abbrev-ref", "HEAD"]),
      git(path, ["remote", "get-url", "origin"]),
      git(path, ["status", "--porcelain", "--untracked-files=no"]),
    ]);
    const gh = remote ? parseGithubRemote(remote) : null;
    owner = gh?.owner ?? null;
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
  let fetchedAt: number | null = null;
  /** A commit, briefly (null when there isn't one). */
  const commit = async (cwd: string, ref = "HEAD") => {
    const l = await git(cwd, ["log", "-1", "--format=%h%x09%s%x09%cr", ref]);
    if (!l) return null;
    const [sha, subject, when] = l.split("\t");
    return { sha, subject: subject ?? "", when: when ?? "" };
  };
  async function repoStatus(): Promise<RepoStatus> {
    const i = await info();
    const empty: RepoStatus = { at: Date.now(), isGit: false, branch: null, github: null, ahead: null, behind: null, fetchedAt, last: null, dirty: [], agents: [], pulls: null };
    if (!i.isGit) return empty;
    const cwd = resolve(ctx.cwd);
    // What GitHub has, every couple of minutes at most (never asking you to sign in from here).
    if (i.github && (!fetchedAt || Date.now() - fetchedAt > 120_000)) {
      const ok = await new Promise<boolean>((done) =>
        execFile("git", ["fetch", "--quiet", "origin"], { cwd, windowsHide: true, timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } }, (err) => done(!err)),
      );
      if (ok) fetchedAt = Date.now();
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
    for (const d of ctx.office.snapshot().desks) {
      const w = d.worker;
      if (!w?.branch || !base) continue;
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
    return { at: Date.now(), isGit: true, branch: i.branch, github: i.github, ahead, behind, fetchedAt, last: await commit(cwd), dirty, agents, pulls, ...(pullsError ? { pullsError } : {}) };
  }

  async function sendProject(ws: WebSocket): Promise<void> {
    const i = await info();
    ctx.send(ws, { t: "project", info: i, recent: loadPrefs(prefsFile).recent, account: github.account });
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

  async function clone(input: string, ws: WebSocket): Promise<void> {
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
      if (r.ok) await open(target, ws);
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

  /** Push `ref` to origin as `head` (or, when GitHub already has a different `head`, as head-xxxx); the branch it landed on, or null. */
  async function pushAs(ref: string, head: string, what: string, where: string, topic: string): Promise<string | null> {
    let pushed = await gitLogged(ctx, ctx.cwd, ["push", "origin", `${ref}:refs/heads/${head}`], `Pushing ${what} to ${where} as ${head}`, topic);
    if (!pushed.ok && /rejected|non-fast-forward|fetch first/i.test(pushed.output)) {
      head = `${head}-${Date.now().toString(36).slice(-4)}`;
      pushed = await gitLogged(ctx, ctx.cwd, ["push", "origin", `${ref}:refs/heads/${head}`], `Pushing as ${head} instead`, topic);
    }
    return pushed.ok ? head : null;
  }

  /** The agents to open pull requests for: the desks that did the goal's tasks, each with its own branch. */
  function agentsFor(goalId: string, only?: string): { deskId: string; name: string; branch: string }[] {
    const goal = ctx.progress.getGoal(goalId);
    const desks = ctx.office?.snapshot().desks ?? [];
    const worked = new Set((goal?.tasks ?? []).map((t) => t.doneBy ?? t.deskId).filter((d): d is string => !!d));
    return desks
      .filter((d) => d.worker?.branch && (only ? d.id === only : worked.has(d.id)))
      .map((d) => ({ deskId: d.id, name: d.worker!.identity?.name ?? `${AGENT_LABELS[d.worker!.agent]} · ${d.label}`, branch: d.worker!.branch! }));
  }

  /**
   * One pull request per agent: each agent's own branch pushed as it is and opened
   * against the default branch, listing the tasks it did. `only` limits it to one desk.
   * Agents with nothing GitHub doesn't already have are skipped; so are ones with a PR still open.
   */
  async function shipAgentPRs(goalId: string, client: ClientRec, only?: string): Promise<void> {
    const goal = ctx.progress.getGoal(goalId);
    const topic = `ship:${goalId}`;
    const fail = (why: string) => ctx.log.start("github", `Pull requests per agent for “${goal?.title ?? "goal"}”`, { topic }).done(false, why);
    if (!goal || (goal.shippedAt && !only)) return;
    const i = await info();
    if (!i.github) return void fail("This project has no GitHub remote (origin). Add one, or ship another way.");
    const agents = agentsFor(goalId, only);
    if (!agents.length) return void fail(only ? "That desk has no agent on its own branch." : "No agent on its own branch worked on this goal. Turn on “Own branch per worker”, or open one pull request for the goal.");
    if (!github.account && !(await github.signIn(false))) throw new SignInNeeded();
    const { owner, repo } = i.github;
    const base = await github.defaultBranch(owner, repo, topic);
    const opened: AgentPullRequest[] = [];
    for (const a of agents) {
      const open = goal.agentPrs?.find((p) => p.deskId === a.deskId && p.state === "open");
      if (open) {
        ctx.log.start("github", `${a.name} already has pull request #${open.number}`, { topic }).done(true, open.url, open.url);
        continue;
      }
      // Nothing to open a PR for when GitHub's base already has all of it (only known once origin/<base> was fetched).
      const ahead = await git(ctx.cwd, ["rev-list", "--count", `refs/remotes/origin/${base}..refs/heads/${a.branch}`]);
      if (ahead === "0") {
        ctx.log.start("github", `${a.name}: nothing new on ${a.branch}`, { topic }).done(true, `${a.branch} has no commits that ${owner}/${repo}'s ${base} doesn't — no pull request.`);
        continue;
      }
      const head = await pushAs(`refs/heads/${a.branch}`, a.branch, `${a.name}'s ${a.branch}`, `${owner}/${repo}`, topic);
      if (!head) continue;
      const mine = goal.tasks.filter((t) => (t.doneBy ?? t.deskId) === a.deskId);
      const tasks = mine.map((t) => `- [${t.status === "done" ? "x" : " "}] ${t.title}`).join("\n");
      const body = `${goal.why ? `${goal.why}\n\n` : ""}**${a.name}'s part of “${goal.title}”**\n${tasks || "_(its own branch)_"}\n\n_Opened from the office in domain by ${client.name}, one pull request per agent._`;
      try {
        const pr = await github.createPull(owner, repo, { title: `${goal.title} — ${a.name}`, head, base, body }, topic);
        const apr: AgentPullRequest = { ...pr, deskId: a.deskId, name: a.name, head };
        ctx.log.start("github", `Opened pull request #${pr.number} for ${a.name}`, { topic }).done(true, pr.url, pr.url);
        ctx.progress.setAgentPr(goal.id, apr);
        ctx.broadcast({ t: "pr", goalId: goal.id, pr, deskId: a.deskId });
        opened.push(apr);
      } catch (e) {
        if (e instanceof SignInNeeded) throw e;
        // Logged; carry on with the next agent.
      }
    }
    if (!opened.length || only) return;
    const list = opened.map((p) => `#${p.number} (${p.name})`).join(", ");
    ctx.progress.shipped(client.name, goal.id, { mode: "manual", url: opened[0].url, note: `Pull requests ${list} on GitHub, one per agent` });
    ctx.broadcast({ t: "loop", goalId: goal.id, event: "shipped", text: `🚢 Opened ${opened.length === 1 ? "a pull request" : `${opened.length} pull requests`} for “${goal.title}”, one per agent: ${list}` });
  }

  async function shipPR(goalId: string, client: ClientRec, ws: WebSocket, opts: { per?: PrPer; deskId?: string } = {}): Promise<void> {
    const goal = ctx.progress.getGoal(goalId);
    const topic = `ship:${goalId}`;
    const fail = (why: string) => ctx.log.start("github", `Pull request for “${goal?.title ?? "goal"}”`, { topic }).done(false, why);
    if ((opts.deskId ? "agent" : (opts.per ?? ctx.progress.policy.prPer)) === "agent") {
      try {
        await shipAgentPRs(goalId, client, opts.deskId);
      } catch (e) {
        if (e instanceof SignInNeeded) {
          fail("Sign in to GitHub first (Projects → Sign in with GitHub).");
          ctx.send(ws, { t: "githubAccount", account: null, error: e.message });
        }
        // Other errors are already in the log.
      }
      return;
    }
    if (!goal || goal.shippedAt) return;
    const i = await info();
    if (!i.github) return void fail("This project has no GitHub remote (origin). Add one, or ship another way.");
    if (!i.branch) return void fail("Your checkout isn't on a branch.");
    try {
      if (!github.account && !(await github.signIn(false))) throw new SignInNeeded();
      const { owner, repo } = i.github;
      const base = await github.defaultBranch(owner, repo, topic);
      const head = await pushAs("HEAD", `domain/${slugify(goal.title)}`, i.branch, `${owner}/${repo}`, topic);
      if (!head) return;
      const session = ctx.progress.snapshot().session;
      const intention = session?.goalId === goal.id && session.intention ? `\n\n> ${session.intention}` : "";
      const tasks = goal.tasks.map((t) => `- [${t.status === "done" ? "x" : " "}] ${t.title}`).join("\n");
      const body = `${goal.why ? `${goal.why}\n\n` : ""}**Tasks**\n${tasks}${intention}\n\n_Opened from the office in domain by ${client.name}._`;
      const pr = await github.createPull(owner, repo, { title: goal.title, head, base, body }, topic);
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
    const i = await info().catch(() => null);
    if (!i?.github || !github.account) return;
    for (const g of ctx.progress.snapshot().goals) {
      for (const a of g.agentPrs ?? []) {
        if (a.state !== "open") continue;
        try {
          const now = await github.pullStatus(i.github.owner, i.github.repo, a.number, `ship:${g.id}`);
          if (now.state !== a.state || now.checks !== a.checks) {
            ctx.progress.setAgentPr(g.id, { ...a, ...now });
            ctx.broadcast({ t: "pr", goalId: g.id, pr: now, deskId: a.deskId });
          }
        } catch {
          /* logged */
        }
      }
      if (!g.pr || g.pr.state !== "open") continue;
      try {
        const now = await github.pullStatus(i.github.owner, i.github.repo, g.pr.number, `ship:${g.id}`);
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
      if (typeof m.url === "string") void clone(m.url, ws);
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
      if (typeof m.goalId !== "string") return;
      const per = m.per === "agent" || m.per === "goal" ? m.per : undefined;
      const deskId = typeof m.deskId === "string" && /^desk-\d{1,3}$/.test(m.deskId) ? m.deskId : undefined;
      void shipPR(m.goalId, client, ws, { per, deskId });
    },
  };

  return { routes, info, poll, dispose: () => timer && clearInterval(timer) };
}

/** The server module: Projects and GitHub. */
export function projectModule(ctx: ServerCtx): Routes {
  return createProjects(ctx).routes;
}
