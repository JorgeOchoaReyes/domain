import { ingestAlumni, openFire } from "./ui/fire.js";
import { ingestLessons, openLessons } from "./ui/lessons.js";
import { ingestSkills } from "./ui/skills.js";
import { ingestVoices, osDictationHint, speak, useVoices } from "./voice.js";
import { openVoices } from "./ui/voices.js";
import { openGiveTask } from "./ui/waiting.js";
import type { AgentKind, ClientMessage, Desk, Look, OfficeState, Presentation } from "../shared/protocol.js";
import { mayDirect, AGENT_KINDS, AGENT_LABELS, DEFAULT_LOOK, coerceLook } from "../shared/protocol.js";
import {
  ARCADES,
  DESK_BY_ID,
  ELEVATOR,
  FLOOR,
  HOOP,
  KITCHEN,
  REVIEW_SPOT,
  MONITOR_CHAIR,
  OFFICE_ARMCHAIRS,
  SPAWN,
  STANDUP,
  WORK_PAD,
  arcadeSpot,
  roomAt,
  deskSeat,
  type RoomId,
  type IdeaBoardId,
  IDEA_BOARDS,
  JUKEBOXES,
  GONG,
} from "../shared/layout.js";
import { ALL_ARCADES, BAY_DESK_IDS, UPSTAIRS, UP_ELEVATOR, WORK_SPOTS, inUpstairs, TEAM_FLOOR, TEAM_ELEVATOR, inTeamFloor, floorOf, type WorkSpot } from "../shared/layout.js";
import { Activities } from "./ui/activities.js";
import { myLaptopProp } from "./scene/laptop.js";
import { Net } from "./net.js";
import { World } from "./scene/world.js";
import { Player, type ViewMode } from "./scene/player.js";
import { ShotMeter } from "./scene/minigames.js";
import { openArcade, arcadeBest } from "./ui/arcade.js";
import { openStandup, standupDraftArrived, type StandupPlan } from "./ui/standup.js";
import { openTeleport, placeDestinations, teleportFlash, type Destination } from "./ui/teleport.js";
import { Minimap } from "./ui/minimap.js";
import { ObjectiveTracker, nextObjective, type Objective } from "./ui/objective.js";
import { MyLaptop } from "./ui/mylaptop.js";
import { ROLES, roleCharacter } from "../shared/roles.js";
import { openMonitor, type MonitorActions, type MonitorView } from "./ui/monitor.js";
import { cameras } from "./scene/monitorwall.js";
import { openDeck, refreshDeck } from "./ui/deck.js";
import { loadSettings, openSettings, saveSettings, type Settings } from "./ui/settings.js";
import { Music } from "./music.js";
import { openJukebox } from "./ui/jukebox.js";
import { TeamChat } from "./ui/chat.js";
import { ingestHistory, openHistory } from "./ui/history.js";
import { Reminders } from "./ui/reminders.js";
import { Phone } from "./ui/phone.js";
import { TEAM_THREAD } from "../shared/chat.js";
import type { ChatThread } from "../shared/chat.js";
import { openAssignCard } from "./ui/assign.js";
import { Assistant, type Guide, type Tip, type TourStep } from "./ui/assistant.js";
import { ingestLan, lanChip, onLanChange, openInvite } from "./ui/invite.js";
import { askPasscode, guestBadge, guestRole, needsPasscode, openNearby, showDisconnected } from "./ui/join.js";
import { githubTools, ingestMcp, openMcp } from "./ui/mcp.js";
import { ingestLogs, openLogs } from "./ui/logs.js";
import { openOfficeMenu, type OfficeTile } from "./ui/officemenu.js";
import { ingestProjects, openProjects, projectBadge, projectState } from "./ui/projects.js";
import { ingestGithub } from "./ui/github.js";
import { agentsState, ingestAgents, installAgent, isInstalled, setAgentsSender } from "./ui/agents.js";
import { openHire, openTeam, type TeamContext } from "./ui/team.js";
import { openPolicy } from "./ui/policy.js";
import type { LoopHandlers } from "./ui/loop.js";
import { openHuddle } from "./ui/huddle.js";
import { ingestDemo, openDemo } from "./ui/demo.js";
import { Hud } from "./ui/hud.js";
import { TerminalOverlay } from "./ui/terminal.js";
import { ReviewPanel } from "./ui/review.js";
import { ProjectorReview } from "./ui/projector.js";
import { IdeaBoard } from "./ui/ideas.js";
import { VR } from "./vr/xr.js";
import { VrFlows } from "./vr/flows.js";
import type { Idea } from "../shared/ideas.js";
import { pickCharacter } from "./ui/charpick.js";
import { esc, escapeModal, modalOpen } from "./ui/modal.js";
import { GoalsWindow } from "./ui/goals.js";
import { SessionPill, listenForRecap, openStartSession, showSessionSummary } from "./ui/session.js";
import { PlayerCard, blankStats, openProfile } from "./ui/profile.js";
import { confetti, engine, floatXp, isMuted, setFxVolume, setMuted, sound } from "./ui/fx.js";
import { carNear, exitSpot } from "./scene/cars.js";
import { Ambience } from "./ambience.js";
import { listenToFrontDoors } from "./scene/rooms.js";
import { listenToModals } from "./ui/modal.js";
import { isIndoors } from "../shared/layout.js";
import { ACHIEVEMENTS, EMPTY_PROGRESS, sessionLength, type Goal, type ProgressState } from "../shared/progress.js";
import * as THREE from "three";
import "./styles/main.css";

const INTERACT_RADIUS = 1.9;
const PRESENCE_INTERVAL = 1000 / 15;

// --- who you are ---------------------------------------------------------------

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked */
  }
}
let myName = load<string>("domain.name.v2", "");
let myLook: Look = coerceLook(load<unknown>("domain.look", DEFAULT_LOOK));

// --- the pieces ------------------------------------------------------------------

const canvas = document.getElementById("scene") as HTMLCanvasElement;
const hudRoot = document.getElementById("hud") as HTMLElement;

const world = new World(canvas, myLook, myName || "You");
const player = new Player(world, canvas, load<ViewMode>("domain.view", "first") === "third" ? "third" : "first");
player.onStand = () => {
  world.setSeated(false);
  // Up from the monitor wall's chair: the arrows walk again.
  if (world.cctv.seated) {
    world.setCctv({ seated: false });
    player.arrowsTaken = false;
  }
};
player.onView = (mode) => {
  save("domain.view", mode);
  document.body.classList.toggle("fp", mode === "first");
};
document.body.classList.toggle("fp", player.view === "first");
/** When the mouse capture last ended, so the Esc that ended it doesn't also open settings. */
let unlockedAt = 0;
player.onStep = (kind) => (kind === "land" ? sound.land() : sound.step());
player.onCrash = (speed) => sound.crash(speed);
// A hidden window stops the game loop: the engine mustn't drone on meanwhile (it picks up again when you are back).
document.addEventListener("visibilitychange", () => document.hidden && engine(null));
player.onLock = (locked) => {
  document.body.classList.toggle("mouse-captured", locked);
  if (!locked) unlockedAt = performance.now();
};
let settings: Settings = loadSettings();
/** The background music (composed live); the jukeboxes and Settings pick it. */
const music = new Music();
// Browsers only let sound start after you click or press a key: start it then.
/** The sound of the place: hum and keyboards indoors, wind and birds out; Settings has its volume. */
const ambience = new Ambience();
const startMusic = () => {
  music.set({ on: settings.music, track: settings.track, volume: settings.musicVolume });
  ambience.set({ on: settings.ambience, volume: settings.ambienceVolume });
};
listenToFrontDoors((opening) => sound.door(opening));
listenToModals((open) => (open ? sound.open() : sound.close()));
window.addEventListener("pointerdown", startMusic, { once: true });
window.addEventListener("keydown", startMusic, { once: true });
let lastQuality: Settings["graphics"] | null = null;
world.onAutoQuality = (q) => {
  settings = { ...settings, graphics: q };
  lastQuality = q;
  saveSettings(settings);
  hud.toast(`🩺 Things were running slow, so graphics are now ${q === "fast" ? "Fast" : "Balanced"} — change it in Settings (Esc)`);
};
function applySettings(s: Settings): void {
  settings = s;
  player.applySettings(s);
  world.setShowHand(s.hand);
  world.setDayNight(s.dayNight);
  if (lastQuality !== s.graphics) {
    lastQuality = s.graphics;
    world.setQuality(s.graphics);
  }
  world.autoQuality = s.autoGraphics;
  minimap?.el.classList.toggle("hidden", !s.minimap);
  // Before your first click the music waits (see startMusic); after it, changes apply at once.
  if (music.playing || !s.music) music.set({ on: s.music, track: s.track, volume: s.musicVolume });
  if (ambience.playing || !s.ambience) ambience.set({ on: s.ambience, volume: s.ambienceVolume });
  setFxVolume(s.fxVolume);
}
const terminal = new TerminalOverlay();
const review = new ReviewPanel();
/** Office hours on the projector (Settings → Office hours). */
const projector = new ProjectorReview();
/** Whether office hours are on, either way. */
const reviewing = () => review.isOpen || projector.isOpen;
const net = new Net();
setAgentsSender((m) => net.send(m));
const hud = new Hud(hudRoot, {
  // A worker in the list opens its channel: what it's doing now, its record, the chat, and its terminal.
  onOpenWorker: (deskId) => (guestRole() === "visitor" ? openTerminal(deskId) : openChat(deskId)),
  onRoundup: () => openRoundup(),
  onOfficeHours: () => startOfficeHours(),
  onGoals: () => openGoals(),
  onFocus: () => openFocus(),
  onProfile: () => openProfile(me(), progress),
  onStandup: () => openStandupNow(),
  onTravel: () => openTravel(),
  onLaptop: () => openLaptop(),
  onMonitor: () => openMonitorNow(),
  onSettings: () => openSettingsNow(),
});
const minimap = new Minimap(hudRoot, () => openTravel());
const objective = new ObjectiveTracker(hudRoot, (o) => doObjective(o));
/** Arnold, the assistant: reminders, "what now?", and the guided tour. */
const assistant = new Assistant(hudRoot, {
  tips: () => pipTips(),
  tour: () => pipTour(),
  whatNow: () => {
    const o = nextObjective(progress, office.desks, office.presentations);
    return { id: "whatnow", urgency: 1, text: `Next: ${o.text}`, action: { label: o.key ? `Do it (${o.key})` : "Do it", run: () => doObjective(o) } };
  },
  freeMouse: () => player.unlock(),
  busy: () => modalOpen() || reviewing() || terminal.isOpen,
  guides: () => pipGuides(),
  cheer: (final) => {
    if (final) {
      sound.levelUp();
      confetti(140);
    } else sound.xp();
  },
});
/** When you last pressed a key or clicked (Arnold only nudges after a quiet spell). */
let lastActivity = performance.now();
for (const ev of ["keydown", "pointerdown"]) window.addEventListener(ev, () => (lastActivity = performance.now()), { capture: true, passive: true });
/**
 * ⚡ Quick start: three ready-made agents (a builder, a tester, a reviewer) at
 * the first free desks, then the stand-up — say what you want, and they're
 * on it. The fastest way from opening the office to agents at work.
 */
function quickStart(): void {
  const free = office.desks.filter((d) => !d.worker && !BAY_DESK_IDS.includes(d.id));
  const taken = progress.team.map((c) => c.name);
  const hired: string[] = [];
  for (const id of ["builder", "tester", "reviewer"]) {
    const desk = free.shift();
    const role = ROLES.find((r) => r.id === id);
    if (!desk || !role) break;
    const agent = isInstalled(role.agent) ? role.agent : (AGENT_KINDS.find((k) => isInstalled(k)) ?? role.agent);
    const c = roleCharacter(role, [...taken, ...hired], agent);
    hired.push(c.name);
    net.send({ t: "characterSave", character: c });
    net.send({ t: "hire", deskId: desk.id, agent: c.agent, characterId: c.id });
  }
  hud.toast(hired.length ? `⚡ ${hired.join(", ")} are on their way to their desks — now say what you want done` : "No free desks for a quick start");
  setTimeout(() => openStandupNow(), 1200);
}

/** A first visit: Arnold offers the tour before the first stand-up. */
let welcomeDue = false;
applySettings(settings);

function openSettingsNow(): void {
  if (modalOpen()) return;
  openSettings(settings, applySettings, {
    firstPerson: player.view === "first",
    muted: isMuted(),
    setFirstPerson: (on) => player.setView(on ? "first" : "third"),
    setMuted: (on) => {
      setMuted(on);
      refreshGame();
    },
    openHelp: () => hud.openHelp(),
  });
}
const shotMeter = new ShotMeter();
// The Office menu: projects and GitHub, your team, MCP tools, inviting people, logs.
const officeBtn = document.createElement("button");
officeBtn.className = "btn dock-btn";
officeBtn.dataset.act = "office";
officeBtn.title = "Office: projects & GitHub, your team, MCP tools, invite people, logs";
officeBtn.innerHTML = `🏢 <span class="lbl">Office</span>`;
officeBtn.addEventListener("click", () => openOfficeMenuNow());
hudRoot.querySelector('.dock [data-act="settings"]')?.before(officeBtn);
/** The Office menu's tiles (features add theirs here). */
const officeTiles: OfficeTile[] = [
  { key: "projects", icon: "github", title: "Projects & GitHub", text: "Which project your workers are on — switch, or clone one from GitHub", run: () => openProjects(projectActions()) },
  { key: "team", icon: "👥", title: "Your team", text: "Characters with names, looks, voices and personas you hire again and again", run: () => openTeam(teamCtx()) },
  { key: "voices", icon: "🗣", title: "Voices", text: "Lifelike ElevenLabs voices for your workers, with your API key", run: () => openVoices((m) => net.send(m), !guestRole()) },
  { key: "lessons", icon: "📚", title: "Lessons", text: "What your team has learned from your feedback and each other — and the end-of-day sync", run: () => openLessons((m) => net.send(m), guestRole() !== "visitor") },
  { key: "history", icon: "📜", title: "History", text: "Everything you and your workers have done — by day, or by worker", run: () => openHistory((m) => net.send(m)) },
  { key: "chat", icon: "💬", title: "Team chat", text: "Message any worker, or everyone — see what each is doing and what it has done", run: () => openChat() },
  { key: "ideas", icon: "💡", title: "Idea board", text: "Sketch an idea and hand it to a worker, or make it a goal — also at the whiteboards", run: () => openIdeas(null) },
  { key: "mcp", icon: "mcp", title: "MCP tools", text: "Tools your workers can use — add once, give to whoever needs them", hostOnly: true, run: () => openMcp({ progress: () => progress, send: (m) => net.send(m), isHost: () => !guestRole() }) },
  { key: "invite", icon: "📡", title: "Invite people", text: "Share your office with people on your Wi-Fi, with a passcode", hostOnly: true, run: () => openInviteNow() },
  { key: "nearby", icon: "📶", title: "Join a nearby office", text: "Offices shared on your network", hostOnly: true, run: () => openNearby({ send: (m) => net.send(m) }) },
  { key: "logs", icon: "log", title: "Logs", text: "Every git, GitHub, MCP, check and deploy step, with output", run: () => openLogs() },
];
function openOfficeMenuNow(): void {
  if (modalOpen()) return;
  openOfficeMenu(officeTiles, !!guestRole());
}
const lanChipEl = document.createElement("div");
lanChipEl.className = "lan-chip-slot";
hudRoot.querySelector(".project")?.appendChild(lanChipEl);
onLanChange(() => (lanChipEl.innerHTML = lanChip()));
function openInviteNow(): void {
  if (modalOpen() || guestRole()) return;
  openInvite({ send: (m) => net.send(m) });
}
function showGuestBadge(): void {
  const role = guestRole();
  document.body.dataset.guest = role ?? "";
  if (!role || hud.leftEl.querySelector(".guest-badge-slot")) return;
  const b = document.createElement("span");
  b.className = "guest-badge-slot";
  b.innerHTML = guestBadge();
  hud.leftEl.appendChild(b);
}

const playChip = document.createElement("div");
playChip.className = "play-chip panel";
playChip.innerHTML = `<span class="key">Tab</span> Menu`;
hudRoot.appendChild(playChip);
const crosshair = document.createElement("div");
crosshair.className = "crosshair";
hudRoot.appendChild(crosshair);
for (const a of ARCADES) world.gameRoom.setBest(a.id, arcadeBest(a.id));
/** What the loop controls (in the Goals window and on your laptop) can do. */
const loopHandlers: LoopHandlers = {
  send: (m) => {
    // A worker's terminal resized here: its laptop (and the monitors) follow, so lines wrap as they do there.
    if (m.t === "resize") world.resizeTerminal(m.deskId, m.cols, m.rows);
    net.send(m);
  },
  roundup: () => openRoundup(),
  officeHours: () => startOfficeHours(),
  openDeck: (goal) => openDeck(goal),
  openLaptop: (app) => laptop.open(app),
  assign: (goalId, taskId, deskId) => openAssignFor(goalId, taskId, deskId),
  openHuddle: (goal) => openHuddle(goal.id, { goal: goalById, desks: () => office.desks, send: (m) => net.send(m) }),
  openDemo: (goal) => openDemo(goal.id, { goal: goalById, send: (m) => net.send(m) }),
  hire: () => {
    escapeModal();
    if (here !== "floor") travelTo({ label: "Work floor", icon: "🖥", ...SPAWN });
    hud.toast("🪑 Walk to a desk with a green + and press E to hire");
  },
};
/** The Agent monitor: every worker's live CLI at once (K, the monitor wall, the laptop, the phone). */
const monitorActions: MonitorActions = {
  office: () => office,
  progress: () => progress,
  send: (m) => net.send(m),
  paintTerminal: (deskId, g, x, y, w, h) => world.paintTerminal(deskId, g, x, y, w, h),
  terminalVersion: (deskId) => world.terminalVersion(deskId),
  canType: () => guestRole() !== "visitor",
  me: () => myName,
  mayDirect: (deskId) => mayDirect(deskById(deskId)?.worker, { name: myName, host: !guestRole() }, [myName, ...office.peers.map((p) => p.name)]),
  openTerminal: (deskId) => openTerminal(deskId),
  goToDesk: (deskId) => {
    escapeModal();
    goToDesk(deskId);
  },
};
let monitorView: MonitorView | null = null;
function openMonitorNow(focus?: string): void {
  if (reviewing()) return;
  phone.close();
  monitorView = openMonitor(monitorActions, () => (monitorView = null), focus).view;
}
const laptop = new MyLaptop(loopHandlers, monitorActions);
const goals = new GoalsWindow({
  loop: loopHandlers,
  create: (title, why, tasks, kind, dueAt) => net.send({ t: "goalCreate", title, why, tasks, kind, dueAt: dueAt ?? null }),
  due: (goalId, dueAt) => net.send({ t: "goalDue", goalId, dueAt }),
  group: (goalId, deskIds) => {
    net.send({ t: "goalGroup", goalId, deskIds });
    if (deskIds.length) hud.toast(`👥 Given to ${deskIds.length} workers — one plans it if needed, then tasks go out as each finishes`);
  },
  remove: (goalId) => net.send({ t: "goalDelete", goalId }),
  addTask: (goalId, title) => net.send({ t: "taskAdd", goalId, title }),
  assign: (goalId, taskId, deskId) => openAssignFor(goalId, taskId, deskId, true),
  policy: () => openPolicyNow(),
  done: (goalId, taskId, done) => net.send({ t: "taskDone", goalId, taskId, done }),
  focus: (goalId) => {
    goals.close();
    openFocus(goalId);
  },
});
const playerCard = new PlayerCard(hud.leftEl, () => openProfile(me(), progress));
const sessionPill = new SessionPill(hudRoot, () => net.send({ t: "sessionStop" }));
let progress: ProgressState = EMPTY_PROGRESS;

let selfId = "";
let office: OfficeState = { desks: [], peers: [], presentations: [] };
let joined = false;

/** Desks whose laptop is waiting for its scrollback, and the terminal's. */
const laptopPending = new Set<string>();
const laptopPrimed = new Set<string>();
let terminalPending: string | null = null;
/** A freshly hired worker whose terminal opens once it sits down. */
let pendingOpen: string | null = null;

/** The review you just decided on, waiting for the worker to leave the line. */
let awaitingAdvance: string | null = null;
/** Workers you said you'd see later, this round of office hours. */
const later = new Set<string>();
/** Each worker's last status, to notice when one starts needing you. */
const lastStatus = new Map<string, string>();
/** The stand-up opens once your progress arrives after you join. */
let standupDue = false;
/** The room you're in, from the minimap. */
let here: RoomId = "standup";
let hoopStreak = 0;
let goals_ = { west: 0, east: 0 };

function goalById(id: string): Goal | undefined {
  return progress.goals.find((g) => g.id === id);
}

function deskById(id: string | null): Desk | undefined {
  return id ? office.desks.find((d) => d.id === id) : undefined;
}

// --- networking ---------------------------------------------------------------------

net.onStatus = (connected) => {
  hud.setConnected(connected);
  if (connected && joined) net.send({ t: "join", name: myName, look: myLook });
  if (connected) {
    // Laptops ask for their terminals afresh after a reconnect.
    laptopPrimed.clear();
  }
};

net.onMessage = (msg) => {
  // The laptop keeps its own view of the loop, deploys and terminals.
  laptop.onMessage(msg);
  ingestLan(msg);
  ingestMcp(msg);
  ingestLogs(msg);
  ingestProjects(msg);
  ingestAgents(msg);
  ingestHistory(msg);
  ingestSkills(msg);
  ingestLessons(msg);
  ingestVoices(msg);
  ingestAlumni(msg);
  ingestDemo(msg);
  ingestGithub(msg);
  if (msg.t === "project") showProject();
  if (msg.t === "guest") showGuestBadge();
  switch (msg.t) {
    case "loop":
      if (msg.event === "deployFailed") {
        sound.click();
        hud.toast(msg.text, "error");
      } else if (msg.event === "checkFailed" || msg.event === "mergeFailed" || msg.event === "warn") {
        hud.toast(msg.text, "warn");
      } else {
        if (msg.event === "merged") sound.xp();
        hud.toast(msg.text);
        if (msg.event === "planned" || msg.event === "deck") sound.xp();
        if (msg.event === "deployStarted") sound.bell();
        // The team huddle and the demo are for everyone: Arnold offers to show them.
        if ((msg.event === "huddle" || msg.event === "demo") && msg.goalId && !reviewing()) {
          const goal = goalById(msg.goalId);
          const watch = msg.event === "demo" ? loopHandlers.openDemo : loopHandlers.openHuddle;
          // (A huddle is offered as it starts, not at each step.)
          if (goal && (msg.event === "demo" || msg.text.startsWith("🤝 Huddle on the plan"))) {
            assistant.say({ id: `${msg.event}-${msg.goalId}`, urgency: 2, text: msg.text, action: { label: msg.event === "demo" ? "🎬 Watch the demo" : "🤝 Watch the huddle", run: () => watch?.(goalById(msg.goalId) ?? goal) } });
          }
        }
      }
      break;
    case "welcome":
      selfId = msg.selfId;
      office = msg.office;
      applyOffice();
      net.send({ t: "projectInfo" });
      net.send({ t: "ideasGet" });
      net.send({ t: "agentsGet" });
      net.send({ t: "chatGet" });
      useVoices((m) => net.send(m));
      net.send({ t: "historyGet" });
      break;
    case "office":
      office = msg.office;
      applyOffice();
      ideaBoard.refreshWorkers();
      break;
    case "ideas":
      onIdeas(msg.ideas);
      break;
    case "chat":
      onChat(msg.threads);
      break;
    case "chatPeek":
      teamChat.peek(msg.peek);
      break;
    case "chatWork":
      teamChat.work(msg.work);
      break;
    case "output":
      world.output(msg.deskId, msg.data);
      if (terminal.isOpen && terminal.deskId === msg.deskId && terminalPending !== msg.deskId) terminal.write(msg.data);
      break;
    case "scrollback":
      if (laptopPending.delete(msg.deskId)) world.output(msg.deskId, msg.data, true);
      if (terminalPending === msg.deskId) {
        terminalPending = null;
        if (terminal.isOpen && terminal.deskId === msg.deskId) terminal.write(msg.data);
      }
      break;
    case "report": {
      // Work's done: it lines up outside your office, your phone pings, and Arnold offers to review it now.
      const p = msg.presentation;
      const w = deskById(p.deskId)?.worker;
      const name = w?.identity?.name ?? AGENT_LABELS[p.agent];
      const r = p.report;
      // The report's title, without the "Finished:" / "Need a decision:" it may start with (we say that ourselves).
      const title = r?.title.replace(/^\s*(?:finished|need a decision|needs a decision|plan|blocked)\s*:\s*/i, "") ?? "";
      const what = r ? (r.status === "plan" ? `has a plan for “${title}”` : r.status === "blocked" ? `needs a decision on “${title}”` : `finished “${title}”`) : "is putting together a progress report";
      if (r) {
        sound.chime();
        phone.notify(`${name} ${what}${r.status === "ready" ? " — ready to review" : ""}`, "reviews");
      }
      hud.toast(`📋 ${name} ${what} — lining up outside your office${away() ? " · T to head over" : ""}`);
      if (r && !reviewing()) {
        assistant.say(
          { id: `ready-${p.deskId}-${r.at}`, urgency: 3, text: `${name} ${what}. It's lined up outside your office.`, action: { label: "🎤 Review now", run: () => openMonitorNow(p.deskId) } },
          { label: "Office hours", run: () => startOfficeHours() },
        );
      }
      break;
    }
    case "progress": {
      const startedNow = !progress.session && msg.progress.session;
      progress = msg.progress;
      world.setProgress(progress);
      monitorView?.refresh();
      goals.update(progress, office.desks, office.presentations);
      refreshDeck(progress.goals);
      refreshGame();
      if (startedNow) {
        sound.bell();
        hud.toast(`🔥 Focus session started — ${sessionLength(progress.session!.minutes)}. Let's go!`);
      }
      if (welcomeDue) {
        welcomeDue = false;
        standupDue = false;
        setTimeout(() => assistant.welcome(myName, () => openStandupNow(), office.desks.some((d) => d.worker) || guestRole() === "visitor" ? undefined : () => quickStart()), 600);
      } else if (standupDue) {
        standupDue = false;
        setTimeout(() => openStandupNow(), 500);
      }
      break;
    }
    case "award":
      onAward(msg);
      break;
    case "sessionEnd":
      showSessionSummary(msg.summary);
      break;
    case "standupDraft":
      standupDraftArrived(msg.draft, msg.via);
      break;
    case "said":
      if (msg.from === "agent") world.speak(msg.deskId, msg.text);
      if (review.isOpen && review.deskId === msg.deskId) review.addLine(msg.from, msg.text);
      if (projector.isOpen && projector.deskId === msg.deskId) projector.addLine(msg.from, msg.text);
      break;
  }
};

// --- the game ---------------------------------------------------------------------------

function me() {
  return progress.players.find((p) => p.name === myName) ?? blankStats(myName);
}

function refreshGame(): void {
  playerCard.update(me());
  hud.updateGame(progress);
  objective.update(nextObjective(progress, office.desks, office.presentations));
}

/** Do what the quest tracker says. */
function doObjective(o: Objective): void {
  if (modalOpen()) return;
  switch (o.action) {
    case "standup":
      openStandupNow();
      break;
    case "hire":
      if (here !== "floor") travelTo({ label: "Work floor", icon: "🖥", ...SPAWN });
      hud.toast("🪑 Walk to a desk with a green + and press E");
      break;
    case "goals":
      openGoals(o.goal?.id);
      break;
    case "roundup":
      openRoundup();
      break;
    case "hours":
      startOfficeHours();
      break;
    case "travel-game": {
      const game = placeDestinations("desks").find((d) => d.label === "Game room");
      if (game) travelTo(game);
      break;
    }
    case "laptop":
      openLaptop();
      break;
  }
}

function openGoals(select?: string): void {
  if (modalOpen() && !goals.isOpen) return;
  goals.open(progress, office.desks, select);
}

function openFocus(goalId: string | null = null): void {
  if (progress.session) {
    const left = Math.ceil((progress.session.endsAt - Date.now()) / 60000);
    hud.toast(`🔥 A focus session is on — ${left} min to go. Stay in the zone!`);
    return;
  }
  if (modalOpen() && !goals.isOpen) return;
  openStartSession(progress, goalId, (minutes, goal) => net.send({ t: "sessionStart", minutes, goalId: goal }));
}

function onAward(a: { who: string; xp: number; reason: string; levelUp?: { level: number; title: string }; unlocked: string[] }): void {
  const shipped = a.reason.startsWith("Task done") || a.reason.startsWith("Goal complete") || a.reason.startsWith("Shipped") || a.reason.startsWith("Delivered");
  if (shipped) {
    // Everyone hears the gong when work ships.
    world.ringGong();
    sound.gong();
  }
  if (a.reason.startsWith("Shipped") || a.reason.startsWith("Delivered")) {
    confetti(260);
    hud.toastHtml(`🚀 <b>${esc(a.who)}</b> shipped it: ${esc(a.reason.replace(/^(Shipped|Delivered): /, ""))}`, "ach", 6500);
  } else if (a.reason.startsWith("Goal complete")) {
    confetti(220);
    hud.toastHtml(`🚀 <b>${esc(a.who)}</b> completed a goal: ${esc(a.reason.replace(/^Goal complete: /, ""))}`, "ach", 6000);
  }
  if (a.who !== myName) return;
  if (a.xp > 0) {
    floatXp(a.xp, playerCard.el);
    if (!shipped) sound.xp();
    if (a.xp >= 50) hud.toastHtml(`<b>+${a.xp} XP</b> · ${esc(a.reason)}`, "xp");
  }
  for (const id of a.unlocked) {
    const def = ACHIEVEMENTS.find((x) => x.id === id);
    if (!def) continue;
    setTimeout(() => {
      sound.achievement();
      hud.toastHtml(`<span class="a-icon">${def.icon}</span><span><small>Achievement unlocked</small><b>${esc(def.title)}</b> — ${esc(def.text)}</span>`, "ach", 5500);
    }, 400);
  }
  if (a.levelUp) showLevelUp(a.levelUp.level, a.levelUp.title);
}

function showLevelUp(level: number, title: string): void {
  sound.levelUp();
  confetti(200);
  const el = document.createElement("div");
  el.className = "levelup";
  el.innerHTML = `<div class="lv-ring">${level}</div><h2>Level up!</h2><p>You're now a ${esc(title)}</p>`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3300);
}

/** Whether you're away from the work (the game room, the kitchen, outside…). */
function away(): boolean {
  return here !== "floor" && here !== "office";
}

function applyOffice(): void {
  world.sync(office.desks, office.presentations, office.peers, selfId);
  // A worker that just started needing you gets a shout, wherever you are.
  for (const desk of office.desks) {
    const st = desk.worker?.status;
    const before = lastStatus.get(desk.id);
    if (st === "waiting" && before && before !== "waiting") {
      sound.click();
      hud.toast(`🔴 ${AGENT_LABELS[desk.worker!.agent]} at ${desk.label} needs you${away() ? " · press T to jump there" : ""}`, "warn");
    }
    if (st) lastStatus.set(desk.id, st);
    else lastStatus.delete(desk.id);
  }
  goals.update(progress, office.desks, office.presentations);
  monitorView?.refresh();
  hud.update(office.desks, office.presentations, office.peers, selfId);
  objective.update(nextObjective(progress, office.desks, office.presentations));

  // Each laptop shows its worker's terminal: fetch the scrollback once per worker.
  for (const desk of office.desks) {
    if (desk.worker && !laptopPrimed.has(desk.id)) {
      laptopPrimed.add(desk.id);
      laptopPending.add(desk.id);
      net.send({ t: "open", deskId: desk.id });
    } else if (!desk.worker) {
      laptopPrimed.delete(desk.id);
    }
  }

  // Keep an open terminal in step, and close it if its worker was sent home.
  if (terminal.isOpen && terminal.deskId) {
    const desk = deskById(terminal.deskId);
    if (!desk?.worker) terminal.close();
    else terminal.setStatus(desk.worker.status);
  }

  // Office hours you asked for while the work was still being checked: now someone's ready.
  if (hoursWhenReady && Date.now() < hoursWhenReady && !reviewing() && !modalOpen() && nextReady()) startOfficeHours();

  // A review was decided: once that worker has left the line, bring in the next.
  if (awaitingAdvance && !office.presentations.some((p) => p.deskId === awaitingAdvance)) {
    awaitingAdvance = null;
    const next = nextReady();
    if (next) openReview(next);
    else endOfficeHours();
  }

  if (pendingOpen && deskById(pendingOpen)?.worker) {
    const id = pendingOpen;
    pendingOpen = null;
    openTerminal(id);
  }
}

// --- desks and terminals -----------------------------------------------------------------

function openTerminal(deskId: string): void {
  const desk = deskById(deskId);
  if (!desk?.worker || reviewing()) return;
  const title = `${AGENT_LABELS[desk.worker.agent]} · ${desk.label} · hired by ${desk.worker.hiredBy}`;
  terminalPending = deskId;
  terminal.open(deskId, title, desk.worker.status, {
    onInput: (data) => net.send({ t: "input", deskId, data }),
    onResize: (cols, rows) => {
      world.resizeTerminal(deskId, cols, rows);
      net.send({ t: "resize", deskId, cols, rows });
    },
    onFire: () => {
      const w = deskById(deskId)?.worker;
      if (!w) return;
      const name = w.identity?.name ?? AGENT_LABELS[w.agent];
      terminal.close();
      openFire({
        name,
        onFire: (reason) => {
          net.send({ t: "fire", deskId, ...(reason ? { reason } : {}) });
          hud.toast(`👋 ${name} went home${reason ? " — the team will learn from why" : ""} · bring them back from Hire → Former workers`);
        },
        onReassign: () => openGoals(),
      });
    },
    onClose: () => {
      terminalPending = null;
    },
  });
  net.send({ t: "open", deskId });
}

function hire(desk: Desk): void {
  openHire(
    { id: desk.id, label: desk.label },
    {
      ...teamCtx(),
      onRehire: (id) => {
        net.send({ t: "rehire", id, deskId: desk.id });
        pendingOpen = desk.id;
      },
      getAlumni: () => net.send({ t: "alumniGet" }),
      onHire: (choice) => {
        net.send(
          typeof choice === "string"
            ? { t: "hire", deskId: desk.id, agent: "claude", characterId: choice }
            : { t: "hire", deskId: desk.id, agent: choice.agent as AgentKind, model: choice.model, leash: choice.leash },
        );
        pendingOpen = desk.id;
      },
    },
  );
}

/** What the team windows need: the roster, the desks, and how to save. */
function teamCtx(): TeamContext {
  return {
    progress,
    desks: office.desks,
    onSave: (c) => net.send({ t: "characterSave", character: c }),
    onDelete: (id) => net.send({ t: "characterDelete", id }),
    onEditPolicy: () => openPolicyNow(),
    scanMcp: () => net.send({ t: "mcpScan" }),
    getSkills: () => net.send({ t: "skillsGet" }),
  };
}

/** What the Projects window may do: switch and clone, and share your GitHub sign-in with workers' tools. */
function projectActions() {
  return {
    send: (m: ClientMessage) => net.send(m),
    hasGithubTools: () => progress.mcp.some((m) => m.auth === "github" && m.enabled),
    addGithubTools: () => {
      net.send({ t: "mcpSave", server: githubTools() });
      hud.toast("🧰 Every worker now gets GitHub's tools, using your sign-in");
    },
  };
}

/** The project's name and branch in the top-left card. */
function showProject(): void {
  const info = projectState.info;
  const name = hudRoot.querySelector<HTMLElement>(".project-name > span");
  if (info && name) name.textContent = info.name;
  let badge = hudRoot.querySelector<HTMLElement>(".project-badge-slot");
  if (!badge) {
    badge = document.createElement("div");
    badge.className = "project-badge-slot";
    hudRoot.querySelector(".project")?.appendChild(badge);
    badge.addEventListener("click", () => openProjects(projectActions()));
  }
  badge.innerHTML = projectBadge();
}

/**
 * Hand a task out on your terms: the assignment card (worker, model, time
 * budget, plan first, definition of done). From the Goals window, it comes
 * back to the goal afterwards.
 */
function openAssignFor(goalId: string, taskId: string, deskId?: string, backToGoals = false): void {
  const goal = progress.goals.find((g) => g.id === goalId);
  const task = goal?.tasks.find((t) => t.id === taskId);
  if (!goal || !task) return;
  const busy = new Map<string, string>();
  for (const g of progress.goals) for (const t of g.tasks) if (t.deskId && t.status !== "done" && t.id !== taskId) busy.set(t.deskId, t.title);
  openAssignCard({
    goal,
    task,
    desks: office.desks,
    policy: progress.policy,
    deskId,
    busy,
    onAssign: (desk, brief) => {
      net.send({ t: "taskAssign", goalId, taskId, deskId: desk, brief });
      sound.click();
      const w = deskById(desk)?.worker;
      hud.toast(
        `👉 ${w ? AGENT_LABELS[w.agent] : "Worker"} is on “${task.title}”` +
          (brief.minutes ? ` · ${brief.minutes} min` : "") +
          (brief.planFirst ? " · plan first" : ""),
      );
      if (backToGoals) setTimeout(() => openGoals(goalId), 60);
    },
    onEditPolicy: () => openPolicyNow(),
  });
}

/** The team's defaults for hiring and handing out tasks. */
function openPolicyNow(): void {
  openPolicy(progress.policy, (p) => {
    net.send({ t: "policySet", policy: p });
    hud.toast("🛠 Team policy saved — new hires and assignments start from it");
  });
}

function openRoundup(): void {
  if (modalOpen()) return;
  hud.openRoundup(
    office.desks,
    office.presentations,
    (deskIds) => {
      net.send({ t: "roundup", deskIds });
      hud.toast(`📣 Called ${deskIds.length} worker${deskIds.length === 1 ? "" : "s"} to your office`);
    },
    () => {},
  );
}

// --- office hours ---------------------------------------------------------------------------

/** The next worker in line with its report ready, skipping ones you'll see later. */
/** You asked for office hours before anyone was ready: start them when someone is (until then). */
let hoursWhenReady = 0;

function nextReady(): Presentation | null {
  return office.presentations.find((p) => p.report && p.report.check?.status !== "running" && !later.has(p.deskId)) ?? null;
}

function startOfficeHours(): void {
  if (reviewing()) return;
  if (terminal.isOpen) terminal.close();
  if (modalOpen()) return;
  later.clear();
  const next = nextReady();
  if (!next) {
    const checking = office.presentations.filter((p) => p.report?.check?.status === "running").length;
    const preparing = office.presentations.length - checking;
    // Work that's in but still being checked: office hours start by themselves when the first is ready.
    if (office.presentations.length) hoursWhenReady = Date.now() + 5 * 60_000;
    hud.toast(
      checking
        ? `🧪 Checking ${checking === 1 ? "their work" : `${checking} pieces of work`} first — office hours start the moment one's ready`
        : preparing
          ? `📝 ${preparing} still preparing their report${preparing === 1 ? "" : "s"} — office hours start when one's ready`
          : "☕ Nobody in line. Press R to round up workers for a review.",
      "warn",
    );
    return;
  }
  hoursWhenReady = 0;
  // Take your seat: the chair at your desk, facing the screen.
  player.sit(REVIEW_SPOT.x, REVIEW_SPOT.z, 0);
  world.setSeated(true);
  openReview(next);
}

function openReview(p: Presentation): void {
  if (!p.report) return;
  world.setPresenting(p.deskId, 0);
  world.showReviewBoard(null);
  const index = office.presentations.findIndex((x) => x.deskId === p.deskId) + 1;
  const onProjector = settings.reviewStyle === "projector";
  document.body.classList.toggle("projecting", onProjector);
  // On the projector you look at the screen with the mouse free for the bar.
  if (onProjector) player.unlock();
  const panel = onProjector ? projector : review;
  panel.open(p, { index, total: office.presentations.length }, {
    onSwitch: () => {
      // The other way, for this review and from now on.
      const next = { ...settings, reviewStyle: onProjector ? ("window" as const) : ("projector" as const) };
      saveSettings(next);
      applySettings(next);
      (onProjector ? projector : review).close(true);
      openReview(p);
    },
    onReview: (approve, text, sketch) => {
      net.send({ t: "review", deskId: p.deskId, approve, text, sketch: sketch ?? undefined });
      awaitingAdvance = p.deskId;
      hud.toast(approve ? `✅ Approved — ${AGENT_LABELS[p.agent]} is back to work` : `✏️ Changes sent to ${AGENT_LABELS[p.agent]}`);
      if (approve) sound.xp();
    },
    onSay: (text) => net.send({ t: "say", deskId: p.deskId, text }),
    onLater: () => {
      later.add(p.deskId);
      const next = nextReady();
      if (next) openReview(next);
      else endOfficeHours();
    },
    onClose: () => endOfficeHours(),
    onSlide: (i) => world.setPresenting(p.deskId, i),
    onBoard: (c) => world.showReviewBoard(c),
    onVoiceError: warnVoice,
  }, deskById(p.deskId)?.worker?.identity ?? null);
}

/** Voice input failing is said once, not on every try. */
let voiceWarned = false;
function warnVoice(err: string): void {
  if (voiceWarned) return;
  voiceWarned = true;
  hud.toast(
    err === "not-allowed"
      ? "🎤 Microphone blocked — allow it to talk to workers"
      : /Electron/.test(navigator.userAgent)
        ? `🎤 To talk, click in a text box and ${osDictationHint()} — your computer types what you say`
        : `🎤 Voice input isn't available in this window — open ${location.origin} in Chrome to talk, or type`,
    "warn",
  );
}

// --- idea boards ------------------------------------------------------------------------------

let ideas: Idea[] = [];
/** The whiteboard you opened the idea board at (your sketch shows on it). */
let ideaAt: IdeaBoardId | null = null;
const ideaBoard = new IdeaBoard({
  send: (m) => net.send(m),
  desks: () => office.desks,
  goalTitle: (id) => progress.goals.find((g) => g.id === id)?.title ?? null,
  canEdit: () => guestRole() !== "visitor",
  onSketch: (c) => world.showIdeaSketch(c ? ideaAt : null, c),
  onVoiceError: warnVoice,
});

function openIdeas(at: IdeaBoardId | null): void {
  if (modalOpen() && !ideaBoard.isOpen) return;
  ideaAt = at;
  ideaBoard.open(ideas);
}

function onIdeas(next: Idea[]): void {
  // Say where an idea went when it changes hands.
  for (const i of next) {
    const before = ideas.find((x) => x.id === i.id);
    if (before && before.status === i.status) continue;
    if (i.status === "handed") hud.toast(`🤝 “${i.title}” handed to ${i.handedTo?.name ?? "a worker"} — it's on the goal as a task`);
    else if (i.status === "goal") hud.toast(`🎯 “${i.title}” is a goal now — plan it or hand out its tasks (G)`);
    else if (!before) hud.toast(`📌 Pinned to the idea board: “${i.title}”`);
  }
  ideas = next;
  world.setIdeas(ideas);
  ideaBoard.update(ideas);
}

// --- team chat ---------------------------------------------------------------------------------

const teamChat = new TeamChat({
  send: (m) => net.send(m),
  desks: () => office.desks,
  openTerminal: (deskId) => openTerminal(deskId),
  onVoiceError: warnVoice,
  me: () => myName,
  onPeople: (who, text) => hud.toast(`💬 ${who}: ${text.length > 80 ? text.slice(0, 78) + "…" : text}`),
});
const chatBtn = document.createElement("button");
chatBtn.className = "btn dock-btn";
chatBtn.dataset.act = "chat";
chatBtn.title = "Team chat (C): message your workers, see what they're doing";
chatBtn.innerHTML = `💬 <span class="lbl">Chat</span>`;
chatBtn.addEventListener("click", () => openChat());
hudRoot.querySelector('.dock [data-act="settings"]')?.before(chatBtn);
teamChat.onUnread = (n) => {
  chatBtn.innerHTML = `💬 <span class="lbl">Chat</span>${n ? `<span class="unread">${n}</span>` : ""}`;
};

function openChat(threadId?: string): void {
  if (modalOpen() || guestRole() === "visitor") return;
  teamChat.open(threadId);
}

/** New threads: an answer you haven't seen pops up as a toast you can click. */
let lastAnswers = new Map<string, number>();
function onChat(threads: ChatThread[]): void {
  const fresh = new Map(threads.map((t) => [t.id, t.messages.filter((m) => m.from === "agent").length]));
  if (lastAnswers.size && !teamChat.isOpen) {
    for (const t of threads) {
      if (t.id === "team") continue;
      const before = lastAnswers.get(t.id) ?? 0;
      const answers = t.messages.filter((m) => m.from === "agent");
      if (answers.length > before) {
        const m = answers.at(-1)!;
        hud.toast(`💬 ${m.who}: ${m.text.slice(0, 120)}${m.text.length > 120 ? "…" : ""} — C to reply`);
      }
    }
  }
  lastAnswers = fresh;
  teamChat.update(threads);
  // "I'll take it": Arnold asks you, wherever you are (the phone, walking about), with the answers on buttons.
  const offer = threads.find((t) => t.id === TEAM_THREAD)?.messages.filter((m) => m.offer?.state === "open").at(-1);
  if (offer?.offer && !askedOffers.has(offer.offer.taskId + offer.offer.deskId)) {
    askedOffers.add(offer.offer.taskId + offer.offer.deskId);
    const o = offer.offer;
    const answer = (a: "take" | "next" | "anyone") => () => net.send({ t: "offerAnswer", taskId: o.taskId, answer: a });
    sound.click();
    assistant.say(
      { id: `offer-${o.taskId}`, urgency: 3, text: `${offer.who}: ${offer.text}`, action: { label: `✅ Let ${offer.who.split(" ")[0]} take it`, run: answer("take") } },
      { label: "🔁 Someone else", run: answer("next") },
    );
  }
}
/** Offers Arnold has already asked you about. */
const askedOffers = new Set<string>();

// --- VR ----------------------------------------------------------------------------------------

const vrFlows = new VrFlows({
  world,
  office: () => office,
  progress: () => progress,
  send: (m) => net.send(m),
  interact: () => interact(),
  position: () => player.position,
  deskAt: () => {
    const near = world.nearestDesk(player.position.x, player.position.z);
    return near && near.dist <= INTERACT_RADIUS ? (deskById(near.id) ?? null) : null;
  },
  places: () => placeDestinations(here),
  travel: (d) => travelTo(d),
});
const vr = new VR(world, player, vrFlows);
vrFlows.vr = vr;
hud.onToast = (text) => vr.notify(text);

/** A 🥽 button in the dock, when this browser can reach a headset. */
async function offerVr(): Promise<void> {
  // Dev only: ?vr emulates a Quest 3, to try VR without one.
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("vr")) {
    const { XRDevice, metaQuest3 } = await import("iwer");
    const device = new XRDevice(metaQuest3);
    device.installRuntime({ forceInstall: true });
    (window as unknown as { __xrDevice: unknown }).__xrDevice = device;
  }
  if (!(await VR.supported())) return;
  const btn = document.createElement("button");
  btn.className = "btn dock-btn";
  btn.dataset.act = "vr";
  btn.title = "Step into the office in your VR headset";
  btn.innerHTML = `🥽 <span class="lbl">VR</span>`;
  btn.addEventListener("click", () => {
    escapeModal();
    vr.enter().catch((e: Error) => hud.toast(`🥽 Couldn't start VR: ${e.message}`, "error"));
  });
  hudRoot.querySelector('.dock [data-act="settings"]')?.before(btn);
}
void offerVr();

function endOfficeHours(): void {
  world.setPresenting(null);
  world.showReviewBoard(null);
  document.body.classList.remove("projecting");
}

// --- Arnold, the assistant ---------------------------------------------------------------------

/** What Arnold should mention right now, most urgent first. */
// --- reminders: what needs you, and what's coming up ------------------------------------------

const reminders = new Reminders({
  office: () => office,
  progress: () => progress,
  goToDesk: (deskId) => goToDesk(deskId),
  officeHours: () => startOfficeHours(),
  openGoal: (goalId) => openGoals(goalId),
  notify: (r, chime) => {
    if (!joined) return;
    if (chime) sound.chime();
    hud.toast(`${r.icon} ${r.text}`, r.urgency === 3 ? "warn" : "");
  },
});
setInterval(() => {
  if (joined) reminders.update();
}, 3000);

/** Your phone (P): everything the laptop has, in your pocket, while you walk. */
const phone = new Phone({
  office: () => office,
  progress: () => progress,
  reminders: () => reminders.list(),
  music: () => ({ on: settings.music, track: settings.track, volume: settings.musicVolume }),
  setMusic: (m) => {
    const next = { ...settings, music: m.on, track: m.track, musicVolume: m.volume };
    saveSettings(next);
    applySettings(next);
    music.set({ on: next.music, track: next.track, volume: next.musicVolume });
  },
  giveTask: (text) => net.send({ t: "quickTask", deskId: "any", text }),
  sendTeam: (text) => {
    net.send({ t: "chatSend", to: TEAM_THREAD, text });
    hud.toast("💬 Sent to #team");
  },
  openChat: (threadId) => openChat(threadId),
  openTerminal: (deskId) => openTerminal(deskId),
  goToDesk: (deskId) => goToDesk(deskId),
  openGoals: (goalId) => openGoals(goalId),
  officeHours: () => startOfficeHours(),
  roundup: () => openRoundup(),
  standup: () => openStandupNow(),
  focus: () => openFocus(),
  lessons: () => openLessons((m) => net.send(m), guestRole() !== "visitor"),
  autopilot: () => progress.policy.autopilot?.on ?? false,
  setAutopilot: (on) => {
    net.send({ t: "policySet", policy: { ...progress.policy, autopilot: { ...progress.policy.autopilot, on } } });
    hud.toast(on ? "🤖 Autopilot on — the office runs itself; you'll hear about questions and finished goals" : "🤖 Autopilot off — you hand out the work");
  },
  openHistory: () => openHistory((m) => net.send(m)),
  openLaptop: () => openLaptop(),
  openMonitor: () => openMonitorNow(),
  review: (deskId, approve, text) => {
    net.send({ t: "review", deskId, approve, ...(text ? { text } : {}) });
    hud.toast(approve ? "✅ Approved from your phone" : "↩ Sent back with your note");
  },
  travel: (p) => travelTo({ label: p.label, icon: p.icon, x: p.x, z: p.z, facing: p.facing }),
  shown: (open) => {
    // The mouse is for the phone while it's out; you can still walk.
    if (open && player.mouseCaptured) player.unlock();
  },
});
hudRoot.querySelector('.dock [data-act="laptop"]')?.before(phone.dockButton);

function pipTips(): Tip[] {
  const tips: Tip[] = [];
  // Deadlines, time budgets and idle hands (waiting workers and the line are below).
  for (const r of reminders.list()) {
    if (/^(due|budget|idle)-/.test(r.id)) tips.push({ id: r.id, urgency: r.urgency, text: `${r.icon} ${r.text}`, action: r.action });
  }
  if (!joined) return tips;
  // No coding agent on this machine yet: nothing can be hired until one is.
  const agents = agentsState();
  if (agents && !guestRole() && !Object.values(agents.installed).some(Boolean)) {
    tips.push(
      agents.npm
        ? {
            id: "no-agents",
            urgency: 2,
            text: agents.installing ? "Installing — it takes a minute. The output's in Office → Logs." : "None of the coding agents are installed on this computer yet. Want me to install Claude Code? (Codex, Gemini CLI and OpenCode are in the hire card.)",
            action: agents.installing ? undefined : { label: "⬇ Install Claude Code", run: () => installAgent("claude") },
          }
        : { id: "no-node", urgency: 2, text: "To hire coding agents, this computer needs Node.js (nodejs.org) — install it, then restart domain and I'll set up the agents." },
    );
  }
  // Last time's team, asleep at their desks: the gong gets them going.
  const asleep = sleepers().length;
  if (asleep && !guestRole()) {
    tips.push({
      id: "asleep",
      urgency: 2,
      text: `Your team from last time is asleep at their desks (${asleep}). Ring the gong by the elevator to get everyone back to work — each picks up where it left off.`,
      action: {
        label: "🔔 Ring the gong",
        run: () => travelTo({ label: "", icon: "", x: GONG.x, z: GONG.z + 1.1, facing: Math.PI, then: () => ringTheGong() }),
      },
    });
  }
  // An agent asking whether to trust its folder: one click trusts the project, for every worker from now on.
  const asking = office.desks.find((d) => d.worker?.status === "waiting" && /trust this folder/.test(d.worker.activity));
  if (asking && !guestRole()) {
    const w = asking.worker!;
    tips.push({
      id: `trust-${asking.id}`,
      urgency: 3,
      text: `${w.identity?.name ?? AGENT_LABELS[w.agent]} is asking whether it can trust this project's files (its own copy at ${asking.label}). Trust them for every worker in this project? I won't ask again.`,
      action: { label: "✅ Trust this project", run: () => net.send({ t: "trustWorkers" }) },
    });
  }
  for (const desk of office.desks) {
    const w = desk.worker;
    if (w?.status !== "waiting" || desk === asking) continue;
    const who = w.identity?.name ?? AGENT_LABELS[w.agent];
    tips.push({
      id: `wait-${desk.id}`,
      urgency: 3,
      text: `${who} at ${desk.label} is waiting for your answer.`,
      action: { label: "Go there", run: () => goToDesk(desk.id) },
    });
  }
  const ready = office.presentations.filter((p) => p.report && p.report.check?.status !== "running").length;
  if (ready) {
    tips.push({
      id: `ready-${ready}`,
      urgency: 2,
      text: ready === 1 ? "Someone's ready to present outside your office." : `${ready} workers are ready to present outside your office.`,
      action: { label: "🎤 Hold office hours", run: () => startOfficeHours() },
    });
  }
  const s = progress.session;
  if (s) {
    const left = s.endsAt - Date.now();
    if (left > 0 && left < 5 * 60_000 && office.desks.some((d) => d.worker)) {
      tips.push({
        id: `ending-${s.id}`,
        urgency: 2,
        text: "Five minutes left in this session — a good moment to round everyone up for a review.",
        action: { label: "📣 Round up", run: () => openRoundup() },
      });
    }
  }
  if (!progress.goals.some((g) => !g.doneAt && !g.shippedAt) && !s) {
    tips.push({ id: "no-goal", urgency: 1, text: "There's no goal yet. Every session starts with a stand-up — want to hold one?", action: { label: "☀️ Hold the stand-up", run: () => openStandupNow() } });
  }
  // The goal card already shows the next step: Arnold only brings it up if you've been idle a while.
  if (performance.now() - lastActivity > 90_000) {
    const o = nextObjective(progress, office.desks, office.presentations);
    tips.push({ id: `next-${o.text}`, urgency: 0, text: `Still here? Next up: ${o.text}`, action: { label: o.key ? `Do it (${o.key})` : "Do it", run: () => doObjective(o) } });
  }
  return tips.sort((a, b) => b.urgency - a.urgency);
}

/** The goal you're on: the session's, else the newest one still open. */
function focusGoal(): Goal | undefined {
  return progress.goals.find((g) => g.id === progress.session?.goalId && !g.shippedAt) ?? progress.goals.find((g) => !g.doneAt && !g.shippedAt);
}

/** Walk up to a free desk and open the hire card. */
function hireAtFreeDesk(): void {
  const desk = office.desks.find((d) => !d.worker);
  const def = desk && DESK_BY_ID.get(desk.id);
  if (!desk || !def) return void hud.toast("Every desk is taken — let one go to hire another");
  const at = deskSeat(def, 1.75);
  travelTo({ label: "", icon: "", x: at.x, z: at.z, facing: def.rotY + Math.PI, then: () => hire(desk) });
}

/** What Arnold can walk you through, as checklists that tick themselves off. */
function pipGuides(): Guide[] {
  const goalReady = () => !!focusGoal();
  const staffed = () => office.desks.some((d) => d.worker);
  const goalStep = {
    title: "Pick a goal",
    text: "Everything starts with a goal: what you want done today. The stand-up sets one (and the tone, and how long you'll focus).",
    done: goalReady,
    action: { label: "☀️ Hold the stand-up", run: () => openStandupNow() },
    spot: '[data-act="standup"]',
  };
  const task: Guide = {
    id: "task",
    icon: "🎯",
    title: "Put a worker on a task",
    finish: "Done — reviewed and approved. That's the whole loop: goal, plan, build, review. Ship it when the goal's ready.",
    steps: () => [
      goalStep,
      {
        title: "Hire a worker",
        text: "Workers are real coding agents — Claude Code, Codex, OpenCode or Gemini — at a desk on the work floor.",
        done: staffed,
        action: { label: "🪑 Take me to a free desk", run: () => hireAtFreeDesk() },
      },
      {
        title: "Break it into tasks",
        text: "Let your worker plan the goal (it writes the tasks for you), or add a few yourself.",
        done: () => (focusGoal()?.tasks.length ?? 0) > 0,
        action: { label: "📋 Open the goal", run: () => openGoals(focusGoal()?.id) },
        spot: '[data-act="goals"]',
      },
      {
        title: "Hand a task out",
        text: "Pick a task and a worker — and if you like, the model, a time budget and what “done” means.",
        done: () => !!focusGoal()?.tasks.some((t) => t.status !== "todo"),
        action: { label: "🎯 Assign a task", run: () => openGoals(focusGoal()?.id) },
      },
      {
        title: "Review the work",
        text: "When it's ready the worker lines up outside your office (or round them up now). Hold office hours, then approve it or send it back.",
        done: () => !!focusGoal()?.tasks.some((t) => t.status === "done"),
        action: {
          label: "🎤 Office hours",
          run: () => (office.presentations.some((p) => p.report) ? startOfficeHours() : openRoundup()),
        },
      },
    ],
  };
  return [
    {
      id: "session",
      icon: "🔥",
      title: "Start a focus session",
      finish: "The session's on. Your workers have their marching orders — I'll shout when someone needs you.",
      steps: () => [
        goalStep,
        {
          title: "Start the clock",
          text: "A session is a timed sprint the whole office works in. Finish it for XP and to keep your streak.",
          done: () => !!progress.session,
          action: { label: "⏱ Start it", run: () => openStandupNow() },
        },
      ],
    },
    task,
    {
      id: "pr",
      icon: "🚀",
      title: "Ship a pull request",
      finish: "Your pull request is up on GitHub. The goal card follows its checks.",
      steps: () => [
        {
          title: "A project on GitHub",
          text: "Pull requests need a project with a GitHub remote — open one, or clone one from GitHub.",
          done: () => !!projectState.info?.github,
          action: { label: "📁 Projects & GitHub", run: () => openProjects(projectActions()) },
        },
        {
          title: "Signed in to GitHub",
          text: "One sign-in, through git's own credential manager. Your workers' git uses it too.",
          done: () => !!projectState.account,
          action: { label: "🔑 Sign in", run: () => openProjects(projectActions()) },
        },
        {
          title: "Approved work",
          text: "Something to ship: at least one task on the goal reviewed and approved (it's merged into your branch).",
          done: () => !!focusGoal()?.tasks.some((t) => t.status === "done"),
          action: { label: "🎯 Walk me through a task", run: () => assistant.startGuide(task) },
        },
        {
          title: "Open the pull request",
          text: "Your branch goes up as domain/<goal> and the PR opens against the default branch.",
          done: () => !!progress.goals.find((g) => g.id === lastShipGoal)?.pr,
          action: {
            label: "🚀 Open the PR",
            run: () => {
              const g = focusGoal();
              if (!g) return;
              lastShipGoal = g.id;
              net.send({ t: "shipPR", goalId: g.id });
              hud.toast(`🚀 Opening a pull request for “${g.title}”…`);
            },
          },
        },
      ],
    },
    {
      id: "idea",
      icon: "💡",
      title: "Hand off an idea",
      finish: "It's on the board — and with a worker, if you handed it over.",
      steps: () => {
        const before = ideas.length;
        return [
          {
            title: "Go to an idea board",
            text: "There's one on wheels on the work floor and one in the stand-up room.",
            done: () => ideaBoard.isOpen || ideas.length > before || !!world.ideaBoardAt(player.position.x, player.position.z),
            action: { label: "💡 Take me there", run: () => travelTo({ label: "", icon: "", x: IDEA_BOARDS[0].spot.x, z: IDEA_BOARDS[0].spot.z + 1.6, facing: Math.PI }) },
          },
          {
            title: "Sketch it and pin it",
            text: "Draw it, say what it is, then pin it — or hand it straight to a worker.",
            done: () => ideas.length > before,
            action: { label: "✏️ Open the board", run: () => openIdeas("floor") },
          },
        ];
      },
    },
  ];
}
/** The goal a guide opened a pull request for (to know when it's up). */
let lastShipGoal: string | null = null;

/** Walk to a worker's desk and open its terminal. */
function goToDesk(deskId: string): void {
  const def = DESK_BY_ID.get(deskId);
  if (!def) return;
  const at = deskSeat(def, 1.75);
  travelTo({ label: "", icon: "", x: at.x, z: at.z, facing: def.rotY + Math.PI, then: () => openTerminal(deskId) });
}

function placeNamed(label: string): Destination | undefined {
  return placeDestinations("desks").find((d) => d.label === label);
}

/** The guided tour, room by room. */
function pipTour(): TourStep[] {
  const go = (label: string) => () => {
    const d = placeNamed(label);
    if (d) {
      escapeModal();
      travelTo(d);
    }
  };
  return [
    {
      title: "Your goal, always in view",
      text: "This card is your quest: the goal, how far along it is and where it is in the loop — plan, build, review, ship — plus the one next step. Click it to do that step.",
      go: go("Stand-up room"),
      spot: ".objective",
    },
    {
      title: "Every session starts with a stand-up",
      text: "Here you pick today's goal, set the tone and how long you'll focus. The big screen keeps the plan up all session. Press U any time.",
      go: go("Stand-up room"),
      spot: '[data-act="standup"]',
    },
    {
      title: "Hire your workers",
      text: "On the work floor, walk to a desk with a green + and press E. Pick an agent — Claude Code, Codex, OpenCode or Gemini — and a model. Each runs in a real terminal on this computer, on its own git branch.",
      go: go("Work floor"),
    },
    {
      title: "Plan it, hand it out",
      text: "Goals (G): let a worker break the goal into tasks, then hand each one out — pick the model, a time budget, plan-first, and what done means.",
      spot: '[data-act="goals"]',
    },
    {
      title: "Got an idea?",
      text: "Walk up to a whiteboard and press E: sketch it, jot a few notes, then hand it to a worker — it becomes a task, briefed with your sketch — or make it a goal. Pinned ideas stay on the boards.",
      go: go("Work floor"),
    },
    {
      title: "Review in your office",
      text: "Round them up (R): each checks its work against your tests and lines up outside. Hold office hours (O): approve to merge it into your branch, or send it back with notes.",
      go: go("Your office"),
      spot: '[data-act="hours"]',
    },
    {
      title: "Your laptop",
      text: "Press L for your laptop: a browser on what's being built, every worker's live terminal, the loop, decks and deploys.",
      spot: '[data-act="laptop"]',
    },
    {
      title: "Get around fast",
      text: "Press T to jump anywhere — or straight to a worker who needs you. The minimap shows the rooms and everyone in them.",
      spot: ".minimap",
    },
    {
      title: "Run the office",
      text: "🏢 Office: switch projects or clone one from GitHub, build your team of characters with names, looks and personas, give workers MCP tools, invite people on your Wi-Fi, and see the logs of everything that ran.",
      spot: '[data-act="office"]',
    },
    {
      title: "Take a break",
      text: "While they work: arcades, hoops, ping-pong, coffee, a walk outside. I'll call you when someone needs you, and the pad by the door takes you straight back.",
      go: go("Game room"),
    },
    {
      title: "That's the office!",
      text: "Esc opens settings (view, speed, graphics), H shows the controls, and you can click me any time to ask what's next.",
      action: { label: "☀️ Hold the stand-up", run: () => openStandupNow() },
    },
  ];
}

// --- stand-up and fast travel ---------------------------------------------------------------

function openStandupNow(): void {
  if (modalOpen()) return;
  openStandup(
    progress,
    office.desks,
    myName,
    (plan: StandupPlan) => {
      net.send({ t: "standup", ...plan });
      sound.levelUp();
      confetti(90);
      const staffed = office.desks.some((d) => d.worker);
      setTimeout(
        () =>
          hud.toast(
            !staffed
              ? "🎯 Goal set. Next: hire a worker on the work floor — T then 1 to get there fast (or set a starting team in Team policy)"
              : plan.dispatch !== false
                ? "🚀 Day started — the tasks are going out to free workers · K watches them all"
                : "🎯 Goal set. Open Goals (G) to hand out its tasks",
          ),
        900,
      );
    },
    () => {},
    {
      draft: (text) => net.send({ t: "standupVoice", text }),
      speak: (text) => speak(text, "claude"),
      resume: () => {
        net.send({ t: "resume" });
        sound.levelUp();
        hud.toast("↺ Picking up where you left off — the team's waking and the open tasks go out");
      },
    },
  );
}

// The end-of-day recap is read aloud.
listenForRecap((text) => speak(text, "claude"));

/** An armchair in your office within reach, if any. */
function armchairNear(x: number, z: number): (typeof OFFICE_ARMCHAIRS)[number] | null {
  return OFFICE_ARMCHAIRS.find((a) => Math.hypot(a.x - x, a.z - z) < 1.3) ?? null;
}

/** Sit in the chair at the monitor wall: the arrows work its cameras until you get up. */
function sitAtMonitorWall(): void {
  player.sit(MONITOR_CHAIR.x, MONITOR_CHAIR.z, MONITOR_CHAIR.facing, MONITOR_CHAIR.pitch);
  world.setSeated(true);
  player.arrowsTaken = true;
  world.setCctv({ seated: true, cam: world.cctv.cam ?? cameras(office.desks)[0]?.id ?? null });
  hud.toast("📺 CCTV: ← → switch camera · ↑ ↓ all or one · C cycle · E full monitor · W to get up");
}

/** At the monitor wall's chair: ← → switch camera, ↑ ↓ all or one, C cycles. True if the key was for it. */
function cctvKey(e: KeyboardEvent): boolean {
  if (!world.cctv.seated || !player.sitting) return false;
  const k = e.key;
  if (k === "ArrowLeft" || k === "ArrowRight") {
    world.setCctv({ cycle: false, mode: "single" });
    world.stepCctv(k === "ArrowLeft" ? -1 : 1);
  } else if (k === "ArrowUp" || k === "ArrowDown") {
    world.setCctv({ cycle: false, mode: world.cctv.mode === "grid" ? "single" : "grid" });
  } else if (k.toLowerCase() === "c") {
    const on = !world.cctv.cycle;
    world.setCctv({ cycle: on, ...(on ? { mode: "single" as const } : {}) });
    hud.toast(on ? "📺 Cycling through the cameras" : "📺 Cycling off");
  } else return false;
  sound.click();
  return true;
}

/** N: the next thing that needs you — an agent's question, then work ready to review — in the Agent monitor. */
function nextNeedsYou(): void {
  const waiting = office.desks.find((d) => d.worker?.status === "waiting");
  // Work in your line (not still with its auditor).
  const ready = office.presentations.find((p) => p.report);
  const id = waiting?.id ?? ready?.deskId;
  if (!id) {
    hud.toast("✨ Nobody needs you right now");
    return;
  }
  openMonitorNow(id);
}

function travelTo(d: Destination): void {
  teleportFlash();
  sound.click();
  player.placeAt(d.x, d.z, d.facing);
  d.then?.();
}

function openTravel(): void {
  if (modalOpen()) return;
  const urgent: Destination[] = [];
  for (const desk of office.desks) {
    const w = desk.worker;
    const def = DESK_BY_ID.get(desk.id);
    if (!w || !def || w.status !== "waiting") continue;
    const at = deskSeat(def, 1.75);
    urgent.push({
      label: `${AGENT_LABELS[w.agent]} needs you`,
      icon: "🔴",
      sub: desk.label,
      urgent: true,
      x: at.x,
      z: at.z,
      facing: def.rotY + Math.PI,
      then: () => openTerminal(desk.id),
    });
  }
  const ready = office.presentations.filter((p) => p.report).length;
  if (ready) {
    urgent.push({
      label: `Office hours · ${ready} ready`,
      icon: "🎤",
      urgent: true,
      x: REVIEW_SPOT.x,
      z: REVIEW_SPOT.z,
      facing: 0,
      then: () => startOfficeHours(),
    });
  }
  const id = here === "floor" ? "desks" : here;
  openTeleport([...urgent, ...placeDestinations(id)], travelTo);
}

function onMinigames(): void {
  const ev = world.events;
  if (ev.hoop === "score") {
    hoopStreak++;
    sound.xp();
    if (hoopStreak >= 3) confetti(40);
    hud.toast(hoopStreak > 1 ? `🏀 Swish! ${hoopStreak} in a row` : "🏀 Swish!");
  } else if (ev.hoop === "miss") {
    if (hoopStreak >= 2) hud.toast(`🏀 Streak over at ${hoopStreak}`);
    hoopStreak = 0;
  }
  if (ev.goal) {
    goals_ = { ...goals_, [ev.goal]: goals_[ev.goal] + 1 };
    sound.gong();
    confetti(70);
    hud.toast(`⚽ GOOOAL! West ${goals_.east} – ${goals_.west} East`);
  }
  // Walking off the free-throw spot puts the ball down.
  if (shotMeter.active && !atHoopSpot()) shotMeter.hide();
}

function atHoopSpot(): boolean {
  const { x, z } = player.position;
  return Math.hypot(x - HOOP.spot.x, z - HOOP.spot.z) < 1.7;
}
function nearArcade(): (typeof ALL_ARCADES)[number] | null {
  const { x, z } = player.position;
  return ALL_ARCADES.find((a) => {
    const s = arcadeSpot(a);
    return Math.hypot(x - s.x, z - s.z) < 0.85;
  }) ?? null;
}
/** Hop on or off the skateboard. */
function toggleBoard(): void {
  if (player.driving) return;
  player.board = !player.board;
  world.setBoard(player.board);
  sound.click();
  hud.toast(player.board ? "🛹 Skateboard! You're twice as fast and you glide — B to hop off" : "🚶 Back on your feet");
}

/** Workers remembered from last time, asleep at their desks. */
function sleepers(): Desk[] {
  return office.desks.filter((d) => d.worker?.status === "asleep");
}

/** Ring the gong: it swings and booms — and wakes anyone asleep from last time. */
function ringTheGong(): void {
  world.ringGong();
  sound.gong();
  const n = sleepers().length;
  if (n && !guestRole()) {
    net.send({ t: "wake" });
    hud.toast(`🔔 Rise and shine — ${n} worker${n === 1 ? " is" : "s are"} back at it, picking up where they left off`);
  }
}

/** Whether you're at the gong (by the elevator). */
function nearGong(): boolean {
  const { x, z } = player.position;
  return Math.hypot(x - GONG.x, z - (GONG.z + 1.1)) < 1.5;
}

/** The jukebox you're standing at, if any. */
function nearJukebox(): (typeof JUKEBOXES)[number] | null {
  const { x, z } = player.position;
  return JUKEBOXES.find((j) => Math.hypot(x - j.spot.x, z - j.spot.z) < 1.4) ?? null;
}

function openJukeboxNow(): void {
  openJukebox({ on: settings.music, track: settings.track, volume: settings.musicVolume }, (j) => {
    const next = { ...settings, music: j.on, track: j.track, musicVolume: j.volume };
    saveSettings(next);
    applySettings(next);
    music.set({ on: next.music, track: next.track, volume: next.musicVolume });
  });
}

function nearCoffee(): boolean {
  const { x, z } = player.position;
  return Math.hypot(x - KITCHEN.coffeeSpot.x, z - KITCHEN.coffeeSpot.z) < 1.4;
}
function inStandupCircle(): boolean {
  const { x, z } = player.position;
  return Math.hypot(x - STANDUP.circle.x, z - STANDUP.circle.z) < STANDUP.circle.r + 0.6 || Math.hypot(x - STANDUP.spot.x, z - STANDUP.spot.z) < 1.2;
}
function onWorkPad(): boolean {
  const { x, z } = player.position;
  return Math.hypot(x - WORK_PAD.x, z - WORK_PAD.z) < WORK_PAD.r + 0.3;
}
function atElevator(): boolean {
  const { x, z } = player.position;
  return Math.abs(x - ELEVATOR.x) < 1.6 && z < FLOOR.minZ + ELEVATOR.depth + 1.6 && z > FLOOR.minZ;
}
/** The elevator doors upstairs (floor 2 or 3): back down, or anywhere. */
function atUpElevator(): boolean {
  const { x, z } = player.position;
  return (inUpstairs(x) && Math.abs(x - UP_ELEVATOR.x) < 1.7 && z < UPSTAIRS.minZ + 3) || (inTeamFloor(x) && Math.abs(x - TEAM_ELEVATOR.x) < 1.7 && z < TEAM_FLOOR.minZ + 3);
}

// --- things to do: darts, piano, treadmill, fishing, laps, the garden… ------------------------

const activities = new Activities({
  position: () => player.position,
  placeAt: (x, z, facing) => player.placeAt(x, z, facing),
  boostFor: (ms) => player.boostFor(ms),
  toast: (text) => hud.toast(text),
  setTreadmill: (i) => world.upstairs.setTreadmill(i),
  fishing: world.park.fishing,
  setBloom: (level) => world.park.setBloom(level),
  busy: () => modalOpen(),
});

// Popcorn, the radio, the lamp, the teddy, the cat, paper toss: what they make happen.
world.props.onEvent = (e) => {
  if (e.boostMs) player.boostFor(e.boostMs);
  if (e.toast) hud.toast(e.toast);
  if (e.sound === "squeak") {
    sound.note(1320);
    sound.note(1760, 0.08);
  } else if (e.sound) sound[e.sound]();
};

/** E in the game room, kitchen, stand-up room, outside… Returns true if it did something. */
// --- your laptop, put down somewhere --------------------------------------------------------

const LAPTOP_SPOT_KEY = "domain.laptopSpot";
const laptopProp = myLaptopProp();
laptopProp.visible = false;
world.scene.add(laptopProp);
let laptopSpot: WorkSpot | null = null;
try {
  laptopSpot = WORK_SPOTS.find((s) => s.id === localStorage.getItem(LAPTOP_SPOT_KEY)) ?? null;
} catch {
  /* no storage: it starts in your bag */
}
placeLaptop(laptopSpot);

/** Leave the laptop open on a work spot (null: it's with you). */
function placeLaptop(spot: WorkSpot | null): void {
  laptopSpot = spot;
  laptopProp.visible = !!spot;
  if (spot) {
    laptopProp.position.set(spot.laptop.x, spot.laptop.y, spot.laptop.z);
    laptopProp.rotation.y = spot.laptop.rotY;
  }
  try {
    if (spot) localStorage.setItem(LAPTOP_SPOT_KEY, spot.id);
    else localStorage.removeItem(LAPTOP_SPOT_KEY);
  } catch {
    /* fine */
  }
}

/** A seat you're standing at (or sitting in) where you can work on your laptop. */
function nearWorkSpot(): WorkSpot | null {
  const { x, z } = player.position;
  let best: WorkSpot | null = null;
  let bestD = 1.4;
  for (const s of WORK_SPOTS) {
    const d = Math.min(Math.hypot(x - s.sit.x, z - s.sit.z), Math.hypot(x - s.laptop.x, z - s.laptop.z) + 0.3);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/** Sit down, put the laptop on the table (or your lap) and open it. */
function sitAndWork(spot: WorkSpot): void {
  const moved = laptopSpot?.id !== spot.id;
  player.sit(spot.sit.x, spot.sit.z, spot.sit.facing);
  placeLaptop(spot);
  sound.click();
  if (moved) hud.toast(`💻 Set up on ${spot.label} — it stays here when you close it; walk back and press E to pick up where you left off`);
  laptop.open();
}

function interactFun(): boolean {
  const { x, z } = player.position;
  if (activities.use()) return true;
  if (world.props.use(x, z)) return true;
  const spot = nearWorkSpot();
  if (spot && spot.id === laptopSpot?.id) {
    sitAndWork(spot);
    return true;
  }
  if (atUpElevator()) {
    openTravel();
    return true;
  }
  const arcade = nearArcade();
  if (arcade) {
    openArcade(arcade.id, (_score, best) => {
      const before = arcadeBest(arcade.id);
      world.gameRoom.setBest(arcade.id, best);
      if (best > 0 && best >= before) hud.toast(`🕹 ${arcade.name} best: ${best}`);
    });
    return true;
  }
  if (atHoopSpot()) {
    if (shotMeter.active) {
      const power = shotMeter.stop();
      world.hoops.shoot(new THREE.Vector3(x, 1.75, z), power);
    } else if (!world.hoops.busy) {
      player.placeAt(x, z, Math.atan2(HOOP.rim.x - x, HOOP.rim.z - z));
      shotMeter.start();
    }
    return true;
  }
  if (world.ball.near(x, z)) {
    const d = player.lookDir;
    world.ball.kick(d.x, d.z, 0.9);
    sound.click();
    return true;
  }
  if (nearJukebox()) {
    openJukeboxNow();
    return true;
  }
  if (nearGong()) {
    ringTheGong();
    return true;
  }
  if (nearCoffee()) {
    player.boostFor(90_000);
    sound.bell();
    hud.toast("☕ Fresh coffee — you move 35% faster for 90 seconds · Q to put it down");
    return true;
  }
  if (onWorkPad()) {
    travelTo({ label: "Work floor", icon: "🖥", ...SPAWN });
    return true;
  }
  if (atElevator()) {
    openTravel();
    return true;
  }
  if (here === "standup" && inStandupCircle()) {
    openStandupNow();
    return true;
  }
  const board = world.ideaBoardAt(x, z);
  if (board) {
    openIdeas(board.id);
    return true;
  }
  return false;
}

/** Where to float the E key: over whatever E would use right now (null: nothing). */
function promptTarget(): { x: number; y: number; z: number } | null {
  if (modalOpen()) return null;
  const { x, z } = player.position;
  const act = activities.near();
  if (act) return act.key;
  const prop = world.props.near(x, z);
  if (prop) return prop.key;
  if (atUpElevator()) return inTeamFloor(x) ? { x: TEAM_ELEVATOR.x, y: 3.0, z: TEAM_FLOOR.minZ + 0.4 } : { x: UP_ELEVATOR.x, y: 3.0, z: UPSTAIRS.minZ + 0.4 };
  const arcade = nearArcade();
  if (arcade) return { x: arcade.x, y: 2.35, z: arcade.z };
  if (atHoopSpot()) return { x: HOOP.rim.x, y: HOOP.rim.y + 0.7, z: HOOP.rim.z };
  if (world.ball.near(x, z)) return { x: world.ball.position.x, y: 0.95, z: world.ball.position.z };
  const juke = nearJukebox();
  if (juke) return juke.key;
  if (nearGong()) return { x: GONG.x + 0.9, y: 1.6, z: GONG.z + 0.2 };
  if (nearCoffee()) return { x: KITCHEN.coffee.x, y: 1.95, z: KITCHEN.coffee.z };
  const spot = nearWorkSpot();
  if (spot && spot.id === laptopSpot?.id) return { x: spot.laptop.x, y: spot.laptop.y + 0.6, z: spot.laptop.z };
  if (onWorkPad()) return { x: WORK_PAD.x, y: 1.4, z: WORK_PAD.z };
  if (atElevator()) return { x: ELEVATOR.x, y: 2.9, z: FLOOR.minZ + ELEVATOR.depth + 0.1 };
  // Low, over the circle: up at eye height it would sit on the big screen's text.
  if (here === "standup" && inStandupCircle()) return { x: STANDUP.circle.x, y: 1.15, z: STANDUP.circle.z + 1.6 };
  const board = world.ideaBoardAt(x, z);
  if (board) return board.key;
  if (world.inMyOffice(x, z) && world.nearReviewDesk(x, z)) return { x: REVIEW_SPOT.x, y: 1.7, z: REVIEW_SPOT.z + 0.9 };
  const near = world.nearestDesk(x, z);
  if (near && near.dist <= INTERACT_RADIUS) {
    const def = DESK_BY_ID.get(near.id);
    if (def) return { x: def.x, y: 1.75, z: def.z };
  }
  return null;
}

function hintFun(): string | null {
  const act = activities.near();
  if (act) return `<span class="title">${act.title}</span> ${act.id === "tread" ? "" : '<span class="key">E</span> '}${act.hint}`;
  const prop = world.props.near(player.position.x, player.position.z);
  if (prop) return `<span class="title">${prop.title}</span> <span class="key">E</span> ${prop.hint}`;
  if (atUpElevator()) return `<span class="title">🛗 Elevator · Floor ${floorOf(player.position.x)}</span> <span class="key">E</span> Down to the office, or anywhere`;
  const arcade = nearArcade();
  if (arcade) {
    const best = arcadeBest(arcade.id);
    return `<span class="title">🕹 ${arcade.name}</span> <span class="key">E</span> Play${best ? ` · best ${best}` : ""}`;
  }
  if (atHoopSpot()) {
    return shotMeter.active
      ? `<span class="title">🏀 Free throw</span> <span class="key">E</span> Shoot — stop in the green`
      : `<span class="title">🏀 Free throw</span> <span class="key">E</span> Pick up the ball${hoopStreak ? ` · streak ${hoopStreak}` : ""}`;
  }
  const { x, z } = player.position;
  if (world.ball.near(x, z)) return `<span class="title">⚽ Ball</span> <span class="key">E</span> Kick where you're looking · or just run into it`;
  if (nearGong()) {
    const n = sleepers().length;
    return n
      ? `<span class="title">🔔 The gong</span> <span class="key">E</span> Ring it to wake your team (${n} asleep)`
      : `<span class="title">🔔 Ship gong</span> <span class="key">E</span> Ring it · it rings by itself when work ships`;
  }
  if (nearJukebox()) {
    const now = music.playing ? `now: ${music.current.icon} ${music.current.name}` : "music's off";
    return `<span class="title">🪩 Jukebox</span> <span class="key">E</span> Pick the music · ${now}`;
  }
  if (nearCoffee()) {
    const left = Math.ceil(player.boosted / 1000);
    return `<span class="title">☕ Coffee machine</span> <span class="key">E</span> ${left ? `Top up (${left}s left)` : "Grab a coffee · speed boost"}`;
  }
  const spot = nearWorkSpot();
  if (spot) {
    return spot.id === laptopSpot?.id
      ? `<span class="title">💻 Your laptop</span> <span class="key">E</span> Sit down and work · <span class="key">P</span> phone`
      : `<span class="title">🪑 A good spot to work</span> <span class="key">L</span> Sit down with your laptop`;
  }
  if (onWorkPad()) return `<span class="title">🖥 Back to work</span> <span class="key">E</span> Jump to the work floor`;
  if (atElevator()) return `<span class="title">🛗 Elevator</span> <span class="key">E</span> Fast travel`;
  if (here === "standup" && inStandupCircle()) {
    return progress.session
      ? `<span class="title">☀️ Stand-up</span> <span class="key">E</span> See today's plan`
      : `<span class="title">☀️ Stand-up</span> <span class="key">E</span> Start the day: goal, tone, intention`;
  }
  if (world.ideaBoardAt(x, z)) {
    const open = ideas.filter((i) => i.status === "open").length;
    return `<span class="title">💡 Idea board</span> <span class="key">E</span> Sketch an idea · hand it to a worker${open ? ` · ${open} pinned` : ""}`;
  }
  return null;
}

// --- interacting ---------------------------------------------------------------------------

function interact(): void {
  if (modalOpen()) return;
  if (player.driving) return getOutOfCar();
  world.hand.swing();
  const car = player.position.y < 0.01 ? carNear(world.cars, player.position.x, player.position.z) : null;
  if (car) {
    player.startDriving(car);
    sound.door(true);
    hud.toast("🚗 W/S gas and brake · A/D steer · Space handbrake · E to get out");
    return;
  }
  // A worker waiting at the stand-up comes before the stand-up itself (they wait round its circle).
  const free = waitingNear();
  if (free) {
    openGiveTask(free, progress, (m) => net.send(m));
    return;
  }
  const { x, z } = player.position;
  // The monitor wall and your desk come before the fun things near them (the bin's paper toss).
  if (world.cctv.seated) {
    openMonitorNow(world.cctv.mode === "single" ? (world.cctv.cam ?? undefined) : undefined);
    return;
  }
  if (world.nearMonitorWall(x, z)) {
    sitAtMonitorWall();
    return;
  }
  if (world.inMyOffice(x, z) && world.nearReviewDesk(x, z)) {
    // Someone ready: office hours. Nobody yet: just sit down at your desk.
    if (office.presentations.some((p) => p.report)) startOfficeHours();
    else {
      player.sit(REVIEW_SPOT.x, REVIEW_SPOT.z, 0);
      world.setSeated(true);
      hud.toast("🪑 At your desk · R rounds everyone up · W to get up");
    }
    return;
  }
  const arm = armchairNear(x, z);
  if (arm && !player.sitting) {
    player.sit(arm.x, arm.z, arm.facing);
    world.setSeated(true);
    return;
  }
  if (interactFun()) return;
  const near = world.nearestDesk(x, z);
  if (!near || near.dist > INTERACT_RADIUS) return;
  const desk = deskById(near.id);
  if (!desk) return;
  if (desk.worker?.status === "asleep") {
    net.send({ t: "wake", deskId: desk.id });
    hud.toast(`☀️ ${desk.worker.identity?.name ?? AGENT_LABELS[desk.worker.agent]} is waking up, back where it left off`);
  } else if (desk.worker) openTerminal(desk.id);
  else hire(desk);
}

/** A worker waiting at the stand-up right by you (not for visitors: they can't hand out work). */
function waitingNear(): Desk | null {
  if (guestRole() === "visitor") return null;
  const id = world.waitingWorkerNear(player.position.x, player.position.z);
  const desk = id ? deskById(id) : null;
  return desk?.worker ? desk : null;
}

/** Out of the car, on whichever side's clear; it stays where you parked it. */
function getOutOfCar(): void {
  const car = player.driving;
  if (!car) return;
  if (Math.abs(car.v) > 4) {
    hud.toast("🚗 Slow down first — Space is the handbrake");
    return;
  }
  const spot = exitSpot(car).find((s) => {
    const [x, z] = world.resolveCollision(s.x, s.z);
    return Math.hypot(x - s.x, z - s.z) < 0.05;
  });
  player.stopDriving(spot ?? exitSpot(car)[0]);
  sound.door(false);
}

function hintFor(): string | null {
  if (modalOpen()) return null;
  if (player.driving) return `<span class="title">🚗 Driving</span> <span class="key">W</span><span class="key">S</span> gas · brake <span class="key">A</span><span class="key">D</span> steer <span class="key">Space</span> handbrake <span class="key">E</span> get out`;
  if (player.position.y < 0.01 && carNear(world.cars, player.position.x, player.position.z)) return `<span class="title">🚗 A car</span> <span class="key">E</span> Drive it`;
  const free = waitingNear()?.worker;
  if (free) return `<span class="title">🙋 ${esc(free.identity?.name ?? AGENT_LABELS[free.agent])}</span> <span class="cost">waiting for a task</span> <span class="key">E</span> Give it one`;
  const fun = hintFun();
  if (fun) return fun;
  const work = hintWork();
  if (work) return work;
  if (!player.mouseCaptured) return `<span class="title">🎮 Click to play</span> <span class="key">Tab</span> frees the mouse`;
  return null;
}

function hintWork(): string | null {
  const { x, z } = player.position;
  if (world.inMyOffice(x, z)) {
    const ready = office.presentations.filter((p) => p.report).length;
    if (world.nearReviewDesk(x, z)) {
      return ready
        ? `<span class="title">⭐ Your desk</span> <span class="key">E</span> Start office hours · ${ready} ready`
        : `<span class="title">⭐ Your desk</span> <span class="key">E</span> Sit down · nobody ready yet · <span class="key">R</span> round up workers`;
    }
    if (world.cctv.seated) return `<span class="title">📺 CCTV</span> <span class="key">←</span><span class="key">→</span> switch · <span class="key">↑</span><span class="key">↓</span> all / one · <span class="key">C</span> cycle · <span class="key">E</span> full monitor · <span class="key">W</span> get up`;
    if (world.nearMonitorWall(x, z)) return `<span class="title">📺 Monitor wall</span> <span class="key">E</span> Sit and watch every agent, CCTV-style`;
    if (player.sitting) return `<span class="title">🪑 Sitting</span> <span class="key">W</span> get up`;
    if (armchairNear(x, z)) return `<span class="title">🛋 Armchair</span> <span class="key">E</span> Sit down`;
    return `<span class="title">⭐ Your office</span> Sit at your desk to hold reviews · <span class="key">K</span> Agent monitor`;
  }
  const near = world.nearestDesk(x, z);
  if (near && near.dist <= INTERACT_RADIUS) {
    const desk = deskById(near.id);
    if (desk?.worker?.status === "asleep") {
      return `<span class="title">💤 ${desk.worker.identity?.name ?? AGENT_LABELS[desk.worker.agent]}</span> <span class="key">E</span> Wake it · or ring the gong to wake everyone`;
    }
    if (desk?.worker) {
      return `<span class="title">${AGENT_LABELS[desk.worker.agent]}</span> <span class="cost">${desk.worker.activity}</span> <span class="key">E</span> Open terminal`;
    }
    if (desk) return `<span class="title">🪑 ${desk.label}</span> <span class="key">E</span> Hire a worker`;
  }
  return null;
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && phone.isOpen && !modalOpen()) {
    phone.close();
    return;
  }
  if (e.key === "Escape") {
    // Nothing open to close: Esc pauses into the settings.
    const justUnlocked = performance.now() - unlockedAt < 250;
    if (projector.isOpen && !modalOpen()) {
      // Esc on the projector: leave it in line and end office hours.
      projector.close();
      return;
    }
    if (!escapeModal() && !terminal.isOpen && !review.isOpen && !shotMeter.active && !justUnlocked) openSettingsNow();
    else if (shotMeter.active) shotMeter.hide();
    return;
  }
  // Ctrl frees a captured mouse, like Tab.
  if (e.key === "Control" && player.mouseCaptured) {
    player.unlock();
    return;
  }
  if (review.key(e) || projector.key(e)) {
    e.preventDefault();
    return;
  }
  const el = e.target as HTMLElement | null;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
  if (el?.closest?.(".xterm")) return;
  if (modalOpen()) return;
  if (cctvKey(e)) {
    e.preventDefault();
    return;
  }
  const key = e.key.toLowerCase();
  if (key === "e") interact();
  else if (key === "o") startOfficeHours();
  else if (key === "r") openRoundup();
  else if (key === "g") openGoals();
  else if (key === "f") openFocus();
  else if (key === "h" || key === "?") hud.openHelp();
  else if (key === "t") openTravel();
  else if (key === "v") player.toggleView();
  else if (key === "b") toggleBoard();
  else if (key === "c") openChat();
  else if (key === "q" && player.boosted > 0) {
    // Put the coffee down: the cup goes, and the speed boost with it.
    player.boostFor(0);
    sound.click();
    hud.toast("☕ Coffee down — back to normal speed");
  }
  else if (key === "u") openStandupNow();
  else if (key === "m") applySettings({ ...settings, minimap: !settings.minimap });
  else if (key === "l") openLaptop();
  else if (key === "k") openMonitorNow();
  else if (key === "n") nextNeedsYou();
  else if (key === "p") phone.toggle();
  else if (e.key === "Tab") {
    e.preventDefault();
    // Tab frees a captured mouse for the menus; with the mouse free it shows or hides the panel.
    if (player.mouseCaptured) player.unlock();
    else hud.togglePanel();
  }
});

window.addEventListener("resize", () => world.resize());
// With the mouse captured, a left click uses whatever you're at, like E.
canvas.addEventListener("pointerdown", (e) => {
  if (modalOpen() || !player.mouseCaptured || e.button !== 0) return;
  interact();
});

// --- main loop -------------------------------------------------------------------------------

/** The mouse was captured when a window opened: capture it again when the window closes. */
let relockAfterWindow = false;
let lastPresence = 0;
let last = performance.now();
let sentX = NaN;
let sentZ = NaN;
let sentFacing = NaN;
/** Which floor you were on last frame (null before the first). */
let wasUpstairs: number | null = null;

function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  // Windows can't be seen in the headset: close them and say so.
  if (vr.presenting && modalOpen()) {
    const title = document.querySelector(".modal h2")?.textContent ?? "A window";
    escapeModal();
    vr.notify(`🖥 ${title} opens on your monitor — try it after VR`);
  }
  vr.update();
  player.enabled = !modalOpen();
  // A window opening hands the mouse back — and closing it takes it again,
  // if it was captured when the window opened (freed with Tab, it stays free).
  if (!player.enabled && player.mouseCaptured) {
    player.unlock();
    relockAfterWindow = true;
  } else if (player.enabled && relockAfterWindow && !terminal.isOpen && !reviewing()) {
    relockAfterWindow = false;
    if (!vr.presenting) player.lock();
  }
  player.update(dt);
  engine(player.driving ? player.driving.v : null);
  world.update(dt, player.velocity);
  onMinigames();
  shotMeter.update(dt);
  activities.update(now);
  world.gameRoom.setDisco(music.playing && music.current.id === "disco", music.pulse());
  world.hand.update(dt, player.speed, player.yawAngle, player.boosted > 0, settings.headBob);
  const workers = world.workerSpots();
  here = minimap.update({ x: player.position.x, z: player.position.z, facing: player.facing }, workers, world.peerSpots()).id;
  const { x: px, z: pz } = player.position;
  ambience.update({ x: px, z: pz, look: player.lookDir, indoors: isIndoors(px, pz), daylight: world.dayLevel, workers });
  // Changing floors: the elevator's ding.
  const upNow = floorOf(px);
  if (upNow !== wasUpstairs) {
    if (wasUpstairs !== null) sound.elevator();
    wasUpstairs = upNow;
  }
  hud.setHint(hintFor());
  // In VR an open panel is what you're using: no E key floating over it.
  world.setPrompt((vr.presenting && vr.panel.open) || reviewing() ? null : promptTarget());
  sessionPill.update(progress);

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

  world.render();
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// --- boot ------------------------------------------------------------------------------------

// You arrive in the stand-up room: every session starts with a stand-up.
player.placeAt(STANDUP.spot.x, STANDUP.spot.z, STANDUP.spot.facing);
// Joining someone else's office over the local network needs its passcode first.
net.onGiveUp = (reason) =>
  showDisconnected(reason, async () => {
    net.setPasscode(await askPasscode("Try the code again"));
    net.connect();
  });
void (async () => {
  if (needsPasscode()) net.setPasscode(await askPasscode());
  net.connect();
})();
world.loop(frame);
// Compile every shader behind the loading screen (no hitch the first time a room
// comes into view), then let the character picker show over the office.
void world.precompile().finally(() => requestAnimationFrame(() => document.getElementById("loading")?.classList.add("done")));
void pickCharacter(myName, myLook).then(({ name, look }) => {
  myName = name;
  myLook = look;
  save("domain.name.v2", name);
  save("domain.look", look);
  world.setMe(name, look);
  refreshGame();
  joined = true;
  standupDue = true;
  welcomeDue = !assistant.toured;
  // Once, after an update: where the new things are.
  try {
    if (assistant.toured && localStorage.getItem("domain.seenNews") !== "phone-1") {
      localStorage.setItem("domain.seenNews", "phone-1");
      setTimeout(
        () =>
          hud.toastHtml(
            `🤖 <b>Arnold here — what's new:</b> <b>📱 Phone</b> (top bar or <span class="key">P</span>) has stand-up, round up, reviews and alerts now · <b>💬 Chat</b> (<span class="key">C</span>) or the laptop's <b>Team</b> app: message anyone, give a task, or ask for an update · <b>🛗 Floor 2</b> is up the elevator`,
            "",
            16000,
          ),
        4000,
      );
    }
  } catch {
    /* no storage: no news */
  }
  net.send({ t: "join", name, look });
});

// A handle for poking at the office from the console (and screenshot scripts) in dev builds.
if (import.meta.env.DEV) {
  (window as unknown as { domain: unknown }).domain = { world, player, vr, music, startOfficeHours, openLaptop, openTravel, openGoals, openHistory: () => openHistory((m) => net.send(m)), openTerminal, phone, escapeModal, net, laptop, progress: () => progress, office: () => office, openHire: (deskId: string) => { const d = deskById(deskId); if (d) hire(d); } };
  (window as unknown as { __roomAt: unknown }).__roomAt = (x: number, z: number) => roomAt(x, z).id;
}

/** Your laptop (L): browser, workers' screens, the loop, decks, deploys. Near a seat, you sit down and work there. */
function openLaptop(): void {
  if (modalOpen()) return;
  const spot = nearWorkSpot();
  if (spot) sitAndWork(spot);
  else laptop.open();
}
