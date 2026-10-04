import type { ClientMessage, ServerMessage } from "../../shared/protocol.js";
import type { GithubIssue, PullRequestInfo } from "../../shared/project.js";
import { icon } from "./icons.js";
import { logView } from "./logs.js";
import { esc, openModal, type Modal } from "./modal.js";
import "../styles/projects.css";

/**
 * GitHub in the Goals window: a chip for a goal's pull request (its number,
 * its checks, a link), and a dialog that turns open issues into tasks.
 */

const CHECKS: Record<PullRequestInfo["checks"], [string, string]> = {
  pending: ["checks running", "pending"],
  success: ["checks pass", "success"],
  failure: ["checks failing", "failure"],
  none: ["no checks", "none"],
};

/** A goal's pull request as a small link chip. */
export function prChipHtml(pr: PullRequestInfo): string {
  const [label, cls] = pr.state === "merged" ? ["merged", "merged"] : pr.state === "closed" ? ["closed", "closed"] : CHECKS[pr.checks];
  const status = pr.state === "open" && pr.checks === "pending" ? icon("spinner", 12) : pr.state === "merged" ? icon("merge", 12) : pr.checks === "failure" ? icon("x", 12) : icon("check", 12);
  return `<a class="pr-chip ${cls}" href="${esc(pr.url)}" target="_blank" rel="noopener" title="${esc(pr.title)}">${icon("pr", 14)} #${pr.number} · ${status} ${label}</a>`;
}

let dialog: { modal: Modal; goalId: string | null; send: (m: ClientMessage) => void } | null = null;
let issues: GithubIssue[] | null = null;
let issuesError = "";

/** Feed every server message through here. */
export function ingestGithub(msg: ServerMessage): void {
  if (msg.t !== "githubIssues") return;
  issues = msg.issues;
  issuesError = msg.error ?? "";
  renderIssues();
}

/** Pick open issues to add as tasks (to a goal, or a new "GitHub issues" goal). */
export function openIssuesImport(goalId: string | null, send: (m: ClientMessage) => void): void {
  issues = null;
  issuesError = "";
  const body = document.createElement("div");
  body.className = "gh-issues";
  const footer = document.createElement("div");
  footer.style.display = "contents";
  footer.innerHTML = `<span class="grow">Each one becomes a task: “#123 Its title”.</span><button class="btn primary gh-add" disabled>Add as tasks</button>`;
  const modal = openModal({
    title: "Import GitHub issues",
    icon: icon("github", 20),
    className: "gh-issues-modal",
    body,
    footer,
    onClose: () => {
      dialog = null;
    },
  });
  dialog = { modal, goalId, send };
  footer.querySelector(".gh-add")!.addEventListener("click", () => {
    const picked = [...body.querySelectorAll<HTMLInputElement>("input[data-n]:checked")].map((c) => Number(c.dataset.n));
    if (!picked.length) return;
    send({ t: "issuesImport", goalId, numbers: picked });
    modal.close();
  });
  send({ t: "githubIssues" });
  renderIssues();
}

function renderIssues(): void {
  if (!dialog) return;
  const body = dialog.modal.body;
  const add = dialog.modal.footer!.querySelector<HTMLButtonElement>(".gh-add")!;
  if (issues === null && !issuesError) {
    body.innerHTML = `<p class="pj-note">${icon("spinner", 14)} Reading open issues…</p>`;
  } else if (issuesError) {
    body.innerHTML = `<p class="pj-err">${esc(issuesError)}</p>`;
    body.appendChild(logView("github", 3));
  } else if (!issues!.length) {
    body.innerHTML = `<p class="pj-note">${icon("check", 14)} No open issues. Nice.</p>`;
  } else {
    body.innerHTML = `<label class="check gh-all"><input type="checkbox" /> <b>All ${issues!.length}</b></label>
      <ul class="gh-list">${issues!
        .map(
          (i) => `<li><label class="check">
            <input type="checkbox" data-n="${i.number}" />
            <span class="gh-i-icon">${icon("issue", 14)}</span>
            <span class="gh-i-main"><b>#${i.number} ${esc(i.title)}</b>${i.labels.length ? `<span class="gh-labels">${i.labels.map((l) => `<span>${esc(l)}</span>`).join("")}</span>` : ""}</span>
            <a href="${esc(i.url)}" target="_blank" rel="noopener" title="Open on GitHub">${icon("link", 12)}</a>
          </label></li>`,
        )
        .join("")}</ul>`;
    const boxes = [...body.querySelectorAll<HTMLInputElement>("input[data-n]")];
    const all = body.querySelector<HTMLInputElement>(".gh-all input")!;
    const sync = () => {
      const n = boxes.filter((b) => b.checked).length;
      add.disabled = n === 0;
      add.textContent = n ? `Add ${n} as task${n === 1 ? "" : "s"}` : "Add as tasks";
      all.checked = n === boxes.length;
    };
    all.addEventListener("change", () => {
      boxes.forEach((b) => (b.checked = all.checked));
      sync();
    });
    boxes.forEach((b) => b.addEventListener("change", sync));
    sync();
  }
}
