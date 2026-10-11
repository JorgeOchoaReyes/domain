import { test } from "node:test";
import assert from "node:assert/strict";
import { GithubJanitor, describePlan, githubTarget, runTag } from "../scripts/e2e/githubTarget.ts";
import { TOKEN, mockGithub } from "./helpers/mockGithub.ts";

test("e2e: the stand-in unless a real test repo is named, with its token", () => {
  assert.deepEqual(githubTarget({}), { mode: "stand-in" });
  assert.deepEqual(githubTarget({ E2E_GITHUB_REPO: "ada/sandbox", E2E_GITHUB_TOKEN: " t0k " }), { mode: "real", owner: "ada", repo: "sandbox", token: "t0k", api: "https://api.github.com", keep: false });
  assert.equal((githubTarget({ E2E_GITHUB_REPO: "https://github.com/ada/sandbox.git", E2E_GITHUB_TOKEN: "t", E2E_GITHUB_KEEP: "1" }) as { repo: string; keep: boolean }).keep, true);
  assert.throws(() => githubTarget({ E2E_GITHUB_REPO: "ada/sandbox" }), /E2E_GITHUB_TOKEN/);
  assert.throws(() => githubTarget({ E2E_GITHUB_REPO: "not a repo", E2E_GITHUB_TOKEN: "t" }), /owner\/repo/);
  const tag = runTag(0);
  assert.equal(tag, "e2e-0");
  const plan = describePlan(githubTarget({ E2E_GITHUB_REPO: "ada/sandbox", E2E_GITHUB_TOKEN: "secret-token" }), tag).join("\n");
  assert.match(plan, /ada\/sandbox/);
  assert.match(plan, /closes every pull request/);
  assert.ok(!plan.includes("secret-token"), "the plan never prints the token");
});

test("e2e: the janitor files issues, finds the run's pull requests and cleans up everything it made", async () => {
  const done: string[] = [];
  const gh = await mockGithub((req, _body, res) => {
    const url = req.url!.split("?")[0];
    if (url === "/repos/acme/web/issues" && req.method === "POST") return !!res.writeHead(201).end(JSON.stringify({ number: 41 }));
    if (url === "/repos/acme/web/pulls" && req.method === "GET")
      return !!res.end(JSON.stringify([{ number: 7, head: { ref: "domain/toy-math-e2e-1" } }, { number: 8, head: { ref: "someone-elses" } }, { number: 9, head: { ref: "domain/claude-desk-1-ab" } }]));
    if (req.method === "PATCH" || req.method === "DELETE") {
      done.push(`${req.method} ${url}`);
      return !!res.writeHead(req.method === "DELETE" ? 204 : 200).end(req.method === "DELETE" ? "" : "{}");
    }
    return false;
  });
  try {
    const j = new GithubJanitor(gh.api, "acme", "web", TOKEN);
    assert.equal(await j.fileIssue("[e2e-1] Login is slow", "b"), 41);
    const fresh = ["domain/toy-math-e2e-1", "domain/claude-desk-1-ab"];
    assert.deepEqual((await j.pullsFrom(fresh)).map((p) => p.number), [7, 9], "only pull requests from this run's branches");
    for (const b of fresh) j.track("branches", b);
    for (const p of await j.pullsFrom(fresh)) j.track("pulls", p.number);
    j.track("pulls", 7);
    const r = await j.cleanup();
    assert.deepEqual(r, { ok: true, failed: [] });
    assert.deepEqual(done, [
      "PATCH /repos/acme/web/pulls/7",
      "PATCH /repos/acme/web/pulls/9",
      "DELETE /repos/acme/web/git/refs/heads/domain/toy-math-e2e-1",
      "DELETE /repos/acme/web/git/refs/heads/domain/claude-desk-1-ab",
      "PATCH /repos/acme/web/issues/41",
    ]);

    // What it couldn't clean up, it says.
    const bad = new GithubJanitor(gh.api, "acme", "web", "wrong-token");
    bad.track("pulls", 7);
    const r2 = await bad.cleanup();
    assert.equal(r2.ok, false);
    assert.match(r2.failed[0], /pull request #7.*401/);
  } finally {
    gh.close();
  }
});
