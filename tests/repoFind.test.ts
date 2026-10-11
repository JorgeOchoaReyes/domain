import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { GitHub } from "../src/server/github.ts";
import { OpLogger } from "../src/server/oplog.ts";
import { Progress } from "../src/server/progress.ts";
import { createProjects } from "../src/server/projects.ts";
import { OpenRepos } from "../src/server/repos.ts";
import { isOfficeWorktree, notOpen, originOf, readRepo, scanRepos, scanRoots } from "../src/server/repoScan.ts";
import { pickRepo, repoChoices, repoFolderName, repoMatches, type FoundRepo, type GithubRepo } from "../src/shared/project.ts";
import { hireRepoChoice, coerceCharacter } from "../src/shared/team.ts";
import { looksLikePath } from "../src/cli/nou.ts";
import type { ServerCtx } from "../src/server/ctx.ts";
import type { ServerMessage } from "../src/shared/protocol.ts";
import { mockGithub, TOKEN } from "./helpers/mockGithub.ts";

/** A folder that looks like a repo to the scan: a .git with HEAD and (maybe) an origin. */
function fakeRepo(dir: string, branch = "main", origin?: string): string {
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  writeFileSync(join(dir, ".git", "config"), `[core]\n\tbare = false\n${origin ? `[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : ""}`);
  return dir;
}

test("the repo scan finds repos (nested ones too), and skips node_modules, hidden folders and the office's worktrees", () => {
  const root = mkdtempSync(join(tmpdir(), "domain-scan-"));
  try {
    fakeRepo(join(root, "web"), "dev", "git@github.com:acme/web.git");
    fakeRepo(join(root, "web", "packages", "ui")); // nested inside a repo, depth 3
    fakeRepo(join(root, "clients", "api"), "main", "https://github.com/acme/api");
    fakeRepo(join(root, "a", "b", "c", "too-deep")); // depth 4
    fakeRepo(join(root, "web", "node_modules", "left-pad"));
    fakeRepo(join(root, ".hidden", "secret"));
    fakeRepo(join(root, "web", ".domain", "worktrees", "desk-1"));
    mkdirSync(join(root, "plain", "folder"), { recursive: true });
    // A linked worktree: .git is a file pointing at the repo's git folder.
    mkdirSync(join(root, "web", ".git", "worktrees", "feature"), { recursive: true });
    writeFileSync(join(root, "web", ".git", "worktrees", "feature", "HEAD"), "ref: refs/heads/feature\n");
    writeFileSync(join(root, "web", ".git", "worktrees", "feature", "commondir"), "../..\n");
    mkdirSync(join(root, "feature"));
    writeFileSync(join(root, "feature", ".git"), `gitdir: ${join(root, "web", ".git", "worktrees", "feature")}\n`);

    const r = scanRepos({ roots: [root] });
    const names = r.repos.map((x) => x.name).sort();
    assert.deepEqual(names, ["api", "feature", "ui", "web"]);
    assert.equal(r.truncated, false);
    const web = r.repos.find((x) => x.name === "web")!;
    assert.equal(web.branch, "dev");
    assert.equal(web.github, "acme/web");
    assert.equal(r.repos.find((x) => x.name === "api")!.github, "acme/api");
    const feature = r.repos.find((x) => x.name === "feature")!;
    assert.equal(feature.branch, "feature", "a linked worktree's own branch");
    assert.equal(feature.github, "acme/web", "and its repo's origin");

    // Deeper when asked; never into node_modules or hidden folders.
    const deep = scanRepos({ roots: [root], maxDepth: 4 }).repos.map((x) => x.name);
    assert.ok(deep.includes("too-deep"));
    assert.ok(!deep.includes("left-pad") && !deep.includes("secret") && !deep.includes("desk-1"));

    // Already open ones (and office worktrees) aren't offered.
    const left = notOpen(r.repos, [join(root, "web") + "\\", join(root, "clients", "api")]).map((x) => x.name).sort();
    assert.deepEqual(left, ["feature", "ui"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the repo scan stops when its time is up (and says so)", () => {
  const root = mkdtempSync(join(tmpdir(), "domain-scan-time-"));
  try {
    for (let i = 0; i < 6; i++) fakeRepo(join(root, `r${i}`));
    let t = 0;
    const r = scanRepos({ roots: [root], budgetMs: 1500, now: () => (t += 500) });
    assert.equal(r.truncated, true);
    assert.ok(r.repos.length < 6, `found ${r.repos.length} before stopping`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("where the scan looks: the project's parent and the usual code folders, or DOMAIN_REPO_ROOTS", () => {
  const home = mkdtempSync(join(tmpdir(), "domain-scan-home-"));
  try {
    mkdirSync(join(home, "projects", "domain", ".claude", "worktrees", "agent-1"), { recursive: true });
    mkdirSync(join(home, "code"));
    mkdirSync(join(home, "Documents", "GitHub"), { recursive: true });
    const roots = scanRoots(join(home, "projects", "domain"), home, {});
    assert.deepEqual(roots, [join(home, "projects"), join(home, "code"), join(home, "Documents", "GitHub")], "only folders that exist, each once");
    // The office running in one of its worktrees looks next to the repo, not among the worktrees.
    assert.deepEqual(scanRoots(join(home, "projects", "domain", ".claude", "worktrees", "agent-1"), home, {})[0], join(home, "projects"));
    assert.deepEqual(scanRoots("x", home, { DOMAIN_REPO_ROOTS: [join(home, "code"), join(home, "nope")].join(delimiter) }), [join(home, "code")]);
    assert.ok(isOfficeWorktree(join(home, "p", ".domain", "worktrees", "desk-2")));
    assert.ok(!isOfficeWorktree(join(home, "p", "worktrees")));
    assert.equal(originOf('[remote "upstream"]\n\turl = https://github.com/a/b\n[remote "origin"]\n\turl = https://gitlab.com/a/b\n'), null, "only origin, only GitHub");
    assert.equal(readRepo(home), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const local = (name: string, github: string | null = null): FoundRepo => ({ name, path: resolve("/code", name), branch: "main", github });
const remote = (fullName: string): GithubRepo => ({ fullName, description: "", private: false, updatedAt: "", cloneUrl: `https://github.com/${fullName}.git`, defaultBranch: "main" });

test("nou repo add NAME|NUMBER: a found repo by its number, name, owner/repo or the start of one", () => {
  const list = repoChoices([local("web", "acme/web"), local("website"), local("api")], [remote("acme/web"), remote("acme/mobile"), remote("ada/api")]);
  // acme/web is on this computer already: listed once.
  assert.equal(list.length, 5);
  const name = (c: ReturnType<typeof pickRepo>) => (typeof c === "string" ? c : c.kind === "local" ? `local:${c.repo.name}` : `github:${c.repo.fullName}`);
  assert.equal(name(pickRepo(list, "1")), "local:web");
  assert.equal(name(pickRepo(list, "4")), "github:acme/mobile");
  assert.match(name(pickRepo(list, "9")), /no repo number 9/);
  assert.equal(name(pickRepo(list, "web")), "local:web", "exact beats the start of website");
  assert.equal(name(pickRepo(list, "WEBS")), "local:website");
  assert.equal(name(pickRepo(list, "acme/mobile")), "github:acme/mobile");
  assert.equal(name(pickRepo(list, "mob")), "github:acme/mobile");
  assert.equal(name(pickRepo(list, "api")), "local:api", "the one on this computer wins over GitHub's");
  assert.match(name(pickRepo(list, "a")), /more than one/);
  assert.match(name(pickRepo(list, "zzz")), /No repo called/);
  assert.ok(repoMatches(list[0], "ACME"));
  assert.ok(!repoMatches(list[2], "acme"));
  // A path is a path.
  assert.ok(looksLikePath("./web") && looksLikePath("C:\\code\\web") && looksLikePath("~/code") && looksLikePath("../x"));
  assert.ok(!looksLikePath("web-that-isnt-here-at-all"));
  assert.equal(repoFolderName("  My New App! "), "My-New-App");
  assert.equal(repoFolderName("../.."), null);
});

test("a character's repo: kept when saved, older characters still load, and a hire falls back when it isn't open", () => {
  const c = coerceCharacter({ name: "Ada", agent: "codex", repo: " C:\\code\\api " })!;
  assert.equal(c.repo, "C:\\code\\api");
  assert.equal(coerceCharacter({ name: "Old" })!.repo, undefined, "older data has none");
  assert.equal(coerceCharacter({ name: "Bad", repo: "x\u0000y" })!.repo, undefined);
  assert.equal(coerceCharacter({ name: "Num", repo: 42 })!.repo, undefined);

  const open = ["C:\\code\\web", "C:\\code\\api"];
  const find = (q: string) => open.find((p) => p.toLowerCase() === q.toLowerCase() || p.toLowerCase().endsWith(`\\${q.toLowerCase()}`)) ?? null;
  assert.deepEqual(hireRepoChoice(undefined, c, find, "C:\\code\\web"), { repo: "C:\\code\\api" }, "the character's own");
  assert.deepEqual(hireRepoChoice("web", c, find, "C:\\code\\web"), { repo: "C:\\code\\web" }, "what you picked on the hire card wins");
  const gone = hireRepoChoice(undefined, { name: "Ada", repo: "C:\\code\\old" }, find, "C:\\code\\web");
  assert.equal(gone.repo, "C:\\code\\web");
  assert.match(gone.note ?? "", /Ada's repo, old, isn't open/);
  assert.deepEqual(hireRepoChoice("nope", null, find, "C:\\code\\web"), { repo: "C:\\code\\web" });
});

function ctxFor(cwd: string) {
  const sent: ServerMessage[] = [];
  const broadcasts: ServerMessage[] = [];
  const log = new OpLogger();
  const ctx = {
    cwd,
    repos: new OpenRepos(cwd),
    port: 0,
    simulate: true,
    office: null,
    progress: new Progress(null),
    log,
    send: (_ws: unknown, m: ServerMessage) => sent.push(m),
    broadcast: (m: ServerMessage) => broadcasts.push(m),
    clients: () => new Map(),
    relaunch: () => true,
  } as unknown as ServerCtx;
  return { ctx, sent, broadcasts, log };
}
const until = async (cond: () => boolean, ms = 20000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

test("repoFind: this computer's repos that aren't open, and your GitHub repos (from a stand-in) minus the open ones", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-find-"));
  const gh = await mockGithub();
  try {
    const project = fakeRepo(join(root, "project"), "main", "https://github.com/ada/web.git");
    fakeRepo(join(root, "api"));
    fakeRepo(join(root, "tools", "cli"));
    const f = ctxFor(project);
    const github = new GitHub({ log: f.log, api: gh.api, token: async () => ({ username: "ada", token: TOKEN }), approve: () => {} });
    const p = createProjects(f.ctx, { prefsFile: join(root, "prefs.json"), pollMs: 0, github, scanRoots: [root] });
    p.routes.repoFind!({ t: "repoFind", fresh: true } as never, {} as never, {} as never);
    await until(() => f.sent.some((m) => m.t === "repoFound"));
    const found = f.sent.find((m) => m.t === "repoFound") as Extract<ServerMessage, { t: "repoFound" }>;
    assert.deepEqual(found.local.map((r) => r.name).sort(), ["api", "cli"], "not the project itself");
    assert.deepEqual(found.github?.map((r) => r.fullName), ["ada/secret"], "ada/web is the project");
    assert.ok(gh.calls.every((c) => c.method === "GET"), "only looks");

    f.sent.length = 0;
    p.routes.repoFind!({ t: "repoFind", text: "cl" } as never, {} as never, {} as never);
    await until(() => f.sent.some((m) => m.t === "repoFound"));
    const some = f.sent.find((m) => m.t === "repoFound") as Extract<ServerMessage, { t: "repoFound" }>;
    assert.deepEqual(some.local.map((r) => r.name), ["cli"]);
    assert.deepEqual(some.github, []);
    p.dispose();
  } finally {
    gh.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("repoCreate: a new, empty repo next to the project, opened alongside — on GitHub (a stand-in) only when asked", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-create-"));
  const bare = join(root, "remote", "fresh.git");
  mkdirSync(bare, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare"], { cwd: bare });
  const gh = await mockGithub((req, body, res) => {
    if (req.url === "/user/repos" && req.method === "POST") {
      const b = JSON.parse(body) as { name: string; private: boolean };
      res.writeHead(201).end(JSON.stringify({ full_name: `ada/${b.name}`, private: b.private, clone_url: bare, default_branch: "main" }));
      return true;
    }
    return false;
  });
  const env = { ...process.env };
  Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
  try {
    const project = join(root, "project");
    mkdirSync(project);
    execFileSync("git", ["init", "-q"], { cwd: project });
    const f = ctxFor(project);
    const github = new GitHub({ log: f.log, api: gh.api, token: async () => ({ username: "ada", token: TOKEN }), approve: () => {} });
    const p = createProjects(f.ctx, { prefsFile: join(root, "prefs.json"), pollMs: 0, github });

    p.routes.repoCreate!({ t: "repoCreate", name: "my notes" } as never, {} as never, {} as never);
    await until(() => f.ctx.repos!.others().length === 1);
    const notes = join(root, "my-notes");
    assert.equal(resolve(f.ctx.repos!.others()[0]), resolve(notes));
    assert.ok(existsSync(join(notes, ".git")) && existsSync(join(notes, "README.md")));
    assert.match(execFileSync("git", ["log", "--oneline"], { cwd: notes, encoding: "utf8" }), /Start my-notes/);
    assert.equal(gh.calls.filter((c) => c.method === "POST").length, 0, "nothing on GitHub unless asked");

    p.routes.repoCreate!({ t: "repoCreate", name: "fresh", github: true, private: true } as never, {} as never, {} as never);
    await until(() => f.ctx.repos!.others().length === 2);
    const post = gh.calls.find((c) => c.method === "POST" && c.url === "/user/repos");
    assert.deepEqual(JSON.parse(post!.body), { name: "fresh", private: true, auto_init: false });
    assert.match(execFileSync("git", ["log", "--oneline", "main"], { cwd: bare, encoding: "utf8" }), /Start fresh/, "pushed to its remote");

    // A folder that's there already isn't touched.
    p.routes.repoCreate!({ t: "repoCreate", name: "fresh" } as never, {} as never, {} as never);
    await until(() => f.log.all().some((e) => e.status === "error" && /already exists/.test(e.output)));
    assert.ok(!f.log.all().some((e) => e.output.includes(TOKEN)), "the token never shows up in the logs");
    p.dispose();
  } finally {
    process.env = env;
    gh.close();
    rmSync(root, { recursive: true, force: true });
  }
});
