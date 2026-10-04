import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { GitHub } from "../src/server/github.ts";
import { OpLogger } from "../src/server/oplog.ts";
import { Progress } from "../src/server/progress.ts";
import { cloneTarget, createProjects, normalizeCloneUrl, slugify } from "../src/server/projects.ts";
import { loadPrefs, MAX_RECENT, rememberProject } from "../src/server/prefs.ts";
import type { ServerCtx } from "../src/server/ctx.ts";
import type { ServerMessage } from "../src/shared/protocol.ts";
import { mockGithub } from "./helpers/mockGithub.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A repo with one commit on main, and a bare "remote" of it. */
function repoWithRemote(root: string): { repo: string; bare: string } {
  const repo = join(root, "web");
  const bare = join(root, "web.git");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "index.html"), "<h1>hi</h1>\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(root, "clone", "-q", "--bare", repo, bare);
  return { repo, bare };
}

function fakeCtx(cwd: string) {
  const sent: ServerMessage[] = [];
  const broadcasts: ServerMessage[] = [];
  const relaunched: string[] = [];
  const log = new OpLogger();
  const progress = new Progress(null);
  const ctx = {
    cwd,
    port: 0,
    simulate: true,
    office: null,
    progress,
    log,
    send: (_ws: unknown, m: ServerMessage) => sent.push(m),
    broadcast: (m: ServerMessage) => broadcasts.push(m),
    clients: () => new Map(),
    wss: null,
    serveStatic: async () => {},
    relaunch: (p: string) => {
      relaunched.push(p);
      return true;
    },
  } as unknown as ServerCtx;
  return { ctx, sent, broadcasts, relaunched, log, progress };
}

const client = { id: "c", name: "Ada", alive: true, joined: true, role: "host" as const };
const ws = {} as never;
const until = async (cond: () => boolean, ms = 15000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

test("what you type is turned into a clone URL (or refused)", () => {
  assert.equal(normalizeCloneUrl("acme/web"), "https://github.com/acme/web.git");
  assert.equal(normalizeCloneUrl("git@github.com:acme/web.git"), "https://github.com/acme/web.git");
  assert.equal(normalizeCloneUrl("https://github.com/acme/web"), "https://github.com/acme/web");
  assert.equal(normalizeCloneUrl("file:///tmp/x.git"), "file:///tmp/x.git");
  assert.equal(normalizeCloneUrl("rm -rf /"), null);
  assert.equal(normalizeCloneUrl("https://x.com/a b"), null, "no spaces sneak onto a command line");
  assert.equal(slugify("Ship the login page!"), "ship-the-login-page");
});

test("recent projects: newest first, once each, at most a dozen", () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-prefs-"));
  const file = join(dir, "prefs.json");
  try {
    rememberProject(join(dir, "a"), null, { file, now: 1 });
    rememberProject(join(dir, "b"), "acme/b", { file, now: 2 });
    rememberProject(join(dir, "a"), null, { file, now: 3, current: true });
    const p = loadPrefs(file);
    assert.deepEqual(p.recent.map((r) => r.name), ["a", "b"]);
    assert.equal(p.recent[1].github, "acme/b");
    assert.equal(p.project, join(dir, "a"));
    for (let i = 0; i < 20; i++) rememberProject(join(dir, `p${i}`), null, { file, now: 10 + i });
    assert.equal(loadPrefs(file).recent.length, MAX_RECENT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project info: branch, GitHub remote and uncommitted changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-proj-"));
  try {
    const { repo } = repoWithRemote(root);
    git(repo, "remote", "add", "origin", "https://github.com/acme/web.git");
    const f = fakeCtx(repo);
    const p = createProjects(f.ctx, { prefsFile: join(root, "prefs.json"), pollMs: 0, github: new GitHub({ log: f.log, token: async () => null }) });
    let i = await p.info();
    assert.deepEqual([i.name, i.isGit, i.branch, i.dirty], ["web", true, "main", false]);
    assert.deepEqual(i.github, { owner: "acme", repo: "web", url: "https://github.com/acme/web" });
    writeFileSync(join(repo, "index.html"), "<h1>changed</h1>\n");
    i = await p.info();
    assert.equal(i.dirty, true);

    const plain = fakeCtx(root);
    const q = createProjects(plain.ctx, { prefsFile: join(root, "prefs2.json"), pollMs: 0, github: new GitHub({ log: plain.log, token: async () => null }) });
    const n = await q.info();
    assert.equal(n.isGit, false, "a plain folder is fine, just not git");
    p.dispose();
    q.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cloning streams into the log and switches the office to the clone", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-clone-"));
  try {
    const { bare } = repoWithRemote(root);
    const projectsDir = join(root, "projects");
    const f = fakeCtx(root);
    const p = createProjects(f.ctx, { prefsFile: join(root, "prefs.json"), projectsDir, pollMs: 0, github: new GitHub({ log: f.log, token: async () => null }) });
    p.routes.projectClone!({ t: "projectClone", url: pathToFileURL(bare).href } as never, client, ws);
    await until(() => f.relaunched.length > 0);
    assert.equal(f.relaunched[0], join(projectsDir, "web"));
    assert.ok(existsSync(join(projectsDir, "web", "index.html")), "the files are there");
    assert.ok(f.broadcasts.some((m) => m.t === "projectSwitching"), "everyone hears the office is switching");
    const entry = f.log.all().find((e) => e.topic === "clone");
    assert.ok(entry && entry.status === "ok" && entry.command?.startsWith("git clone --progress"));
    assert.equal(loadPrefs(join(root, "prefs.json")).project, join(projectsDir, "web"), "it's the project to open next time");
    // A second clone of the same repo gets its own folder.
    assert.equal(cloneTarget(projectsDir, "https://github.com/acme/web.git"), join(projectsDir, "web-2"));
    p.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("opening a folder that doesn't exist says so and stays put", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-open-"));
  try {
    const f = fakeCtx(root);
    const p = createProjects(f.ctx, { prefsFile: join(root, "prefs.json"), pollMs: 0, github: new GitHub({ log: f.log, token: async () => null }) });
    p.routes.projectOpen!({ t: "projectOpen", path: join(root, "nope") } as never, client, ws);
    await until(() => f.log.all().some((e) => e.status === "error"));
    assert.equal(f.relaunched.length, 0);
    mkdirSync(join(root, "there"));
    p.routes.projectOpen!({ t: "projectOpen", path: join(root, "there") } as never, client, ws);
    await until(() => f.relaunched.length > 0);
    assert.equal(f.relaunched[0], join(root, "there"));
    p.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shipping a goal pushes a branch, opens a pull request and follows its checks", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-ship-"));
  const gh = await mockGithub();
  try {
    const { repo, bare } = repoWithRemote(root);
    // It looks like GitHub, but pushes land in the local bare repo.
    git(repo, "remote", "add", "origin", "https://github.com/acme/web.git");
    git(repo, "config", `url.${pathToFileURL(bare).href}.pushInsteadOf`, "https://github.com/acme/web.git");
    writeFileSync(join(repo, "login.html"), "<form></form>\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "login");

    const f = fakeCtx(repo);
    const github = new GitHub({ log: f.log, api: gh.api, token: async () => ({ username: "ada", token: "ghp_test_secret_token_123" }), approve: () => {} });
    const p = createProjects(f.ctx, { prefsFile: join(root, "prefs.json"), pollMs: 0, github });
    const goal = f.progress.createGoal("Ada", "Ship the login page", "Users can sign in", ["Build the form"])!;

    p.routes.shipPR!({ t: "shipPR", goalId: goal.id } as never, client, ws);
    await until(() => !!f.progress.getGoal(goal.id)?.pr);
    const g = f.progress.getGoal(goal.id)!;
    assert.equal(g.pr!.number, 7);
    assert.ok(g.shippedAt, "the goal shipped");
    assert.equal(g.ship?.url, "https://github.com/acme/web/pull/7");
    assert.ok(git(bare, "branch", "--list", "domain/ship-the-login-page"), "the branch reached the remote");
    const post = gh.calls.find((c) => c.method === "POST");
    assert.ok(post);
    const body = JSON.parse(post!.body) as { head: string; base: string; title: string; body: string };
    assert.deepEqual([body.head, body.base, body.title], ["domain/ship-the-login-page", "main", "Ship the login page"]);
    assert.match(body.body, /Build the form/);
    assert.ok(f.broadcasts.some((m) => m.t === "pr"));
    assert.ok(f.log.all().some((e) => e.topic === `ship:${goal.id}` && e.tool === "git" && e.status === "ok"), "the push is in the log");

    // Its checks come in.
    await p.poll();
    assert.equal(f.progress.getGoal(goal.id)!.pr!.checks, "success");
    p.dispose();
  } finally {
    gh.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("open issues become tasks", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-issues-"));
  const gh = await mockGithub();
  try {
    const { repo } = repoWithRemote(root);
    git(repo, "remote", "add", "origin", "https://github.com/acme/web.git");
    const f = fakeCtx(repo);
    const github = new GitHub({ log: f.log, api: gh.api, token: async () => ({ username: "ada", token: "ghp_test_secret_token_123" }), approve: () => {} });
    const p = createProjects(f.ctx, { prefsFile: join(root, "prefs.json"), pollMs: 0, github });
    p.routes.githubIssues!({ t: "githubIssues" } as never, client, ws);
    await until(() => f.sent.some((m) => m.t === "githubIssues"));
    const msg = f.sent.find((m) => m.t === "githubIssues") as Extract<ServerMessage, { t: "githubIssues" }>;
    assert.deepEqual(msg.issues.map((i) => i.number), [1, 3]);

    p.routes.issuesImport!({ t: "issuesImport", goalId: null, numbers: [1, 3] } as never, client, ws);
    const goal = f.progress.snapshot().goals.find((g) => g.title === "GitHub issues");
    assert.deepEqual(goal?.tasks.map((t) => t.title), ["#1 Login is slow", "#3 Typo on home"]);
    p.dispose();
  } finally {
    gh.close();
    rmSync(root, { recursive: true, force: true });
  }
});
