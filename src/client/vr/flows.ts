import type * as THREE from "three";
import type { ClientMessage, Desk, OfficeState, Presentation } from "../../shared/protocol.js";
import type { ProgressState } from "../../shared/progress.js";
import type { IdeaBoardId } from "../../shared/layout.js";
import { AGENT_LABELS, type AgentKind } from "../../shared/protocol.js";
import type { World } from "../scene/world.js";
import type { Destination } from "../ui/teleport.js";
import { canvasThumb } from "../ui/sketchpad.js";
import { Dictation, speak, stopSpeaking } from "../voice.js";
import type { PanelButton, PanelSpec } from "./panel.js";
import type { VR, VrHooks } from "./xr.js";

/**
 * What you do in VR, as floating panels: talk to a worker (hold a grip and
 * speak — it's typed into its terminal), hire one at an empty desk, hold
 * office hours (the slides on the big screen, narrated; approve or say what
 * to change), and draw ideas straight onto the whiteboards with your laser,
 * then pin them or hand them to a worker. The menu (B/Y) travels and exits.
 */

export interface VrCtx {
  world: World;
  office(): OfficeState;
  progress(): ProgressState;
  send(msg: ClientMessage): void;
  /** E as on the desktop (coffee, the ball, the pad back to work…). */
  interact(): void;
  position(): { x: number; z: number };
  /** The desk you're at (within reach), if any. */
  deskAt(): Desk | null;
  places(): Destination[];
  travel(d: Destination): void;
}

const STATUS: Record<string, string> = {
  booting: "Starting up",
  idle: "Free",
  working: "Working",
  waiting: "Needs you",
  presenting: "Presenting",
  done: "Done",
};

const HIRE: AgentKind[] = ["claude", "codex", "gemini", "opencode"];

type Mode =
  | { kind: "none" }
  | { kind: "desk"; deskId: string }
  | { kind: "review"; deskId: string; slide: number; notes: string }
  | { kind: "idea"; board: IdeaBoardId };

export class VrFlows implements VrHooks {
  vr: VR | null = null;
  private mode: Mode = { kind: "none" };
  private dictation: Dictation;
  /** What's being said right now (shown live on the panel). */
  private heard = "";
  /** Presentations you put off this session. */
  private later = new Set<string>();
  // The idea you're drawing.
  private sketch = document.createElement("canvas");
  private ink = false;
  private ideaTitle = "";
  private handTo = 0;
  private last: { x: number; y: number } | null = null;

  constructor(private ctx: VrCtx) {
    this.sketch.width = 960;
    this.sketch.height = 560;
    this.wipe();
    this.dictation = new Dictation(
      (text) => {
        this.heard = text;
        this.refresh();
      },
      () => this.heardAll(),
      (err) => this.vr?.notify(err === "not-allowed" ? "🎤 The microphone is blocked" : "🎤 Voice isn't available here"),
    );
  }

  // --- VrHooks -----------------------------------------------------------------------

  changed(on: boolean): void {
    if (on) {
      this.vr?.notify("🥽 Left stick walks · right turns · trigger points · A uses · B menu · hold grip to talk");
      return;
    }
    this.dictation.stop();
    stopSpeaking();
    if (this.mode.kind === "review") this.ctx.world.setPresenting(null);
    if (this.mode.kind === "idea") this.ctx.world.showIdeaSketch(null, null);
    this.mode = { kind: "none" };
  }

  interact(): void {
    const { x, z } = this.ctx.position();
    const w = this.ctx.world;
    const board = w.ideaBoardAt(x, z);
    if (board) return this.openIdea(board.id);
    if (w.inMyOffice(x, z) && w.nearReviewDesk(x, z)) return this.startReview();
    const desk = this.ctx.deskAt();
    if (desk) return desk.worker ? this.openWorker(desk.id) : this.openHire(desk);
    this.ctx.interact();
  }

  menu(): PanelSpec {
    const p = this.ctx.progress();
    const goal = p.goals.find((g) => g.id === p.session?.goalId) ?? p.goals.find((g) => !g.doneAt);
    const ready = this.ready().length;
    const staffed = this.ctx.office().desks.filter((d) => d.worker).length;
    const want = ["Work floor", "Your office", "Stand-up room", "Game room"];
    const places = this.ctx.places().filter((d) => want.includes(d.label));
    const buttons: PanelButton[] = places.map((d) => ({ label: `${d.icon} ${d.label}`, run: () => this.ctx.travel(d) }));
    if (ready) buttons.push({ label: `🎤 Office hours (${ready})`, tone: "good", run: () => this.goReview() });
    if (staffed) buttons.push({ label: "📣 Round everyone up", run: () => this.ctx.send({ t: "roundup", deskIds: [] }) });
    buttons.push({ label: "🚪 Leave VR", tone: "bad", run: () => this.vr?.exit() });
    return {
      title: "🥽 domain",
      lines: [goal ? `🎯 ${goal.title}` : "No goal yet — hold the stand-up after VR", `${staffed} worker${staffed === 1 ? "" : "s"} · ${ready} ready to present`],
      buttons,
    };
  }

  drawables(): THREE.Object3D[] {
    return this.ctx.world.ideaBoardFaces();
  }

  draw(hit: THREE.Intersection, phase: "start" | "move" | "end"): void {
    const board = hit.object.userData.board as IdeaBoardId | undefined;
    if (!board || !hit.uv) return;
    if (this.mode.kind !== "idea" || this.mode.board !== board) this.openIdea(board);
    const x = hit.uv.x * this.sketch.width;
    const y = (1 - hit.uv.y) * this.sketch.height;
    if (phase === "start") this.last = { x, y };
    if (phase === "end" || !this.last) {
      this.last = null;
      return;
    }
    const g = this.sketch.getContext("2d")!;
    g.strokeStyle = "#2b2d42";
    g.lineWidth = 7;
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(this.last.x, this.last.y);
    g.lineTo(x, y);
    g.stroke();
    this.last = { x, y };
    if (!this.ink) {
      this.ink = true;
      this.refresh();
    }
    this.ctx.world.showIdeaSketch(board, this.sketch);
  }

  talk(down: boolean): void {
    if (down) {
      if (this.mode.kind === "none") {
        this.vr?.notify("🎤 Talk to a worker at its desk, in a review, or at an idea board");
        return;
      }
      stopSpeaking(); // don't transcribe a worker's own voice
      this.heard = "";
      this.dictation.start();
      this.refresh();
    } else this.dictation.stop();
  }

  // --- talking -----------------------------------------------------------------------

  /** The grip was let go: put what you said where it goes. */
  private heardAll(): void {
    const text = this.heard.trim();
    this.heard = "";
    if (!text) return this.refresh();
    const m = this.mode;
    if (m.kind === "desk") {
      this.ctx.send({ t: "input", deskId: m.deskId, data: text + "\r" });
      this.vr?.notify(`🎤 → ${this.nameOf(m.deskId)}: “${text}”`);
    } else if (m.kind === "review") m.notes = m.notes ? `${m.notes} ${text}` : text;
    else if (m.kind === "idea") this.ideaTitle = text;
    this.refresh();
  }

  /** Re-draw the open panel (live transcript, new state). */
  private refresh(): void {
    const m = this.mode;
    if (!this.vr?.panel.open) return;
    if (m.kind === "desk") this.openWorker(m.deskId);
    else if (m.kind === "review") this.showReview();
    else if (m.kind === "idea") this.openIdea(m.board);
  }

  private hearing(): string[] {
    return this.dictation.isActive ? [`🎤 ${this.heard || "Listening…"}`] : [];
  }

  // --- workers -------------------------------------------------------------------------

  private nameOf(deskId: string): string {
    const w = this.ctx.office().desks.find((d) => d.id === deskId)?.worker;
    return w ? (w.identity?.name ?? AGENT_LABELS[w.agent]) : "the worker";
  }

  private openWorker(deskId: string): void {
    const desk = this.ctx.office().desks.find((d) => d.id === deskId);
    const w = desk?.worker;
    if (!desk || !w) return;
    this.mode = { kind: "desk", deskId };
    const task = this.ctx.progress().goals.flatMap((g) => g.tasks).find((t) => t.deskId === deskId && t.status === "doing");
    const key = (label: string, data: string): PanelButton => ({ label, stay: true, run: () => this.ctx.send({ t: "input", deskId, data }) });
    this.vr?.open({
      title: `${this.nameOf(deskId)} · ${STATUS[w.status] ?? w.status}`,
      lines: [task ? `🎯 ${task.title}` : w.activity, ...(this.hearing().length ? this.hearing() : ["Hold a grip and speak — it's typed into its terminal"])],
      buttons: [key("⏎ Enter", "\r"), key("⎋ Esc", "\x1b"), { label: "📣 Call it in to present", run: () => this.ctx.send({ t: "roundup", deskIds: [deskId] }) }, { label: "✔ Done", run: () => (this.mode = { kind: "none" }) }],
    });
  }

  private openHire(desk: Desk): void {
    this.mode = { kind: "none" };
    const team = this.ctx.progress().team.slice(0, 4);
    const buttons: PanelButton[] = [
      ...team.map((c) => ({ label: `👤 ${c.name}`, run: () => this.ctx.send({ t: "hire", deskId: desk.id, agent: c.agent, characterId: c.id }) })),
      ...HIRE.map((agent) => ({ label: AGENT_LABELS[agent], run: () => this.ctx.send({ t: "hire", deskId: desk.id, agent }) })),
    ];
    this.vr?.open({ title: `🪑 Hire at ${desk.label}`, lines: [team.length ? "Someone from your team, or a fresh agent" : "Pick an agent — it starts in a real terminal here"], buttons });
  }

  // --- office hours -----------------------------------------------------------------------

  private ready(): Presentation[] {
    return this.ctx.office().presentations.filter((p) => p.report && p.report.check?.status !== "running");
  }

  /** Walk to your desk and start. */
  private goReview(): void {
    const office = this.ctx.places().find((d) => d.label === "Your office");
    if (office) this.ctx.travel(office);
    this.startReview();
  }

  private startReview(): void {
    const ready = this.ready();
    const p = ready.find((x) => !this.later.has(x.deskId)) ?? ready[0];
    if (!p) {
      this.mode = { kind: "none" };
      const staffed = this.ctx.office().desks.some((d) => d.worker);
      this.vr?.open({
        title: "⭐ Your desk",
        lines: ["Nobody's ready to present yet."],
        buttons: staffed ? [{ label: "📣 Round everyone up", run: () => this.ctx.send({ t: "roundup", deskIds: [] }) }] : [{ label: "OK", run: () => {} }],
      });
      return;
    }
    this.later.delete(p.deskId);
    this.mode = { kind: "review", deskId: p.deskId, slide: 0, notes: "" };
    this.ctx.world.setPresenting(p.deskId, 0);
    this.showReview();
    this.narrate();
  }

  private presentation(): Presentation | null {
    const m = this.mode;
    return m.kind === "review" ? (this.ctx.office().presentations.find((p) => p.deskId === m.deskId) ?? null) : null;
  }

  private narrate(): void {
    const m = this.mode;
    const p = this.presentation();
    if (m.kind !== "review" || !p?.report) return;
    const r = p.report;
    const text = m.slide === 0 ? `${r.title}. ${r.summary}` : (r.slides[m.slide - 1] ?? "");
    const voice = this.ctx.office().desks.find((d) => d.id === m.deskId)?.worker?.identity?.voice ?? "";
    speak(text, p.agent, undefined, voice);
  }

  private showReview(): void {
    const m = this.mode;
    const p = this.presentation();
    if (m.kind !== "review" || !p?.report) {
      this.vr?.close();
      return;
    }
    const r = p.report;
    const count = 1 + r.slides.length;
    const go = (d: number) => () => {
      m.slide = Math.max(0, Math.min(count - 1, m.slide + d));
      this.ctx.world.setPresenting(m.deskId, m.slide);
      this.showReview();
      this.narrate();
    };
    const check = r.check ? (r.check.status === "pass" ? `✅ ${r.check.command} passed` : r.check.status === "fail" ? `❌ ${r.check.command} failed` : "") : "";
    const plan = r.status === "plan";
    this.vr?.open({
      title: `🎤 ${this.nameOf(m.deskId)} ${plan ? "has a plan" : r.status === "blocked" ? "needs a decision" : "presents"}`,
      lines: [
        `“${r.title}” · slide ${m.slide + 1} of ${count}`,
        ...(check ? [check] : []),
        ...(this.hearing().length ? this.hearing() : [m.notes ? `📝 ${m.notes}` : "Hold a grip to talk: ask it something, or say what to change"]),
      ],
      cols: 3,
      buttons: [
        { label: "◀ Back", stay: true, run: go(-1) },
        { label: "Next ▶", stay: true, run: go(1) },
        { label: "💬 Ask it", stay: true, run: () => this.ask() },
        { label: plan ? "✅ Approve plan" : "✅ Approve", tone: "good", run: () => this.decide(true) },
        { label: "✏️ Send changes", tone: "bad", stay: true, run: () => this.decide(false) },
        { label: "⏭ Later", run: () => this.putOff() },
      ],
    }, true);
  }

  private ask(): void {
    const m = this.mode;
    if (m.kind !== "review") return;
    if (!m.notes) {
      this.vr?.notify("🎤 Hold a grip and say your question first");
      return;
    }
    this.ctx.send({ t: "say", deskId: m.deskId, text: m.notes });
    this.vr?.notify(`💬 Asked: “${m.notes}”`);
    m.notes = "";
    this.showReview();
  }

  private decide(approve: boolean): void {
    const m = this.mode;
    if (m.kind !== "review") return;
    if (!approve && !m.notes) {
      this.vr?.notify("🎤 Hold a grip and say what should change first");
      return;
    }
    this.ctx.send({ t: "review", deskId: m.deskId, approve, text: m.notes || undefined });
    this.next();
  }

  private putOff(): void {
    const m = this.mode;
    if (m.kind === "review") this.later.add(m.deskId);
    this.next();
  }

  /** On to whoever's next in line, or wrap up. */
  private next(): void {
    stopSpeaking();
    const m = this.mode;
    const done = m.kind === "review" ? m.deskId : null;
    this.ctx.world.setPresenting(null);
    this.mode = { kind: "none" };
    // The server takes a moment to clear the decided one from the line.
    setTimeout(() => {
      const more = this.ready().filter((p) => p.deskId !== done && !this.later.has(p.deskId));
      if (more.length) this.startReview();
      else {
        this.vr?.close();
        this.vr?.notify("⭐ That's everyone — office hours are over");
      }
    }, 400);
  }

  // --- ideas ---------------------------------------------------------------------------------

  private wipe(): void {
    const g = this.sketch.getContext("2d")!;
    g.fillStyle = "#fbfdff";
    g.fillRect(0, 0, this.sketch.width, this.sketch.height);
    this.ink = false;
  }

  private openIdea(board: IdeaBoardId): void {
    this.mode = { kind: "idea", board };
    const staffed = this.ctx.office().desks.filter((d) => d.worker);
    const to = staffed.length ? staffed[this.handTo % staffed.length] : null;
    const buttons: PanelButton[] = [{ label: "📌 Pin it", tone: "good", run: () => this.saveIdea() }];
    if (to) {
      buttons.push({ label: `🤝 Hand to ${this.nameOf(to.id)}`, run: () => this.saveIdea({ handoff: to.id }) });
      if (staffed.length > 1) buttons.push({ label: "Someone else ▸", stay: true, run: () => ((this.handTo += 1), this.openIdea(board)) });
    }
    buttons.push({ label: "🎯 Make it a goal", run: () => this.saveIdea({ goal: true }) });
    buttons.push({
      label: "🧽 Wipe",
      stay: true,
      run: () => {
        this.wipe();
        this.ideaTitle = "";
        this.ctx.world.showIdeaSketch(board, this.sketch);
        this.openIdea(board);
      },
    });
    this.vr?.open({
      title: "💡 Idea board",
      lines: [
        this.ink ? "Keep drawing, or pin it" : "Point at the board and hold the trigger to draw",
        ...(this.hearing().length ? this.hearing() : [this.ideaTitle ? `“${this.ideaTitle}”` : "Hold a grip and say what it is"]),
      ],
      buttons,
    }, true);
  }

  private saveIdea(then?: { handoff?: string; goal?: boolean }): void {
    if (!this.ink && !this.ideaTitle) {
      this.vr?.notify("💡 Draw something or say what it is first");
      return;
    }
    this.ctx.send({
      t: "ideaSave",
      idea: { title: this.ideaTitle, text: this.ideaTitle, kind: "build", thumb: this.ink ? canvasThumb(this.sketch) : null },
      ...(this.ink ? { sketch: this.sketch.toDataURL("image/png") } : {}),
      ...(then ? { then } : {}),
    });
    this.wipe();
    this.ideaTitle = "";
    this.ctx.world.showIdeaSketch(null, null);
    this.mode = { kind: "none" };
  }
}
