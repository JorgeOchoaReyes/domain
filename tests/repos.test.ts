import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GitHub } from "../src/server/github.ts";
import { Office } from "../src/server/office.ts";
import { OpLogger } from "../src/server/oplog.ts";
import { Progress } from "../src/server/progress.ts";
import { createProjects } from "../src/server/projects.ts";
import { OpenRepos } from "../src/server/repos.ts";
import { coerceBrief, DEFAULT_POLICY } from "../src/shared/policy.ts";
import type { ServerCtx } from "../src/server/ctx.ts";
import type { ServerMessage } from "../src/shared/protocol.ts";
import { mockGithub } from "./helpers/mockGithub.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A repo with one commit on main. */
function repo(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@t");
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** No agent CLIs on the PATH (a desk gets a plain shell), and worktrees in a temp folder. */
function plainShell(root: string): () => void {
  const path = process.env.PATH;
  const worktrees = process.env.DOMAIN_WORKTREES;
  const gitDir = execFileSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" })
    .split(/\r?\n/)[0]
    .replace(/[\\/][^\\/]+$/, "");
  process.env.PATH = [gitDir, process.platform === "win32" ? `${process.env.SystemRoot}\\System32` : "/usr/bin:/bin"].join(process.platform === "win32" ? ";" : ":");
  process.env.DOMAIN_WORKTREES = join(root, "worktrees");
  return () => {
    process.env.PATH = path;
    if (worktrees === undefined) delete process.env.DOMAIN_WORKTREES;
    else process.env.DOMAIN_WORKTREES = worktrees;
  };
}

const inside = (child: string, parent: string) => resolve(child).toLowerCase().startsWith(resolve(parent).toLowerCase());

test("open repos: the project plus others, found by name, kept between runs — and an office without any is as before", () => {
  const root = mkdtempSync(join(tmpdir(), "domain-repos-"));
  try {
    const site = repo(root, "site");
    const api = repo(root, "api");
    const file = join(site, ".domain", "repos.json");

    const fresh = new OpenRepos(site, file);
    assert.deepEqual(fresh.all(), [resolve(site)], "just the project");
    assert.equal(fresh.hireRepo, resolve(site), "new hires work in the project");
    assert.ok(!existsSync(file), "nothing written until you open one");

    assert.equal(fresh.add(api), resolve(api));
    assert.equal(fresh.add(api), resolve(api), "once");
    assert.equal(fresh.add(join(root, "nope")), null, "only folders that exist");
    assert.deepEqual(fresh.others(), [resolve(api)]);
    assert.equal(fresh.find("API"), resolve(api), "by name, any case");
    assert.equal(fresh.find("si"), resolve(site), "or the start of it");
    assert.equal(fresh.find("zzz"), null);
    assert.equal(fresh.forHire("api"), resolve(api));
    assert.equal(fresh.forHire("zzz"), resolve(site), "an unknown repo: where new hires work");
    assert.ok(fresh.setHireRepo("api"));
    assert.equal(fresh.hireRepo, resolve(api));

    const again = new OpenRepos(site, file);
    assert.deepEqual(again.all(), [resolve(site), resolve(api)], "kept");
    assert.equal(again.hireRepo, resolve(api));
    assert.ok(!again.remove("site"), "the project stays open");
    assert.ok(again.remove("api"));
    assert.equal(again.hireRepo, resolve(site), "closing it sends new hires back to the project");

    // A folder that's gone isn't open any more.
    fresh.add(api);
    rmSync(api, { recursive: true, force: true });
    assert.deepEqual(new OpenRepos(site, file).all(), [resolve(site)]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a task can name the repo it's done in", () => {
  assert.equal(coerceBrief({ repo: " C:/code/api " }, DEFAULT_POLICY).repo, "C:/code/api");
  assert.equal(coerceBrief({}, DEFAULT_POLICY).repo, undefined, "none: the worker's own");
  assert.equal(coerceBrief({ repo: 3 }, DEFAULT_POLICY).repo, undefined);
});

test("each worker works in its repo: its own worktree and branch there, merged into that repo's branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-repos-office-"));
  const restore = plainShell(root);
  const site = repo(root, "site");
  const api = repo(root, "api");
  const memory = join(site, ".domain", "office.json");
  const office = new Office({ cwd: site, simulate: false, memory });
  let second: Office | null = null;
  try {
    assert.ok(office.hire("desk-1", "claude", "Ann", "", "ask", true));
    assert.ok(office.hire("desk-2", "claude", "Ann", "", "ask", true, null, api));
    const one = office.snapshot().desks.find((d) => d.id === "desk-1")!.worker!;
    const two = office.snapshot().desks.find((d) => d.id === "desk-2")!.worker!;
    assert.equal(one.repo, undefined, "in the project: as before");
    assert.equal(two.repo, resolve(api));
    assert.equal(office.repoOf("desk-2"), resolve(api));
    assert.ok(git(api, "branch", "--list", two.branch!), "its branch is in the api repo");
    assert.ok(!git(site, "branch", "--list", two.branch!), "not in the project");
    assert.ok(git(site, "branch", "--list", one.branch!));
    const apiDir = office.workdir("desk-2");
    assert.notEqual(resolve(apiDir), resolve(api), "its own folder");
    assert.ok(!inside(apiDir, api) && !inside(apiDir, site), "outside both checkouts");
    assert.equal(resolve(git(apiDir, "rev-parse", "--path-format=absolute", "--git-common-dir")).toLowerCase(), resolve(api, ".git").toLowerCase(), "a worktree of api");

    // Its work merges into the api repo's branch.
    writeFileSync(join(apiDir, "routes.ts"), "export {};\n");
    const ws = office.workspacesOf("desk-2")!;
    assert.ok(ws.commitAll(apiDir, "domain: routes"));
    const m = ws.merge(office.workspaceOf("desk-2")!.branch, "routes");
    assert.equal(m.outcome, "merged");
    assert.ok(existsSync(join(api, "routes.ts")), "on api's main");
    assert.ok(!existsSync(join(site, "routes.ts")), "the project is untouched");
    assert.equal(office.workspacesOf("desk-1"), office.workspaces, "the project's are the office's own");

    // Moved: it restarts in the other repo, its old (empty) branch cleared.
    const oldBranch = one.branch!;
    const moved = office.moveToRepo("desk-1", api, true);
    assert.deepEqual(moved, { moved: true });
    assert.equal(office.repoOf("desk-1"), resolve(api));
    assert.ok(!git(site, "branch", "--list", oldBranch), "its empty branch in the project went");
    const now = office.snapshot().desks.find((d) => d.id === "desk-1")!.worker!;
    assert.ok(git(api, "branch", "--list", now.branch!), "a new branch in api");
    assert.deepEqual(office.moveToRepo("desk-1", api, true), { moved: false }, "already there");

    // Remembered between runs, in its repo.
    await new Promise((r) => setTimeout(r, 700));
    office.dispose();
    second = new Office({ cwd: site, simulate: false, memory });
    assert.equal(second.repoOf("desk-2"), resolve(api));
    assert.equal(second.snapshot().desks.find((d) => d.id === "desk-2")!.worker!.repo, resolve(api));
  } finally {
    office.dispose();
    second?.dispose();
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an office remembered by an older version (no repos) wakes in the project", () => {
  const root = mkdtempSync(join(tmpdir(), "domain-repos-old-"));
  try {
    const site = repo(root, "site");
    const memory = join(site, ".domain", "office.json");
    mkdirSync(join(site, ".domain"), { recursive: true });
    writeFileSync(
      memory,
      JSON.stringify({ team: [{ deskId: "desk-3", agent: "claude", hiredBy: "Ann", model: "", leash: "ask", identity: null, workspace: null, activity: "" }] }),
    );
    const real = new Office({ cwd: site, simulate: false, memory });
    try {
      const w = real.snapshot().desks.find((d) => d.id === "desk-3")!.worker!;
      assert.equal(w.status, "asleep");
      assert.equal(w.repo, undefined);
      assert.equal(real.repoOf("desk-3"), site);
      assert.equal(real.workdir("desk-3"), site);
    } finally {
      real.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeCtx(cwd: string, repos: OpenRepos, office: Office | null = null) {
  const sent: ServerMessage[] = [];
  const broadcasts: ServerMessage[] = [];
  const log = new OpLogger();
  const progress = new Progress(null);
  const ctx = {
    cwd,
    repos,
    port: 0,
    simulate: true,
    office,
    progress,
    log,
    send: (_ws: unknown, m: ServerMessage) => sent.push(m),
    broadcast: (m: ServerMessage) => broadcasts.push(m),
    clients: () => new Map(),
    wss: null,
    serveStatic: async () => {},
    relaunch: () => true,
  } as unknown as ServerCtx;
  return { ctx, sent, broadcasts, log, progress };
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

test("repos open alongside without a restart, show up in the Repo view, and ship their own pull requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-repos-ship-"));
  const gh = await mockGithub();
  try {
    const site = repo(root, "site");
    const web = repo(root, "web");
    const bare = join(root, "web.git");
    git(root, "clone", "-q", "--bare", web, bare);
    git(web, "remote", "add", "origin", "https://github.com/acme/web.git");
    git(web, "config", `url.${pathToFileURL(bare).href}.pushInsteadOf`, "https://github.com/acme/web.git");
    writeFileSync(join(web, "login.html"), "<form></form>\n");
    git(web, "add", "-A");
    git(web, "commit", "-q", "-m", "login");

    const repos = new OpenRepos(site);
    const office = new Office({ cwd: site, simulate: true });
    const f = fakeCtx(site, repos, office);
    const github = new GitHub({ log: f.log, api: gh.api, token: async () => ({ username: "ada", token: "ghp_test_secret_token_123" }), approve: () => {} });
    const p = createProjects(f.ctx, { prefsFile: join(root, "prefs.json"), pollMs: 0, github });

    // Single repo: the Repo view is as it was.
    p.routes.repoStatus!({ t: "repoStatus" } as never, client, ws);
    await until(() => f.sent.some((m) => m.t === "repoStatus"));
    const alone = (f.sent.find((m) => m.t === "repoStatus") as Extract<ServerMessage, { t: "repoStatus" }>).status;
    assert.equal(alone.others, undefined);
    assert.equal(alone.name, undefined);

    // Open web alongside: no restart, everyone hears.
    p.routes.repoAdd!({ t: "repoAdd", path: web } as never, client, ws);
    await until(() => f.broadcasts.some((m) => m.t === "project"));
    const proj = f.broadcasts.find((m) => m.t === "project") as Extract<ServerMessage, { t: "project" }>;
    assert.deepEqual(proj.repos?.map((r) => r.name), ["web"]);
    assert.equal(proj.hireRepo, resolve(site));
    assert.ok(!f.broadcasts.some((m) => m.t === "projectSwitching"), "nothing restarts");

    // A worker hired into web shows up under web in the Repo view.
    office.hire("desk-1", "claude", "Ada", "", "ask", false, null, web);
    f.sent.length = 0;
    p.routes.repoStatus!({ t: "repoStatus" } as never, client, ws);
    await until(() => f.sent.some((m) => m.t === "repoStatus"));
    const both = (f.sent.find((m) => m.t === "repoStatus") as Extract<ServerMessage, { t: "repoStatus" }>).status;
    assert.equal(both.name, "site");
    assert.deepEqual(both.others?.map((r) => [r.name, r.isGit, r.github?.repo]), [["web", true, "web"]]);

    // Closing it while someone works there: no.
    p.routes.repoClose!({ t: "repoClose", path: "web" } as never, client, ws);
    assert.deepEqual(repos.others(), [resolve(web)]);
    assert.ok(f.log.all().some((e) => e.status === "error" && /still work/.test(e.output)));

    // A goal whose tasks were done in web ships from web.
    const goal = f.progress.createGoal("Ada", "Ship the login page", "Users can sign in", ["Build the form"])!;
    const taskId = f.progress.getGoal(goal.id)!.tasks[0].id;
    f.progress.assign("Ada", goal.id, taskId, "desk-1", { ...coerceBrief({}, DEFAULT_POLICY), repo: resolve(web) });
    p.routes.shipPR!({ t: "shipPR", goalId: goal.id } as never, client, ws);
    await until(() => !!f.progress.getGoal(goal.id)?.pr);
    const pr = f.progress.getGoal(goal.id)!.pr!;
    assert.equal(pr.number, 7);
    assert.equal(pr.repo, "acme/web", "the PR says which repo");
    assert.ok(git(bare, "branch", "--list", "domain/ship-the-login-page"), "pushed from web");

    // Its checks are followed there.
    await p.poll();
    assert.equal(f.progress.getGoal(goal.id)!.pr!.checks, "success");
    assert.equal(f.progress.getGoal(goal.id)!.pr!.repo, "acme/web");
    p.dispose();
    office.dispose();
  } finally {
    gh.close();
    rmSync(root, { recursive: true, force: true });
  }
});
