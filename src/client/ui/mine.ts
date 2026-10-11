import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { AgentKind, ClientMessage, ServerMessage } from "../../shared/protocol.js";
import { lastLines, type MineState, type MineTab } from "../../shared/mine.js";
import { allText, copyAll, copyOnSelect } from "./termcopy.js";
import { esc } from "./modal.js";
import "../styles/mine.css";

/**
 * 💻 Mine, on the laptop: your own terminals. Tabs of real shells on this
 * computer (or your own agent CLI session in one), started in the project or
 * an open repo; they live on the server, so they're still there when you
 * close the laptop or reload. Host only — guests never see the app, and the
 * server never sends them a byte of it.
 */

const TERM_THEME = { background: "#1e1f2e", foreground: "#cdd6f4", cursor: "#ff8a5b", selectionBackground: "#585b70" };
const ACTIVE_KEY = "domain.mine.active";
const LINES = 40;

export class MineApp {
  private state: MineState | null = null;
  private active: string | null = (() => {
    try {
      return localStorage.getItem(ACTIVE_KEY);
    } catch {
      return null;
    }
  })();
  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private host = document.createElement("div");
  private root: HTMLElement | null = null;
  /** Waiting for the active tab's scrollback (output until then is in it). */
  private waiting = false;
  private resizer = new ResizeObserver(() => this.refit());

  constructor(
    private send: (m: ClientMessage) => void,
    /** Esc in the terminal closes the laptop. */
    private onEscape: () => void,
  ) {
    this.host.className = "lt-term mn-term";
    this.resizer.observe(this.host);
  }

  private get shown(): boolean {
    return !!this.root?.isConnected;
  }

  /** Put the app in the laptop's content area. */
  mount(content: HTMLElement): void {
    content.innerHTML = `
      <div class="mn">
        <div class="mn-bar">
          <div class="mn-tabs"></div>
          <div class="mn-new-wrap">
            <button class="btn small primary mn-new" title="A new shell in the project">＋ New tab</button><button class="btn small mn-more" title="Pick the shell, an agent of your own, and where it starts">▾</button>
            <form class="mn-pick hidden">
              <label>Run <select class="mn-what"></select></label>
              <label>In <select class="mn-where"></select></label>
              <button class="btn small primary" type="submit">Open</button>
            </form>
          </div>
        </div>
        <div class="mn-head">
          <span class="mn-where-now"></span>
          <span class="grow"></span>
          <button class="btn small mn-code" title="Open this folder in VS Code">🧩 Open in VS Code</button>
          <button class="btn small mn-files" title="Open this folder in your file manager">📂 Open folder</button>
          <button class="btn small mn-copy" title="Copy the whole terminal">📋 Copy all</button>
          <button class="btn small primary mn-hand" title="Give the team a task about this folder — with this tab's last lines, if you like">🎯 Hand this to the team</button>
        </div>
        <form class="mn-handoff hidden">
          <textarea rows="2" placeholder="What should the team do? e.g. “Fix the failing test below”"></textarea>
          <label class="mn-attach"><input type="checkbox" checked /> Attach the last ${LINES} lines of this tab</label>
          <div class="mn-hand-acts"><button class="btn small primary" type="submit">🎯 Give as a task</button><button class="btn small mn-hand-cancel" type="button">Cancel</button></div>
        </form>
        <div class="mn-body"></div>
      </div>`;
    this.root = content.querySelector<HTMLElement>(".mn")!;
    const body = this.root.querySelector<HTMLElement>(".mn-body")!;
    body.appendChild(this.host);
    this.ensureTerm();
    const pick = this.root.querySelector<HTMLFormElement>(".mn-pick")!;
    this.root.querySelector(".mn-new")!.addEventListener("click", () => this.openTab({}));
    this.root.querySelector(".mn-more")!.addEventListener("click", () => pick.classList.toggle("hidden"));
    pick.addEventListener("submit", (e) => {
      e.preventDefault();
      const what = pick.querySelector<HTMLSelectElement>(".mn-what")!.value;
      const folder = pick.querySelector<HTMLSelectElement>(".mn-where")!.value;
      const [kind, id] = what.split(":");
      this.openTab(kind === "agent" ? { agent: id as AgentKind, folder } : { shell: id, folder });
      pick.classList.add("hidden");
    });
    this.root.querySelector(".mn-tabs")!.addEventListener("click", (e) => {
      const x = (e.target as HTMLElement).closest<HTMLElement>("[data-close]");
      if (x) {
        e.stopPropagation();
        this.send({ t: "mineClose", tabId: x.dataset.close! });
        return;
      }
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]");
      if (b) this.attach(b.dataset.tab!);
    });
    this.root.querySelector(".mn-code")!.addEventListener("click", () => this.reveal("code"));
    this.root.querySelector(".mn-files")!.addEventListener("click", () => this.reveal("files"));
    this.root.querySelector(".mn-copy")!.addEventListener("click", () => this.term && copyAll(this.term));
    const hand = this.root.querySelector<HTMLFormElement>(".mn-handoff")!;
    const box = hand.querySelector("textarea")!;
    box.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") e.stopPropagation();
    });
    this.root.querySelector(".mn-hand")!.addEventListener("click", () => {
      hand.classList.toggle("hidden");
      if (!hand.classList.contains("hidden")) {
        const tab = this.tab();
        hand.querySelector<HTMLElement>(".mn-attach")!.style.display = tab ? "" : "none";
        box.focus();
      }
    });
    hand.querySelector(".mn-hand-cancel")!.addEventListener("click", () => hand.classList.add("hidden"));
    hand.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = box.value.trim();
      if (!text) return box.focus();
      const tab = this.tab();
      const folder = this.folder();
      const attach = hand.querySelector<HTMLInputElement>(".mn-attach input")!.checked && tab && this.term;
      const out = attach ? lastLines(allText(this.term!), LINES) : "";
      const name = this.state?.folders.find((f) => f.path === folder)?.name;
      this.send({
        t: "quickTask",
        deskId: "any",
        text: name ? `In ${name}: ${text}` : text,
        ...(folder && !this.state?.folders.find((f) => f.path === folder)?.main ? { repo: folder } : {}),
        ...(out.trim() ? { files: [{ name: "terminal-output.txt", text: out }] } : {}),
      });
      box.value = "";
      hand.classList.add("hidden");
      this.flash("🎯 Handed to the team — whoever takes it says so in #team");
    });
    this.waiting = false;
    this.send({ t: "mineGet" });
    this.render();
    if (this.active) this.attach(this.active);
  }

  /** Every server message (only the Mine ones matter). */
  onMessage(msg: ServerMessage): void {
    if (msg.t === "mine") {
      this.state = msg.state;
      if (msg.opened) this.active = null;
      const ids = msg.state.tabs.map((t) => t.id);
      const want = msg.opened ?? (this.active && ids.includes(this.active) ? this.active : (ids[0] ?? null));
      if (this.shown) {
        this.render();
        if (want !== this.active) {
          if (want) this.attach(want);
          else this.setActive(null);
        }
      } else if (want !== this.active) this.setActive(want);
    } else if (msg.t === "mineOutput") {
      if (this.term && this.shown && msg.tabId === this.active && !this.waiting) this.term.write(msg.data);
    } else if (msg.t === "mineScrollback") {
      if (this.term && msg.tabId === this.active && this.waiting) {
        this.waiting = false;
        this.term.reset();
        this.term.write(msg.data);
        this.refit();
      }
    }
  }

  refit(): void {
    if (!this.shown || !this.fit || !this.term || !this.host.isConnected) return;
    try {
      this.fit.fit();
      const t = this.tab();
      if (t?.alive) this.send({ t: "mineResize", tabId: t.id, cols: this.term.cols, rows: this.term.rows });
    } catch {
      /* no size yet */
    }
  }

  private tab(): MineTab | null {
    return this.state?.tabs.find((t) => t.id === this.active) ?? null;
  }

  /** The folder the header's buttons act on: the active tab's, or the project's. */
  private folder(): string | null {
    return this.tab()?.folder ?? this.state?.folders[0]?.path ?? null;
  }

  private setActive(id: string | null): void {
    this.active = id;
    try {
      if (id) localStorage.setItem(ACTIVE_KEY, id);
      else localStorage.removeItem(ACTIVE_KEY);
    } catch {
      /* fine */
    }
  }

  private openTab(req: { shell?: string; agent?: AgentKind; folder?: string }): void {
    this.ensureTerm();
    try {
      this.fit?.fit();
    } catch {
      /* not laid out */
    }
    this.send({ t: "mineOpen", ...req, ...(this.term ? { cols: this.term.cols, rows: this.term.rows } : {}) });
  }

  private attach(id: string): void {
    this.ensureTerm();
    this.setActive(id);
    this.waiting = true;
    this.term!.reset();
    this.render();
    this.send({ t: "mineAttach", tabId: id });
    requestAnimationFrame(() => {
      this.refit();
      this.term?.focus();
    });
  }

  private reveal(how: "code" | "files"): void {
    const folder = this.folder();
    if (folder) this.send({ t: "mineReveal", folder, how });
  }

  private flash(text: string): void {
    const el = this.root?.querySelector<HTMLElement>(".mn-where-now");
    if (!el) return;
    el.dataset.flash = "1";
    el.textContent = text;
    window.setTimeout(() => {
      delete el.dataset.flash;
      this.render();
    }, 4000);
  }

  private render(): void {
    if (!this.root) return;
    const s = this.state;
    const tabs = s?.tabs ?? [];
    const full = !!s && tabs.length >= s.max;
    this.root.querySelector<HTMLElement>(".mn-tabs")!.innerHTML =
      tabs
        .map(
          (t) =>
            `<button class="mn-tab ${t.id === this.active ? "on" : ""} ${t.alive ? "" : "ended"}" data-tab="${esc(t.id)}" title="${esc(t.folder)}"><span>${t.agent ? "🤖" : "›_"}</span> ${esc(t.title)} <small>${esc(s!.folders.find((f) => f.path === t.folder)?.name ?? "")}${t.alive ? "" : " · ended"}</small><i data-close="${esc(t.id)}" title="Close (ends its shell)">✕</i></button>`,
        )
        .join("") || `<span class="mn-none">No tabs yet — ＋ New tab opens a shell here, on this computer.</span>`;
    const newBtn = this.root.querySelector<HTMLButtonElement>(".mn-new")!;
    newBtn.disabled = full;
    newBtn.title = full ? `${s!.max} tabs is the most — close one first` : "A new shell in the project";
    const what = this.root.querySelector<HTMLSelectElement>(".mn-what")!;
    const where = this.root.querySelector<HTMLSelectElement>(".mn-where")!;
    const whatKey = JSON.stringify([s?.shells, s?.agents]);
    if (what.dataset.key !== whatKey) {
      what.dataset.key = whatKey;
      what.innerHTML = (s?.shells ?? []).map((x) => `<option value="shell:${esc(x.id)}">${esc(x.label)}</option>`).join("") + (s?.agents ?? []).map((a) => `<option value="agent:${esc(a.id)}">🤖 ${esc(a.label)}</option>`).join("");
    }
    const whereKey = JSON.stringify(s?.folders);
    if (where.dataset.key !== whereKey) {
      where.dataset.key = whereKey;
      where.innerHTML = (s?.folders ?? []).map((f) => `<option value="${esc(f.path)}">${f.main ? "📁 the project" : "📦"} ${esc(f.name)}</option>`).join("");
    }
    const now = this.root.querySelector<HTMLElement>(".mn-where-now")!;
    const folder = this.folder();
    const t = this.tab();
    if (!now.dataset.flash) now.innerHTML = folder ? `${t ? `<b>${esc(t.title)}</b> in ` : ""}<code>${esc(folder)}</code> <span class="lt-note">only you can see these · select to copy · Ctrl+[ sends Esc</span>` : "";
    this.root.querySelector<HTMLElement>(".mn-code")!.style.display = s?.code ? "" : "none";
    this.host.classList.toggle("mn-blank", !t);
  }

  private ensureTerm(): void {
    if (this.term) return;
    const term = new Terminal({ cursorBlink: true, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 13, theme: TERM_THEME, scrollback: 5000 });
    copyOnSelect(term);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(this.host);
    term.onData((data) => {
      const t = this.tab();
      if (t?.alive) this.send({ t: "mineInput", tabId: t.id, data });
    });
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.key === "Escape") {
        this.onEscape();
        return false;
      }
      return true;
    });
    this.term = term;
    this.fit = fit;
  }
}
