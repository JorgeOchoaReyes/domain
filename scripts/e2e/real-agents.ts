// The real thing, end to end: real Claude Code agents (Sonnet) on a throwaway repo — hired from the
// ready-made roles, a stand-up with who-does-what, real edits in their own worktrees (outside the
// project), teammate audits, your check command, real decks, a send-back, a merge conflict resolved,
// merges into main, and shipping: a real push and a pull request through the GitHub API — one for the
// goal, then one per agent from each agent's own branch. By default GitHub is a local stand-in (no
// account needed). Everything is isolated: its own git config, prefs and folders in a temp dir.
//
//   npm run e2e:real                       (takes a few minutes; uses your Claude Code sign-in)
//   npm run e2e:real -- --dry-run          what it would do, and against which GitHub — then stops
//
// Against a real GitHub test repository instead (opt-in; see scripts/e2e/githubTarget.ts):
//
//   E2E_GITHUB_REPO=you/domain-e2e-sandbox E2E_GITHUB_TOKEN=github_pat_… npm run e2e:real
//
// It clones that repo, files two issues, pushes branches and opens pull requests there — and, pass or
// fail, closes the pull requests, deletes the branches and closes the issues it made (E2E_GITHUB_KEEP=1
// leaves them). The repo's default branch itself is never pushed.
//
// It prints PASS/FAIL for each step and exits 1 if anything failed.
import { spawn, execFileSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockGithub } from "../../tests/helpers/mockGithub.ts";
import { connect, statusText, type Conn } from "../../src/cli/nou.ts";
import { ROLES, roleCharacter } from "../../src/shared/roles.ts";
import { DEFAULT_POLICY } from "../../src/shared/policy.ts";
import { deckOf, parseSlide, CHANGED_HEADING } from "../../src/shared/slides.ts";
import type { ServerMessage } from "../../src/shared/protocol.ts";
import { GithubJanitor, describePlan, githubTarget, runTag, type GithubTarget } from "./githubTarget.ts";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run") || process.env.E2E_DRY_RUN === "1";
let target: GithubTarget;
try {
  target = githubTarget();
} catch (e) {
  console.error(`❌ ${(e as Error).message}`);
  process.exit(2);
}
const REAL = target.mode === "real" ? target : null;
const TAG = runTag();
const STAND_IN_TOKEN = "ghp_test_secret_token_123";
if (DRY) {
  console.log(`e2e:real — dry run (${REAL ? `real GitHub: ${REAL.owner}/${REAL.repo}` : "the GitHub stand-in"}), run tag ${TAG}\n`);
  for (const l of describePlan(target, TAG)) console.log(`  • ${l}`);
  console.log("\n  • The office: three ready-made Claude Code agents (Sonnet), a stand-up, real edits, audits, checks, merges.");
  console.log("\nNothing was started, cloned, pushed or opened. Run it without --dry-run to do it.");
  process.exit(0);
}
const D = args.find((a) => !a.startsWith("--")) ?? mkdtempSync(join(tmpdir(), "domain-e2e-"));
const TOY = join(D, "toy");
// A free port of its own (never someone else's office).
const PORT = Number(process.env.E2E_PORT) || (await new Promise<number>((r) => {
  const srv = createNetServer().listen(0, "127.0.0.1", () => {
    const p = (srv.address() as { port: number }).port;
    srv.close(() => r(p));
  });
}));
const results: string[] = [];
const t0 = Date.now();
const at = () => `${Math.round((Date.now() - t0) / 1000)}s`.padStart(5);
const log = (s: string) => console.log(`${at()} ${s}`);
const check = (name: string, ok: boolean, detail = "") => {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(D, "gitconfig") };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

// --- A throwaway world: a toy repo with a real bug, a bare repo standing in for GitHub ---------
// (Real mode: a clone of your test repo, with the toy library committed on top — locally only.)
const OWNER = REAL?.owner ?? "acme";
const REPO = REAL?.repo ?? "web";
const TOKEN = REAL?.token ?? STAND_IN_TOKEN;
if (!existsSync(TOY)) {
  mkdirSync(TOY, { recursive: true });
  const fwd = D.split("\\").join("/");
  // Its own git: an identity, a token for github.com, and (stand-in) pushes to github.com/acme/web going to the bare repo.
  // A real token stays in the environment: the helper reads $E2E_GITHUB_TOKEN, so it's never written here.
  writeFileSync(
    join(D, "gitconfig"),
    [
      "[user]",
      "\tname = Deep Test",
      "\temail = deep@test.local",
      "[init]",
      "\tdefaultBranch = main",
      '[credential "https://github.com"]',
      REAL
        ? '\thelper = "!f() { test \\"$1\\" = get && echo username=x-access-token && echo password=$E2E_GITHUB_TOKEN; }; f"'
        : `\thelper = "!f() { test \\"$1\\" = get && echo username=ada && echo password=${STAND_IN_TOKEN}; }; f"`,
      ...(REAL ? [] : [`[url "file:///${fwd}/origin.git"]`, "\tpushInsteadOf = https://github.com/acme/web.git"]),
      "",
    ].join("\n"),
  );
  if (REAL) git(D, "clone", "-q", `https://github.com/${OWNER}/${REPO}.git`, "toy");
  else {
    git(D, "init", "-q", "--bare", "origin.git");
    git(TOY, "init", "-q", "-b", "main");
  }
  mkdirSync(join(TOY, "src"), { recursive: true });
  mkdirSync(join(TOY, "tests"), { recursive: true });
  writeFileSync(join(TOY, "package.json"), JSON.stringify({ name: "toy-math", version: "1.0.0", type: "module", scripts: { test: "node --test tests/*.test.js" } }, null, 2));
  writeFileSync(
    join(TOY, "src", "math.js"),
    ["export function add(a, b) {", "  return a + b;", "}", "", "export function average(xs) {", "  return xs.reduce((s, x) => s + x, 0) / xs.length;", "}", ""].join("\n"),
  );
  writeFileSync(
    join(TOY, "tests", "math.test.js"),
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { add, average } from "../src/math.js";',
      "",
      'test("add", () => assert.equal(add(2, 3), 5));',
      'test("average", () => assert.equal(average([1, 2, 3]), 2));',
      "",
    ].join("\n"),
  );
  writeFileSync(join(TOY, "domain.config.json"), JSON.stringify({ check: "npm test" }));
  writeFileSync(join(TOY, ".gitignore"), "node_modules\n.domain\n");
  git(TOY, "add", "-A");
  git(TOY, "commit", "-qm", "Toy math library");
  if (!REAL) {
    git(TOY, "remote", "add", "origin", "https://github.com/acme/web.git");
    git(TOY, "push", "-q", "-u", "origin", "main");
  }
}
// The branch the office works on (and merges into): main, or your test repo's default branch.
const BASE = git(TOY, "rev-parse", "--abbrev-ref", "HEAD");
log(`world in ${D}${REAL ? ` — real GitHub: ${OWNER}/${REPO} (on ${BASE}), run ${TAG}` : ""}`);

/** The branches GitHub has (the bare repo, for the stand-in). */
const remoteHeads = (): Map<string, string> =>
  new Map(
    (REAL ? git(TOY, "ls-remote", "--heads", "origin") : git(D, "ls-remote", "--heads", `file:///${D.replace(/\\/g, "/")}/origin.git`))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const [sha, ref] = l.split("\t");
        return [ref.replace(/^refs\/heads\//, ""), sha] as [string, string];
      }),
  );
const headsBefore = remoteHeads();
const janitor = REAL ? new GithubJanitor(REAL.api, OWNER, REPO, REAL.token, log) : null;
const prsSeen = new Set<number>();

// GitHub has one open pull request of its own, with failing checks (for the Repo view).
const gh = REAL ? null : await mockGithub((req, _body, res) => {
  const url = req.url!.split("?")[0];
  if (url === "/repos/acme/web/pulls" && req.method === "GET") return !!res.end(JSON.stringify([{ number: 12, title: "Speed up login", html_url: "https://github.com/acme/web/pull/12", head: { ref: "fast-login", sha: "f00d" } }]));
  if (url === "/repos/acme/web/commits/f00d/check-runs") return !!res.end(JSON.stringify({ check_runs: [{ status: "completed", conclusion: "failure" }] }));
  if (url === "/repos/acme/web/commits/f00d/status") return !!res.end(JSON.stringify({ statuses: [] }));
  return false;
});
log(REAL ? `real GitHub at ${REAL.api}` : `fake GitHub at ${gh!.api}`);
const server = spawn("npx", ["tsx", "src/server/index.ts"], {
  cwd: process.cwd(),
  shell: true,
  env: { ...env, PORT: String(PORT), DOMAIN_CWD: TOY, DOMAIN_GITHUB_API: gh?.api ?? REAL!.api, DOMAIN_PREFS: join(D, "prefs.json"), DOMAIN_ADDRESS: join(D, "office.json"), DOMAIN_PROJECTS_DIR: join(D, "projects"), DOMAIN_WORKTREES: join(D, "worktrees") },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOut = "";
server.stdout.on("data", (d) => (serverOut += d));
server.stderr.on("data", (d) => (serverOut += d));
for (let i = 0; i < 60 && !/listening/.test(serverOut); i++) await sleep(500);
if (!/listening/.test(serverOut)) throw new Error(`the office didn't start:\n${serverOut}`);
log(`office up on :${PORT}`);

let conn: Conn | null = null;
try {
  conn = await connect("Deep tester", `ws://127.0.0.1:${PORT}`);
  const c = conn;
  // Make sure it's our office, on our toy repo.
  c.send({ t: "projectInfo" });
  const ours = await c.next((m): m is Extract<ServerMessage, { t: "project" }> => m.t === "project", 10000);
  if (ours?.info.path.split("\\").join("/").toLowerCase() !== TOY.split("\\").join("/").toLowerCase()) throw new Error(`connected to another office (${ours?.info.path})`);
  const next = <T extends ServerMessage["t"]>(t: T, ms = 20000, test: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true) =>
    c.next((m): m is Extract<ServerMessage, { t: T }> => m.t === t && test(m as Extract<ServerMessage, { t: T }>), ms);
  // Follow everything that happens.
  c.on((m) => {
    if (m.t === "pr") prsSeen.add(m.pr.number);
    if (m.t === "loop" && m.text) log(`   · ${m.text}`);
    if (m.t === "report" && m.presentation.report) log(`   🎤 ${m.presentation.deskId}: ${m.presentation.report.status} — ${m.presentation.report.title}`);
  });

  // --- The team's terms: Haiku, free to edit and run, their own branches. ---
  c.send({ t: "policySet", policy: { ...DEFAULT_POLICY, ...c.progress.policy, leash: "safe", isolate: true, merge: "auto", gate: "fix", defaultModel: { ...c.progress.policy.defaultModel, claude: "sonnet" } } });
  c.send({ t: "trustWorkers" });

  // --- GitHub: sign in, repos, this project's remote, issues. ---
  c.send({ t: "githubSignIn" });
  const acct = await next("githubAccount");
  check("GitHub: sign in", REAL ? !!acct?.account?.login : acct?.account?.login === "ada", JSON.stringify(acct?.account ?? acct));
  c.send({ t: "githubRepos" });
  const repos = await next("githubRepos");
  check("GitHub: your repos", REAL ? (repos?.repos.length ?? 0) >= 1 : (repos?.repos.length ?? 0) === 2, repos?.repos.map((r) => r.fullName ?? (r as { name?: string }).name).join(", "));
  c.send({ t: "projectInfo" });
  const proj = await c.next((m): m is Extract<ServerMessage, { t: "project" }> => m.t === "project", 10000);
  const info = (proj as unknown as { info?: { github?: { owner: string; repo: string }; branch?: string } } | null)?.info;
  check("GitHub: the project's remote is recognised", info?.github?.owner === OWNER && info.github.repo === REPO && info.branch === BASE, JSON.stringify({ github: info?.github, branch: info?.branch }));
  // Real: file two issues of our own (closed again at the end); the stand-in has #1 and #3.
  const issueTitles = REAL ? [`[${TAG}] Login is slow`, `[${TAG}] Typo on home`] : ["Login is slow", "Typo on home"];
  const issueNums = janitor ? [await janitor.fileIssue(issueTitles[0], "Filed by domain's end-to-end run; it closes this itself."), await janitor.fileIssue(issueTitles[1], "Filed by domain's end-to-end run; it closes this itself.")] : [1, 3];
  c.send({ t: "githubIssues" });
  const issues = await next("githubIssues");
  check("GitHub: open issues (pull requests left out)", REAL ? issueNums.every((n) => issues?.issues.some((i) => i.number === n)) : issues?.issues.length === 2, issues?.issues.map((i) => `#${i.number}`).join(" "));
  c.send({ t: "issuesImport", goalId: null, numbers: issueNums });
  const imported = await next("progress", 8000, (m) => m.progress.goals.some((g) => g.title === "GitHub issues"));
  const issueGoal = imported?.progress.goals.find((g) => g.title === "GitHub issues");
  const wantTasks = issueNums.map((n, k) => `#${n} ${issueTitles[k]}`).join(" | ");
  check("GitHub: issues become tasks", issueGoal?.tasks.map((t) => t.title).join(" | ") === wantTasks, issueGoal?.tasks.map((t) => t.title).join(" | "));
  if (issueGoal) c.send({ t: "goalDelete", goalId: issueGoal.id });

  // --- Hire three ready-made agents (real Claude Code, on Haiku). ---
  const hires: [string, string][] = [
    ["builder", "desk-1"],
    ["tester", "desk-2"],
    ["docs", "desk-3"],
  ];
  for (const [roleId, deskId] of hires) {
    const role = ROLES.find((r) => r.id === roleId)!;
    const ch = { ...roleCharacter(role, c.progress.team.map((x) => x.name)), model: "sonnet", leash: "safe" as const };
    c.send({ t: "characterSave", character: ch });
    c.send({ t: "hire", deskId, agent: "claude", characterId: ch.id });
  }
  const up = await next("office", 30000, (m) => hires.every(([, d]) => !!m.office.desks.find((x) => x.id === d)?.worker));
  check("hire 3 ready-made agents", !!up, up?.office.desks.filter((d) => d.worker).map((d) => `${d.worker!.identity?.name}@${d.id}:${d.worker!.branch}`).join(", "));
  // Ready: each one up and idle (a trust prompt is answered by trustWorkers).
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    const ds = c.office.desks.filter((d) => hires.some(([, id]) => id === d.id));
    ready = ds.every((d) => d.worker?.status === "idle");
    if (i % 10 === 0) log(`   booting: ${ds.map((d) => `${d.id}=${d.worker?.status}`).join(" ")}`);
    if (!ready) await sleep(2000);
  }
  check("agents boot to ready", ready, ready ? "" : c.office.desks.filter((d) => d.worker).map((d) => `${d.id}: ${d.worker!.status} — ${d.worker!.activity}`).join(" | "));
  if (!ready) throw new Error("agents didn't come up");
  const branches = c.office.desks.filter((d) => d.worker).map((d) => d.worker!.branch);
  check("each agent on its own branch (worktree)", branches.every((b) => !!b && b.startsWith("domain/")) && new Set(branches).size === 3, branches.join(", "));
  const norm = (p: string) => p.split("\\").join("/").toLowerCase();
  const trees = git(TOY, "worktree", "list").split(/\r?\n/).slice(1).map((l) => l.split(/\s+/)[0]);
  check("their copies live outside your project", trees.length === 3 && trees.every((t) => !norm(t).startsWith(norm(TOY))), trees.join(" | "));

  // --- The stand-up: three tasks, each to its pick. ---
  const tasks = [
    ["Add a subtract(a, b) function to src/math.js, exported, with a test for it in tests/math.test.js", "desk-1"],
    ["Make average([]) return 0 instead of NaN in src/math.js, and add a test for it in tests/math.test.js", "desk-2"],
    ["Write a README.md with a one-paragraph intro and a usage example for add and average", "desk-3"],
  ] as const;
  c.send({
    t: "standup",
    goalId: null,
    newGoal: { title: REAL ? `Toy math ${TAG}` : "Toy math: subtract, average fix, README", why: "Deep end-to-end test", tasks: tasks.map((t) => t[0]), kind: "build" },
    tone: "ship",
    intention: "All three merged and the PR open",
    minutes: 60,
    summary: "Three small changes, one each.",
    eod: ["PR open"],
    dispatch: true,
    assign: tasks.map(([task, deskId]) => ({ task, deskId })),
  });
  const started = await next("progress", 20000, (m) => !!m.progress.session && m.progress.goals.some((g) => g.tasks.filter((t) => t.deskId).length === 3));
  const goal = started?.progress.goals.find((g) => g.id === started.progress.session?.goalId);
  check("stand-up: each task goes to its pick", !!goal && tasks.every(([title, d]) => goal.tasks.find((t) => t.title === title)?.deskId === d), goal?.tasks.map((t) => `${t.deskId}`).join(" "));
  if (!goal) throw new Error("no goal");

  // --- Work, audits, checks: wait for each to reach your line, then review it. ---
  // Until every task is done (approved AND merged — a conflict goes back to resolve, and comes again).
  const sentBack = new Set<string>();
  const handled = new Map<string, number>();
  const deadline = Date.now() + 25 * 60_000;
  let lastStatus = "";
  const doneCount = () => c.progress.goals.find((g) => g.id === goal.id)?.tasks.filter((t) => t.status === "done").length ?? 0;
  while (doneCount() < 3 && Date.now() < deadline) {
    const st = c.office.desks.filter((d) => d.worker).map((d) => `${d.worker!.identity?.name}:${d.worker!.status}`).join(" ");
    if (st !== lastStatus) {
      log(`   ${st} · ${doneCount()}/3 done`);
      lastStatus = st;
    }
    for (const p of c.office.presentations.filter((x) => x.report && handled.get(x.deskId) !== x.report.at)) {
      const r = p.report!;
      if (r.check?.status === "running") continue;
      handled.set(p.deskId, r.at);
      const deck = deckOf(r);
      const name = c.office.desks.find((d) => d.id === p.deskId)?.worker?.identity?.name ?? p.deskId;
      if (r.status === "blocked" || r.status === "plan") {
        log(`   ${name} asks: ${r.question ?? r.title} — answering`);
        c.send({ t: "review", deskId: p.deskId, approve: r.status === "plan", text: "Keep it simple: the smallest change that does the task. Carry on." });
        continue;
      }
      const rich = deck.filter((s) => {
        const x = parseSlide(s);
        return !!x.heading && x.bullets.length >= 1;
      }).length;
      const changed = r.slides.find((s) => s.startsWith(CHANGED_HEADING));
      check(`${name}: a real deck (${deck.length} slides, ${rich} with heading + points)`, rich >= 3, deck.map((s) => parseSlide(s).heading || parseSlide(s).bullets[0]).join(" · "));
      check(`${name}: what changed, from git`, !!changed, changed?.split(/\r?\n/)[0] ?? "none");
      check(`${name}: checks ran on it`, r.check?.status === "pass" || r.check?.status === "fail", `${r.check?.command} → ${r.check?.status}`);
      if (r.check?.status !== "pass") {
        log(`   ${name}'s check failed — the office sends it back to fix by itself`);
        continue;
      }
      // Send the first finished one back once, to test the loop; approve the rest.
      if (!sentBack.size) {
        sentBack.add(p.deskId);
        log(`   ↩ sending ${name} back once`);
        c.send({ t: "review", deskId: p.deskId, approve: false, text: "Good — one more thing: add a one-line comment above the function saying what it does. Then present again." });
        continue;
      }
      c.send({ t: "review", deskId: p.deskId, approve: true });
      log(`   ✅ approving ${name}`);
    }
    await sleep(3000);
  }
  check("all three finished, checked, approved and merged", doneCount() === 3, `${doneCount()}/3 in ${Math.round((Date.now() - t0) / 60000)} min`);
  check("the one sent back came back and was done", [...sentBack].every((d) => c.progress.goals.find((g) => g.id === goal.id)?.tasks.some((t) => t.status === "done" && t.title === tasks.find((x) => x[1] === d)?.[0])), [...sentBack].join(","));
  const auditNotes = c.office.presentations.length;
  void auditNotes;

  // --- What landed on your branch (main), for real. ---
  await sleep(3000);
  const logMain = git(TOY, "log", "--oneline", BASE);
  log(`   main:\n${logMain.split("\n").map((l) => `        ${l}`).join("\n")}`);
  const math = readFileSync(join(TOY, "src", "math.js"), "utf8");
  check("merged: subtract() on main", /export function subtract/.test(math));
  check("merged: average([]) fixed on main", /length\s*===?\s*0|!xs\.length|xs\.length\s*\?/.test(math), math.split("\n").filter((l) => /average|length/.test(l)).join(" ⏎ "));
  check("merged: README on main", existsSync(join(TOY, "README.md")));
  let testsOk = false;
  let testOut = "";
  try {
    testOut = execFileSync("npm", ["test"], { cwd: TOY, env, encoding: "utf8", shell: true });
    testsOk = true;
  } catch (e) {
    testOut = String((e as { stdout?: string }).stdout ?? e);
  }
  check("main's tests pass after the merges", testsOk, (testOut.match(/# (pass|fail) \d+/g) ?? []).join(" "));
  check("nothing uncommitted left on main", git(TOY, "status", "--porcelain").split("\n").filter((l) => l && !l.includes(".domain")).length === 0, git(TOY, "status", "--porcelain"));

  // --- Ship it: push to GitHub (the bare repo, or your test repo) and open the pull request. ---
  // One for the goal (the policy's default)...
  c.send({ t: "shipPR", goalId: goal.id, per: "goal" });
  const pr = await next("pr", 30000, (m) => !m.deskId);
  check("ship: pull request opened", REAL ? !!pr && pr.pr.number > 0 && pr.pr.url.startsWith(`https://github.com/${OWNER}/${REPO}/pull/`) : pr?.pr.number === 7, pr?.pr.url);
  const pushed = [...remoteHeads().keys()].find((b) => b.startsWith("domain/") && !b.includes("-desk-") && !headsBefore.has(b));
  check("ship: branch pushed to GitHub", !!pushed, pushed);
  if (gh) {
    const prCall = gh.calls.find((x) => x.method === "POST" && x.url === "/repos/acme/web/pulls");
    const prBody = prCall ? (JSON.parse(prCall.body) as { title: string; head: string; base: string; body: string }) : null;
    check("ship: PR names the branch, base and tasks", !!prBody && prBody.base === "main" && pushed === prBody.head && /\[x\]/.test(prBody.body), prBody ? `${prBody.head} → ${prBody.base}` : "no call");
  } else check("ship: the goal's branch carries the run's tag", !!pushed?.includes(TAG), pushed);
  check("GitHub token never in the office's logs", !serverOut.includes(TOKEN));
  // The office follows the PR's checks (a real test repo may have no CI: "none" is fine there).
  const settled = (x: string) => x === "success" || (!!REAL && x === "none");
  const followed = await next("pr", REAL ? 180000 : 60000, (m) => !m.deskId && settled(m.pr.checks));
  check("ship: the PR's checks are followed", !!followed && settled(followed.pr.checks), `checks: ${followed?.pr.checks ?? c.progress.goals.find((g) => g.id === goal.id)?.pr?.checks}`);

  // ...and one per agent, each from its own branch.
  const agentPrs = new Map<string, Extract<ServerMessage, { t: "pr" }>>();
  const offPr = c.on((m) => {
    if (m.t === "pr" && m.deskId && !agentPrs.has(m.deskId)) agentPrs.set(m.deskId, m);
  });
  for (const [, deskId] of hires) c.send({ t: "shipPR", goalId: goal.id, deskId });
  for (let i = 0; i < 120 && agentPrs.size < hires.length; i++) await sleep(500);
  offPr();
  check("ship per agent: a pull request from each agent's own branch", agentPrs.size === hires.length, [...agentPrs.values()].map((m) => `${m.deskId} #${m.pr.number}`).join(", "));
  const agentBranches = c.office.desks.filter((d) => hires.some(([, id]) => id === d.id)).map((d) => d.worker?.branch ?? "");
  const headsNow = remoteHeads();
  check("ship per agent: each agent's branch pushed as it is", agentBranches.every((b) => !!b && headsNow.get(b) === git(TOY, "rev-parse", b)), agentBranches.join(", "));
  const goalNow = c.progress.goals.find((g) => g.id === goal.id);
  check("ship per agent: kept on the goal", (goalNow?.agentPrs?.length ?? 0) === hires.length, goalNow?.agentPrs?.map((p) => `${p.name} #${p.number}`).join(", "));
  if (gh) {
    const titles = gh.calls.filter((x) => x.method === "POST" && x.url === "/repos/acme/web/pulls").map((x) => (JSON.parse(x.body) as { title: string; head: string }));
    check("ship per agent: each PR names its agent and its branch", agentBranches.every((b) => titles.some((t) => t.head === b && t.title.includes(" — "))), titles.map((t) => `${t.head}: ${t.title}`).join(" | "));
  }

  // --- Where the repo stands (the laptop's Repo app, nou repo). ---
  c.send({ t: "repoStatus" });
  const rs = (await next("repoStatus", 45000))?.status;
  const aheadGit = Number(git(TOY, "rev-list", "--count", `origin/${BASE}..${BASE}`));
  check("repo: branch, and ahead of GitHub as git says", rs?.branch === BASE && rs.ahead === aheadGit && rs.behind === 0, `office ↑${rs?.ahead} ↓${rs?.behind}, git ↑${aheadGit}`);
  check("repo: each agent's branch", (rs?.agents.length ?? 0) === 3 && rs!.agents.every((a) => a.branch.startsWith("domain/")), rs?.agents.map((a) => `${a.name} ${a.branch}`).join(", "));
  check(
    "repo: open pull requests with their checks",
    (REAL ? rs?.pulls?.some((p) => p.number === pr?.pr.number) : rs?.pulls?.some((p) => p.number === 12 && p.checks === "failure")) ?? false,
    JSON.stringify(rs?.pulls ?? rs?.pullsError),
  );

  // --- Notes from your computer, attached to a task: copied into the agent's folder, and read. ---
  const bolt = c.office.desks.find((d) => d.worker?.identity?.name === "Bolt")!;
  c.send({
    t: "quickTask",
    deskId: bolt.id,
    text: "Read the attached notes, then create NOTES-CHECK.md containing only the magic word from them. Commit it.",
    files: [{ name: "style.md", text: "# Style\n\n- The magic word is PINEAPPLE.\n" }, { name: "../../escape.txt", text: "a plain file name, whatever it says" }],
  });
  await sleep(4000);
  const boltTree = git(TOY, "worktree", "list")
    .split(/\r?\n/)
    .find((l) => l.includes(bolt.worker!.branch!))!
    .split(/\s+/)[0];
  check("attach: copied into the agent's own folder (names can't climb out)", existsSync(join(boltTree, ".domain", "notes", "style.md")) && existsSync(join(boltTree, ".domain", "notes", "escape.txt")), join(boltTree, ".domain", "notes"));
  let word = "";
  for (let i = 0; i < 90 && !word; i++) {
    await sleep(2000);
    const f = join(boltTree, "NOTES-CHECK.md");
    if (existsSync(f)) word = readFileSync(f, "utf8").trim();
  }
  check("attach: the agent read them", /PINEAPPLE/.test(word), word.slice(0, 40));

  console.log("\n" + statusText(c.office, c.progress));
} catch (e) {
  check("run finished without crashing", false, (e as Error).stack ?? String(e));
} finally {
  conn?.close();
  // The whole tree first (the shell's child is the office), then the shell.
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
  server.kill();
  gh?.close();
  // Real GitHub: put the test repo back as it was — every PR, branch and issue this run made.
  if (janitor && REAL) {
    try {
      const fresh = [...remoteHeads().keys()].filter((b) => !headsBefore.has(b));
      for (const b of fresh) janitor.track("branches", b);
      for (const p of await janitor.pullsFrom(fresh)) janitor.track("pulls", p.number);
      for (const n of prsSeen) janitor.track("pulls", n);
      if (REAL.keep) log(`   E2E_GITHUB_KEEP=1 — left on ${OWNER}/${REPO}: PRs ${janitor.made.pulls.map((n) => `#${n}`).join(" ") || "none"}, branches ${janitor.made.branches.join(" ") || "none"}, issues ${janitor.made.issues.map((n) => `#${n}`).join(" ") || "none"}`);
      else {
        const done = await janitor.cleanup();
        check("cleanup: the test repo's PRs, branches and issues from this run are gone", done.ok, done.failed.join(" | "));
      }
    } catch (e) {
      check("cleanup: the test repo's PRs, branches and issues from this run are gone", false, (e as Error).message);
    }
  }
  writeFileSync(join(D, "server.log"), serverOut);
  console.log("\n" + results.join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
