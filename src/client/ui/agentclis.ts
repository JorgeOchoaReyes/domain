import { AGENT_PACKAGES, canUpdate, updateTarget } from "../../shared/agents.js";
import { AGENT_LABELS, type AgentKind, type ClientMessage } from "../../shared/protocol.js";
import { AGENT_COLOR } from "../scene/characters.js";
import { agentsState, onAgentsChange } from "./agents.js";
import { esc, openModal } from "./modal.js";

/**
 * Agent CLIs (Office menu): each one's version and the newest out, with an
 * Update button. An update waits until that agent's workers are free, then
 * pauses them, installs, and starts them again where they were. Pin a version
 * to stay on it when an update breaks something.
 */
export function openAgentClis(send: (m: ClientMessage) => void, openLogs: () => void): void {
  send({ t: "agentsCheck" });
  const body = document.createElement("div");
  body.className = "ac";
  const render = () => {
    const s = agentsState();
    if (!s) {
      body.innerHTML = `<p class="st-hint">Looking…</p>`;
      return;
    }
    const kinds = Object.keys(AGENT_PACKAGES) as AgentKind[];
    body.innerHTML = `
      <p class="ls-intro">The coding agents on this computer. An out-of-date CLI can stop working, so update when one's out — it waits until that agent's workers are free, then starts them again where they were. If an update breaks something, go back and <b>pin</b> the version that worked.</p>
      <ul class="ac-list">${kinds
        .map((k) => {
          const v = s.versions[k];
          const to = updateTarget(v);
          const have = s.installed[k];
          const queued = s.queued.includes(k);
          const status = !have
            ? "Not installed"
            : s.updating === k
              ? `⏳ Updating to ${esc(to ?? "the newest")}…`
              : queued
                ? "⏳ Updates once its workers are free"
                : !v?.current
                  ? "Installed (couldn't tell which version)"
                  : to && !canUpdate(k, v)
                    ? `On ${esc(v.current)} · <b>${esc(to)} is out</b> — update it with the installer you got it from`
                    : to
                    ? v.pinned
                      ? `On ${esc(v.current)} · 📌 pinned to ${esc(v.pinned)}`
                      : `On ${esc(v.current)} · <b>${esc(to)} is out</b>`
                    : `On ${esc(v.current)} · ${v.pinned ? "📌 pinned" : v.latest ? "up to date" : "couldn't check for updates"}`;
          const busy = !!s.installing || !!s.updating;
          const act = !have
            ? `<button class="btn small primary ac-install" ${busy || !s.npm ? "disabled" : ""}>⬇ Install</button>`
            : to && !queued && s.updating !== k && canUpdate(k, v)
              ? `<button class="btn small primary ac-update" ${!s.npm && v?.via === "npm" ? "disabled" : ""}>⬆ ${v?.pinned ? "Go to" : "Update to"} ${esc(to)}</button>`
              : "";
          const pin = have && v?.current && v.via === "npm"
            ? v.pinned
              ? `<button class="btn small ac-unpin" title="Follow the newest version again">Unpin</button>`
              : `<button class="btn small ac-pin" title="Stay on ${esc(v.current)}: updates won't move it">📌 Keep ${esc(v.current)}</button>`
            : "";
          return `<li data-agent="${k}"><span class="dot" style="background:${AGENT_COLOR[k]}"></span><b>${AGENT_LABELS[k]}</b>
            <span class="ac-status">${status}</span>${act}${pin}</li>`;
        })
        .join("")}</ul>
      <p class="st-hint">${s.npm ? `Checked ${s.checkedAt ? new Date(s.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "just now"} · npm's output is in <a href="#" class="ac-logs">Logs</a>.` : "Updating needs npm — install Node.js from nodejs.org."}</p>`;
    body.querySelectorAll<HTMLElement>(".ac-list li").forEach((li) => {
      const agent = li.dataset.agent as AgentKind;
      li.querySelector(".ac-install")?.addEventListener("click", () => send({ t: "agentInstall", agent }));
      li.querySelector(".ac-update")?.addEventListener("click", () => send({ t: "agentUpdate", agent }));
      li.querySelector(".ac-pin")?.addEventListener("click", () => send({ t: "agentPin", agent, version: agentsState()?.versions[agent]?.current ?? null }));
      li.querySelector(".ac-unpin")?.addEventListener("click", () => send({ t: "agentPin", agent, version: null }));
    });
    body.querySelector(".ac-logs")?.addEventListener("click", (e) => {
      e.preventDefault();
      modal.close();
      openLogs();
    });
  };
  const footer = document.createElement("div");
  footer.style.display = "contents";
  footer.innerHTML = `<span class="grow"></span><button class="btn ac-check">↻ Check now</button>`;
  footer.querySelector(".ac-check")!.addEventListener("click", () => send({ t: "agentsCheck" }));
  const stop = onAgentsChange(render);
  const modal = openModal({ title: "Agent CLIs", icon: "⬆", className: "ac-modal", body, footer, onClose: stop });
  render();
}
