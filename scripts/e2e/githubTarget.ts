// Which GitHub the end-to-end run talks to: the local stand-in (the default — no account, nothing
// leaves the machine), or a real test repository you name (opt-in), plus the janitor that cleans up
// everything a real run leaves there: the pull requests it opened, the branches it pushed and the
// issues it filed. Nothing here runs on its own; scripts/e2e/real-agents.ts uses it.
//
//   E2E_GITHUB_REPO=you/domain-e2e-sandbox   a throwaway repo with at least one commit (e.g. a README)
//   E2E_GITHUB_TOKEN=github_pat_…            a token that can push to it and open/close PRs and issues
//                                            (fine-grained: Contents, Pull requests, Issues: read & write)
//   E2E_GITHUB_KEEP=1                        leave what it made (to look at it), instead of cleaning up

export type GithubTarget =
  | { mode: "stand-in" }
  | { mode: "real"; owner: string; repo: string; token: string; api: string; keep: boolean };

/** The target from the environment; throws with what's missing when it's asked for but incomplete. */
export function githubTarget(env: NodeJS.ProcessEnv = process.env): GithubTarget {
  const slug = (env.E2E_GITHUB_REPO ?? "").trim();
  if (!slug) return { mode: "stand-in" };
  const m = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})$/.exec(slug.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, ""));
  if (!m) throw new Error(`E2E_GITHUB_REPO should be owner/repo, not “${slug}”`);
  const token = (env.E2E_GITHUB_TOKEN ?? "").trim();
  if (!token) throw new Error("E2E_GITHUB_REPO is set, so E2E_GITHUB_TOKEN must be too (a token that can push to it and open pull requests and issues)");
  return { mode: "real", owner: m[1], repo: m[2], token, api: (env.E2E_GITHUB_API ?? "https://api.github.com").replace(/\/$/, ""), keep: env.E2E_GITHUB_KEEP === "1" };
}

/** A unique tag for one run: on every branch, PR and issue it makes, so cleanup only ever touches its own. */
export function runTag(now = Date.now()): string {
  return `e2e-${now.toString(36)}`;
}

/** What a run would do against `target`, in words (for --dry-run). */
export function describePlan(target: GithubTarget, tag: string): string[] {
  if (target.mode === "stand-in") {
    return [
      "GitHub: the local stand-in (tests/helpers/mockGithub.ts) — no account, nothing leaves this machine.",
      "Pushes go to a bare repo in the run's temp folder (git's pushInsteadOf).",
      "Set E2E_GITHUB_REPO=owner/repo and E2E_GITHUB_TOKEN=… to run against a real test repository instead.",
    ];
  }
  const slug = `${target.owner}/${target.repo}`;
  return [
    `GitHub: the real API at ${target.api}, on the test repository ${slug} (token from E2E_GITHUB_TOKEN; it's never written to disk).`,
    `It clones ${slug} into a temp folder, adds the toy library on top of its default branch (locally — that branch is never pushed).`,
    `It files two issues titled “[${tag}] …”, imports them as tasks, then deletes those tasks.`,
    `Three agents work on their own branches; it pushes the goal as domain/toy-math-${tag} and opens a pull request,`,
    "then pushes each agent's own branch (domain/<agent>-<desk>-<id>) and opens a pull request per agent, and follows their checks.",
    "Every branch that's new on the remote after the run (compared with before it) counts as this run's.",
    target.keep
      ? "E2E_GITHUB_KEEP=1: it leaves those pull requests, branches and issues for you to look at."
      : "Cleanup, pass or fail: it closes every pull request it opened, deletes every branch it pushed, and closes the issues it filed.",
  ];
}

interface Made {
  issues: number[];
  pulls: number[];
  branches: string[];
}

/** Talks to GitHub's REST API for the run itself (filing issues, cleaning up): never the office's own client. */
export class GithubJanitor {
  readonly made: Made = { issues: [], pulls: [], branches: [] };
  constructor(
    private api: string,
    private owner: string,
    private repo: string,
    private token: string,
    private say: (s: string) => void = () => {},
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.api}/repos/${this.owner}/${this.repo}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "domain-e2e",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  async fileIssue(title: string, body: string): Promise<number> {
    const r = (await this.call("POST", "/issues", { title, body })) as { number: number };
    this.made.issues.push(r.number);
    return r.number;
  }

  /** Open pull requests from any of these branches (whoever opened them: the office, or an agent). */
  async pullsFrom(heads: string[]): Promise<{ number: number; head: string }[]> {
    const list = (await this.call("GET", "/pulls?state=open&per_page=100")) as { number: number; head?: { ref?: string } }[];
    return list.filter((p) => !!p.head?.ref && heads.includes(p.head.ref)).map((p) => ({ number: p.number, head: String(p.head!.ref) }));
  }

  /** Remember a PR or branch the office made, so cleanup gets it. */
  track(kind: "pulls" | "branches", v: number | string): void {
    const list = this.made[kind] as (number | string)[];
    if (!list.includes(v)) list.push(v);
  }

  /** Close every PR, delete every branch and close every issue this run made. Best effort: it reports what it couldn't. */
  async cleanup(): Promise<{ ok: boolean; failed: string[] }> {
    const failed: string[] = [];
    const attempt = async (what: string, f: () => Promise<unknown>) => {
      try {
        await f();
        this.say(`   🧹 ${what}`);
      } catch (e) {
        failed.push(`${what}: ${(e as Error).message}`);
      }
    };
    for (const n of this.made.pulls) await attempt(`closed pull request #${n}`, () => this.call("PATCH", `/pulls/${n}`, { state: "closed" }));
    for (const b of this.made.branches) await attempt(`deleted branch ${b}`, () => this.call("DELETE", `/git/refs/heads/${b.split("/").map(encodeURIComponent).join("/")}`));
    for (const n of this.made.issues) await attempt(`closed issue #${n}`, () => this.call("PATCH", `/issues/${n}`, { state: "closed", state_reason: "not_planned" }));
    return { ok: !failed.length, failed };
  }
}
