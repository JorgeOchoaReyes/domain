import {
  CAMPFIRE,
  DOCK_SPOT,
  GARDEN,
  TRACK_CHECKPOINTS,
  UP,
} from "../../shared/layout.js";
import { DART_ORDER as ORDER, dartScore } from "../../shared/darts.js";
import { esc, openModal } from "./modal.js";
import { sound } from "./fx.js";
import "../styles/activities.css";

/**
 * Things to do between reviews — upstairs: darts, the piano, the vending
 * machine, a treadmill, a breathing mat, the bookshelf, the telescope; out
 * back: fishing off the dock, timed laps of the track, watering the garden,
 * a marshmallow at the campfire. Each is a spot: walk up, the hint says what
 * E does. Bests and catches are kept in this browser.
 */

export interface ActivityContext {
  position(): { x: number; z: number };
  placeAt(x: number, z: number, facing: number): void;
  boostFor(ms: number): void;
  toast(text: string): void;
  setTreadmill(i: number | null): void;
  fishing: { cast(): void; bite(): void; reset(): void };
  setBloom(level: number): void;
  /** Is a window open (then nothing in the world reacts)? */
  busy(): boolean;
}

export interface Activity {
  id: string;
  title: string;
  /** What E does, as hint HTML after the key. */
  hint: string;
  /** Where the floating E goes. */
  key: { x: number; y: number; z: number };
}

const store = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem(`domain.${k}`);
      return v === null ? d : (JSON.parse(v) as T);
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown): void {
    try {
      localStorage.setItem(`domain.${k}`, JSON.stringify(v));
    } catch {
      /* fine */
    }
  },
};

const near = (p: { x: number; z: number }, s: { x: number; z: number }, r: number) => Math.hypot(p.x - s.x, p.z - s.z) < r;

const TIPS = [
  "Give each task a “Done means” list — the review holds the worker to it, and you to it.",
  "Pair a builder with an auditor: they go back and forth until it's really ready (three rounds at most), then you get one report.",
  "Set a deadline on a goal: I'll remind you an hour out, fifteen minutes out, and if it slips.",
  "Plan first is cheap insurance: the worker shows you its plan before it touches the code.",
  "Give a goal to a group: one plans it, then tasks go out across them as each one finishes.",
  "Ring the gong after a restart: everyone you had wakes up right where they left off.",
  "Your phone (P) has everything — alerts, chat, goals, reviews — and you can keep walking.",
  "The team chat's 🖥 Terminal button types straight into a worker's terminal — /model, y, anything.",
  "Small tasks ship. If a task needs more than an hour, it's probably two tasks.",
  "Round up (R) asks everyone to wrap up and present — good before lunch or a meeting.",
  "Projector reviews put the slides on the big screen in your office; sit in your chair and step through.",
  "A worker that's waiting on you for long shows up in Alerts, chimes, and comes back until you answer.",
  "Take the laptop to a couch (L near a seat): it stays there for next time.",
  "Five minutes on the treadmill counts. So does one minute on the breathing mat.",
  "History (📜) remembers every task, review and ship — handy for the weekly update.",
  "Research goals end in a deck, not a PR — present it from the laptop's 📊 Decks.",
  "Check “Keep the checks green” in Team defaults so nothing reaches you red.",
  "If two workers keep colliding, give them separate folders — they have their own worktrees already.",
];

const SNACKS = [
  ["🍫", "A chocolate bar", "Sugar rush: you're quicker for a bit"],
  ["🥨", "Pretzels", "Salty, crunchy, and somehow productive"],
  ["🍎", "An apple", "Healthy choice. Your future self thanks you"],
  ["🥤", "A fizzy drink", "Bubbles! Zoom"],
  ["🍪", "A giant cookie", "It's the size of your face"],
  ["🥜", "Trail mix", "Mostly raisins. Classic"],
  ["🧃", "A juice box", "Tiny straw, big energy"],
] as const;

const FISH: { icon: string; name: string; weight: number; rare?: boolean }[] = [
  { icon: "🐟", name: "a little perch", weight: 30 },
  { icon: "🐠", name: "a sunfish", weight: 22 },
  { icon: "🐡", name: "a puffer (how?)", weight: 8 },
  { icon: "🦐", name: "a shrimp", weight: 12 },
  { icon: "🥾", name: "an old boot", weight: 10 },
  { icon: "🦆", name: "…a duck. You let it go", weight: 6 },
  { icon: "🐢", name: "a turtle — it waves", weight: 6 },
  { icon: "🐙", name: "an octopus?!", weight: 3, rare: true },
  { icon: "💾", name: "a floppy disk with someone's README", weight: 2, rare: true },
  { icon: "🐋", name: "A WHALE (it's a small pond)", weight: 1, rare: true },
];

function pick<T extends { weight: number }>(list: T[]): T {
  let r = Math.random() * list.reduce((n, x) => n + x.weight, 0);
  for (const x of list) if ((r -= x.weight) <= 0) return x;
  return list[0];
}

export class Activities {
  private fish: { state: "idle" | "waiting" | "bite"; at: number } = { state: "idle", at: 0 };
  private lap: { next: number; dir: 1 | -1 | 0; start: number; visited: number } | null = null;
  private tread: { i: number; start: number; x: number; z: number } | null = null;
  private roasting = 0;

  constructor(private c: ActivityContext) {
    // The garden wilts a little each day you don't water it.
    const g = store.get("garden", { day: "", level: 0.35 });
    const today = new Date().toDateString();
    if (g.day && g.day !== today) {
      const days = Math.round((Date.parse(today) - Date.parse(g.day)) / 86_400_000);
      g.level = Math.max(0.2, g.level - 0.3 * Math.max(1, days));
    }
    this.c.setBloom(g.level);
  }

  /** What's here to do, if anything. */
  near(): Activity | null {
    const p = this.c.position();
    if (this.tread) return { id: "tread", title: "🏃 Treadmill", hint: `${this.treadStats()} — move to step off`, key: { x: UP.treadmills[this.tread.i].x, y: 2, z: UP.treadmills[this.tread.i].z } };
    if (near(p, UP.dartsSpot, 1.4)) return { id: "darts", title: "🎯 Darts", hint: `Throw three · best ${store.get<number>("darts.best", 0)}`, key: { x: UP.darts.x + 0.6, y: UP.darts.y, z: UP.darts.z + 0.3 } };
    if (near(p, UP.pianoSpot, 1.3)) return { id: "piano", title: "🎹 Piano", hint: "Sit down and play", key: { x: UP.piano.x, y: 1.6, z: UP.piano.z - 0.3 } };
    if (near(p, UP.vendingSpot, 1.3)) return { id: "vending", title: "🍫 Vending machine", hint: "Grab a snack · a little speed boost", key: { x: UP.vending.x, y: 2.4, z: UP.vending.z + 0.5 } };
    for (let i = 0; i < UP.treadmills.length; i++) {
      const t = UP.treadmills[i];
      if (near(p, { x: t.x, z: t.z + 0.3 }, 1.2)) return { id: `tread-${i}`, title: "🏃 Treadmill", hint: `Hop on · best ${(store.get<number>("tread.best", 0) / 1000).toFixed(2)} km`, key: { x: t.x, y: 1.8, z: t.z - 0.8 } };
    }
    for (const m of UP.mats) if (near(p, m, 1.2)) return { id: "breathe", title: "🧘 Breathing mat", hint: "One calm minute", key: { x: m.x, y: 1.0, z: m.z } };
    if (near(p, UP.shelfSpot, 1.5)) return { id: "shelf", title: "📚 Bookshelf", hint: "Pull a book: a tip for running your team", key: { x: UP.shelfSpot.x - 0.6, y: 1.9, z: UP.shelfSpot.z } };
    if (near(p, UP.telescopeSpot, 1.2)) return { id: "telescope", title: "🔭 Telescope", hint: "Look out over the city", key: { x: UP.telescope.x, y: 1.8, z: UP.telescope.z } };
    if (near(p, DOCK_SPOT, 1.0)) {
      const caught = store.get<string[]>("fish", []);
      const hint = this.fish.state === "idle" ? `Cast a line · ${caught.length} caught` : this.fish.state === "waiting" ? "Waiting for a bite… (E reels in)" : "❗ A BITE — press E now!";
      return { id: "fish", title: "🎣 Fishing", hint, key: { x: DOCK_SPOT.x + 0.8, y: 1.4, z: DOCK_SPOT.z } };
    }
    if (near(p, GARDEN.spot, 1.6)) return { id: "garden", title: "🌻 Garden", hint: "Water the flowers", key: { x: GARDEN.spot.x, y: 1.3, z: GARDEN.spot.z - 1 } };
    if (near(p, CAMPFIRE, CAMPFIRE.logR - 0.4) || (near(p, CAMPFIRE, CAMPFIRE.logR + 1.4) && !near(p, { x: CAMPFIRE.x, z: CAMPFIRE.z + CAMPFIRE.logR }, 1.2))) {
      return { id: "fire", title: "🔥 Campfire", hint: this.roasting ? "Roasting…" : "Roast a marshmallow", key: { x: CAMPFIRE.x, y: 1.6, z: CAMPFIRE.z } };
    }
    return null;
  }

  /** E: do whatever's here. True if something happened. */
  use(): boolean {
    const a = this.near();
    if (!a) return false;
    const id = a.id;
    if (id === "tread") {
      this.stopTreadmill();
      return true;
    }
    if (id === "darts") openDarts();
    else if (id === "piano") openPiano();
    else if (id === "vending") this.snack();
    else if (id.startsWith("tread-")) this.startTreadmill(Number(id.slice(6)));
    else if (id === "breathe") openBreathing(() => this.c.toast("🧘 One calm minute. Back to it, gently."));
    else if (id === "shelf") {
      sound.click();
      this.c.toast(`📚 ${TIPS[Math.floor(Math.random() * TIPS.length)]}`);
    } else if (id === "telescope") this.telescope();
    else if (id === "fish") this.fishE();
    else if (id === "garden") this.water();
    else if (id === "fire") this.marshmallow();
    return true;
  }

  /** Every frame: fishing timers, laps, the treadmill. */
  update(now = performance.now()): void {
    const p = this.c.position();
    // Fishing: walking off the dock reels in.
    if (this.fish.state !== "idle") {
      if (!near(p, DOCK_SPOT, 1.6)) this.reelIn(false);
      else if (this.fish.state === "waiting" && now >= this.fish.at) {
        this.fish = { state: "bite", at: now + 1400 };
        this.c.fishing.bite();
        sound.splash();
        this.c.toast("❗ Something's biting — press E!");
      } else if (this.fish.state === "bite" && now >= this.fish.at) {
        this.c.fishing.reset();
        this.fish = { state: "idle", at: 0 };
        this.c.toast("🎣 It got away… cast again?");
      }
    }
    // Laps: pass the checkpoints in order, either way round.
    this.trackLap(p, now);
    // The treadmill: stepping off ends it.
    if (this.tread && Math.hypot(p.x - this.tread.x, p.z - this.tread.z) > 0.5) this.stopTreadmill();
  }

  private trackLap(p: { x: number; z: number }, now: number): void {
    const at = TRACK_CHECKPOINTS.findIndex((c) => near(p, c, 2.2));
    if (at < 0) return;
    if (!this.lap) {
      if (at === 0) this.lap = { next: -1, dir: 0, start: now, visited: 0 };
      return;
    }
    const L = this.lap;
    if (at === 0) {
      if (L.visited === 3) {
        const t = (now - L.start) / 1000;
        const best = store.get<number>("lap.best", 0);
        const record = !best || t < best;
        if (record) store.set("lap.best", t);
        sound.xp();
        this.c.toast(`🏁 Lap: ${t.toFixed(1)} s${record ? " — a new best!" : ` · best ${best.toFixed(1)} s`}`);
        this.lap = { next: -1, dir: 0, start: now, visited: 0 };
      } else if (L.visited === 0) L.start = now;
      return;
    }
    if (L.dir === 0) {
      if (at === 1 || at === 3) {
        L.dir = at === 1 ? 1 : -1;
        L.visited = 1;
        L.next = (at + L.dir + 4) % 4;
      }
      return;
    }
    if (at === L.next) {
      L.visited++;
      L.next = (at + L.dir + 4) % 4;
    } else if (at !== (L.next - L.dir + 4) % 4) {
      this.lap = null;
    }
  }

  private snack(): void {
    const [icon, name, line] = SNACKS[Math.floor(Math.random() * SNACKS.length)];
    sound.click();
    this.c.boostFor(45_000);
    this.c.toast(`${icon} ${name} — ${line} (45 s)`);
  }

  private startTreadmill(i: number): void {
    const t = UP.treadmills[i];
    const x = t.x;
    const z = t.z + 0.25;
    this.c.placeAt(x, z, Math.PI);
    this.tread = { i, start: performance.now(), x, z };
    this.c.setTreadmill(i);
    sound.click();
    this.c.toast("🏃 On the treadmill — walk and think. Move to step off.");
  }

  private treadStats(): string {
    if (!this.tread) return "";
    const s = (performance.now() - this.tread.start) / 1000;
    return `${((s * 1.6) / 1000).toFixed(2)} km · ${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  }

  private stopTreadmill(): void {
    if (!this.tread) return;
    const s = (performance.now() - this.tread.start) / 1000;
    const m = s * 1.6;
    const best = store.get<number>("tread.best", 0);
    if (m > best) store.set("tread.best", m);
    this.c.setTreadmill(null);
    this.tread = null;
    if (s > 5) this.c.toast(`🏃 ${(m / 1000).toFixed(2)} km in ${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}${m > best && best ? " — your longest yet!" : ""}`);
  }

  private fishE(): void {
    if (this.fish.state === "idle") {
      this.c.placeAt(DOCK_SPOT.x, DOCK_SPOT.z, DOCK_SPOT.facing);
      this.c.fishing.cast();
      sound.splash();
      this.fish = { state: "waiting", at: performance.now() + 2500 + Math.random() * 6000 };
      this.c.toast("🎣 Line's out… wait for the bobber to dip");
    } else this.reelIn(this.fish.state === "bite");
  }

  private reelIn(caught: boolean): void {
    this.c.fishing.reset();
    this.fish = { state: "idle", at: 0 };
    if (!caught) return;
    const f = pick(FISH);
    const all = store.get<string[]>("fish", []);
    const fresh = !all.includes(f.name);
    all.push(f.name);
    store.set("fish", all.slice(-500));
    if (f.rare) sound.achievement();
    else sound.xp();
    this.c.toast(`${f.icon} You caught ${f.name}!${fresh ? " (new!)" : ""} · ${all.length} caught`);
  }

  private water(): void {
    const g = store.get("garden", { day: "", level: 0.35 });
    const today = new Date().toDateString();
    const already = g.day === today && g.level >= 1;
    g.level = Math.min(1, g.level + 0.25);
    g.day = today;
    store.set("garden", g);
    this.c.setBloom(g.level);
    sound.splash();
    this.c.toast(already ? "🌻 It's in full bloom — come back tomorrow" : g.level >= 1 ? "🌻 Full bloom! The bees are thrilled" : "💧 Watered — the flowers perk up");
  }

  private marshmallow(): void {
    if (this.roasting) return;
    this.roasting = window.setTimeout(() => {
      this.roasting = 0;
      const r = Math.random();
      this.c.toast(r < 0.55 ? "🍡 Perfectly golden. Chef's kiss." : r < 0.85 ? "🍡 A little toasty — still great" : "🔥 Fully on fire. Blow it out. Eat it anyway.");
      sound.xp();
    }, 2600);
    this.c.toast("🔥 Roasting a marshmallow…");
  }

  private telescope(): void {
    const h = new Date().getHours();
    const sights =
      h >= 20 || h < 6
        ? ["the city lights twinkling", "a plane blinking across the stars", "someone else still working late, three towers over", "the moon over the river"]
        : ["a window cleaner waving from a tower", "a pigeon on a crane, supervising", "the river glittering", "a rooftop garden with a tiny dog", "a hot-air balloon, far off"];
    sound.click();
    this.c.toast(`🔭 You spot ${sights[Math.floor(Math.random() * sights.length)]}.`);
  }
}

// ---------------------------------------------------------------------------
// Darts: three throws at a board; your aim sways, so time the release.
// ---------------------------------------------------------------------------

function openDarts(): void {
  const body = document.createElement("div");
  body.className = "darts";
  body.innerHTML = `<canvas width="440" height="440"></canvas><div class="dt-bar"><span class="dt-throws"></span><span class="dt-total"></span><button class="btn small dt-again">↻ Again</button></div><p class="dt-help">Move the mouse to aim — it sways — and click (or Space) to throw. Three darts.</p>`;
  let raf = 0;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === " " || e.key.toLowerCase() === "e") {
      e.preventDefault();
      e.stopPropagation();
      if (darts.length >= 3) darts = [];
      else throwDart();
      renderBar();
    }
  };
  openModal({
    title: "Darts",
    icon: "🎯",
    className: "darts-modal",
    body,
    onClose: () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey, true);
    },
  });
  const cv = body.querySelector("canvas")!;
  const g = cv.getContext("2d")!;
  const R = 190;
  const C = 220;
  let aim = { x: C, y: C };
  let darts: { x: number; y: number; s: number }[] = [];
  let t = 0;
  const best = () => store.get<number>("darts.best", 0);
  const drawBoard = () => {
    g.clearRect(0, 0, 440, 440);
    g.fillStyle = "#1b1b26";
    g.beginPath();
    g.arc(C, C, R + 26, 0, Math.PI * 2);
    g.fill();
    for (let i = 0; i < 20; i++) {
      const a0 = ((i * 18 - 9 - 90) * Math.PI) / 180;
      const a1 = a0 + (18 * Math.PI) / 180;
      const ring = (r0: number, r1: number, color: string) => {
        g.fillStyle = color;
        g.beginPath();
        g.arc(C, C, r1 * R, a0, a1);
        g.arc(C, C, r0 * R, a1, a0, true);
        g.fill();
      };
      const dark = i % 2 === 0;
      ring(0.094, 0.58, dark ? "#262626" : "#f1e3c6");
      ring(0.58, 0.63, dark ? "#d62839" : "#2a9d8f");
      ring(0.63, 0.95, dark ? "#262626" : "#f1e3c6");
      ring(0.95, 1, dark ? "#d62839" : "#2a9d8f");
      g.fillStyle = "#fff";
      g.font = "bold 15px system-ui";
      g.textAlign = "center";
      g.textBaseline = "middle";
      const am = (a0 + a1) / 2;
      g.fillText(String(ORDER[i]), C + Math.cos(am) * (R + 14), C + Math.sin(am) * (R + 14));
    }
    g.fillStyle = "#2a9d8f";
    g.beginPath();
    g.arc(C, C, 0.094 * R, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#d62839";
    g.beginPath();
    g.arc(C, C, 0.037 * R, 0, Math.PI * 2);
    g.fill();
  };
  const sway = () => ({ x: aim.x + Math.sin(t * 2.3) * 18 + Math.sin(t * 5.1) * 7, y: aim.y + Math.cos(t * 1.9) * 16 + Math.sin(t * 4.3) * 6 });
  const frame = () => {
    t += 1 / 60;
    drawBoard();
    for (const d of darts) {
      g.fillStyle = "#ffd166";
      g.strokeStyle = "#000";
      g.lineWidth = 2;
      g.beginPath();
      g.arc(d.x, d.y, 5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    if (darts.length < 3) {
      const s = sway();
      g.strokeStyle = "#ffffff";
      g.lineWidth = 2;
      g.beginPath();
      g.arc(s.x, s.y, 10, 0, Math.PI * 2);
      g.moveTo(s.x - 16, s.y);
      g.lineTo(s.x + 16, s.y);
      g.moveTo(s.x, s.y - 16);
      g.lineTo(s.x, s.y + 16);
      g.stroke();
    }
    raf = requestAnimationFrame(frame);
  };
  const renderBar = () => {
    const total = darts.reduce((n, d) => n + d.s, 0);
    body.querySelector(".dt-throws")!.textContent = darts.map((d) => d.s).join(" · ") || "—";
    body.querySelector(".dt-total")!.textContent = `Total ${total} · best ${best()}`;
  };
  const throwDart = () => {
    if (darts.length >= 3) return;
    const s = sway();
    const score = dartScore((s.x - C) / R, (s.y - C) / R);
    darts.push({ x: s.x, y: s.y, s: score });
    sound.thunk();
    if (darts.length === 3) {
      const total = darts.reduce((n, d) => n + d.s, 0);
      if (total > best()) {
        store.set("darts.best", total);
        sound.achievement();
      }
    }
    renderBar();
  };
  cv.addEventListener("mousemove", (e) => {
    const r = cv.getBoundingClientRect();
    aim = { x: ((e.clientX - r.left) / r.width) * 440, y: ((e.clientY - r.top) / r.height) * 440 };
  });
  cv.addEventListener("click", throwDart);
  body.querySelector(".dt-again")!.addEventListener("click", () => {
    darts = [];
    renderBar();
  });
  window.addEventListener("keydown", onKey, true);
  renderBar();
  frame();
}

// ---------------------------------------------------------------------------
// The piano: two octaves on your keyboard (or click the keys).
// ---------------------------------------------------------------------------

const WHITE_KEYS = "asdfghjkl;'".split("");
const BLACK_KEYS: Record<number, string> = { 0: "w", 1: "e", 3: "t", 4: "y", 5: "u", 7: "o", 8: "p" };
const SEMIS_WHITE = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17];
const freq = (semi: number) => 261.63 * Math.pow(2, semi / 12);
const ODE = [4, 4, 5, 7, 7, 5, 4, 2, 0, 0, 2, 4, 4, 2, 2];

function openPiano(): void {
  const body = document.createElement("div");
  body.className = "piano";
  const whites = SEMIS_WHITE.map((s, i) => `<button class="pk w" data-s="${s}"><span>${esc(WHITE_KEYS[i].toUpperCase())}</span></button>`).join("");
  const blacks = Object.entries(BLACK_KEYS)
    .map(([i, k]) => `<button class="pk b" data-s="${SEMIS_WHITE[Number(i)] + 1}" style="left:${(Number(i) + 1) * 54 - 17}px"><span>${esc(k.toUpperCase())}</span></button>`)
    .join("");
  body.innerHTML = `<div class="pk-keys">${whites}${blacks}</div><div class="pk-bar"><button class="btn small pk-tune">🎼 Play a tune</button><span class="as-hint">Keys A–' are the white notes, W E T Y U O P the black ones.</span></div>`;
  openModal({ title: "Piano", icon: "🎹", className: "piano-modal", body });
  const press = (semi: number) => {
    sound.note(freq(semi));
    const el = body.querySelector<HTMLElement>(`.pk[data-s="${semi}"]`);
    el?.classList.add("down");
    setTimeout(() => el?.classList.remove("down"), 160);
  };
  body.querySelectorAll<HTMLElement>(".pk").forEach((b) => b.addEventListener("pointerdown", () => press(Number(b.dataset.s))));
  body.querySelector(".pk-tune")!.addEventListener("click", () => ODE.forEach((s, i) => setTimeout(() => press(s), i * 320)));
  const keyMap = new Map<string, number>();
  WHITE_KEYS.forEach((k, i) => keyMap.set(k, SEMIS_WHITE[i]));
  for (const [i, k] of Object.entries(BLACK_KEYS)) keyMap.set(k, SEMIS_WHITE[Number(i)] + 1);
  const onKey = (e: KeyboardEvent) => {
    if (!body.isConnected) {
      window.removeEventListener("keydown", onKey, true);
      return;
    }
    const s = keyMap.get(e.key.toLowerCase());
    if (s === undefined || e.repeat) return;
    e.preventDefault();
    e.stopPropagation();
    press(s);
  };
  window.addEventListener("keydown", onKey, true);
}

// ---------------------------------------------------------------------------
// The breathing mat: one guided minute.
// ---------------------------------------------------------------------------

function openBreathing(done: () => void): void {
  const el = document.createElement("div");
  el.className = "breathe";
  el.innerHTML = `<div class="br-circle"></div><div class="br-text">Breathe in…</div><div class="br-left"></div><button class="btn small br-stop">I'm good</button>`;
  document.body.append(el);
  const text = el.querySelector<HTMLElement>(".br-text")!;
  const left = el.querySelector<HTMLElement>(".br-left")!;
  const start = performance.now();
  const PHASES: [string, number][] = [
    ["Breathe in…", 4],
    ["Hold", 4],
    ["And out, slowly…", 6],
  ];
  const cycle = PHASES.reduce((n, p) => n + p[1], 0);
  const tick = setInterval(() => {
    const s = (performance.now() - start) / 1000;
    if (s >= 60) return end(true);
    let k = s % cycle;
    for (const [label, d] of PHASES) {
      if (k < d) {
        text.textContent = label;
        break;
      }
      k -= d;
    }
    left.textContent = `${Math.ceil(60 - s)} s`;
  }, 200);
  const end = (finished: boolean) => {
    clearInterval(tick);
    window.removeEventListener("keydown", onKey, true);
    el.remove();
    if (finished) {
      sound.bell();
      done();
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      end(false);
    }
  };
  window.addEventListener("keydown", onKey, true);
  el.querySelector(".br-stop")!.addEventListener("click", () => end(false));
}
