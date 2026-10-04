import type { ClientMessage, GuestRole, LanOffice } from "../../shared/protocol.js";
import { esc, openModal, type Modal } from "./modal.js";
import "../styles/lan.css";

/**
 * Joining someone's office on your network. A page opened from another
 * computer's address asks for the host's 6-digit code first (a full-screen
 * card, before the character picker), checks it, and remembers it for this
 * visit. Once in, the office tells us our role — visitor or teammate — for
 * the HUD to show and to hide what we can't do. "Nearby" lists offices
 * sharing on this network.
 */

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const storeKey = () => `domain.lan.code.${location.host}`;

let role: GuestRole | null = null;
let host = "";

/** True when this page comes from another computer's office (so we're a guest and need its code). */
export function needsPasscode(): boolean {
  return !LOCAL.has(location.hostname);
}

/** Our role in someone else's office, or null when this is our own office. */
export function guestRole(): GuestRole | null {
  return role;
}

/** Whose office we're in (when a guest). */
export function guestHost(): string {
  return host;
}

/** The office told us who we are (the `guest` message). */
export function setGuest(r: GuestRole, h: string): void {
  role = r;
  host = h;
  document.body.classList.toggle("is-guest", true);
  document.body.dataset.guest = r;
}

/** A small badge for the HUD: "👀 Visitor in Ann's office". Empty in your own office. */
export function guestBadge(): string {
  if (!role) return "";
  return `<span class="guest-badge ${role}" title="${role === "teammate" ? "You can run the work here" : "You can walk around and watch"}">${role === "teammate" ? "🤝 Teammate" : "👀 Visitor"}${host ? ` · ${esc(host)}'s office` : ""}</span>`;
}

function read(): string | null {
  try {
    return sessionStorage.getItem(storeKey());
  } catch {
    return null;
  }
}

function remember(code: string | null): void {
  try {
    if (code) sessionStorage.setItem(storeKey(), code);
    else sessionStorage.removeItem(storeKey());
  } catch {
    /* storage blocked */
  }
}

/** Ask the office whether a code is right (wrong guesses are rate-limited there). */
async function check(code: string): Promise<{ ok: true; role: GuestRole; host: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/__domain/lan-check?code=${encodeURIComponent(code)}`, { cache: "no-store" });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; role?: GuestRole; host?: string; error?: string };
    if (res.ok && body.ok) return { ok: true, role: body.role === "teammate" ? "teammate" : "visitor", host: body.host ?? "" };
    return { ok: false, error: body.error ?? (res.status === 429 ? "Too many wrong codes. Wait a minute." : "That code isn't right.") };
  } catch {
    return { ok: false, error: "Can't reach this office. Is the host still sharing, and are you on the same Wi-Fi?" };
  }
}

/**
 * The join card: ask for the host's code, check it, remember it for this
 * visit. Resolves with a code that works. Tries a remembered code first,
 * silently, unless `error` says the last one stopped working.
 */
export async function askPasscode(error?: string): Promise<string> {
  const saved = error ? null : read();
  if (saved) {
    const r = await check(saved);
    if (r.ok) {
      setGuest(r.role, r.host);
      return saved;
    }
    remember(null);
  }
  return new Promise((resolve) => {
    const el = document.createElement("div");
    el.className = "join-screen";
    el.innerHTML = `
      <div class="join-card">
        <div class="join-icon">📡</div>
        <h1>Join this office</h1>
        <p>You're joining an office on your network at <b>${esc(location.host)}</b>.<br/>Ask the person who invited you for the <b>6-digit code</b>.</p>
        <form class="join-form">
          <input class="join-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••" aria-label="Passcode" />
          <button class="btn primary join-go" type="submit">Join</button>
        </form>
        <p class="join-error">${error ? esc(error) : ""}</p>
        <p class="join-hint">Both computers need to be on the same Wi-Fi. The code is on the host's <b>Invite</b> window.</p>
      </div>`;
    document.body.appendChild(el);
    const input = el.querySelector<HTMLInputElement>(".join-code")!;
    const err = el.querySelector<HTMLElement>(".join-error")!;
    const go = el.querySelector<HTMLButtonElement>(".join-go")!;
    input.addEventListener("input", () => {
      input.value = input.value.replace(/\D/g, "").slice(0, 6);
      if (input.value.length === 6) el.querySelector<HTMLFormElement>(".join-form")!.requestSubmit();
    });
    el.querySelector<HTMLFormElement>(".join-form")!.addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = input.value.trim();
      if (!/^\d{6}$/.test(code)) {
        err.textContent = "The code is 6 digits.";
        return;
      }
      go.disabled = true;
      go.textContent = "Checking…";
      const r = await check(code);
      go.disabled = false;
      go.textContent = "Join";
      if (!r.ok) {
        err.textContent = r.error;
        input.select();
        el.querySelector(".join-card")!.classList.remove("shake");
        void (el.querySelector(".join-card") as HTMLElement).offsetWidth;
        el.querySelector(".join-card")!.classList.add("shake");
        return;
      }
      remember(code);
      setGuest(r.role, r.host);
      el.remove();
      resolve(code);
    });
    setTimeout(() => input.focus(), 0);
  });
}

/** Shown when a guest's connection ends: the host stopped sharing, or the office is gone. */
export function showDisconnected(reason: "stopped" | "unreachable", onRetry: () => void): void {
  const el = document.createElement("div");
  el.className = "join-screen";
  el.innerHTML = `
    <div class="join-card">
      <div class="join-icon">${reason === "stopped" ? "👋" : "📴"}</div>
      <h1>${reason === "stopped" ? "The host stopped sharing" : "Lost the office"}</h1>
      <p>${reason === "stopped" ? `${esc(host || "The host")} closed their office to the network.` : "This office can't be reached right now — the host may have stopped sharing, or changed the code."}</p>
      <button class="btn primary retry">Try again</button>
    </div>`;
  document.body.appendChild(el);
  el.querySelector(".retry")!.addEventListener("click", () => {
    el.remove();
    remember(null);
    onRetry();
  });
}

// --- nearby offices ----------------------------------------------------------------

let nearby: Modal | null = null;
let nearbyList: HTMLElement | null = null;

/** Offices found on the network (the `lanOffices` message). */
export function showNearby(offices: LanOffice[]): void {
  if (!nearbyList || !nearby) return;
  nearbyList.innerHTML = offices.length
    ? offices
        .map(
          (o) => `<li class="nb-office">
            <span class="nb-icon">🏢</span>
            <span class="nb-main"><b>${esc(o.name)}'s office</b><span>${esc(o.project)} · ${o.players} here · ${esc(o.url.replace("http://", ""))}</span></span>
            <a class="btn primary" href="${esc(o.url)}">Join</a>
          </li>`,
        )
        .join("")
    : `<li class="nb-empty">No offices found on this network.<br/>Ask the host for their address (it's on their <b>Invite</b> window) and type it below. Firewalls can hide offices from the list even when they're reachable.</li>`;
}

/** "Nearby": offices sharing on this Wi-Fi, plus a box to type an address. */
export function openNearby(ctx: { send(msg: ClientMessage): void }): void {
  const body = document.createElement("div");
  body.className = "nearby";
  body.innerHTML = `
    <p class="as-note">Offices on your Wi-Fi that are sharing right now. Joining asks for the host's 6-digit code.</p>
    <ul class="nb-list"><li class="nb-empty">🔎 Looking around your network…</li></ul>
    <form class="nb-form"><input type="text" placeholder="Or type an address, e.g. 192.168.1.23:8788" /><button class="btn" type="submit">Go</button></form>`;
  nearbyList = body.querySelector(".nb-list");
  nearby = openModal({
    title: "Offices nearby",
    icon: "📡",
    className: "nearby-modal",
    body,
    footer: `<button class="btn rescan">🔄 Look again</button><span class="grow">Same Wi-Fi only · the host shares from their Invite window</span>`,
    onClose: () => {
      nearby = null;
      nearbyList = null;
    },
  });
  const input = body.querySelector<HTMLInputElement>(".nb-form input")!;
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") e.stopPropagation();
  });
  body.querySelector<HTMLFormElement>(".nb-form")!.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    location.href = /^https?:\/\//.test(v) ? v : `http://${v}`;
  });
  const scan = () => {
    if (nearbyList) nearbyList.innerHTML = `<li class="nb-empty">🔎 Looking around your network…</li>`;
    ctx.send({ t: "lanDiscover" });
  };
  nearby.footer!.querySelector(".rescan")!.addEventListener("click", scan);
  scan();
}
