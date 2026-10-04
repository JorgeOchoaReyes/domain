import type { AgentKind, Desk, OfficeState, Presentation } from "../shared/protocol.js";
import { AGENT_LABELS } from "../shared/protocol.js";
import { Net } from "./net.js";
import { World } from "./scene/world.js";
import { Player } from "./scene/player.js";
import { Hud } from "./ui/hud.js";
import { TerminalOverlay } from "./ui/terminal.js";
import { ReviewPanel } from "./ui/review.js";

const INTERACT_RADIUS = 2.4;
const PRESENCE_INTERVAL = 1000 / 15;

const canvas = document.getElementById("scene") as HTMLCanvasElement;
const hudRoot = document.getElementById("hud") as HTMLElement;

const world = new World(canvas);
const player = new Player(world, canvas);
const hud = new Hud(hudRoot);
const terminal = new TerminalOverlay(hudRoot);
const review = new ReviewPanel(hudRoot);
const net = new Net();

// Bottom banner nudging you to hold office hours when agents are waiting.
const presentAlert = document.createElement("div");
presentAlert.className = "present-alert card";
hudRoot.appendChild(presentAlert);

let selfId = "";
let office: OfficeState = { desks: [], peers: [], presentations: [] };
let joined = false;
/** Desk whose review we just submitted, waiting for it to leave the queue. */
let awaitingAdvance: string | null = null;

function deskById(id: string | null): Desk | undefined {
  return id ? office.desks.find((d) => d.id === id) : undefined;
}

// --- networking -------------------------------------------------------------

net.onStatus = (connected) => {
  hud.setConnected(connected);
  if (connected && joined) {
    const name = localStorage.getItem("domain.name") || "Guest";
    net.send({ t: "join", name });
  }
};

net.onMessage = (msg) => {
  switch (msg.t) {
    case "welcome":
      selfId = msg.selfId;
      office = msg.office;
      applyOffice();
      break;
    case "office":
      office = msg.office;
      applyOffice();
      break;
    case "output":
      if (terminal.isOpen && terminal.deskId === msg.deskId) terminal.write(msg.data);
      break;
    case "scrollback":
      if (terminal.isOpen && terminal.deskId === msg.deskId) terminal.write(msg.data);
      break;
    case "report":
      // The snapshot that follows updates the line; just nudge the banner now.
      updatePresentAlert();
      break;
  }
};

function applyOffice(): void {
  world.syncDesks(office.desks);
  world.syncWorkerAvatars(office.desks, office.presentations);
  world.syncPeers(office.peers, selfId);

  // If a terminal is open, reflect status changes and close it if the worker
  // was sent home (possibly by someone else).
  if (terminal.isOpen && terminal.deskId) {
    const desk = deskById(terminal.deskId);
    if (!desk?.worker) {
      closeTerminal();
    } else {
      terminal.setStatus(desk.worker.status);
    }
  }

  // Advance the review queue: once a reviewed worker has left the line, move
  // to the next presenter, or close office hours if the line is empty.
  if (review.isOpen && awaitingAdvance) {
    const stillThere = office.presentations.some((p) => p.deskId === awaitingAdvance);
    if (!stillThere) {
      awaitingAdvance = null;
      if (office.presentations.length > 0) openReview(office.presentations[0]);
      else closeReview();
    }
  }

  updatePresentAlert();
}

function updatePresentAlert(): void {
  const n = office.presentations.length;
  if (n > 0 && !review.isOpen && !terminal.isOpen && !hud.modalOpen) {
    presentAlert.innerHTML = `🔔 ${n} agent${n > 1 ? "s" : ""} waiting to present — <kbd>O</kbd> to hold office hours`;
    presentAlert.classList.add("show");
  } else {
    presentAlert.classList.remove("show");
  }
}

// --- interaction ------------------------------------------------------------

function closeTerminal(): void {
  terminal.close();
  player.enabled = true;
}

function openTerminal(deskId: string): void {
  const desk = deskById(deskId);
  if (!desk?.worker) return;
  const title = `${AGENT_LABELS[desk.worker.agent]} · hired by ${desk.worker.hiredBy}`;
  terminal.open(deskId, title, desk.worker.status, {
    onInput: (data) => net.send({ t: "input", deskId, data }),
    onResize: (cols, rows) => net.send({ t: "resize", deskId, cols, rows }),
    onFire: () => {
      net.send({ t: "fire", deskId });
      closeTerminal();
    },
    onClose: closeTerminal,
  });
  player.enabled = false;
  net.send({ t: "open", deskId });
}

function hire(deskId: string, agent: AgentKind): void {
  net.send({ t: "hire", deskId, agent });
  // The office snapshot will bring the new worker; open its terminal once it
  // arrives so the player sees the boot sequence.
  pendingOpen = deskId;
}
let pendingOpen: string | null = null;

// --- office hours (presentations) ------------------------------------------

function openReview(p: Presentation): void {
  player.enabled = false;
  hud.setPrompt(null);
  review.open(p, office.presentations.length, {
    onReview: (approve, text) => {
      net.send({ t: "review", deskId: p.deskId, approve, text });
      awaitingAdvance = p.deskId;
    },
    onClose: () => {
      awaitingAdvance = null;
      player.enabled = true;
      updatePresentAlert();
    },
  });
}

function closeReview(): void {
  review.close();
  awaitingAdvance = null;
  player.enabled = true;
  updatePresentAlert();
}

function enterOfficeHours(): void {
  if (review.isOpen || terminal.isOpen || hud.modalOpen) return;
  if (office.presentations.length === 0) return;
  openReview(office.presentations[0]);
}

function interact(): void {
  if (terminal.isOpen || hud.modalOpen || review.isOpen) return;
  const near = world.nearestDesk(player.position.x, player.position.z);
  if (!near || near.dist > INTERACT_RADIUS) return;
  const desk = deskById(near.id);
  if (!desk) return;
  if (desk.worker) {
    openTerminal(desk.id);
  } else {
    player.enabled = false;
    hud.openHireMenu(
      (agent) => {
        hire(desk.id, agent);
        player.enabled = true;
      },
      () => {
        player.enabled = true;
      },
    );
  }
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (terminal.isOpen) closeTerminal();
    else if (review.isOpen) closeReview();
    else if (hud.modalOpen) hud.cancelMenu();
    return;
  }
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  const key = e.key.toLowerCase();
  if (key === "e") interact();
  else if (key === "o") enterOfficeHours();
});

window.addEventListener("resize", () => world.resize());

// --- main loop --------------------------------------------------------------

let lastPresence = 0;
let last = performance.now();
let sentX = NaN;
let sentZ = NaN;
let sentFacing = NaN;

function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  player.update(dt);
  world.update(dt);

  // Prompt text when near a desk.
  if (!terminal.isOpen && !hud.modalOpen && !review.isOpen) {
    const near = world.nearestDesk(player.position.x, player.position.z);
    if (near && near.dist <= INTERACT_RADIUS) {
      const desk = deskById(near.id);
      if (desk?.worker) {
        hud.setPrompt(`<kbd>E</kbd> open ${AGENT_LABELS[desk.worker.agent]}'s terminal`);
      } else {
        hud.setPrompt(`<kbd>E</kbd> hire a worker at this desk`);
      }
    } else {
      hud.setPrompt(null);
    }
  }

  // Throttled presence updates.
  if (joined && now - lastPresence > PRESENCE_INTERVAL) {
    const p = player.position;
    const f = player.facing;
    if (p.x !== sentX || p.z !== sentZ || f !== sentFacing) {
      net.send({ t: "move", x: round(p.x), z: round(p.z), facing: round(f) });
      sentX = p.x;
      sentZ = p.z;
      sentFacing = f;
      lastPresence = now;
    }
  }

  // Open a freshly hired worker's terminal once it appears.
  if (pendingOpen && deskById(pendingOpen)?.worker) {
    const id = pendingOpen;
    pendingOpen = null;
    openTerminal(id);
  }

  world.render();
  requestAnimationFrame(frame);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// --- boot --------------------------------------------------------------------

hud.showJoin((name) => {
  joined = true;
  net.send({ t: "join", name });
});
net.connect();
requestAnimationFrame(frame);
