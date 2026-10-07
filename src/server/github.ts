import { spawn } from "node:child_process";
import type { GithubAccount, GithubIssue, GithubRepo, PullRequestInfo } from "../shared/project.js";
import type { OpLogger } from "./oplog.js";

/**
 * GitHub, through the sign-in you already have: git's own credential manager
 * (on Windows, Git Credential Manager opens the browser once). We ask git for
 * the github.com credential, use it for the REST API, and hand it back with
 * `git credential approve` so it's remembered. The token lives in memory
 * only — never on disk, never in a log. Every call shows up in the Logs.
 *
 * DOMAIN_GITHUB_API points the client at another API (tests use a mock).
 */

export interface Credential {
  username: string;
  token: string;
}

/** Where a token comes from. `interactive` lets the credential manager show its sign-in. */
/**
 * Where tokens come from. `username` picks the account when the credential
 * manager holds several (otherwise it asks you to pick — or, with no window
 * allowed, gives nothing back).
 */
export type TokenSource = (opts: { interactive: boolean; username?: string }) => Promise<Credential | null>;

export class SignInNeeded extends Error {
  constructor(message = "Sign in to GitHub first") {
    super(message);
  }
}

/** Run `git credential <op>` with `input` on stdin; resolves with stdout ("" on failure). */
function gitCredential(op: "fill" | "approve", input: string, interactive: boolean, timeoutMs: number): Promise<string> {
  return new Promise((done) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    // Git Credential Manager: no windows unless we're signing in on purpose.
    if (!interactive) Object.assign(env, { GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "" });
    let out = "";
    let finished = false;
    const child = spawn("git", ["credential", op], { env, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const finish = (text: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done(text);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish("");
    }, timeoutMs);
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.on("error", () => finish(""));
    child.on("close", (code) => finish(code === 0 ? out : ""));
    child.stdin.end(input);
  });
}

/** The real source: git's credential helper for https://github.com. */
export function gitCredentialSource(): TokenSource {
  return async ({ interactive, username }) => {
    const user = username && /^[A-Za-z0-9-]{1,39}$/.test(username) ? `username=${username}\n` : "";
    const out = await gitCredential("fill", `protocol=https\nhost=github.com\n${user}\n`, interactive, interactive ? 5 * 60_000 : 8000);
    const get = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(out)?.[1]?.trim() ?? "";
    const token = get("password");
    return token ? { username: get("username"), token } : null;
  };
}

/** Tell git the credential worked, so its helper keeps it. */
export function approveCredential(c: Credential): void {
  void gitCredential("approve", `protocol=https\nhost=github.com\nusername=${c.username}\npassword=${c.token}\n\n`, false, 8000);
}

/** Roll a commit's check runs and statuses up into one word. */
export function rollupChecks(
  runs: { status?: string; conclusion?: string | null }[],
  statuses: { state?: string }[] = [],
): PullRequestInfo["checks"] {
  if (!runs.length && !statuses.length) return "none";
  const bad = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "error"]);
  if (runs.some((r) => r.conclusion && bad.has(r.conclusion)) || statuses.some((s) => s.state === "failure" || s.state === "error")) {
    return "failure";
  }
  if (runs.some((r) => r.status !== "completed") || statuses.some((s) => s.state === "pending")) return "pending";
  return "success";
}

export interface GithubOptions {
  log: OpLogger;
  token?: TokenSource;
  api?: string;
  approve?: (c: Credential) => void;
  /** Which account to use when there are several: the last one you signed in as, or the repo's owner. */
  username?: () => string | null;
}

export class GitHub {
  readonly api: string;
  private log: OpLogger;
  private source: TokenSource;
  private approve: (c: Credential) => void;
  private username: () => string | null;
  private cred: Credential | null = null;
  private approved = false;
  account: GithubAccount | null = null;

  /** The signed-in token, for handing to workers' GitHub tools (in memory only). */
  get token(): string | null {
    return this.account ? (this.cred?.token ?? null) : null;
  }

  constructor(opts: GithubOptions) {
    this.api = (opts.api ?? process.env.DOMAIN_GITHUB_API ?? "https://api.github.com").replace(/\/$/, "");
    this.log = opts.log;
    this.source = opts.token ?? gitCredentialSource();
    this.approve = opts.approve ?? approveCredential;
    this.username = opts.username ?? (() => null);
  }

  /** A token: for the account we expect first (quietly), then whichever the credential manager offers. */
  private async fetchCred(interactive: boolean): Promise<Credential | null> {
    const username = this.username() ?? undefined;
    if (username) {
      const c = await this.source({ interactive: false, username });
      if (c) return c;
    }
    return this.source({ interactive });
  }

  /** Who's signed in; with `interactive`, let the credential manager sign you in. Null when not signed in. */
  async signIn(interactive: boolean): Promise<GithubAccount | null> {
    if (!this.cred || interactive) this.cred = await this.fetchCred(interactive);
    if (!this.cred) return (this.account = null);
    try {
      const u = (await this.request("GET", "/user", undefined, "github")) as { login?: string; avatar_url?: string };
      this.account = { login: String(u.login ?? this.cred.username), avatarUrl: String(u.avatar_url ?? "") };
      if (!this.approved) {
        this.approved = true;
        this.approve(this.cred);
      }
      return this.account;
    } catch (e) {
      if (e instanceof SignInNeeded) {
        this.cred = null;
        this.account = null;
        return null;
      }
      throw e;
    }
  }

  async repos(): Promise<GithubRepo[]> {
    const list = (await this.request("GET", "/user/repos?sort=updated&per_page=50", undefined, "github")) as Record<string, unknown>[];
    return list.map((r) => ({
      fullName: String(r.full_name ?? ""),
      description: String(r.description ?? ""),
      private: r.private === true,
      updatedAt: String(r.updated_at ?? ""),
      cloneUrl: String(r.clone_url ?? ""),
      defaultBranch: String(r.default_branch ?? "main"),
    }));
  }

  async issues(owner: string, repo: string): Promise<GithubIssue[]> {
    const list = (await this.request("GET", `/repos/${owner}/${repo}/issues?state=open&per_page=50`, undefined, "github")) as Record<string, unknown>[];
    return list
      .filter((i) => !i.pull_request)
      .map((i) => ({
        number: Number(i.number),
        title: String(i.title ?? ""),
        body: String(i.body ?? "").slice(0, 2000),
        labels: Array.isArray(i.labels) ? i.labels.map((l) => String((l as { name?: unknown }).name ?? l)).slice(0, 8) : [],
        url: String(i.html_url ?? ""),
      }));
  }

  async defaultBranch(owner: string, repo: string, topic?: string): Promise<string> {
    const r = (await this.request("GET", `/repos/${owner}/${repo}`, undefined, topic)) as { default_branch?: string };
    return r.default_branch ?? "main";
  }

  async createPull(owner: string, repo: string, pr: { title: string; head: string; base: string; body: string }, topic?: string): Promise<PullRequestInfo> {
    const r = (await this.request("POST", `/repos/${owner}/${repo}/pulls`, pr, topic)) as Record<string, unknown>;
    return { number: Number(r.number), url: String(r.html_url ?? ""), title: String(r.title ?? pr.title), state: "open", checks: "pending" };
  }

  /** A pull request's state and its checks, rolled up. */
  /** The open pull requests, newest first, each with its checks. */
  async openPulls(owner: string, repo: string, limit = 8): Promise<(PullRequestInfo & { head: string })[]> {
    const list = (await this.request("GET", `/repos/${owner}/${repo}/pulls?state=open&per_page=${limit}`, undefined, undefined, true)) as Record<string, unknown>[];
    return Promise.all(
      (Array.isArray(list) ? list : []).slice(0, limit).map(async (r) => {
        const head = r.head as { ref?: string; sha?: string } | undefined;
        let checks: PullRequestInfo["checks"] = "none";
        if (head?.sha) {
          try {
            const runs = (await this.request("GET", `/repos/${owner}/${repo}/commits/${head.sha}/check-runs`, undefined, undefined, true)) as { check_runs?: { status?: string; conclusion?: string | null }[] };
            const status = (await this.request("GET", `/repos/${owner}/${repo}/commits/${head.sha}/status`, undefined, undefined, true)) as { statuses?: { state?: string }[] };
            checks = rollupChecks(runs.check_runs ?? [], status.statuses ?? []);
          } catch {
            /* checks unknown */
          }
        }
        return { number: Number(r.number), url: String(r.html_url ?? ""), title: String(r.title ?? ""), state: "open" as const, checks, head: String(head?.ref ?? "") };
      }),
    );
  }

  async pullStatus(owner: string, repo: string, number: number, topic?: string): Promise<PullRequestInfo> {
    const r = (await this.request("GET", `/repos/${owner}/${repo}/pulls/${number}`, undefined, topic)) as Record<string, unknown>;
    const sha = String((r.head as { sha?: string } | undefined)?.sha ?? "");
    let checks: PullRequestInfo["checks"] = "none";
    if (sha) {
      const runs = (await this.request("GET", `/repos/${owner}/${repo}/commits/${sha}/check-runs`, undefined, topic, true)) as {
        check_runs?: { status?: string; conclusion?: string | null }[];
      };
      const status = (await this.request("GET", `/repos/${owner}/${repo}/commits/${sha}/status`, undefined, topic, true)) as {
        statuses?: { state?: string }[];
      };
      checks = rollupChecks(runs.check_runs ?? [], status.statuses ?? []);
    }
    const state: PullRequestInfo["state"] = r.merged === true || r.merged_at ? "merged" : r.state === "closed" ? "closed" : "open";
    return { number, url: String(r.html_url ?? ""), title: String(r.title ?? ""), state, checks };
  }

  /**
   * One REST call, logged (never the token). A 401 means sign in again.
   * `quiet` calls (polling) don't add a log entry unless they fail.
   */
  private async request(method: string, path: string, body?: unknown, topic?: string, quiet = false): Promise<unknown> {
    if (!this.cred) this.cred = await this.fetchCred(false);
    if (!this.cred) throw new SignInNeeded();
    const url = `${this.api}${path}`;
    const op = quiet ? null : this.log.start("github", `GitHub: ${method} ${path.split("?")[0]}`, { command: `${method} ${url}`, topic });
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.cred.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "domain-office",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (res.status === 401) {
        this.cred = null;
        op?.done(false, "401 — GitHub didn't accept the sign-in. Sign in again.");
        throw new SignInNeeded("GitHub didn't accept the sign-in — sign in again");
      }
      if (!res.ok) {
        const msg = (json as { message?: string; errors?: { message?: string }[] } | null)?.message ?? text.slice(0, 200);
        const extra = (json as { errors?: { message?: string }[] } | null)?.errors?.map((e) => e.message).filter(Boolean).join("; ");
        const detail = `${res.status} ${msg}${extra ? ` — ${extra}` : ""}`;
        (op ?? this.log.start("github", `GitHub: ${method} ${path.split("?")[0]}`, { command: `${method} ${url}`, topic })).done(false, detail);
        throw new Error(detail);
      }
      op?.done(true, `${res.status} ${res.statusText || "OK"}`);
      return json;
    } catch (e) {
      if (e instanceof SignInNeeded) throw e;
      if (e instanceof Error && /^\d{3} /.test(e.message)) throw e;
      const detail = e instanceof Error ? e.message : String(e);
      (op ?? this.log.start("github", `GitHub: ${method} ${path.split("?")[0]}`, { command: `${method} ${url}`, topic })).done(false, detail);
      throw new Error(detail);
    }
  }
}
