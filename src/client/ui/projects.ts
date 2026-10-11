import type { ClientMessage, ServerMessage } from "../../shared/protocol.js";
import type { FoundRepo, GithubAccount, GithubRepo, ProjectInfo, RecentProject, RepoWorker } from "../../shared/project.js";
import { icon } from "./icons.js";
import { logView, openLogs } from "./logs.js";
import { esc, openModal, type Modal } from "./modal.js";
import "../styles/projects.css";

/**
 * Projects: which folder your workers work in, the other repos open
 * alongside it, and adding more. The window opens with one big "＋ Add a
 * repo" button: a chooser with the repos found on this computer (one click),
 * your GitHub repos (clone + add), any folder, or a new, empty repo. Below
 * it, every open repo with who works there, where new hires go, and close.
 * Then switching the office to another project, and your GitHub sign-in
 * (git's own), with every git step's output right there.
 */

export type AddTab = "local" | "github" | "folder" | "new";

export const projectState = {
  info: null as ProjectInfo | null,
  recent: [] as RecentProject[],
  account: null as GithubAccount | null,
  accountError: "",
  /** Asked git for a sign-in and heard back. */
  accountChecked: false,
  signingIn: false,
  repos: [] as GithubRepo[],
  reposError: "",
  reposLoading: false,
  /** You joined someone else's office: their projects aren't yours to switch. */
  guest: false,
  /** The other repos open alongside the project, where new hires work, and who works where. */
  open: [] as ProjectInfo[],
  hireRepo: "",
  workers: [] as RepoWorker[],
  /** Repos found on this computer that aren't open (null until asked). */
  found: null as FoundRepo[] | null,
  foundTruncated: false,
  finding: false,
};

export interface ProjectActions {
  send(msg: ClientMessage): void;
  /** Whether workers already get GitHub tools from your sign-in. */
  hasGithubTools?(): boolean;
  /** Give every worker GitHub tools (MCP) using your sign-in. */
  addGithubTools?(): void;
}

let modal: Modal | null = null;
let actions: ProjectActions | null = null;
/** The add-a-repo chooser: which part is showing (null: closed). */
let tab: AddTab | null = null;
let localFilter = "";
let githubFilter = "";
const listeners = new Set<() => void>();

/** Be told when anything about projects changes (the laptop's Repo app, the HUD). */
export function onProjectsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Is the current project on GitHub (and can we act on it here)? */
export function isGithubProject(): boolean {
  return !!projectState.info?.github && !projectState.guest;
}

/** Feed every server message through here. */
export function ingestProjects(msg: ServerMessage): void {
  switch (msg.t) {
    case "project":
      projectState.info = msg.info;
      projectState.recent = msg.recent;
      if (msg.account) projectState.account = msg.account;
      projectState.open = msg.repos ?? [];
      projectState.hireRepo = msg.hireRepo ?? "";
      projectState.workers = msg.workers ?? [];
      // What's open changed: what's found (minus the open ones) is out of date.
      if (projectState.found && modal && tab === "local") findRepos();
      settlePending();
      break;
    case "githubAccount":
      projectState.accountChecked = true;
      projectState.signingIn = false;
      projectState.account = msg.account;
      projectState.accountError = msg.error ?? "";
      if (msg.account && (modal || listeners.size) && !projectState.repos.length) requestGithubRepos();
      break;
    case "githubRepos":
      projectState.reposLoading = false;
      projectState.repos = msg.repos;
      projectState.reposError = msg.error ?? "";
      break;
    case "repoFound":
      projectState.finding = false;
      projectState.found = msg.local;
      projectState.foundTruncated = !!msg.truncated;
      break;
    case "guest":
      projectState.guest = true;
      break;
    case "projectSwitching":
      showSwitching(msg.name, msg.path);
      return;
    default:
      return;
  }
  render();
  for (const l of listeners) l();
}

let sender: ((m: ClientMessage) => void) | null = null;
/** How the laptop and HUD reach the server when the window isn't open. */
export function setProjectSender(send: (m: ClientMessage) => void): void {
  sender = send;
}
const send = (m: ClientMessage) => (actions?.send ?? sender)?.(m);

/** Ask for your GitHub repos (when signed in). */
export function requestGithubRepos(): void {
  if (projectState.reposLoading) return;
  projectState.reposLoading = true;
  send({ t: "githubRepos" });
}

/** Look for repos on this computer (the server scans, briefly, and remembers). */
export function findRepos(fresh = false): void {
  projectState.finding = true;
  send({ t: "repoFind", ...(fresh ? { fresh: true } : {}) });
}

/** The current project's name and branch, for the HUD ("" until we know). */
export function projectBadge(): string {
  const i = projectState.info;
  if (!i) return "";
  const n = 1 + projectState.open.length;
  const host = !projectState.guest;
  const acct = projectState.account;
  return `<div class="pj-hud">
    <span class="pj-hud-chips">
      <button class="pj-hud-main" data-pj="open" title="${esc(i.path)} — open Projects & GitHub">${i.github ? `${icon("github", 13)} ${esc(i.github.owner)}/${esc(i.github.repo)}` : icon("folder", 13)}${
        i.branch ? ` <span class="pj-branch">${icon("branch", 12)} ${esc(i.branch)}</span>` : ""
      }</button>
      <button class="pj-hud-chip" data-pj="open" title="${esc([i, ...projectState.open].map((r) => r.name).join(", "))}">📦 ${n} repo${n === 1 ? "" : "s"}</button>
      ${
        host
          ? acct
            ? `<button class="pj-hud-chip gh on" data-pj="github" title="Signed in to GitHub — your repos">${icon("github", 12)} @${esc(acct.login)}</button>`
            : `<button class="pj-hud-chip gh" data-pj="github" title="Sign in with git's own sign-in, to clone your repos and open pull requests">${icon("github", 12)} Sign in to GitHub</button>`
          : ""
      }
      ${host ? `<button class="pj-hud-chip add" data-pj="add" title="Open another repo alongside this one — from this computer, GitHub, a folder, or a new one">＋ Add repo</button>` : ""}
    </span>
  </div>`;
}

/** The repos open now: the project, then the others (for picking one per task). */
export function openRepos(): ProjectInfo[] {
  const i = projectState.info;
  return i ? [i, ...projectState.open] : [];
}

function ago(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function samePath(a: string, b: string): boolean {
  const n = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
  return n(a) === n(b);
}

/**
 * Open the Projects window. `add`: with the add-a-repo chooser open on that
 * part ("local" for the repos on this computer, "github", "folder", "new").
 */
export function openProjects(a: ProjectActions, opts: { add?: AddTab } = {}): void {
  actions = a;
  sender ??= a.send;
  tab = opts.add ?? null;
  const body = document.createElement("div");
  body.className = "projects";
  modal = openModal({
    title: "Projects & GitHub",
    icon: icon("folder", 20),
    className: "projects-modal",
    body,
    footer: `<span class="grow">Each worker works in one open repo; new hires go where you say.</span><button class="btn small pj-logs">${icon("log", 14)} Logs</button>`,
    onClose: () => {
      modal = null;
      actions = null;
    },
  });
  modal.footer?.querySelector(".pj-logs")?.addEventListener("click", () => openLogs());
  a.send({ t: "projectInfo" });
  if (!projectState.guest) findRepos();
  if (projectState.account) requestGithubRepos();
  render();
  if (tab) modal.body.querySelector(".pa-chooser")?.scrollIntoView({ block: "nearest" });
}

/** Waiting for a repo to be added, to hand it back to whoever asked (a dropdown's "＋ Add a repo…"). */
let pendingAdd: { had: string[]; then: (path: string) => void } | null = null;

/**
 * "＋ Add a repo…" from a dropdown: the Add-a-repo chooser; once a new repo
 * opens, the window closes and `then` gets its folder (to select it where you were).
 */
export function addRepoThen(a: ProjectActions, then: (path: string) => void): void {
  openProjects(a, { add: "local" });
  pendingAdd = { had: openRepos().map((r) => r.path), then };
}

/** A "project" message: did the repo someone was waiting for open? */
function settlePending(): void {
  if (!pendingAdd) return;
  if (!modal) {
    pendingAdd = null;
    return;
  }
  const added = projectState.open.find((r) => !pendingAdd!.had.some((p) => samePath(p, r.path)));
  if (!added) return;
  const { then } = pendingAdd;
  pendingAdd = null;
  modal.close();
  then(added.path);
}

/** A repo dropdown's options: the open repos, then "＋ Add a repo…" (value "+add"). */
export function repoOptionsHtml(selected: string, opts: { none?: string } = {}): string {
  const all = openRepos();
  return `${opts.none !== undefined ? `<option value="" ${selected ? "" : "selected"}>${esc(opts.none)}</option>` : ""}${all
    .map((r) => `<option value="${esc(r.path)}" ${selected && samePath(selected, r.path) ? "selected" : ""}>📦 ${esc(r.name)}</option>`)
    .join("")}<option value="+add">＋ Add a repo…</option>`;
}

/** A live worker's repo, to move it to another (its terminal, the laptop's Workers header). "" for guests. */
export function workerRepoHtml(deskId: string, repo: string | undefined): string {
  if (projectState.guest || !projectState.info) return "";
  const now = repo || projectState.info.path;
  return `<label class="wr" title="The repo it works in — moving it restarts it there, on a branch of its own (unmerged work is kept)">📦 <select class="wr-sel" data-desk="${esc(deskId)}">${repoOptionsHtml(now)}</select></label>`;
}

/** Wire the worker repo dropdowns in `root`: move it (workerRepo), or ＋ Add a repo… and move it there. */
export function wireWorkerRepo(root: HTMLElement, send: (m: ClientMessage) => void, addThen: (then: (path: string) => void) => void): void {
  root.querySelectorAll<HTMLSelectElement>(".wr-sel").forEach((sel) => {
    const was = sel.value;
    sel.addEventListener("keydown", (e) => e.stopPropagation());
    sel.addEventListener("change", () => {
      const deskId = sel.dataset.desk!;
      if (sel.value === "+add") {
        sel.value = was;
        addThen((path) => send({ t: "workerRepo", deskId, repo: path }));
      } else if (!samePath(sel.value, was)) send({ t: "workerRepo", deskId, repo: sel.value });
    });
  });
}

/** Your GitHub repos with search and one-click clone + add (the Projects window and the laptop's Repo app). */
export function githubListHtml(filter: string, cls = "pj-repo-list"): string {
  const acct = projectState.account;
  if (!acct) return "";
  if (projectState.reposLoading) return `<p class="pj-note">${icon("spinner", 14)} Loading your repositories…</p>`;
  if (projectState.reposError) return `<p class="pj-err">${esc(projectState.reposError)}</p>`;
  const here = new Set(openRepos().map((r) => (r.github ? `${r.github.owner}/${r.github.repo}`.toLowerCase() : "")).filter(Boolean));
  const q = filter.trim().toLowerCase();
  const repos = projectState.repos.filter((r) => !q || r.fullName.toLowerCase().includes(q) || r.description.toLowerCase().includes(q));
  return `<ul class="${cls}">${repos
    .slice(0, 40)
    .map(
      (r) => `<li>
        <span class="pj-r-icon">${icon("github", 16)}</span>
        <span class="pj-r-main"><b>${esc(r.fullName)}${r.private ? ` <span class="pj-lock">private</span>` : ""}</b><span class="pj-desc">${esc(r.description || "No description")}</span></span>
        ${
          here.has(r.fullName.toLowerCase())
            ? `<span class="pj-r-when">${icon("check", 12)} open</span>`
            : `<button class="btn small primary pj-clone-repo" data-url="${esc(r.cloneUrl || r.fullName)}" title="Clone it and open it alongside this project (no restart)">${icon("clone", 14)} Clone + add</button>`
        }
      </li>`,
    )
    .join("")}${repos.length ? "" : `<li class="pj-note">${projectState.repos.length ? "No repositories match." : "No repositories yet."}</li>`}</ul>`;
}

/** The sign-in button (or who you're signed in as). */
export function githubAccountHtml(): string {
  const acct = projectState.account;
  return acct
    ? `<div class="pj-account">${acct.avatarUrl ? `<img src="${esc(acct.avatarUrl)}" alt="" />` : icon("github", 22)}<span>Signed in as <b>@${esc(acct.login)}</b></span></div>`
    : `<div class="pj-signin">
        <button class="btn primary pj-signin-btn" ${projectState.signingIn ? "disabled" : ""}>${projectState.signingIn ? icon("spinner", 16) : icon("github", 16)} ${projectState.signingIn ? "Waiting for GitHub…" : "Sign in with GitHub"}</button>
        <p class="pj-note">${icon("key", 12)} Uses git's own sign-in (Git Credential Manager): a browser window opens once. domain never stores your token.${
          projectState.accountError ? ` <span class="pj-err">${esc(projectState.accountError)}</span>` : ""
        }</p>
      </div>`;
}

/** Wire the GitHub bits (sign in, clone + add) in `root`. */
export function bindGithub(root: HTMLElement, afterSignIn: () => void): void {
  root.querySelectorAll<HTMLButtonElement>(".pj-clone-repo").forEach((b) =>
    b.addEventListener("click", () => {
      send({ t: "projectClone", url: b.dataset.url!, add: true });
      b.disabled = true;
      b.innerHTML = `${icon("spinner", 14)} Cloning…`;
    }),
  );
  root.querySelector(".pj-signin-btn")?.addEventListener("click", () => {
    projectState.signingIn = true;
    projectState.accountError = "";
    send({ t: "githubSignIn" });
    afterSignIn();
  });
}

function chooserHtml(): string {
  const t = tab ?? "local";
  const tabBtn = (id: AddTab, label: string) => `<button class="pa-tab ${t === id ? "on" : ""}" data-tab="${id}">${label}</button>`;
  let part = "";
  if (t === "local") {
    const q = localFilter.trim().toLowerCase();
    const list = (projectState.found ?? []).filter((r) => !q || [r.name, r.path, r.github ?? ""].some((k) => k.toLowerCase().includes(q)));
    part = `<div class="pj-row-in"><input type="text" class="pa-search" data-keep="local" placeholder="Search the repos on this computer…" value="${esc(localFilter)}" />
        <button class="btn small pa-rescan" title="Look again">↻</button></div>
      ${
        projectState.found === null || (projectState.finding && !projectState.found.length)
          ? `<p class="pj-note">${icon("spinner", 14)} Looking in your code folders…</p>`
          : `<ul class="pj-repo-list pa-found">${list
              .slice(0, 60)
              .map(
                (r) => `<li>
              <span class="pj-r-icon">${r.github ? icon("github", 16) : icon("folder", 16)}</span>
              <span class="pj-r-main"><b>${esc(r.name)}${r.branch ? ` <span class="pj-desc">· ${esc(r.branch)}</span>` : ""}</b><code>${esc(r.path)}</code>${r.github ? `<span class="pj-desc">${esc(r.github)}</span>` : ""}</span>
              <button class="btn small primary pj-add" data-path="${esc(r.path)}" title="Open it alongside this project (no restart)">＋ Add</button>
              <button class="btn small pj-open" data-path="${esc(r.path)}" title="Switch the office to it (restarts)">Open</button>
            </li>`,
              )
              .join("")}${list.length ? "" : `<li class="pj-note">${projectState.found.length ? "None match." : "No other git repos found — try A folder, GitHub, or a new repo."}</li>`}</ul>
            <p class="pj-note">Looked in this project's folder, ~/projects, ~/code, ~/src, ~/dev, ~/Documents/GitHub, ~/source/repos and ~/repos — three folders deep${projectState.foundTruncated ? ", and stopped after a moment (there may be more)" : ""}.</p>`
      }`;
  } else if (t === "github") {
    part = `${githubAccountHtml()}
      ${projectState.account ? `<input type="text" class="pa-search" data-keep="github" placeholder="Search your repositories…" value="${esc(githubFilter)}" />${githubListHtml(githubFilter)}` : ""}
      <div class="pj-row-in"><input type="text" class="pj-url" data-keep="url" placeholder="or any repo: owner/repo or https://github.com/owner/repo" />
        <button class="btn primary pj-clone">${icon("clone", 14)} Clone + add</button></div>
      <div class="pj-log-slot"></div>`;
  } else if (t === "folder") {
    part = `<div class="pj-row-in">
        <input type="text" class="pj-path" data-keep="path" placeholder="Paste a folder's path, e.g. C:\\code\\my-app or ~/code/my-app" />
        <button class="btn primary pj-path-add">＋ Add</button>
      </div>
      <div class="pj-row-in"><button class="btn pj-pick">${icon("folder", 14)} Choose a folder…</button><span class="pj-note">the folder picker is in the desktop app</span></div>
      <p class="pj-note">It opens alongside this project — no restart. Any folder works; a git repo gives each worker a branch of its own.</p>`;
  } else {
    part = `<div class="pj-row-in">
        <input type="text" class="pa-new-name" data-keep="new" placeholder="Name it, e.g. my-new-app" maxlength="60" />
        <button class="btn primary pa-create">＋ Create</button>
      </div>
      <label class="pj-note"><input type="checkbox" class="pa-new-gh" ${projectState.account ? "" : "disabled"} /> Also create it on GitHub ${projectState.account ? `(as @${esc(projectState.account.login)}, private)` : "(sign in first)"}</label>
      <p class="pj-note">Runs <code>git init</code> in a new folder next to this project, with a README and a first commit, and opens it alongside.</p>
      <div class="pj-log-slot"></div>`;
  }
  return `<section class="pa-chooser">
      <div class="pa-tabs">${tabBtn("local", `${icon("folder", 14)} On this computer${projectState.found?.length ? ` <span class="pa-n">${projectState.found.length}</span>` : ""}`)}${tabBtn("github", `${icon("github", 14)} From GitHub`)}${tabBtn("folder", `${icon("folder", 14)} A folder path`)}${tabBtn("new", "✨ A new, empty repo")}</div>
      <div class="pa-part" data-part="${t}">${part}</div>
    </section>`;
}

function render(): void {
  if (!modal || !actions) return;
  const body = modal.body;
  // Keep what you were typing.
  const drafts = new Map<string, string>();
  body.querySelectorAll<HTMLInputElement>("input[data-keep]").forEach((el) => drafts.set(el.dataset.keep!, el.value));
  const newGh = body.querySelector<HTMLInputElement>(".pa-new-gh")?.checked ?? false;
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.keep;
  const scroll = body.scrollTop;
  const i = projectState.info;
  const host = !projectState.guest;

  const current = i
    ? `<section class="pj-current">
        <div class="pj-cur-icon">${icon("folder", 30)}</div>
        <div class="pj-cur-main">
          <div class="pj-kicker">This project</div>
          <h3>${esc(i.name)}</h3>
          <code class="pj-path">${esc(i.path)}</code>
          <div class="pj-chips">
            ${
              i.isGit
                ? `<span class="pj-chip">${icon("git", 14)} git${i.branch ? ` · ${icon("branch", 12)} ${esc(i.branch)}` : ""}</span>`
                : `<span class="pj-chip warn">${icon("git", 14)} Not a git repo — workers share this folder (no branches of their own)</span>`
            }
            ${
              i.github
                ? `<a class="pj-chip gh" href="${esc(i.github.url)}" target="_blank" rel="noopener">${icon("github", 14)} ${esc(i.github.owner)}/${esc(i.github.repo)}</a>`
                : i.isGit
                  ? `<span class="pj-chip muted">${icon("github", 14)} Not on GitHub</span>`
                  : ""
            }
          </div>
          ${i.dirty ? `<p class="pj-warn">⚠️ You have uncommitted changes. Commit them so approved work can merge into ${esc(i.branch ?? "your branch")}.</p>` : ""}
        </div>
        ${host ? `<button class="btn primary pa-add-btn ${tab ? "on" : ""}">＋ Add a repo</button>` : ""}
      </section>`
    : `<section class="pj-current loading">${icon("spinner", 20)} Looking at this project…</section>`;

  // Every open repo: who works there, where new hires go, and closing it.
  const all = i ? [i, ...projectState.open] : [];
  const hireAt = projectState.hireRepo || i?.path || "";
  const openHtml = all.length
    ? `<section class="pj-open-repos">
        <h4>${icon("git", 14)} Open repos <span class="pj-hint">${all.length} · each worker works in one; a task can name another</span></h4>
        <ul class="pj-recent">${all
          .map((r, n) => {
            const who = projectState.workers.filter((w) => samePath(w.repo, r.path));
            return `<li>
              <span class="pj-r-icon">${r.github ? icon("github", 16) : icon("folder", 16)}</span>
              <span class="pj-r-main"><b>${esc(r.name)}${n === 0 ? ` <span class="pj-lock">project</span>` : ""}</b><code>${esc(r.path)}</code><span class="pj-desc">${
                r.branch ? `${esc(r.branch)} · ` : ""
              }${who.length ? `👥 ${esc(who.map((w) => w.name).join(", "))}` : "nobody works here yet"}</span></span>
              ${all.length < 2 ? "" : samePath(hireAt, r.path) ? `<span class="pj-r-when">new hires work here</span>` : host ? `<button class="btn small pj-hire-here" data-path="${esc(r.path)}">Hire here</button>` : ""}
              ${n === 0 || !host ? "" : `<button class="btn small pj-close-repo" data-path="${esc(r.path)}" title="Close it (its worktrees and branches are kept)">Close</button>`}
            </li>`;
          })
          .join("")}</ul>
        ${
          all.length > 1 && projectState.workers.length && host
            ? `<div class="pj-movers">${projectState.workers
                .map(
                  (w) => `<label class="pj-mover"><span>${esc(w.name)}</span><select class="pj-move" data-desk="${esc(w.deskId)}">${all
                    .map((r) => `<option value="${esc(r.path)}" ${samePath(r.path, w.repo) ? "selected" : ""}>${esc(r.name)}</option>`)
                    .join("")}</select></label>`,
                )
                .join("")}</div>
              <p class="pj-note">Moving a worker restarts it in that repo, on a branch of its own.</p>`
            : ""
        }
      </section>`
    : "";

  const recent = projectState.recent.filter((r) => !i || !all.some((o) => samePath(r.path, o.path)));
  const recentHtml = recent.length
    ? `<ul class="pj-recent">${recent
        .map(
          (r) => `<li>
            <span class="pj-r-icon">${r.github ? icon("github", 16) : icon("folder", 16)}</span>
            <span class="pj-r-main"><b>${esc(r.name)}</b><code>${esc(r.path)}</code></span>
            <span class="pj-r-when">${ago(r.openedAt)}</span>
            <button class="btn small pj-add" data-path="${esc(r.path)}" title="Open it alongside this project (no restart)">Add</button>
            <button class="btn small pj-open" data-path="${esc(r.path)}" title="Switch the office to it (restarts)">Open</button>
          </li>`,
        )
        .join("")}</ul>`
    : `<p class="pj-note">Projects you open show up here.</p>`;

  const ghTools = projectState.account && actions?.addGithubTools
    ? actions.hasGithubTools?.()
      ? `<p class="pj-note">${icon("mcp", 12)} Every worker also gets GitHub's tools (issues, PRs, code search).</p>`
      : `<button class="btn small pj-ghtools">${icon("mcp", 14)} Give every worker GitHub tools</button>`
    : "";

  body.innerHTML = host
    ? `${current}
      ${tab ? chooserHtml() : ""}
      ${openHtml}
      <div class="pj-grid">
        <section>
          <h4>${icon("folder", 14)} Recent</h4>
          ${recentHtml}
          <p class="pj-note">Add opens it alongside this project, no restart. Open switches: the office restarts in that folder.</p>
        </section>
        <section>
          <h4>${icon("github", 14)} GitHub</h4>
          ${githubAccountHtml()}
          ${projectState.account ? `<p class="pj-note">${icon("check", 12)} Every worker's <code>git</code> uses this sign-in too. Your repos: ＋ Add a repo → From GitHub.</p>` : ""}
          ${ghTools}
        </section>
      </div>`
    : `${current}${openHtml}<p class="pj-note">You're a guest in this office: the host picks the project.</p>`;

  body.querySelectorAll<HTMLInputElement>("input[data-keep]").forEach((el) => {
    if (drafts.has(el.dataset.keep!)) el.value = drafts.get(el.dataset.keep!)!;
  });
  const ghBox = body.querySelector<HTMLInputElement>(".pa-new-gh");
  if (ghBox) ghBox.checked = newGh;
  if (focused) {
    const el = body.querySelector<HTMLInputElement>(`[data-keep="${focused}"]`);
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }
  body.scrollTop = scroll;
  const url = body.querySelector<HTMLInputElement>(".pj-url");
  const path = body.querySelector<HTMLInputElement>(".pj-path");
  const newName = body.querySelector<HTMLInputElement>(".pa-new-name");
  for (const el of body.querySelectorAll<HTMLInputElement>("input[type=text]")) {
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") e.stopPropagation();
      if (e.key === "Enter") {
        if (el === url) clone(url.value);
        if (el === path) addPath(path.value);
        if (el === newName) create();
      }
    });
  }
  body.querySelectorAll(".pj-log-slot").forEach((s) => s.appendChild(logView("clone", 3)));

  body.querySelector(".pa-add-btn")?.addEventListener("click", () => {
    tab = tab ? null : "local";
    if (tab && projectState.found === null) findRepos();
    render();
  });
  body.querySelectorAll<HTMLButtonElement>(".pa-tab").forEach((b) =>
    b.addEventListener("click", () => {
      tab = b.dataset.tab as AddTab;
      if (tab === "github" && projectState.account && !projectState.repos.length) requestGithubRepos();
      render();
    }),
  );
  body.querySelector(".pa-rescan")?.addEventListener("click", () => {
    findRepos(true);
    render();
  });
  body.querySelectorAll<HTMLInputElement>(".pa-search").forEach((el) =>
    el.addEventListener("input", () => {
      if (el.dataset.keep === "local") localFilter = el.value;
      else githubFilter = el.value;
      render();
    }),
  );
  body.querySelectorAll<HTMLButtonElement>(".pj-open").forEach((b) => b.addEventListener("click", () => openPath(b.dataset.path!)));
  body.querySelectorAll<HTMLButtonElement>(".pj-add").forEach((b) =>
    b.addEventListener("click", () => {
      send({ t: "repoAdd", path: b.dataset.path! });
      b.disabled = true;
      b.textContent = "Adding…";
    }),
  );
  body.querySelector(".pj-path-add")?.addEventListener("click", () => addPath(path?.value ?? ""));
  body.querySelector(".pj-pick")?.addEventListener("click", () => send({ t: "repoAdd", path: "" }));
  body.querySelector(".pa-create")?.addEventListener("click", () => create());
  body.querySelectorAll<HTMLButtonElement>(".pj-hire-here").forEach((b) => b.addEventListener("click", () => send({ t: "repoHire", path: b.dataset.path! })));
  body.querySelectorAll<HTMLButtonElement>(".pj-close-repo").forEach((b) => b.addEventListener("click", () => send({ t: "repoClose", path: b.dataset.path! })));
  body.querySelectorAll<HTMLSelectElement>(".pj-move").forEach((el) => el.addEventListener("change", () => send({ t: "workerRepo", deskId: el.dataset.desk!, repo: el.value })));
  body.querySelector(".pj-clone")?.addEventListener("click", () => clone(url?.value ?? ""));
  body.querySelector(".pj-ghtools")?.addEventListener("click", () => {
    actions?.addGithubTools?.();
    render();
  });
  bindGithub(body, render);
}

function openPath(p: string): void {
  if (!p.trim()) return;
  send({ t: "projectOpen", path: p.trim() });
}

function addPath(p: string): void {
  if (!p.trim()) return;
  send({ t: "repoAdd", path: p.trim() });
}

function clone(u: string): void {
  if (!u.trim()) return;
  send({ t: "projectClone", url: u.trim(), add: true });
}

function create(): void {
  const name = modal?.body.querySelector<HTMLInputElement>(".pa-new-name")?.value.trim() ?? "";
  if (!name) return;
  const onGithub = !!modal?.body.querySelector<HTMLInputElement>(".pa-new-gh")?.checked;
  send({ t: "repoCreate", name, ...(onGithub ? { github: true, private: true } : {}) });
  const el = modal?.body.querySelector<HTMLInputElement>(".pa-new-name");
  if (el) el.value = "";
}

/** The office is restarting on another project: a calm full-screen card while it does. */
function showSwitching(name: string, path: string): void {
  if (document.querySelector(".pj-switching")) return;
  const el = document.createElement("div");
  el.className = "pj-switching";
  el.innerHTML = `<div class="pj-sw-card">${icon("spinner", 34)}<h2>Opening ${esc(name)}…</h2><code>${esc(path)}</code><p>The office restarts in that folder. Each project keeps its own goals and progress.</p></div>`;
  document.body.appendChild(el);
  // If nothing restarts us (browser mode), don't leave the card up forever.
  setTimeout(() => el.remove(), 12_000);
}
