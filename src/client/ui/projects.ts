import type { ClientMessage, ServerMessage } from "../../shared/protocol.js";
import type { GithubAccount, GithubRepo, ProjectInfo, RecentProject } from "../../shared/project.js";
import { icon } from "./icons.js";
import { logView, openLogs } from "./logs.js";
import { esc, openModal, type Modal } from "./modal.js";
import "../styles/projects.css";

/**
 * Projects: which folder your workers work in, the ones you've opened
 * before, and starting fresh from GitHub. The Projects window shows the
 * current project (its branch, whether it's on GitHub, whether uncommitted
 * changes would hold up merges), lets you switch to a recent one or any
 * folder, sign in with GitHub through git's own sign-in, and clone a repo —
 * with the clone's progress right there.
 */

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
let filter = "";

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
      break;
    case "githubAccount":
      projectState.accountChecked = true;
      projectState.signingIn = false;
      projectState.account = msg.account;
      projectState.accountError = msg.error ?? "";
      if (msg.account && modal && !projectState.repos.length) requestRepos();
      break;
    case "githubRepos":
      projectState.reposLoading = false;
      projectState.repos = msg.repos;
      projectState.reposError = msg.error ?? "";
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
}

function requestRepos(): void {
  if (!actions || projectState.reposLoading) return;
  projectState.reposLoading = true;
  actions.send({ t: "githubRepos" });
}

/** The current project's name and branch, for the HUD ("" until we know). */
export function projectBadge(): string {
  const i = projectState.info;
  if (!i) return "";
  return `<span class="pj-badge" title="${esc(i.path)}">${icon("folder", 13)} ${esc(i.name)}${
    i.branch ? ` <span class="pj-branch">${icon("branch", 12)} ${esc(i.branch)}</span>` : ""
  }${i.github ? ` <span class="pj-gh" title="On GitHub: ${esc(i.github.owner)}/${esc(i.github.repo)}">${icon("github", 12)}</span>` : ""}</span>`;
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

/** Open the Projects window. */
export function openProjects(a: ProjectActions): void {
  actions = a;
  const body = document.createElement("div");
  body.className = "projects";
  modal = openModal({
    title: "Projects",
    icon: icon("folder", 20),
    className: "projects-modal",
    body,
    footer: `<span class="grow">Your workers open their terminals in the current project.</span><button class="btn small pj-logs">${icon("log", 14)} Logs</button>`,
    onClose: () => {
      modal = null;
    },
  });
  modal.footer?.querySelector(".pj-logs")?.addEventListener("click", () => openLogs());
  a.send({ t: "projectInfo" });
  if (projectState.account) requestRepos();
  render();
}

function render(): void {
  if (!modal || !actions) return;
  const body = modal.body;
  // Keep what you were typing.
  const urlDraft = body.querySelector<HTMLInputElement>(".pj-url")?.value ?? "";
  const pathDraft = body.querySelector<HTMLInputElement>(".pj-path")?.value ?? "";
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.keep;
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
      </section>`
    : `<section class="pj-current loading">${icon("spinner", 20)} Looking at this project…</section>`;

  const recent = projectState.recent.filter((r) => !i || !samePath(r.path, i.path));
  const recentHtml = recent.length
    ? `<ul class="pj-recent">${recent
        .map(
          (r) => `<li>
            <span class="pj-r-icon">${r.github ? icon("github", 16) : icon("folder", 16)}</span>
            <span class="pj-r-main"><b>${esc(r.name)}</b><code>${esc(r.path)}</code></span>
            <span class="pj-r-when">${ago(r.openedAt)}</span>
            <button class="btn small pj-open" data-path="${esc(r.path)}">Open</button>
          </li>`,
        )
        .join("")}</ul>`
    : `<p class="pj-note">Projects you open show up here.</p>`;

  const acct = projectState.account;
  const signIn = acct
    ? `<div class="pj-account">${acct.avatarUrl ? `<img src="${esc(acct.avatarUrl)}" alt="" />` : icon("github", 22)}<span>Signed in as <b>@${esc(acct.login)}</b></span></div>
       <p class="pj-note">${icon("check", 12)} Every worker's <code>git</code> uses this sign-in too.</p>
       ${
         actions?.addGithubTools
           ? actions.hasGithubTools?.()
             ? `<p class="pj-note">${icon("mcp", 12)} Every worker also gets GitHub's tools (issues, PRs, code search).</p>`
             : `<button class="btn small pj-ghtools">${icon("mcp", 14)} Give every worker GitHub tools</button>`
           : ""
       }`
    : `<div class="pj-signin">
        <button class="btn primary pj-signin-btn" ${projectState.signingIn ? "disabled" : ""}>${projectState.signingIn ? icon("spinner", 16) : icon("github", 16)} ${projectState.signingIn ? "Waiting for GitHub…" : "Sign in with GitHub"}</button>
        <p class="pj-note">${icon("key", 12)} Uses git's own sign-in (Git Credential Manager): a browser window opens once. domain never stores your token.${
          projectState.accountError ? ` <span class="pj-err">${esc(projectState.accountError)}</span>` : ""
        }</p>
      </div>`;

  const q = filter.toLowerCase();
  const repos = projectState.repos.filter((r) => !q || r.fullName.toLowerCase().includes(q) || r.description.toLowerCase().includes(q));
  const repoList = acct
    ? `<div class="pj-repos">
        <input type="text" class="pj-filter" data-keep="filter" placeholder="Search your repositories…" value="${esc(filter)}" />
        ${
          projectState.reposLoading
            ? `<p class="pj-note">${icon("spinner", 14)} Loading your repositories…</p>`
            : projectState.reposError
              ? `<p class="pj-err">${esc(projectState.reposError)}</p>`
              : `<ul class="pj-repo-list">${repos
                  .slice(0, 30)
                  .map(
                    (r) => `<li>
                      <span class="pj-r-icon">${icon("github", 16)}</span>
                      <span class="pj-r-main"><b>${esc(r.fullName)}</b>${r.private ? ` <span class="pj-lock">private</span>` : ""}<span class="pj-desc">${esc(r.description || "No description")}</span></span>
                      <button class="btn small pj-clone-repo" data-url="${esc(r.cloneUrl)}">${icon("clone", 14)} Clone</button>
                    </li>`,
                  )
                  .join("")}${repos.length ? "" : `<li class="pj-note">No repositories match.</li>`}</ul>`
        }
      </div>`
    : "";

  body.innerHTML = host
    ? `${current}
      <div class="pj-grid">
        <section>
          <h4>${icon("folder", 14)} Recent</h4>
          ${recentHtml}
          <h4>${icon("folder", 14)} Open a folder</h4>
          <div class="pj-row">
            <button class="btn pj-pick">Choose a folder…</button>
            <input type="text" class="pj-path" data-keep="path" placeholder="or paste a path, e.g. C:\\code\\my-app" />
            <button class="btn small pj-path-go">Open</button>
          </div>
          <p class="pj-note">Switching restarts the office in that folder.</p>
        </section>
        <section>
          <h4>${icon("github", 14)} Start from GitHub</h4>
          ${signIn}
          <div class="pj-row">
            <input type="text" class="pj-url" data-keep="url" placeholder="owner/repo or https://github.com/owner/repo" />
            <button class="btn primary pj-clone">${icon("clone", 14)} Clone</button>
          </div>
          ${repoList}
          <div class="pj-log-slot"></div>
        </section>
      </div>`
    : `${current}<p class="pj-note">You're a guest in this office: the host picks the project.</p>`;

  const url = body.querySelector<HTMLInputElement>(".pj-url");
  const path = body.querySelector<HTMLInputElement>(".pj-path");
  if (url) url.value = urlDraft;
  if (path) path.value = pathDraft;
  if (focused) {
    const el = body.querySelector<HTMLInputElement>(`[data-keep="${focused}"]`);
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }
  for (const el of body.querySelectorAll<HTMLInputElement>("input[type=text]")) {
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") e.stopPropagation();
      if (e.key === "Enter") {
        if (el === url) clone(url.value);
        if (el === path) openPath(path.value);
      }
    });
  }
  body.querySelector(".pj-log-slot")?.appendChild(logView("clone", 3));

  const send = actions.send;
  body.querySelectorAll<HTMLButtonElement>(".pj-open").forEach((b) => b.addEventListener("click", () => openPath(b.dataset.path!)));
  body.querySelector(".pj-pick")?.addEventListener("click", () => send({ t: "projectOpen", path: "" }));
  body.querySelector(".pj-path-go")?.addEventListener("click", () => openPath(path?.value ?? ""));
  body.querySelector(".pj-clone")?.addEventListener("click", () => clone(url?.value ?? ""));
  body.querySelectorAll<HTMLButtonElement>(".pj-clone-repo").forEach((b) => b.addEventListener("click", () => clone(b.dataset.url!)));
  body.querySelector(".pj-ghtools")?.addEventListener("click", () => {
    actions?.addGithubTools?.();
    render();
  });
  body.querySelector(".pj-signin-btn")?.addEventListener("click", () => {
    projectState.signingIn = true;
    projectState.accountError = "";
    send({ t: "githubSignIn" });
    render();
  });
  body.querySelector<HTMLInputElement>(".pj-filter")?.addEventListener("input", (e) => {
    filter = (e.target as HTMLInputElement).value;
    render();
  });
}

function openPath(p: string): void {
  if (!p.trim() || !actions) return;
  actions.send({ t: "projectOpen", path: p.trim() });
}

function clone(u: string): void {
  if (!u.trim() || !actions) return;
  actions.send({ t: "projectClone", url: u.trim() });
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
