import type { ClientMessage, ServerMessage, AgentKind } from "../../shared/protocol.js";
import { AGENT_KINDS, AGENT_LABELS } from "../../shared/protocol.js";
import type { ProgressState } from "../../shared/progress.js";
import type { McpHealth, McpSeen, McpServer } from "../../shared/mcp.js";
import { GITHUB_MCP_URL, mcpTarget, SECRET_MASK } from "../../shared/mcp.js";
import { AGENT_COLOR } from "../scene/characters.js";
import { icon } from "./icons.js";
import { logView } from "./logs.js";
import { esc, openModal } from "./modal.js";
import "../styles/mcp.css";

/**
 * The MCP window: the tools your workers can use. Your office's own servers
 * (added once, given to everyone or to the characters you pick, each with a
 * health check), quick presets for common ones, and the servers each agent
 * already loads from its own settings — with what the office ran, live.
 */

export interface McpWindowCtx {
  progress(): ProgressState;
  send(msg: ClientMessage): void;
  /** Guests can look but not change anything. */
  isHost(): boolean;
}

interface Preset {
  id: string;
  label: string;
  blurb: string;
  server: Omit<McpServer, "id" | "enabled" | "everyone">;
  /** Which env key needs a value, and where to get it. */
  needs?: { key: string; hint: string };
}

const PRESETS: Preset[] = [
  {
    id: "filesystem",
    label: "Filesystem",
    blurb: "Read and write files in the project",
    server: { name: "filesystem", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."], url: "", env: {} },
  },
  {
    id: "fetch",
    label: "Fetch",
    blurb: "Read web pages",
    server: { name: "fetch", transport: "stdio", command: "uvx", args: ["mcp-server-fetch"], url: "", env: {} },
  },
  {
    id: "playwright",
    label: "Playwright",
    blurb: "Drive a real browser",
    server: { name: "playwright", transport: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"], url: "", env: {} },
  },
  {
    id: "github",
    label: "GitHub",
    blurb: "Issues, PRs and code on GitHub — uses your GitHub sign-in, nothing to paste",
    server: { name: "github", transport: "http", command: "", args: [], url: GITHUB_MCP_URL, env: {}, auth: "github" },
  },
  {
    id: "context7",
    label: "Context7",
    blurb: "Up-to-date library docs",
    server: { name: "context7", transport: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"], url: "", env: {} },
  },
  {
    id: "memory",
    label: "Memory",
    blurb: "A notebook workers share",
    server: { name: "memory", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], url: "", env: {} },
  },
];

let seen: McpSeen[] = [];
const changeListeners = new Set<() => void>();

/** Be told when what's known about MCP servers changes. */
export function onMcpChange(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

/** The MCP tools a new hire of this agent starts with: its CLI's own, plus the office's for everyone. */
export function mcpToolsFor(agent: string, office: McpServer[]): string[] {
  const own = seen.filter((s) => s.agent === agent).map((s) => s.name);
  const ours = office.filter((s) => s.enabled && s.everyone).map((s) => s.name);
  return [...new Set([...own, ...ours])];
}
const health = new Map<string, McpHealth>();
let rerender: (() => void) | null = null;

/** Feed every server message through here. */
export function ingestMcp(msg: ServerMessage): void {
  if (msg.t === "mcpSeen") seen = msg.seen;
  else if (msg.t === "mcpHealth") {
    for (const h of msg.health) health.set(h.key, h);
  } else if (msg.t !== "progress") return;
  rerender?.();
  for (const l of changeListeners) l();
}

function badge(key: string): string {
  const h = health.get(key);
  if (!h) return `<span class="mcp-badge unknown">not checked</span>`;
  if (h.status === "checking") return `<span class="mcp-badge checking">${icon("spinner", 12)} checking</span>`;
  if (h.status === "ok") return `<span class="mcp-badge ok" title="${esc(h.detail)}">${icon("check", 12)} ${esc(h.detail)}</span>`;
  if (h.status === "auth") return `<span class="mcp-badge auth" title="It answered, but wants you signed in">${icon("key", 12)} needs sign-in</span>`;
  return `<span class="mcp-badge error" title="${esc(h.detail)}">${icon("x", 12)} ${esc(h.detail.length > 46 ? h.detail.slice(0, 45) + "…" : h.detail)}</span>`;
}

function target(s: { transport: string; command: string; args: string[]; url: string }): string {
  return mcpTarget(s);
}

export function openMcp(ctx: McpWindowCtx): void {
  const host = ctx.isHost();
  let editing: McpServer | null = null;

  const body = document.createElement("div");
  body.className = "mcp";
  body.innerHTML = `
    <div class="mcp-intro">
      <span class="mcp-intro-icon">${icon("mcp", 30)}</span>
      <p><b>MCP servers are tools your workers can use</b> — read files, browse the web, work with GitHub, drive a browser.
      Add one here once and choose who gets it: every new hire, or just the characters you pick. It's given to a worker for its
      session only — your agents' own settings aren't changed.</p>
    </div>
    <section class="mcp-sec mine"></section>
    <section class="mcp-sec theirs"></section>
    <section class="mcp-sec add"></section>
    <section class="mcp-sec runs"><h4>${icon("log", 14)} What the office ran</h4></section>`;
  body.querySelector(".runs")!.appendChild(logView("mcp", 6));

  const footer = document.createElement("div");
  footer.style.display = "contents";
  footer.innerHTML = `<span class="grow">${host ? "Saved with your office · checked when you save" : "Only the host can change MCP servers"}</span>
    <button class="btn rescan">${icon("mcp", 14)} Re-read agents</button><button class="btn primary checkall">${icon("check", 14)} Check all</button>`;
  footer.querySelector(".rescan")!.addEventListener("click", () => ctx.send({ t: "mcpScan" }));
  footer.querySelector(".checkall")!.addEventListener("click", () => ctx.send({ t: "mcpCheck" }));
  if (!host) footer.querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.disabled = true));

  openModal({
    title: "MCP servers",
    icon: icon("mcp", 20),
    className: "mcp-modal",
    body,
    footer,
    onClose: () => {
      rerender = null;
    },
  });

  const mine = body.querySelector<HTMLElement>(".mine")!;
  const add = body.querySelector<HTMLElement>(".add")!;
  const theirs = body.querySelector<HTMLElement>(".theirs")!;

  const renderMine = () => {
    const list = ctx.progress().mcp;
    mine.innerHTML = `<h4>${icon("plug", 14)} Your office's servers</h4>` +
      (list.length
        ? `<ul class="mcp-list">${list
            .map(
              (s) => `<li class="mcp-item ${s.enabled ? "" : "off"}" data-id="${s.id}">
            <span class="mcp-ic">${icon(s.transport === "http" ? "link" : "terminal", 16)}</span>
            <span class="mcp-main"><b>${esc(s.name)}</b><code>${esc(target(s))}</code></span>
            ${badge(s.id)}
            <label class="mcp-toggle" title="Off: no worker gets it"><input type="checkbox" data-k="enabled" ${s.enabled ? "checked" : ""} ${host ? "" : "disabled"}/> On</label>
            <label class="mcp-toggle" title="Every new hire gets it (characters can opt out)"><input type="checkbox" data-k="everyone" ${s.everyone ? "checked" : ""} ${host ? "" : "disabled"}/> Everyone</label>
            ${host ? `<button class="btn small mcp-check" title="Check it">${icon("check", 12)}</button><button class="btn small edit">Edit</button><button class="btn small danger del" title="Remove">${icon("x", 12)}</button>` : ""}
          </li>`,
            )
            .join("")}</ul>`
        : `<p class="mcp-empty">None yet. Pick a preset below — Filesystem and Fetch are a good start.</p>`);
    mine.querySelectorAll<HTMLElement>(".mcp-item").forEach((li) => {
      const s = list.find((x) => x.id === li.dataset.id)!;
      li.querySelectorAll<HTMLInputElement>("input[data-k]").forEach((cb) =>
        cb.addEventListener("change", () => ctx.send({ t: "mcpSave", server: { ...s, [cb.dataset.k!]: cb.checked } })),
      );
      li.querySelector(".mcp-check")?.addEventListener("click", () => ctx.send({ t: "mcpCheck", key: s.id }));
      li.querySelector(".edit")?.addEventListener("click", () => {
        editing = structuredClone(s);
        renderAdd();
      });
      const del = li.querySelector<HTMLButtonElement>(".del");
      del?.addEventListener("click", () => {
        if (del.dataset.armed) ctx.send({ t: "mcpDelete", id: s.id });
        else {
          del.dataset.armed = "1";
          del.textContent = "Remove?";
          setTimeout(() => {
            delete del.dataset.armed;
            del.innerHTML = icon("x", 12);
          }, 2500);
        }
      });
    });
  };

  const renderAdd = () => {
    if (!host) {
      add.innerHTML = "";
      return;
    }
    if (!editing) {
      add.innerHTML = `<h4>${icon("plug", 14)} Add a server</h4>
        <div class="mcp-presets">${PRESETS.map(
          (p) => `<button class="mcp-preset" data-p="${p.id}"><b>${esc(p.label)}</b><span>${esc(p.blurb)}</span>${p.needs ? `<i>${icon("key", 11)} needs a token</i>` : ""}</button>`,
        ).join("")}<button class="mcp-preset custom" data-p="custom"><b>＋ Your own</b><span>Any command or URL</span></button></div>`;
      add.querySelectorAll<HTMLElement>(".mcp-preset").forEach((b) =>
        b.addEventListener("click", () => {
          const p = PRESETS.find((x) => x.id === b.dataset.p);
          // GitHub with your sign-in needs no form: add it for everyone straight away.
          if (p?.server.auth === "github") {
            ctx.send({ t: "mcpSave", server: githubTools() });
            return;
          }
          editing = p
            ? { ...structuredClone(p.server), id: Math.random().toString(36).slice(2, 10), enabled: true, everyone: true }
            : { id: Math.random().toString(36).slice(2, 10), name: "", transport: "stdio", command: "", args: [], url: "", env: {}, enabled: true, everyone: true };
          renderAdd();
        }),
      );
      return;
    }
    const e = editing;
    const preset = PRESETS.find((p) => p.server.name === e.name);
    const envLabel = e.transport === "http" ? "Headers" : "Environment";
    add.innerHTML = `<h4>${icon("plug", 14)} ${ctx.progress().mcp.some((x) => x.id === e.id) ? "Edit" : "New"} server</h4>
      <div class="mcp-form">
        <label>Name<input type="text" class="f-name" maxlength="40" value="${esc(e.name)}" placeholder="e.g. filesystem" /></label>
        <div class="seg f-transport"><button data-t="stdio">${icon("terminal", 13)} Runs a command</button><button data-t="http">${icon("link", 13)} Lives at a URL</button></div>
        <div class="f-stdio">
          <label>Command<input type="text" class="f-cmd" value="${esc(e.command)}" placeholder="npx" /></label>
          <label>Arguments <span class="opt">(one per line)</span><textarea class="f-args" rows="3">${esc(e.args.join("\n"))}</textarea></label>
        </div>
        <div class="f-http"><label>URL<input type="text" class="f-url" value="${esc(e.url)}" placeholder="https://…/mcp" /></label></div>
        <div class="f-env-head">${envLabel} <span class="opt">(values are kept on this computer and never shown again)</span></div>
        <div class="f-env"></div>
        <button class="btn small f-addenv">＋ ${e.transport === "http" ? "Header" : "Variable"}</button>
        ${preset?.needs ? `<p class="mcp-need">${icon("key", 12)} ${esc(preset.needs.key)}: ${esc(preset.needs.hint)}</p>` : ""}
        <div class="f-opts">
          <label class="mcp-toggle"><input type="checkbox" class="f-on" ${e.enabled ? "checked" : ""}/> On</label>
          <label class="mcp-toggle"><input type="checkbox" class="f-all" ${e.everyone ? "checked" : ""}/> Every new hire gets it</label>
          <span class="grow"></span>
          <button class="btn f-cancel">Cancel</button><button class="btn primary f-save">Save & check</button>
        </div>
        <p class="mcp-error"></p>
      </div>`;
    const $ = <T extends HTMLElement>(sel: string) => add.querySelector<T>(sel)!;
    const envRows: { k: string; v: string }[] = Object.entries(e.env).map(([k, v]) => ({ k, v }));
    const renderEnv = () => {
      $(".f-env").innerHTML = envRows
        .map(
          (r, i) => `<div class="f-env-row" data-i="${i}"><input type="text" class="k" value="${esc(r.k)}" placeholder="NAME" />
            <input type="password" class="v" value="${esc(r.v)}" placeholder="value" autocomplete="off" /><button class="btn small rm">${icon("x", 11)}</button></div>`,
        )
        .join("");
      $(".f-env").querySelectorAll<HTMLElement>(".f-env-row").forEach((row) => {
        const i = Number(row.dataset.i);
        row.querySelector<HTMLInputElement>(".k")!.addEventListener("input", (ev) => (envRows[i].k = (ev.target as HTMLInputElement).value.trim()));
        row.querySelector<HTMLInputElement>(".v")!.addEventListener("input", (ev) => (envRows[i].v = (ev.target as HTMLInputElement).value));
        row.querySelector(".rm")!.addEventListener("click", () => {
          envRows.splice(i, 1);
          renderEnv();
        });
      });
    };
    const syncTransport = () => {
      add.querySelectorAll<HTMLElement>(".f-transport button").forEach((b) => b.classList.toggle("on", b.dataset.t === e.transport));
      $(".f-stdio").style.display = e.transport === "stdio" ? "" : "none";
      $(".f-http").style.display = e.transport === "http" ? "" : "none";
    };
    add.querySelectorAll<HTMLElement>(".f-transport button").forEach((b) =>
      b.addEventListener("click", () => {
        e.transport = b.dataset.t as "stdio" | "http";
        syncTransport();
      }),
    );
    add.querySelectorAll<HTMLElement>("input, textarea").forEach((el) =>
      el.addEventListener("keydown", (ev) => {
        if ((ev as KeyboardEvent).key !== "Escape") ev.stopPropagation();
      }),
    );
    $(".f-addenv").addEventListener("click", () => {
      envRows.push({ k: "", v: "" });
      renderEnv();
    });
    $(".f-cancel").addEventListener("click", () => {
      editing = null;
      renderAdd();
    });
    $(".f-save").addEventListener("click", () => {
      const env: Record<string, string> = {};
      for (const r of envRows) if (r.k) env[r.k] = r.v;
      const server: McpServer = {
        ...e,
        name: $<HTMLInputElement>(".f-name").value.trim(),
        command: $<HTMLInputElement>(".f-cmd").value.trim(),
        args: $<HTMLTextAreaElement>(".f-args").value.split("\n").map((x) => x.trim()).filter(Boolean),
        url: $<HTMLInputElement>(".f-url").value.trim(),
        env,
        enabled: $<HTMLInputElement>(".f-on").checked,
        everyone: $<HTMLInputElement>(".f-all").checked,
      };
      const err = !server.name
        ? "Give it a name."
        : server.transport === "stdio" && !server.command
          ? "What command starts it? (e.g. npx)"
          : server.transport === "http" && !/^https?:\/\//i.test(server.url)
            ? "Its URL should start with https://"
            : preset?.needs && (!env[preset.needs.key] || env[preset.needs.key].trim() === "Bearer")
              ? `It needs ${preset.needs.key} — ${preset.needs.hint}`
              : "";
      if (err) {
        $(".mcp-error").textContent = err;
        return;
      }
      ctx.send({ t: "mcpSave", server });
      editing = null;
      renderAdd();
    });
    renderEnv();
    syncTransport();
  };

  const renderTheirs = () => {
    const byAgent = new Map<AgentKind, McpSeen[]>();
    for (const s of seen) byAgent.set(s.agent, [...(byAgent.get(s.agent) ?? []), s]);
    const office = ctx.progress().mcp;
    const wide = (name: string) => office.some((o) => o.enabled && o.everyone && o.name.toLowerCase() === name.toLowerCase());
    const waiting = seen.filter((s) => !wide(s.name)).length;
    theirs.innerHTML = `<h4>${icon("terminal", 14)} Found in your CLIs <span class="opt">(already set up in Claude Code, Codex, Gemini CLI or OpenCode — their settings aren't changed)</span></h4>
      ${seen.length ? `<p class="mcp-found-note">${waiting ? `<b>${waiting}</b> not given to every worker yet — <b>Add for everyone</b> copies one into your office's list (its secrets stay on this computer).` : `${icon("check", 12)} Every one of them is in your office's list for everyone.`}</p>` : ""}` +
      (seen.length
        ? AGENT_KINDS.filter((a) => byAgent.has(a))
            .map(
              (a) => `<div class="mcp-agent"><div class="mcp-agent-head"><span class="dot" style="background:${AGENT_COLOR[a]}"></span>${esc(AGENT_LABELS[a])}</div>
            <ul class="mcp-list">${byAgent
              .get(a)!
              .map((s) => {
                const key = `${s.agent}:${s.name}`;
                const keys = s.envKeys ?? [];
                const env = keys.slice(0, 3).map((k) => `${k}=${SECRET_MASK}`).join(" ") + (keys.length > 3 ? ` +${keys.length - 3} more` : "");
                return `<li class="mcp-item" data-key="${esc(key)}" data-name="${esc(s.name)}" data-agent="${esc(s.agent)}"><span class="mcp-ic">${icon(s.transport === "http" ? "link" : "terminal", 16)}</span>
                <span class="mcp-main"><b>${esc(s.name)}</b><code>${esc(s.target)}</code><small>${esc(s.source)}${env ? ` · ${esc(env)}` : ""}</small></span>${badge(key)}
                ${host ? `<button class="btn small mcp-check" title="Check it">${icon("check", 12)}</button>` : ""}
                ${wide(s.name) ? `<span class="mcp-badge ok">${icon("check", 12)} everyone has it</span>` : host ? `<button class="btn small primary mcp-adopt" title="Copy it into your office's list: every new hire gets it, whichever agent it is">＋ Add for everyone</button>` : ""}</li>`;
              })
              .join("")}</ul></div>`,
            )
            .join("")
        : `<p class="mcp-empty">None found in Claude Code, Codex, Gemini CLI or OpenCode settings.</p>`);
    theirs.querySelectorAll<HTMLElement>(".mcp-item").forEach((li) => {
      li.querySelector(".mcp-check")?.addEventListener("click", () => ctx.send({ t: "mcpCheck", key: li.dataset.key }));
      const adopt = li.querySelector<HTMLButtonElement>(".mcp-adopt");
      adopt?.addEventListener("click", () => {
        ctx.send({ t: "mcpAdopt", name: li.dataset.name!, agent: li.dataset.agent as AgentKind });
        adopt.disabled = true;
        adopt.innerHTML = `${icon("spinner", 12)} Adding…`;
      });
    });
  };

  rerender = () => {
    renderMine();
    renderTheirs();
  };
  renderMine();
  renderAdd();
  renderTheirs();
  if (host) {
    ctx.send({ t: "mcpScan" });
    if (!health.size) ctx.send({ t: "mcpCheck" });
  }
}

/** GitHub's MCP server for every worker, authenticated with your GitHub sign-in (no token stored). */
export function githubTools(): McpServer {
  return { id: "github-signin", name: "github", transport: "http", command: "", args: [], url: GITHUB_MCP_URL, env: {}, enabled: true, everyone: true, auth: "github" };
}
