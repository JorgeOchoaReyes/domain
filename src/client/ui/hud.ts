import { AGENT_KINDS, AGENT_LABELS, type AgentKind } from "../../shared/protocol.js";

const AGENT_DOT: Record<AgentKind, string> = {
  claude: "#c58bff",
  codex: "#4ade80",
  opencode: "#38bdf8",
  gemini: "#fbbf24",
};

/**
 * All the 2D overlay chrome: the join screen, connection badge, controls hint,
 * the center interaction prompt, and the hire menu. It is a thin view layer —
 * it raises callbacks and holds no game state.
 */
export class Hud {
  private root: HTMLElement;
  private connEl!: HTMLElement;
  private promptEl!: HTMLElement;
  private menuEl: HTMLElement | null = null;

  /** True while any modal (join or menu) owns the screen. */
  get modalOpen(): boolean {
    return this.menuEl !== null || this.joinOpen;
  }
  private joinOpen = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.buildStatic();
  }

  private buildStatic(): void {
    const brand = document.createElement("div");
    brand.className = "brand card";
    brand.innerHTML = `<h1>domain</h1><span class="conn">connecting…</span>`;
    this.root.appendChild(brand);
    this.connEl = brand.querySelector(".conn")!;

    const hint = document.createElement("div");
    hint.className = "hint card";
    hint.innerHTML = `
      <div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move · drag to look · scroll to zoom</div>
      <div><kbd>E</kbd> interact with a desk · <kbd>O</kbd> office hours · <kbd>Esc</kbd> close</div>`;
    this.root.appendChild(hint);

    this.promptEl = document.createElement("div");
    this.promptEl.className = "prompt card";
    this.root.appendChild(this.promptEl);
  }

  setConnected(connected: boolean): void {
    this.connEl.textContent = connected ? "connected" : "reconnecting…";
    this.connEl.classList.toggle("ok", connected);
    this.connEl.classList.toggle("down", !connected);
  }

  setPrompt(html: string | null): void {
    if (html && !this.modalOpen) {
      this.promptEl.innerHTML = html;
      this.promptEl.classList.add("show");
    } else {
      this.promptEl.classList.remove("show");
    }
  }

  // --- join ---------------------------------------------------------------

  showJoin(onJoin: (name: string) => void): void {
    this.joinOpen = true;
    const overlay = document.createElement("div");
    overlay.className = "join interactive";
    overlay.innerHTML = `
      <div class="box card">
        <h1>domain</h1>
        <p>A 3D room where you put coding agents to work at desks.</p>
        <input type="text" maxlength="24" placeholder="Your name" />
        <button>Enter the office</button>
      </div>`;
    this.root.appendChild(overlay);
    const input = overlay.querySelector("input")!;
    const button = overlay.querySelector("button")!;
    const saved = localStorage.getItem("domain.name");
    if (saved) input.value = saved;
    const submit = () => {
      const name = input.value.trim() || "Guest";
      localStorage.setItem("domain.name", name);
      overlay.remove();
      this.joinOpen = false;
      onJoin(name);
    };
    button.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    setTimeout(() => input.focus(), 0);
  }

  // --- hire menu ----------------------------------------------------------

  openHireMenu(onPick: (agent: AgentKind) => void, onCancel: () => void): void {
    this.closeMenu();
    const menu = document.createElement("div");
    menu.className = "menu card interactive";
    const rows = AGENT_KINDS.map(
      (k) =>
        `<button class="row" data-agent="${k}"><span class="dot" style="background:${AGENT_DOT[k]}"></span>${AGENT_LABELS[k]}</button>`,
    ).join("");
    menu.innerHTML = `<h2>Hire a worker</h2>${rows}<div class="close">Esc to cancel</div>`;
    this.root.appendChild(menu);
    this.menuEl = menu;
    this.setPrompt(null);

    menu.querySelectorAll<HTMLButtonElement>(".row").forEach((btn) => {
      btn.addEventListener("click", () => {
        const agent = btn.dataset.agent as AgentKind;
        this.closeMenu();
        onPick(agent);
      });
    });
    // Remember the cancel handler so Esc (handled in main) can call closeMenu.
    this.cancelMenu = () => {
      this.closeMenu();
      onCancel();
    };
    const first = menu.querySelector<HTMLButtonElement>(".row");
    first?.focus();
  }

  /** Invoked by main.ts on Esc; no-op if no menu is open. */
  cancelMenu: () => void = () => {};

  closeMenu(): void {
    this.menuEl?.remove();
    this.menuEl = null;
    this.cancelMenu = () => {};
  }
}
