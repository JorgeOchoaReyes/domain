import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHub, SignInNeeded, rollupChecks } from "../src/server/github.ts";
import { OpLogger } from "../src/server/oplog.ts";
import { parseGithubRemote } from "../src/shared/project.ts";
import { TOKEN, mockGithub } from "./helpers/mockGithub.ts";

test("signing in, listing repos and issues through the API, token never logged", async () => {
  const gh = await mockGithub();
  const log = new OpLogger();
  const approved: string[] = [];
  try {
    const client = new GitHub({ log, api: gh.api, token: async () => ({ username: "ada", token: TOKEN }), approve: (c) => approved.push(c.username) });
    const account = await client.signIn(false);
    assert.deepEqual(account, { login: "ada", avatarUrl: "https://avatars.example/ada.png" });
    assert.deepEqual(approved, ["ada"], "git is told the credential worked, once");

    const repos = await client.repos();
    assert.equal(repos.length, 2);
    assert.deepEqual(repos[1], { fullName: "ada/secret", description: "", private: true, updatedAt: "2026-09-01T00:00:00Z", cloneUrl: "https://github.com/ada/secret.git", defaultBranch: "trunk" });

    const issues = await client.issues("acme", "web");
    assert.deepEqual(issues.map((i) => i.number), [1, 3], "pull requests aren't issues");
    assert.deepEqual(issues[0].labels, ["perf"]);

    const pr = await client.createPull("acme", "web", { title: "Ship it", head: "domain/ship-it", base: "main", body: "b" });
    assert.equal(pr.number, 7);
    const status = await client.pullStatus("acme", "web", 7);
    assert.deepEqual([status.state, status.checks], ["open", "success"]);

    const all = JSON.stringify(log.all());
    assert.ok(!all.includes(TOKEN), "the token never appears in the logs");
    assert.ok(log.all().some((e) => e.tool === "github" && e.command?.startsWith("GET ")), "API calls are logged with their method and URL");
  } finally {
    gh.close();
  }
});

test("no sign-in, or a rejected one, asks you to sign in again", async () => {
  const gh = await mockGithub();
  try {
    const none = new GitHub({ log: new OpLogger(), api: gh.api, token: async () => null });
    assert.equal(await none.signIn(false), null);
    await assert.rejects(() => none.repos(), SignInNeeded);

    const bad = new GitHub({ log: new OpLogger(), api: gh.api, token: async () => ({ username: "x", token: "wrong" }), approve: () => assert.fail("never approve a bad credential") });
    assert.equal(await bad.signIn(false), null);
  } finally {
    gh.close();
  }
});

test("checks roll up to one word", () => {
  assert.equal(rollupChecks([]), "none");
  assert.equal(rollupChecks([{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "skipped" }]), "success");
  assert.equal(rollupChecks([{ status: "in_progress", conclusion: null }]), "pending");
  assert.equal(rollupChecks([{ status: "completed", conclusion: "failure" }, { status: "in_progress" }]), "failure");
  assert.equal(rollupChecks([], [{ state: "pending" }]), "pending");
  assert.equal(rollupChecks([{ status: "completed", conclusion: "success" }], [{ state: "error" }]), "failure");
});

test("GitHub remotes are recognised in every usual form", () => {
  assert.deepEqual(parseGithubRemote("https://github.com/acme/web.git"), { owner: "acme", repo: "web" });
  assert.deepEqual(parseGithubRemote("https://github.com/acme/web"), { owner: "acme", repo: "web" });
  assert.deepEqual(parseGithubRemote("git@github.com:acme/my.site.git"), { owner: "acme", repo: "my.site" });
  assert.equal(parseGithubRemote("https://gitlab.com/acme/web.git"), null);
  assert.equal(parseGithubRemote("C:/code/web"), null);
});

test("with several accounts in the credential manager, it asks for yours quietly before showing a picker", async () => {
  const gh = await mockGithub();
  try {
    const asked: string[] = [];
    // Like Git Credential Manager holding several accounts: nothing without a name (no window allowed).
    const token = async ({ interactive, username }: { interactive: boolean; username?: string }) => {
      asked.push(`${username ?? "-"}:${interactive}`);
      return username === "ada" ? { username: "ada", token: TOKEN } : null;
    };
    const client = new GitHub({ log: new OpLogger(), api: gh.api, token, approve: () => {}, username: () => "ada" });
    const account = await client.signIn(true);
    assert.equal(account?.login, "ada");
    assert.deepEqual(asked, ["ada:false"], "the named account was found without a picker");

    const nobody = new GitHub({ log: new OpLogger(), api: gh.api, token, approve: () => {}, username: () => "grace" });
    assert.equal(await nobody.signIn(true), null);
    assert.deepEqual(asked.slice(1), ["grace:false", "-:true"], "an unknown name falls back to the credential manager's own sign-in");
  } finally {
    gh.close();
  }
});
