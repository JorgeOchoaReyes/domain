/**
 * The window frame every dialog uses: a dimmed backdrop, a paper card with a
 * header (icon, title, ✕) and a body, and an optional footer. Esc or ✕ closes
 * it. Only one is open at a time.
 */

export interface ModalOptions {
  title: string;
  icon?: string;
  /** Extra class on the card, for its own sizing (e.g. "wide"). */
  className?: string;
  body: HTMLElement | string;
  footer?: HTMLElement | string;
  /** Called after it closes, however it was closed. */
  onClose?: () => void;
  /** Return false to keep it open when Esc or ✕ is pressed. */
  canClose?: () => boolean;
}

export interface Modal {
  card: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement | null;
  close(): void;
}

let current: (Modal & { tryClose(): void }) | null = null;

export function modalOpen(): boolean {
  return current !== null;
}

/** Esc pressed: close the open modal if it allows. Returns true if one was open. */
export function escapeModal(): boolean {
  if (!current) return false;
  current.tryClose();
  return true;
}

let onModal: ((open: boolean) => void) | null = null;
/** Hear windows open and close (one swapped for another counts as an open). */
export function listenToModals(cb: (open: boolean) => void): void {
  onModal = cb;
}
let swapping = false;

export function openModal(opts: ModalOptions): Modal {
  swapping = true;
  current?.close();
  swapping = false;
  onModal?.(true);
  const backdrop = document.createElement("div");
  backdrop.className = "backdrop";
  const card = document.createElement("div");
  card.className = `modal ${opts.className ?? ""}`;
  card.innerHTML = `
    <header>
      ${opts.icon ? `<span class="m-icon">${opts.icon}</span>` : ""}
      <h2></h2>
      <button class="btn close" title="Close (Esc)" aria-label="Close">✕</button>
    </header>
    <div class="body"></div>`;
  card.querySelector("h2")!.textContent = opts.title;
  const body = card.querySelector<HTMLElement>(".body")!;
  if (typeof opts.body === "string") body.innerHTML = opts.body;
  else body.appendChild(opts.body);
  let footer: HTMLElement | null = null;
  if (opts.footer !== undefined) {
    footer = document.createElement("footer");
    if (typeof opts.footer === "string") footer.innerHTML = opts.footer;
    else footer.appendChild(opts.footer);
    card.appendChild(footer);
  }
  backdrop.appendChild(card);
  document.getElementById("hud")!.appendChild(backdrop);

  let closed = false;
  const modal = {
    card,
    body,
    footer,
    close: () => {
      if (closed) return;
      closed = true;
      backdrop.remove();
      if (current === modal) current = null;
      if (!swapping) onModal?.(false);
      opts.onClose?.();
    },
    tryClose: () => {
      if (opts.canClose && !opts.canClose()) return;
      modal.close();
    },
  };
  card.querySelector(".close")!.addEventListener("click", () => modal.tryClose());
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop) modal.tryClose();
  });
  current = modal;
  return modal;
}

/** Escape text for innerHTML. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
