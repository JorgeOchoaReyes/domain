import { alumnusHtml, formerWorkers, onAlumniChange } from "./fire.js";
import { onSkillsChange, skillsLine, skillsOf } from "./skills.js";
import { mcpToolsFor, onMcpChange } from "./mcp.js";
import * as THREE from "three";
import { OutlineEffect } from "three/examples/jsm/effects/OutlineEffect.js";
import type { AgentKind, Desk, Worker } from "../../shared/protocol.js";
import { AGENT_KINDS, AGENT_LABELS } from "../../shared/protocol.js";
import type { ProgressState } from "../../shared/progress.js";
import { LEASH_ICON, LEASH_LABEL, LEASH_RULES, modelLabel, type Leash } from "../../shared/policy.js";
import {
  ACCESSORIES,
  BOT_COLORS,
  FACES,
  HATS,
  MAX_PERSONA,
  MAX_TEAM,
  coerceCharacter,
  defaultLook,
  type Accessory,
  type Character,
  type CharacterLook,
  type Face,
  type Hat,
} from "../../shared/team.js";
import { AGENT_COLOR, Bot } from "../scene/characters.js";
import { listVoices, speak, stopSpeaking } from "../voice.js";
import { esc, openModal } from "./modal.js";
import { agentsState, installAgent, isInstalled, onAgentsChange } from "./agents.js";
import { ROLES, roleCharacter, type Role } from "../../shared/roles.js";
import { isLocalModel, modelChoices } from "../../shared/localModels.js";
import { loopState } from "./loop.js";
import "../styles/team.css";

/**
 * Your team: workers with names, faces and personalities you set up once and
 * hire again and again. The hire window shows your characters first (one
 * click to put one at the desk) with a quick plain hire below; the character
 * editor sets the name, agent, model, leash, standing instructions (persona),
 * voice and look, with a live 3D preview.
 */

// --- names ----------------------------------------------------------------------

/** What to call a worker: its character's name, or its agent's. */
export function workerName(w: Pick<Worker, "agent" | "identity">): string {
  return w.identity?.name ?? AGENT_LABELS[w.agent];
}

const NAMES = [
  "Ada", "Linus", "Grace", "Pixel", "Bolt", "Nova", "Ziggy", "Mochi", "Rex", "Juno", "Sprocket", "Byte",
  "Echo", "Kiwi", "Atlas", "Zola", "Turing", "Hopper", "Lovelace", "Fizz", "Biscuit", "Comet", "Pixel", "Orbit",
];
function randomName(taken: Set<string>): string {
  const free = NAMES.filter((n) => !taken.has(n.toLowerCase()));
  const pool = free.length ? free : NAMES;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** The agent a role runs on here: its own if that CLI's installed, else the first one that is. */
function roleAgent(role: Role): AgentKind {
  return isInstalled(role.agent) ? role.agent : (AGENT_KINDS.find((k) => isInstalled(k)) ?? role.agent);
}

/** The ready-made agents, as cards: hire one (or add it to the team) in a click. */
function rolesHtml(hiring: boolean): string {
  return `<section class="tm-roles">
    <h4>🧩 Ready-made agents <span class="tm-sub">detailed working methods for the usual jobs — ${hiring ? "hire one in a click" : "add one to your team"}, edit it after</span></h4>
    <ul class="tm-role-list">${ROLES.map(
      (r) => `<li class="tm-role" data-role="${r.id}" title="${esc(r.persona)}">
        <span class="tm-role-icon" style="background:${r.look.color}">${r.icon}</span>
        <span class="tm-role-main"><b>${esc(r.title)}</b><small>${esc(r.blurb)}</small></span>
        <button class="btn small ${hiring ? "primary" : ""} tm-role-go">${hiring ? "Hire" : "＋ Add"}</button>
      </li>`,
    ).join("")}</ul>
  </section>`;
}

const FACE_LABEL: Record<Face, string> = { smile: "🙂 Smile", grin: "😁 Grin", cool: "😎 Cool", sleepy: "😴 Sleepy", wink: "😉 Wink", focused: "🧐 Focused" };
const HAT_LABEL: Record<Hat, string> = {
  none: "None",
  headset: "🎧 Headset",
  cap: "🧢 Cap",
  beanie: "🧶 Beanie",
  crown: "👑 Crown",
  party: "🥳 Party",
  wizard: "🧙 Wizard",
  headphones: "🎵 Headphones",
};
const ACC_LABEL: Record<Accessory, string> = { none: "None", glasses: "👓 Glasses", bowtie: "🎀 Bow tie", scarf: "🧣 Scarf", badge: "⭐ Badge", mustache: "🥸 Mustache" };

// --- portraits ----------------------------------------------------------------------

const portraits = new Map<string, string>();
let shot: { renderer: THREE.WebGLRenderer; effect: OutlineEffect; scene: THREE.Scene; camera: THREE.PerspectiveCamera } | null = null;

function portraitRig() {
  if (shot) return shot;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 192;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(192, 192, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const effect = new OutlineEffect(renderer, { defaultThickness: 0.006, defaultColor: [0.17, 0.18, 0.26] });
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight("#fff5e6", "#c9a27a", 1.7));
  const sun = new THREE.DirectionalLight("#fff1d6", 1.4);
  sun.position.set(2, 4, 5);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  camera.position.set(0.35, 0.95, 2.6);
  camera.lookAt(0, 0.72, 0);
  shot = { renderer, effect, scene, camera };
  return shot;
}

/** A head-and-shoulders picture of a bot with this look (a data URL, cached per look). */
export function portrait(look: CharacterLook | null, agent: AgentKind): string {
  const key = Bot.keyFor(agent, look);
  const hit = portraits.get(key);
  if (hit) return hit;
  let url = "";
  try {
    const r = portraitRig();
    const bot = new Bot(agent, look);
    bot.root.rotation.y = -0.35;
    bot.update(0, { seated: false, walking: false, status: "idle" });
    r.scene.add(bot.root);
    r.effect.render(r.scene, r.camera);
    url = r.renderer.domElement.toDataURL("image/png");
    r.scene.remove(bot.root);
    bot.dispose();
  } catch {
    url = "";
  }
  portraits.set(key, url);
  return url;
}

function avatarHtml(look: CharacterLook | null, agent: AgentKind, size = 64): string {
  const src = portrait(look, agent);
  return src
    ? `<img class="tm-face" src="${src}" width="${size}" height="${size}" alt="" />`
    : `<span class="tm-face tm-dot" style="width:${size}px;height:${size}px;background:${look?.color ?? AGENT_COLOR[agent]}"></span>`;
}

// --- the windows -----------------------------------------------------------------------

export interface TeamContext {
  /** Ask for a fresh look at the agents' MCP settings (to show each one's tools). */
  scanMcp?(): void;
  /** Ask which skills each agent has. */
  getSkills?(): void;
  progress: ProgressState;
  desks: Desk[];
  /** Save a new or changed character. */
  onSave(c: Character): void;
  onDelete(id: string): void;
  onEditPolicy(): void;
}

export interface HireContext extends TeamContext {
  /** Put a character (by id), or a plain agent, at the desk. */
  onHire(choice: string | { agent: AgentKind; model: string; leash: Leash }): void;
  /** Bring a former worker back to the desk. */
  onRehire?(id: string): void;
  getAlumni?(): void;
}

/** Characters as you see them now: the saved team plus anything just saved here. */
function teamOf(ctx: TeamContext, local: Map<string, Character | null>): Character[] {
  const out = new Map(ctx.progress.team.map((c) => [c.id, c]));
  for (const [id, c] of local) {
    if (c) out.set(id, c);
    else out.delete(id);
  }
  return [...out.values()];
}

/** Which desk a character is working at, if any. */
function deskOf(desks: Desk[], id: string): Desk | undefined {
  return desks.find((d) => d.worker?.identity?.characterId === id);
}

function cardHtml(c: Character, desks: Desk[], hiring: boolean, policy: ProgressState["policy"]): string {
  const at = deskOf(desks, c.id);
  const model = c.model || policy.defaultModel[c.agent];
  return `<li class="tm-card" data-id="${esc(c.id)}">
    ${avatarHtml(c.look, c.agent)}
    <div class="tm-main">
      <div class="tm-name">${esc(c.name)}</div>
      <div class="tm-meta"><span class="dot" style="background:${AGENT_COLOR[c.agent]}"></span>${esc(AGENT_LABELS[c.agent])} · ${esc(modelLabel(model))} · ${LEASH_ICON[c.leash]} ${esc(LEASH_LABEL[c.leash].toLowerCase())}</div>
      ${c.persona ? `<div class="tm-persona">“${esc(c.persona.length > 90 ? c.persona.slice(0, 88) + "…" : c.persona)}”</div>` : ""}
      <div class="tm-stats">${c.hires ? `Hired ${c.hires}×` : "Never hired yet"}${at ? ` · <b>at ${esc(at.label)}</b>` : ""}</div>
    </div>
    <div class="tm-actions">
      ${hiring ? `<button class="btn primary tm-hire" ${at ? "disabled title='Already at a desk'" : ""}>${at ? "Working" : "Hire"}</button>` : ""}
      <button class="btn small tm-edit" title="Edit">✏️</button>
      <button class="btn small tm-del" title="Remove from the team">🗑</button>
    </div>
  </li>`;
}

/**
 * The hire window for a free desk: your characters first (one click), a quick
 * plain hire below, and a button to make a new character.
 */
export function openHire(desk: { id: string; label: string }, ctx: HireContext): void {
  openRoster(ctx, desk);
}

/** Manage your team outside of hiring. */
export function openTeam(ctx: TeamContext & Partial<Pick<HireContext, "onHire">>): void {
  openRoster(ctx, null);
}

function openRoster(ctx: TeamContext & Partial<Pick<HireContext, "onHire">>, desk: { id: string; label: string } | null, local = new Map<string, Character | null>()): void {
  const hiring = desk !== null && !!ctx.onHire;
  const team = teamOf(ctx, local);
  const policy = ctx.progress.policy;
  let leash: Leash = policy.leash;
  const body = document.createElement("div");
  body.className = "team";
  body.innerHTML = `
    <section>
      <div class="tm-head"><h4>👥 Your team <span class="tm-count">${team.length}/${MAX_TEAM}</span></h4>
        <button class="btn primary tm-new" ${team.length >= MAX_TEAM ? "disabled" : ""}>＋ New character</button></div>
      ${
        team.length
          ? `<ul class="tm-list">${team.map((c) => cardHtml(c, ctx.desks, hiring, policy)).join("")}</ul>`
          : `<div class="tm-empty">${avatarHtml(null, "claude", 72)}<div><b>No characters yet.</b><br/>Pick a ready-made agent below, or give a worker a name, a face and a way of working — it remembers who it is every time you hire it.</div></div>`
      }
    </section>
    ${rolesHtml(hiring)}
    ${
      hiring
        ? `<section class="tm-quick">
      <h4>⚡ Quick hire <span class="tm-sub">a plain worker, no character</span></h4>
      <div class="seg tm-leash">${(Object.keys(LEASH_LABEL) as Leash[]).map((l) => `<button data-l="${l}" title="${esc(LEASH_RULES[l])}">${LEASH_ICON[l]} ${esc(LEASH_LABEL[l])}</button>`).join("")}</div>
      <ul class="tm-agents">${AGENT_KINDS.map((k) => {
        const models = modelChoices(k, policy.models[k], loopState.config?.localModels ?? [], [policy.defaultModel[k]]);
        return `<li data-agent="${k}"><span class="dot" style="background:${AGENT_COLOR[k]}"></span><b>${AGENT_LABELS[k]}</b>
          <select class="tm-model" title="Model — the ones on this computer (🖥) are free and private">${models.map((m) => `<option value="${esc(m)}" ${m === policy.defaultModel[k] ? "selected" : ""}>${esc(modelLabel(m))}${isLocalModel(m) ? " · free, private" : ""}</option>`).join("")}</select>
          <button class="btn small tm-quick-hire">Hire</button>
          <span class="tm-tools" data-agent="${k}"></span><span class="tm-skills" data-agent="${k}"></span>
          <button class="btn small primary tm-install" title="Install it with npm">⬇ Install</button></li>`;
      }).join("")}</ul>
    </section>
    <section class="tm-former"></section>`
        : ""
    }`;
  const footer = document.createElement("div");
  footer.style.display = "contents";
  footer.innerHTML = `<button class="btn tm-policy">🛠 Team defaults</button><span class="grow">${hiring ? "It runs in a real terminal on this machine, in your project folder" : "Characters keep their name, look, model and instructions every time you hire them"}</span>`;
  // A CLI that isn't installed gets an Install button instead of Hire (and says why).
  const showInstalled = () => {
    const s = agentsState();
    body.querySelectorAll<HTMLElement>(".tm-agents li").forEach((li) => {
      const k = li.dataset.agent as AgentKind;
      const have = isInstalled(k);
      const busy = s?.installing === k;
      li.classList.toggle("missing", !have);
      li.querySelector<HTMLElement>(".tm-quick-hire")!.hidden = !have;
      li.querySelector<HTMLSelectElement>(".tm-model")!.hidden = !have;
      const inst = li.querySelector<HTMLButtonElement>(".tm-install")!;
      inst.hidden = have;
      inst.disabled = !!s?.installing || s?.npm === false;
      inst.textContent = busy ? "Installing…" : s?.npm === false ? "Needs Node.js" : "⬇ Install";
      inst.title = s?.npm === false ? "Install Node.js from nodejs.org first (it brings npm)" : "Install it with npm — the output's in Logs";
    });
  };
  // Each agent's MCP tools (from its own config and the office's), so you know what it can use.
  const showTools = () =>
    body.querySelectorAll<HTMLElement>(".tm-tools").forEach((el) => {
      const tools = mcpToolsFor(el.dataset.agent!, ctx.progress.mcp);
      el.textContent = tools.length ? `🧰 ${tools.join(", ")}` : "🧰 no MCP tools";
      el.title = tools.length ? "MCP servers it starts with — its own config plus the office's (Office → MCP tools)" : "Add some in Office → MCP tools";
    });
  const showSkills = () =>
    body.querySelectorAll<HTMLElement>(".tm-skills").forEach((el) => {
      const l = skillsLine(skillsOf(el.dataset.agent!).map((s) => s.name));
      el.textContent = l.text;
      el.title = l.title;
    });
  const stopSkills = onSkillsChange(showSkills);
  // Former workers: everyone you let go, to bring back here.
  const showFormer = () => {
    const el = body.querySelector<HTMLElement>(".tm-former");
    if (!el) return;
    const list = formerWorkers();
    el.innerHTML = list.length ? `<h4>↩ Former workers <span class="tm-sub">bring one back to this desk</span></h4><ul class="fw-list">${list.map(alumnusHtml).join("")}</ul>` : "";
    el.querySelectorAll<HTMLElement>(".fw-row").forEach((row) =>
      row.querySelector(".fw-back")!.addEventListener("click", () => {
        modal.close();
        (ctx as HireContext).onRehire?.(row.dataset.alum!);
      }),
    );
  };
  const stopFormer = onAlumniChange(showFormer);
  (ctx as HireContext).getAlumni?.();
  const stopTools = onMcpChange(showTools);
  ctx.scanMcp?.();
  ctx.getSkills?.();
  const stopAgents = onAgentsChange(showInstalled);
  const stopWatching = () => {
    stopAgents();
    stopTools();
    stopSkills();
    stopFormer();
  };
  const modal = openModal({ title: hiring ? `Hire a worker · ${desk!.label}` : "Your team", icon: "👥", className: "team-modal", body, footer, onClose: stopWatching });
  showInstalled();
  showTools();
  showSkills();
  showFormer();

  footer.querySelector(".tm-policy")!.addEventListener("click", () => {
    modal.close();
    ctx.onEditPolicy();
  });
  // A ready-made agent: it joins the team as a character (and, hiring, sits down at the desk).
  body.querySelectorAll<HTMLElement>(".tm-role").forEach((li) =>
    li.querySelector(".tm-role-go")!.addEventListener("click", () => {
      const role = ROLES.find((r) => r.id === li.dataset.role)!;
      if (team.length >= MAX_TEAM) return;
      const c = roleCharacter(role, team.map((x) => x.name), roleAgent(role));
      ctx.onSave(c);
      local.set(c.id, c);
      modal.close();
      if (hiring) ctx.onHire?.(c.id);
      else openRoster(ctx, desk, local);
    }),
  );
  body.querySelector(".tm-new")?.addEventListener("click", () => {
    modal.close();
    openEditor(null, ctx, desk, local);
  });
  body.querySelectorAll<HTMLElement>(".tm-card").forEach((li) => {
    const c = team.find((x) => x.id === li.dataset.id)!;
    li.querySelector(".tm-hire")?.addEventListener("click", () => {
      modal.close();
      ctx.onHire?.(c.id);
    });
    li.querySelector(".tm-edit")!.addEventListener("click", () => {
      modal.close();
      openEditor(c, ctx, desk, local);
    });
    const del = li.querySelector<HTMLButtonElement>(".tm-del")!;
    del.addEventListener("click", () => {
      // A second click confirms.
      if (!del.dataset.armed) {
        del.dataset.armed = "1";
        del.textContent = "Sure?";
        setTimeout(() => {
          delete del.dataset.armed;
          del.textContent = "🗑";
        }, 2500);
        return;
      }
      ctx.onDelete(c.id);
      local.set(c.id, null);
      modal.close();
      openRoster(ctx, desk, local);
    });
  });
  if (hiring) {
    const sync = () => body.querySelectorAll<HTMLElement>(".tm-leash button").forEach((b) => b.classList.toggle("on", b.dataset.l === leash));
    body.querySelectorAll<HTMLElement>(".tm-leash button").forEach((b) =>
      b.addEventListener("click", () => {
        leash = b.dataset.l as Leash;
        sync();
      }),
    );
    sync();
    body.querySelectorAll<HTMLElement>(".tm-agents li").forEach((li) => {
      li.querySelector(".tm-quick-hire")!.addEventListener("click", () => {
        const model = li.querySelector<HTMLSelectElement>(".tm-model")!.value;
        modal.close();
        ctx.onHire?.({ agent: li.dataset.agent as AgentKind, model, leash });
      });
      li.querySelector(".tm-install")!.addEventListener("click", () => installAgent(li.dataset.agent as AgentKind));
    });
  }
  (body.querySelector<HTMLElement>(".tm-hire:not([disabled])") ?? body.querySelector<HTMLElement>(".tm-new"))?.focus();
}

/** Make a new character (null) or change one. */
export function openCharacterEditor(c: Character | null, ctx: TeamContext & Partial<Pick<HireContext, "onHire">>, desk: { id: string; label: string } | null = null): void {
  openEditor(c, ctx, desk, new Map());
}

function openEditor(
  existing: Character | null,
  ctx: TeamContext & Partial<Pick<HireContext, "onHire">>,
  desk: { id: string; label: string } | null,
  local: Map<string, Character | null>,
): void {
  const team = teamOf(ctx, local);
  const taken = new Set(team.filter((x) => x.id !== existing?.id).map((x) => x.name.toLowerCase()));
  const policy = ctx.progress.policy;
  const c: Character = existing
    ? structuredClone(existing)
    : {
        id: Math.random().toString(36).slice(2, 10),
        name: randomName(taken),
        agent: "claude",
        model: "",
        leash: policy.leash,
        persona: "",
        voice: "",
        look: { ...defaultLook("claude"), color: BOT_COLORS[Math.floor(Math.random() * BOT_COLORS.length)] },
        mcp: ctx.progress.mcp.filter((m) => m.enabled && m.everyone).map((m) => m.id),
        createdAt: Date.now(),
        hires: 0,
      };

  const body = document.createElement("div");
  body.className = "tm-editor";
  body.innerHTML = `
    <div class="tm-preview"><canvas></canvas><span>Drag to spin</span></div>
    <div class="tm-form">
      <label>Name</label>
      <div class="webhook"><input type="text" class="tm-name-in" maxlength="24" /><button class="btn tm-dice" title="Random name">🎲</button></div>

      <label>Agent</label>
      <div class="seg tm-agent">${AGENT_KINDS.map((k) => `<button data-k="${k}"><span class="dot" style="background:${AGENT_COLOR[k]}"></span>${AGENT_LABELS[k]}</button>`).join("")}</div>

      <div class="tm-row">
        <div><label>Model</label><select class="tm-model-in"></select></div>
        <div><label>Leash</label><div class="seg tm-leash-in">${(Object.keys(LEASH_LABEL) as Leash[]).map((l) => `<button data-l="${l}" title="${esc(LEASH_RULES[l])}">${LEASH_ICON[l]} ${esc(LEASH_LABEL[l])}</button>`).join("")}</div></div>
      </div>

      <label>How it works <span class="tm-sub">— added to every task it gets · start from a role, then make it yours</span></label>
      <div class="templates tm-presets">${ROLES.map((r, i) => `<button class="btn chip" data-p="${i}" title="${esc(r.blurb)}">${r.icon} ${esc(r.title)}</button>`).join("")}</div>
      <textarea class="tm-persona-in" rows="7" maxlength="${MAX_PERSONA}" placeholder="What it's for and how it works: what it does first, how it goes about it, what done means, what it reports back."></textarea>

      <label>Look</label>
      <div class="swatches tm-colors">${BOT_COLORS.map((col) => `<button class="swatch" data-c="${col}" style="background:${col}" aria-label="${col}"></button>`).join("")}</div>
      <div class="tm-looks">
        <div><span class="tm-sub">Face</span><div class="seg tm-face-in">${FACES.map((f) => `<button data-v="${f}">${FACE_LABEL[f]}</button>`).join("")}</div></div>
        <div><span class="tm-sub">Hat</span><div class="seg tm-hat-in">${HATS.map((h) => `<button data-v="${h}">${HAT_LABEL[h]}</button>`).join("")}</div></div>
        <div><span class="tm-sub">Extra</span><div class="seg tm-acc-in">${ACCESSORIES.map((a) => `<button data-v="${a}">${ACC_LABEL[a]}</button>`).join("")}</div></div>
      </div>
      <button class="btn small tm-surprise">🎲 Surprise look</button>

      <label>Voice</label>
      <div class="webhook"><select class="tm-voice-in"></select><button class="btn tm-say" title="Hear it">▶</button></div>

      <label>Skills <span class="tm-sub">all on by default — untick what it shouldn't use</span></label><div class="tm-skill-list"></div>
      ${
        ctx.progress.mcp.length
          ? `<label>Tools (MCP)</label><div class="tm-mcp">${ctx.progress.mcp
              .map((m) => `<label class="tm-check"><input type="checkbox" data-mcp="${esc(m.id)}" ${c.mcp.includes(m.id) ? "checked" : ""} ${m.enabled ? "" : "disabled"} /> 🔌 ${esc(m.name)}${m.enabled ? "" : " <i>(off)</i>"}</label>`)
              .join("")}</div>`
          : ""
      }
    </div>`;
  const footer = document.createElement("div");
  footer.style.display = "contents";
  const canHire = desk !== null && !!ctx.onHire && !deskOf(ctx.desks, c.id);
  footer.innerHTML = `<button class="btn tm-back">◀ Team</button><span class="grow tm-error"></span><button class="btn tm-save">💾 Save</button>${canHire ? `<button class="btn primary tm-save-hire">Save &amp; hire at ${esc(desk!.label)}</button>` : ""}`;
  const modal = openModal({
    title: existing ? `Edit ${existing.name}` : "New character",
    icon: "✨",
    className: "team-editor-modal",
    body,
    footer,
    onClose: () => {
      stopPreview();
      stopSpeaking();
    },
  });

  const $ = <T extends HTMLElement>(sel: string) => body.querySelector<T>(sel)!;
  const nameIn = $<HTMLInputElement>(".tm-name-in");
  const personaIn = $<HTMLTextAreaElement>(".tm-persona-in");
  const modelIn = $<HTMLSelectElement>(".tm-model-in");
  const voiceIn = $<HTMLSelectElement>(".tm-voice-in");
  nameIn.value = c.name;
  personaIn.value = c.persona;
  for (const el of [nameIn, personaIn]) {
    el.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key !== "Escape") e.stopPropagation();
    });
  }
  nameIn.addEventListener("input", () => (c.name = nameIn.value));
  personaIn.addEventListener("input", () => (c.persona = personaIn.value));
  $(".tm-dice").addEventListener("click", () => {
    c.name = randomName(taken);
    nameIn.value = c.name;
  });
  body.querySelectorAll<HTMLElement>(".tm-presets [data-p]").forEach((b) =>
    b.addEventListener("click", () => {
      // A role's method replaces what's there (they're whole working methods, not one-liners to stack).
      const r = ROLES[Number(b.dataset.p)];
      c.persona = r.persona;
      personaIn.value = c.persona;
      if (c.agent === "claude" && !c.model) c.model = r.model;
      c.leash = r.leash;
      renderModels();
      body.querySelectorAll<HTMLElement>(".tm-leash-in button").forEach((x) => x.classList.toggle("on", x.dataset.l === c.leash));
    }),
  );

  const renderModels = () => {
    const def = policy.defaultModel[c.agent];
    const choices = modelChoices(c.agent, policy.models[c.agent], loopState.config?.localModels ?? [], [c.model]);
    modelIn.innerHTML = choices.map((m) => `<option value="${esc(m)}" ${m === c.model ? "selected" : ""}>${m ? `${esc(modelLabel(m))}${isLocalModel(m) ? " · free, private" : ""}` : `Team default (${esc(modelLabel(def))})`}</option>`).join("");
  };
  modelIn.addEventListener("change", () => (c.model = modelIn.value));

  const segPick = (sel: string, get: () => string, set: (v: string) => void, after?: () => void) => {
    const render = () => body.querySelectorAll<HTMLElement>(`${sel} button`).forEach((b) => b.classList.toggle("on", (b.dataset.v ?? b.dataset.k ?? b.dataset.l) === get()));
    body.querySelectorAll<HTMLElement>(`${sel} button`).forEach((b) =>
      b.addEventListener("click", () => {
        set((b.dataset.v ?? b.dataset.k ?? b.dataset.l)!);
        render();
        after?.();
      }),
    );
    render();
    return render;
  };
  const renderSwatches = () => body.querySelectorAll<HTMLElement>(".tm-colors .swatch").forEach((b) => b.classList.toggle("sel", b.dataset.c === c.look.color));
  body.querySelectorAll<HTMLElement>(".tm-colors .swatch").forEach((b) =>
    b.addEventListener("click", () => {
      c.look.color = b.dataset.c!;
      renderSwatches();
      rebuild();
    }),
  );
  segPick(
    ".tm-agent",
    () => c.agent,
    (v) => {
      c.agent = v as AgentKind;
      c.model = "";
      // Another agent, other skills: the old picks don't apply.
      c.skillsOff = [];
      renderModels();
      renderSkills();
    },
    rebuild,
  );
  segPick(".tm-leash-in", () => c.leash, (v) => (c.leash = v as Leash));
  const renderFace = segPick(".tm-face-in", () => c.look.face, (v) => (c.look.face = v as Face), rebuild);
  const renderHat = segPick(".tm-hat-in", () => c.look.hat, (v) => (c.look.hat = v as Hat), rebuild);
  const renderAcc = segPick(".tm-acc-in", () => c.look.accessory, (v) => (c.look.accessory = v as Accessory), rebuild);
  $(".tm-surprise").addEventListener("click", () => {
    const any = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
    c.look = { color: any(BOT_COLORS), face: any(FACES), hat: any(HATS), accessory: any(ACCESSORIES) };
    renderSwatches();
    renderFace();
    renderHat();
    renderAcc();
    rebuild();
  });
  renderSwatches();
  renderModels();

  const fillVoices = () => {
    const voices = listVoices();
    voiceIn.innerHTML =
      `<option value="">Auto — picked for its agent</option>` +
      voices.map((v) => `<option value="${esc(v.name)}" ${v.name === c.voice ? "selected" : ""}>${esc(v.label ?? v.name)} (${esc(v.lang)})</option>`).join("");
  };
  fillVoices();
  if (typeof speechSynthesis !== "undefined" && !listVoices().length) setTimeout(fillVoices, 600);
  voiceIn.addEventListener("change", () => (c.voice = voiceIn.value));
  $(".tm-say").addEventListener("click", () => speak(`Hi, I'm ${c.name || "your new teammate"}. Ready when you are!`, c.agent, undefined, c.voice));

  // Its agent's skills: on unless listed in skillsOff (redrawn if the agent changes).
  const renderSkills = () => {
    const el = body.querySelector<HTMLElement>(".tm-skill-list");
    if (!el) return;
    const list = skillsOf(c.agent);
    const off = new Set(c.skillsOff ?? []);
    el.innerHTML = list.length
      ? list
          .map((s) => `<label class="tm-check" title="${esc(s.description)}"><input type="checkbox" data-skill="${esc(s.name)}" ${off.has(s.name) ? "" : "checked"} /> 🎓 ${esc(s.name)}${s.source === "project" ? " <i>(project)</i>" : ""}</label>`)
          .join("")
      : `<p class="tm-sub">No skills found for ${esc(AGENT_LABELS[c.agent])} — add them to its skills folder.</p>`;
    el.querySelectorAll<HTMLInputElement>("[data-skill]").forEach((cb) =>
      cb.addEventListener("change", () => {
        const n = cb.dataset.skill!;
        const cur = new Set(c.skillsOff ?? []);
        if (cb.checked) cur.delete(n);
        else cur.add(n);
        c.skillsOff = [...cur];
      }),
    );
  };
  renderSkills();
  const stopSkillList = onSkillsChange(renderSkills);
  ctx.getSkills?.();
  void stopSkillList;

  body.querySelectorAll<HTMLInputElement>("[data-mcp]").forEach((cb) =>
    cb.addEventListener("change", () => {
      const id = cb.dataset.mcp!;
      c.mcp = cb.checked ? [...new Set([...c.mcp, id])] : c.mcp.filter((x) => x !== id);
    }),
  );

  // --- the live preview -------------------------------------------------------
  const canvas = body.querySelector("canvas")!;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const effect = new OutlineEffect(renderer, { defaultThickness: 0.004, defaultColor: [0.17, 0.18, 0.26] });
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight("#fff5e6", "#c9a27a", 1.6));
  const sun = new THREE.DirectionalLight("#fff1d6", 1.6);
  sun.position.set(2, 4, 5);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(30, 0.8, 0.1, 50);
  camera.position.set(0, 0.95, 3.4);
  camera.lookAt(0, 0.68, 0);
  let bot: Bot | null = null;
  function rebuild(): void {
    if (bot) {
      scene.remove(bot.root);
      bot.dispose();
    }
    bot = new Bot(c.agent, c.look);
    scene.add(bot.root);
  }
  rebuild();
  let spin = 0.4;
  let dragging = false;
  let lastX = 0;
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastX = e.clientX;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    spin += (e.clientX - lastX) * 0.012;
    lastX = e.clientX;
  });
  canvas.addEventListener("pointerup", () => (dragging = false));
  let raf = 0;
  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!dragging) spin += dt * 0.5;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w && h && (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio()))) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    if (bot) {
      bot.root.rotation.y = spin;
      bot.update(dt, { seated: false, walking: false, status: "idle" });
    }
    effect.render(scene, camera);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  function stopPreview(): void {
    cancelAnimationFrame(raf);
    bot?.dispose();
    renderer.dispose();
  }

  // --- saving ---------------------------------------------------------------------
  const save = (): Character | null => {
    const clean = coerceCharacter({ ...c, name: nameIn.value, persona: personaIn.value });
    const err = footer.querySelector<HTMLElement>(".tm-error")!;
    if (!clean) {
      err.textContent = "Give it a name";
      nameIn.focus();
      return null;
    }
    if (taken.has(clean.name.toLowerCase())) {
      err.textContent = `There's already a ${clean.name} on the team`;
      nameIn.focus();
      return null;
    }
    if (!existing && team.length >= MAX_TEAM) {
      err.textContent = `The team is full (${MAX_TEAM})`;
      return null;
    }
    ctx.onSave(clean);
    local.set(clean.id, clean);
    return clean;
  };
  footer.querySelector(".tm-back")!.addEventListener("click", () => {
    modal.close();
    openRoster(ctx, desk, local);
  });
  footer.querySelector(".tm-save")!.addEventListener("click", () => {
    if (!save()) return;
    modal.close();
    openRoster(ctx, desk, local);
  });
  footer.querySelector(".tm-save-hire")?.addEventListener("click", () => {
    const saved = save();
    if (!saved) return;
    modal.close();
    // Messages arrive in order: the save lands before the hire.
    ctx.onHire?.(saved.id);
  });
  setTimeout(() => nameIn.focus(), 0);
}
