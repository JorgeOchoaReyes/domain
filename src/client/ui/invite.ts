import type { ClientMessage, GuestRole, ServerMessage } from "../../shared/protocol.js";
import { esc, openModal, type Modal } from "./modal.js";
import { setGuest, showNearby } from "./join.js";
import "../styles/lan.css";

/**
 * Inviting people on your Wi-Fi into your office. Pick what guests may do —
 * visit (walk around, watch) or work with you as teammates (who can type into
 * your workers' terminals, which run on this computer) — and share the
 * 6-digit code and the address. The window shows who's joined, lets you
 * change the role for new arrivals, and stops sharing.
 */

export interface LanActions {
  send(msg: ClientMessage): void;
}

interface LanState {
  on: boolean;
  urls: string[];
  code: string | null;
  role: GuestRole;
  guests: number;
}

let state: LanState = { on: false, urls: [], code: null, role: "visitor", guests: 0 };
let modal: Modal | null = null;
let actions: LanActions | null = null;
let pendingRole: GuestRole = "visitor";
let starting = false;
const listeners = new Set<() => void>();

/** The sharing state, for the HUD. */
export function lanState(): Readonly<LanState> {
  return state;
}

/** Hear when sharing starts, stops or guests come and go (to refresh a HUD chip). */
export function onLanChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Feed every server message through here (lan, lanOffices, guest). */
export function ingestLan(msg: ServerMessage): void {
  if (msg.t === "lan") {
    const before = state;
    state = { on: msg.on, urls: msg.urls, code: msg.code, role: msg.role, guests: msg.guests };
    starting = false;
    if (modal && actions) render();
    if (before.on !== state.on || before.guests !== state.guests || before.role !== state.role) for (const fn of listeners) fn();
  } else if (msg.t === "lanOffices") {
    showNearby(msg.offices);
  } else if (msg.t === "guest") {
    setGuest(msg.role, msg.host);
  }
}

/** "📡 Sharing · 2 guests" while sharing; empty otherwise. */
export function lanChip(): string {
  if (!state.on) return "";
  return `<span class="lan-chip" title="Your office is open on your network (${state.role === "teammate" ? "teammates" : "visitors"})">📡 Sharing · ${state.guests} guest${state.guests === 1 ? "" : "s"}</span>`;
}

const ROLE_TEXT: Record<GuestRole, { icon: string; title: string; text: string }> = {
  visitor: { icon: "👀", title: "Visitors", text: "Walk around, watch the workers and their screens, see the goals. They can't change anything." },
  teammate: {
    icon: "🤝",
    title: "Teammates",
    text: "Everything visitors can, plus hire workers, hand out tasks, review and ship. They can type into your workers' terminals — which run on this computer — so only invite people you trust.",
  },
};

function roleCards(selected: GuestRole): string {
  return (Object.keys(ROLE_TEXT) as GuestRole[])
    .map(
      (r) => `<button class="lan-role ${r === selected ? "on" : ""} ${r}" data-role="${r}">
        <span class="lr-icon">${ROLE_TEXT[r].icon}</span>
        <b>${ROLE_TEXT[r].title}</b>
        <span>${esc(ROLE_TEXT[r].text)}</span>
      </button>`,
    )
    .join("");
}

function render(): void {
  if (!modal || !actions) return;
  const body = modal.body;
  if (!state.on) {
    body.innerHTML = `
      <div class="lan-intro">
        <div class="lan-steps">
          <div><span>1</span>Pick what guests can do</div>
          <div><span>2</span>Share the code and address</div>
          <div><span>3</span>They open it on the same Wi-Fi</div>
        </div>
      </div>
      <h4 class="lan-h">Guests can be</h4>
      <div class="lan-roles">${roleCards(pendingRole)}</div>
      <p class="as-note">Only people on your network can reach it, and only with the code. You can stop sharing any time.</p>`;
    body.querySelectorAll<HTMLElement>(".lan-role").forEach((b) =>
      b.addEventListener("click", () => {
        pendingRole = b.dataset.role as GuestRole;
        render();
      }),
    );
    modal.footer!.innerHTML = `<span class="grow">Your office stays private until you start sharing</span><button class="btn primary start">${starting ? "Opening…" : "📡 Start sharing"}</button>`;
    const start = modal.footer!.querySelector<HTMLButtonElement>(".start")!;
    start.disabled = starting;
    start.addEventListener("click", () => {
      starting = true;
      actions!.send({ t: "lanStart", role: pendingRole });
      render();
    });
    return;
  }
  const code = state.code ?? "······";
  body.innerHTML = `
    <div class="lan-live">
      <div class="lan-code-box">
        <span class="lan-label">Passcode</span>
        <div class="lan-code" aria-label="Passcode ${esc(code.split("").join(" "))}">${esc(code.slice(0, 3))}<i></i>${esc(code.slice(3))}</div>
        <button class="btn small copy" data-copy="${esc(code)}">Copy code</button>
      </div>
      <div class="lan-where">
        <span class="lan-label">They open</span>
        ${
          state.urls.length
            ? state.urls
                .map((u) => `<div class="lan-url"><code>${esc(u)}</code><button class="btn small copy" data-copy="${esc(u)}">Copy</button></div>`)
                .join("")
            : `<p class="as-note">No network address found — is this computer on Wi-Fi?</p>`
        }
        <p class="as-note">…in a browser on the same Wi-Fi, or find you under <b>Nearby</b> in their domain app.</p>
      </div>
    </div>
    <div class="lan-guests">${state.guests ? `🧑‍🤝‍🧑 <b>${state.guests}</b> guest${state.guests === 1 ? "" : "s"} here` : "Nobody's joined yet."}</div>
    <h4 class="lan-h">New guests join as</h4>
    <div class="lan-roles">${roleCards(state.role)}</div>
    <p class="as-note">Can't connect? Windows may ask to allow domain on <b>private networks</b> — say yes (or allow it in Windows Defender Firewall).</p>`;
  body.querySelectorAll<HTMLButtonElement>(".copy").forEach((b) =>
    b.addEventListener("click", () => {
      void navigator.clipboard?.writeText(b.dataset.copy ?? "").then(() => {
        b.textContent = "Copied ✓";
        setTimeout(() => (b.textContent = b.dataset.copy === code ? "Copy code" : "Copy"), 1500);
      });
    }),
  );
  body.querySelectorAll<HTMLElement>(".lan-role").forEach((b) =>
    b.addEventListener("click", () => {
      const r = b.dataset.role as GuestRole;
      if (r !== state.role) actions!.send({ t: "lanStart", role: r });
    }),
  );
  modal.footer!.innerHTML = `<span class="grow">Sharing on your network · ${state.role === "teammate" ? "teammates" : "visitors"}</span><button class="btn danger stop">Stop sharing</button>`;
  modal.footer!.querySelector(".stop")!.addEventListener("click", () => actions!.send({ t: "lanStop" }));
}

/** The Invite window. */
export function openInvite(ctx: LanActions): void {
  actions = ctx;
  pendingRole = state.role;
  modal = openModal({
    title: "Invite people",
    icon: "📡",
    className: "invite-modal",
    body: document.createElement("div"),
    footer: document.createElement("div"),
    onClose: () => {
      modal = null;
    },
  });
  render();
}
