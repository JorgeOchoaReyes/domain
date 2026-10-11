import { AGENT_KINDS, AGENT_LABELS, type AgentKind, type ClientMessage } from "../../shared/protocol.js";
import { AGENT_CONTEXT, SLOW_TPS } from "../../shared/localModels.js";
import {
  GREEN_MAX_LINES,
  MAX_START_TEAM,
  LEASH_ICON,
  LEASH_LABEL,
  LEASH_RULES,
  ON_TIME_UP_LABEL,
  TIME_BUDGETS,
  isModelName,
  modelLabel,
  type GateMode,
  type Leash,
  type MergeMode,
  type OnTimeUp,
  type TeamPolicy,
} from "../../shared/policy.js";
import type { PrPer } from "../../shared/project.js";
import { loopState } from "./loop.js";
import { AGENT_COLOR } from "../scene/characters.js";
import { esc, openModal } from "./modal.js";

/**
 * The team policy: the defaults every hire and every task starts from. Which
 * models each agent offers and starts on, how much rope a new hire gets, the
 * usual time budget and what happens when it runs out, whether tasks start
 * with a plan, and the standard definition of done. Shared by everyone in the
 * office and saved with your progress. (It can also be seeded from `"team"`
 * in domain.config.json.)
 */
export function openPolicy(policy: TeamPolicy, onSave: (p: TeamPolicy) => void, send?: (m: ClientMessage) => void): void {
  const p: TeamPolicy = structuredClone(policy);
  const body = document.createElement("div");
  body.className = "policy";
  body.innerHTML = `
    <section class="po-fast">
      <h4>⚡ Speed</h4>
      <label class="as-check"><input type="checkbox" class="po-keep-busy" ${p.autopilot.keepBusy ? "checked" : ""} />
        <span><b>Keep workers busy</b> — even with autopilot off, a worker that finishes picks up the next task of the goal you chose at the stand-up, instead of waiting for you</span></label>
      <label class="as-check"><input type="checkbox" class="po-green" ${p.autopilot.approveGreen ? "checked" : ""} />
        <span><b>Approve on green</b> — small work (up to ${GREEN_MAX_LINES} lines) whose checks passed merges without waiting for you; you hear about it. Needs a check command, so “green” means your tests passed</span></label>
      <label class="as-check po-start"><span><b>Starting team</b> — when the office opens, last time's workers wake and new ones are hired until there are</span>
        <select class="po-start-n">${Array.from({ length: MAX_START_TEAM + 1 }, (_, n) => `<option value="${n}" ${n === p.startTeam.count ? "selected" : ""}>${n === 0 ? "none" : n}</option>`).join("")}</select>
        <select class="po-start-agent">${AGENT_KINDS.map((k) => `<option value="${k}" ${k === p.startTeam.agent ? "selected" : ""}>${esc(AGENT_LABELS[k])}</option>`).join("")}</select>
        <span class="as-hint">ready by the time the stand-up's done</span></label>
    </section>
    <section class="po-auto">
      <h4>🤖 Autopilot</h4>
      <label class="as-check"><input type="checkbox" class="po-auto-on" ${p.autopilot.on ? "checked" : ""} />
        <span><b>Run the office for me</b> — goals get planned, free workers pick up the next tasks (deadlines first) with a teammate auditing, and when a goal's tasks are all done its lead pulls it together and presents the whole. You get questions, plans, and the finished result.</span></label>
      <label class="as-check"><input type="checkbox" class="po-auto-approve" ${p.autopilot.approveAudited ? "checked" : ""} />
        <span><b>Approve audited work</b> — work whose checks passed and whose auditor approved it doesn't wait for you</span></label>
      <label class="as-check"><input type="checkbox" class="po-auto-interns" ${p.autopilot.interns ? "checked" : ""} />
        <span><b>🎓 Workers may bring in interns</b> — for the independent pieces of a task (up to three at a time, at the intern bay); they review their interns' work, and interns go home when there's nothing left</span></label>
      <label class="as-check po-eod"><span><b>🌙 End-of-day sync at</b></span> <input type="time" class="po-auto-eod" value="${esc(p.autopilot.eodAt)}" /> <span class="as-hint">everyone writes up what they learned; one merges it into the team's lessons</span></label>
    </section>
    <section>
      <h4>Models</h4>
      <p class="as-note">The models offered when you hire or hand out a task — names your CLI accepts for <code>--model</code>, comma-separated. A new hire starts on the default.</p>
      <div class="po-agents">
        ${AGENT_KINDS.map(
          (k) => `<div class="po-agent" data-agent="${k}">
            <span class="po-name"><span class="dot" style="background:${AGENT_COLOR[k]}"></span>${esc(AGENT_LABELS[k])}</span>
            <input type="text" class="po-models" placeholder="${k === "claude" ? "opus, sonnet, haiku" : "e.g. a model name your CLI takes"}" value="${esc(p.models[k].filter(Boolean).join(", "))}" />
            <select class="po-default"></select>
          </div>`,
        ).join("")}
      </div>
      ${localModelsHtml(!!send)}
      <p class="as-note po-error"></p>
    </section>
    <section>
      <h4>New hires</h4>
      <div class="seg po-leash">${(Object.keys(LEASH_LABEL) as Leash[]).map((l) => `<button data-l="${l}" title="${esc(LEASH_RULES[l])}">${LEASH_ICON[l]} ${esc(LEASH_LABEL[l])}</button>`).join("")}</div>
      <p class="as-note">“Go ahead” starts Claude Code with <code>--permission-mode acceptEdits</code>, Codex with <code>--sandbox workspace-write --ask-for-approval on-request</code> and Gemini CLI with <code>--approval-mode auto_edit</code>; OpenCode keeps its own prompts.</p>
    </section>
    <section>
      <h4>Tasks</h4>
      <div class="seg po-time">${TIME_BUDGETS.map((m) => `<button data-m="${m}">${m ? `${m} min` : "No limit"}</button>`).join("")}</div>
      <div class="seg po-timeup">${(Object.keys(ON_TIME_UP_LABEL) as OnTimeUp[]).map((u) => `<button data-u="${u}">When time's up: ${esc(ON_TIME_UP_LABEL[u])}</button>`).join("")}</div>
      <label class="as-check"><input type="checkbox" class="po-plan" ${p.planFirst ? "checked" : ""} /> <span><b>🧠 Plan first</b> by default</span></label>
      <h4>Done means</h4>
      <textarea class="po-done" rows="4">${esc(p.done.join("\n"))}</textarea>
    </section>
    <section>
      <h4>Branches & checks</h4>
      <label class="as-check"><input type="checkbox" class="po-isolate" ${p.isolate ? "checked" : ""} />
        <span><b>🌿 Own branch per worker</b> — each new hire works in its own git worktree, so parallel workers never touch the same files${gitNote()}</span></label>
      <div class="seg po-merge">
        <button data-g="auto">✅ Approving merges its branch into ${esc(loopState.config?.git?.base ?? "your branch")}</button>
        <button data-g="manual">✋ Leave it on its branch (merge yourself)</button>
      </div>
      <p class="as-note">Before review, finished work runs your check: ${checkNote()}</p>
      <div class="seg po-gate">
        <button data-k="fix">🔁 Failed check: send it back to fix (up to 2 tries)</button>
        <button data-k="show">👀 Failed check: show it in the review</button>
      </div>
      <div class="seg po-prper">
        <button data-r="goal" title="Your branch is pushed as domain/&lt;goal&gt; and one pull request opens for the whole goal">🔀 Ship to GitHub: one pull request per goal</button>
        <button data-r="agent" title="Each agent's own branch is pushed as it is and gets its own pull request, listing the tasks it did">🔀 Ship to GitHub: one pull request per agent</button>
      </div>
    </section>`;
  const footer = document.createElement("div");
  footer.style.display = "contents";
  footer.innerHTML = `<span class="grow">Shared with everyone in the office · new hires and new assignments use it</span><button class="btn primary save">Save team policy</button>`;
  const modal = openModal({ title: "Team policy", icon: "🛠", className: "policy-modal", body, footer });

  for (const el of body.querySelectorAll<HTMLElement>("input[type=text], textarea")) {
    el.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key !== "Escape") e.stopPropagation();
    });
  }

  const parseModels = (row: HTMLElement): string[] =>
    (row.querySelector<HTMLInputElement>(".po-models")!.value || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  const renderDefaults = () => {
    body.querySelectorAll<HTMLElement>(".po-agent").forEach((row) => {
      const k = row.dataset.agent as AgentKind;
      const list = ["", ...parseModels(row).filter(isModelName)];
      if (!list.includes(p.defaultModel[k])) p.defaultModel[k] = "";
      row.querySelector<HTMLSelectElement>(".po-default")!.innerHTML = list
        .map((m) => `<option value="${esc(m)}" ${m === p.defaultModel[k] ? "selected" : ""}>Starts on: ${esc(modelLabel(m))}</option>`)
        .join("");
    });
  };
  body.querySelectorAll<HTMLElement>(".po-agent").forEach((row) => {
    row.querySelector(".po-models")!.addEventListener("input", renderDefaults);
    row.querySelector<HTMLSelectElement>(".po-default")!.addEventListener("change", (e) => {
      p.defaultModel[row.dataset.agent as AgentKind] = (e.target as HTMLSelectElement).value;
    });
  });
  const seg = (sel: string, key: string, get: () => string, set: (v: string) => void) => {
    const render = () => body.querySelectorAll<HTMLElement>(`${sel} button`).forEach((b) => b.classList.toggle("on", b.dataset[key] === get()));
    body.querySelectorAll<HTMLElement>(`${sel} button`).forEach((b) =>
      b.addEventListener("click", () => {
        set(b.dataset[key]!);
        render();
      }),
    );
    render();
  };
  seg(".po-leash", "l", () => p.leash, (v) => (p.leash = v as Leash));
  seg(".po-time", "m", () => String(p.minutes), (v) => (p.minutes = Number(v)));
  seg(".po-timeup", "u", () => p.onTimeUp, (v) => (p.onTimeUp = v as OnTimeUp));
  body.querySelector<HTMLInputElement>(".po-plan")!.addEventListener("change", (e) => (p.planFirst = (e.target as HTMLInputElement).checked));
  body.querySelector<HTMLInputElement>(".po-isolate")!.addEventListener("change", (e) => (p.isolate = (e.target as HTMLInputElement).checked));
  seg(".po-merge", "g", () => p.merge, (v) => (p.merge = v as MergeMode));
  seg(".po-gate", "k", () => p.gate, (v) => (p.gate = v as GateMode));
  seg(".po-prper", "r", () => p.prPer ?? "goal", (v) => (p.prPer = v as PrPer));
  renderDefaults();
  // One click puts a local model on Codex's list (and OpenCode's, if it's set up for that provider);
  // an Ollama model on Claude Code's too (it runs through Ollama's Anthropic-compatible API).
  // A copy of an Ollama model with an agent-sized context window.
  body.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((b) =>
    b.addEventListener("click", () => {
      send?.({ t: "localCopy", model: b.dataset.copy!, ctx: AGENT_CONTEXT });
      b.disabled = true;
      b.textContent = "⏳ Making it…";
    }),
  );
  body.querySelectorAll<HTMLButtonElement>("[data-local]").forEach((b) =>
    b.addEventListener("click", () => {
      const model = b.dataset.local!;
      for (const k of (model.startsWith("ollama/") ? ["claude", "codex", "opencode"] : ["codex", "opencode"]) as AgentKind[]) {
        const input = body.querySelector<HTMLInputElement>(`.po-agent[data-agent="${k}"] .po-models`)!;
        const list = input.value.split(",").map((x) => x.trim()).filter(Boolean);
        if (!list.includes(model)) input.value = [...list, model].join(", ");
      }
      b.classList.add("on");
      renderDefaults();
    }),
  );

  footer.querySelector(".save")!.addEventListener("click", () => {
    const bad: string[] = [];
    body.querySelectorAll<HTMLElement>(".po-agent").forEach((row) => {
      const k = row.dataset.agent as AgentKind;
      const list = parseModels(row);
      bad.push(...list.filter((m) => !isModelName(m)));
      p.models[k] = ["", ...list.filter(isModelName)];
    });
    if (bad.length) {
      body.querySelector(".po-error")!.textContent = `Not a model name: ${bad.join(", ")} — letters, digits and . _ : / - only`;
      return;
    }
    const done = body.querySelector<HTMLTextAreaElement>(".po-done")!.value.split("\n").map((x) => x.trim()).filter(Boolean);
    if (done.length) p.done = done;
    p.autopilot = {
      on: body.querySelector<HTMLInputElement>(".po-auto-on")!.checked,
      approveAudited: body.querySelector<HTMLInputElement>(".po-auto-approve")!.checked,
      interns: body.querySelector<HTMLInputElement>(".po-auto-interns")!.checked,
      eodAt: body.querySelector<HTMLInputElement>(".po-auto-eod")!.value,
      keepBusy: body.querySelector<HTMLInputElement>(".po-keep-busy")!.checked,
      approveGreen: body.querySelector<HTMLInputElement>(".po-green")!.checked,
    };
    p.startTeam = {
      agent: body.querySelector<HTMLSelectElement>(".po-start-agent")!.value as AgentKind,
      count: Number(body.querySelector<HTMLSelectElement>(".po-start-n")!.value),
    };
    modal.close();
    onSave(p);
  });
}

function gitNote(): string {
  const c = loopState.config;
  if (!c) return "";
  if (c.simulate) return " <i>(simulated workers share the project folder)</i>";
  return c.git ? "" : " <i>(needs the project to be a git repo with a commit)</i>";
}

function checkNote(): string {
  const cmd = loopState.config?.check;
  return cmd ? `<code>${esc(cmd)}</code>` : `none set — add <code>"check": "npm test"</code> to domain.config.json`;
}

/** One local model: offer it, its context window (with a bigger copy when it's too small), its speed here. */
function localRow(m: string, canCopy: boolean): string {
  const i = loopState.localInfo[m];
  const k = (n: number) => `${Math.round(n / 1024)}K`;
  const ollama = m.startsWith("ollama/");
  const small = ollama && (!i?.ctx || i.ctx < AGENT_CONTEXT);
  const ctx = !ollama ? "" : i?.ctx ? `${k(i.ctx)} context${i.max ? ` (up to ${k(i.max)})` : ""}` : "Ollama's default context — too small for an agent";
  const speed = i?.tps ? ` · ${Math.round(i.tps)} tokens/s here${i.tps < SLOW_TPS ? " (slow: small tasks only)" : ""}` : "";
  const copy = small && (!i?.max || i.max >= AGENT_CONTEXT) && canCopy ? `<button class="btn small" data-copy="${esc(m)}" title="Same model, nothing downloaded — it just runs with a bigger window (and uses more memory)">⤢ Make a ${k(AGENT_CONTEXT)} copy</button>` : "";
  return `<li><button class="btn chip" data-local="${esc(m)}">${esc(m)}</button><span class="as-note ${small ? "po-warn" : ""}">${esc(ctx)}${esc(speed)}</span>${copy}</li>`;
}

/** Models served on this machine, offered with one click. */
function localModelsHtml(canCopy: boolean): string {
  const local = loopState.config?.localModels ?? [];
  if (!local.length) {
    return `<p class="as-note">🖥 Local models: none found. Start <b>Ollama</b> or <b>LM Studio</b> and reopen this to add their models.</p>`;
  }
  return `<div class="po-local"><span class="as-note">🖥 On this machine — click to offer to Codex and OpenCode (and Ollama's to Claude Code):</span>
    <ul class="po-local-list">${local.map((m) => localRow(m, canCopy)).join("")}</ul>
    <p class="as-note">Codex runs these with <code>--oss --local-provider</code>; Claude Code runs Ollama's through its Anthropic-compatible API (Ollama 0.14 or newer). OpenCode needs that provider in its own config.</p></div>`;
}
