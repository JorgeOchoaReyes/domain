import { join, resolve, dirname } from "node:path";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import type {
  AgentKind,
  CheckResult,
  Desk,
  Look,
  OfficeState,
  Peer,
  Presentation,
  Report,
  Worker,
} from "../shared/protocol.js";
import { AGENT_LABELS, DEFAULT_LOOK, coerceReply, coerceReport } from "../shared/protocol.js";
import { DESKS, SPAWN } from "../shared/layout.js";
import { createWorker, type IWorkerSession } from "./workerSession.js";
import type { Leash, TaskBrief } from "../shared/policy.js";
import type { WorkerIdentity } from "../shared/team.js";
import { DropWatcher, writeBrief } from "./reports.js";
import { Workspaces, type Workspace } from "./workspace.js";

interface Seat {
  desk: Desk;
  session: IWorkerSession | null;
  /** Unsubscribe callbacks for the live session's listeners. */
  cleanup: (() => void)[];
  /** The worker's own git worktree and branch, if it has one. */
  workspace: Workspace | null;
  /** What it was doing before it went quiet, to show again when it picks up. */
  busyWith?: string;
  /** Remembered from last time and not running yet: the gong (or E) wakes it. */
  asleep?: Remembered;
  /**
   * A worker in its own folder reports and replies there (its .domain/,
   * which git ignores) — never outside it, where agents must ask permission.
   */
  drops?: { dir: string; watchers: Pick<DropWatcher<{ at: number }>, "start" | "stop" | "forget">[] };
}

/** Presence record for a connected client. */
interface Presence {
  peer: Peer;
}

export interface OfficeOptions {
  /** Directory real terminals start in. Defaults to the server's cwd. */
  cwd?: string;
  /** Force simulated workers (no real local terminals). */
  simulate?: boolean;
  /** Whether you've trusted this project's worker folders (agents' trust prompts get answered). */
  trusted?: () => boolean;
  /** Where the office remembers who's at which desk between runs (null: it doesn't). */
  memory?: string | null;
}

/** A worker as remembered between runs: enough to wake it where it was. */
interface Remembered {
  deskId: string;
  agent: AgentKind;
  hiredBy: string;
  model: string;
  leash: Leash;
  identity: WorkerIdentity | null;
  workspace: Workspace | null;
  activity: string;
}

/**
 * Authoritative office state: the desks, who is sitting at them, the people
 * connected, and the line of workers waiting to present. The server owns
 * exactly one of these.
 *
 * The office does not know about WebSockets; it emits plain events and lets
 * the networking layer broadcast them. That keeps the room logic testable in
 * isolation.
 */
export class Office {
  private seats: Seat[] = [];
  private presences = new Map<string, Presence>();
  /** Desk ids with an unreviewed report, in the order they lined up. */
  private queue: string[] = [];
  private watcher: DropWatcher<Report> | null = null;
  private replies: DropWatcher<{ say: string; at: number }> | null = null;

  /** Called whenever any snapshot-visible state changes. */
  onChange: (() => void) | null = null;
  /** Called with (deskId, data) when a seated worker produces output. */
  onOutput: ((deskId: string, data: string) => void) | null = null;
  /** Called when a worker drops a new report and joins the presentation line. */
  onReport: ((presentation: Presentation) => void) | null = null;
  /** The MCP servers a worker launches with: extra CLI args and env (set by the server). */
  mcpFor: ((deskId: string, agent: AgentKind, identity: WorkerIdentity | null) => { args: string[]; env: Record<string, string> } | null) | null = null;
  /** Called when you or a worker says something during its review. */
  onSaid: ((deskId: string, from: "agent" | "you", text: string) => void) | null = null;

  private readonly cwd: string;
  private readonly simulate: boolean;
  private readonly reportsDir: string;
  private readonly repliesDir: string;
  private readonly reviewsDir: string;
  /** Workers' own branches. Disabled for simulated workers and outside a git repo. */
  readonly workspaces: Workspaces | null;

  private trusted: () => boolean;
  private memory: string | null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: OfficeOptions = {}) {
    this.trusted = options.trusted ?? (() => false);
    this.memory = options.memory ?? null;
    this.cwd = options.cwd ?? process.cwd();
    this.simulate = options.simulate ?? false;
    this.reportsDir = join(this.cwd, ".domain", "reports");
    this.repliesDir = join(this.cwd, ".domain", "replies");
    this.reviewsDir = join(this.cwd, ".domain", "reviews");
    const ws = this.simulate ? null : new Workspaces(this.cwd);
    this.workspaces = ws?.enabled ? ws : null;

    for (const def of DESKS) {
      this.seats.push({
        desk: { id: def.id, label: def.label, x: def.x, z: def.z, rotY: def.rotY, worker: null },
        session: null,
        cleanup: [],
        workspace: null,
      });
    }

    this.recall();

    // Real workers report and talk back by writing files; watch for them.
    // Simulated workers do both in-process, so no file watching is needed.
    if (!this.simulate) {
      writeBrief(join(this.cwd, ".domain"));
      this.watcher = new DropWatcher(this.reportsDir, coerceReport, (deskId, report) => this.reportDropped(deskId, report));
      this.watcher.start();
      this.replies = new DropWatcher(this.repliesDir, coerceReply, (deskId, reply) => this.replyDropped(deskId, reply));
      this.replies.start();
    }
  }

  // --- presence -----------------------------------------------------------

  addPeer(id: string, name: string, look: Look = DEFAULT_LOOK): void {
    this.presences.set(id, {
      peer: { id, name, look, x: SPAWN.x, z: SPAWN.z, facing: SPAWN.facing },
    });
    this.changed();
  }

  removePeer(id: string): void {
    if (this.presences.delete(id)) this.changed();
  }

  movePeer(id: string, x: number, z: number, facing: number): void {
    const p = this.presences.get(id);
    if (!p) return;
    p.peer.x = x;
    p.peer.z = z;
    p.peer.facing = facing;
    // Movement is high-frequency; broadcasting is handled by the caller on a
    // throttle, so we just update state here.
  }

  // --- desks --------------------------------------------------------------

  hire(deskId: string, agent: AgentKind, hiredBy: string, model = "", leash: Leash = "ask", isolate = false, identity: WorkerIdentity | null = null): boolean {
    const seat = this.seats.find((s) => s.desk.id === deskId);
    if (!seat || seat.session) return false;
    // Its own branch and folder, so parallel workers never edit the same files.
    seat.workspace = isolate && this.workspaces ? this.workspaces.create(deskId, agent) : null;
    const session = this.launch(deskId, agent, model, leash, seat.workspace?.path ?? this.cwd, identity);
    seat.session = session;
    seat.desk.worker = this.toWorker(session, hiredBy, model, leash, seat.workspace?.branch ?? null, identity);
    this.attach(seat, session);
    this.changed();
    return true;
  }

  private reportDropped(deskId: string, report: Report): void {
    this.setReport(deskId, report);
  }

  private replyDropped(deskId: string, reply: { say: string }): void {
    if (this.seats.find((s) => s.desk.id === deskId)?.session) this.onSaid?.(deskId, "agent", reply.say);
  }

  /**
   * Where a desk's worker drops its report and replies: inside its own folder
   * when it has one (with its own copy of BRIEF.md), watched for as long as
   * it's there; else the project's .domain/.
   */
  private dropDirs(deskId: string, cwd: string): { reports: string; replies: string } {
    const seat = this.seats.find((s) => s.desk.id === deskId);
    if (this.simulate || !seat || resolve(cwd) === resolve(this.cwd)) return { reports: this.reportsDir, replies: this.repliesDir };
    const base = join(cwd, ".domain");
    const dirs = { reports: join(base, "reports"), replies: join(base, "replies") };
    if (seat.drops?.dir !== base) {
      this.stopDrops(seat);
      writeBrief(base);
      const watchers = [
        new DropWatcher(dirs.reports, coerceReport, (d, r) => this.reportDropped(d, r)),
        new DropWatcher(dirs.replies, coerceReply, (d, r) => this.replyDropped(d, r)),
      ];
      for (const w of watchers) w.start();
      seat.drops = { dir: base, watchers };
    }
    return dirs;
  }

  private stopDrops(seat: Seat): void {
    for (const w of seat.drops?.watchers ?? []) w.stop();
    seat.drops = undefined;
  }

  private launch(deskId: string, agent: AgentKind, model: string, leash: Leash, cwd: string, identity: WorkerIdentity | null, resume = false): IWorkerSession {
    const mcp = this.simulate ? null : this.mcpFor?.(deskId, agent, identity);
    const drops = this.dropDirs(deskId, cwd);
    return createWorker(agent, {
      cwd,
      simulate: this.simulate,
      deskId,
      reportsDir: drops.reports,
      repliesDir: drops.replies,
      model,
      leash,
      extraArgs: mcp?.args,
      env: mcp?.env,
      autoTrust: this.trusted,
      resume,
    });
  }

  /** You trusted this project: answer every worker stopped at a trust prompt. Returns how many. */
  async trustAll(): Promise<number> {
    let n = 0;
    for (const seat of this.seats) if (seat.session?.askingTrust && (await seat.session.trust?.())) n++;
    return n;
  }

  /**
   * Put a desk's worker on another model for its next task. Claude Code
   * switches in place (`/model`), keeping its context; other CLIs pick their
   * model at launch, so the worker restarts on the new one. Returns what
   * happened, so the caller knows to give a restarted CLI time to boot.
   */
  switchModel(deskId: string, model: string): "same" | "switched" | "restarted" | null {
    const seat = this.seats.find((s) => s.desk.id === deskId);
    const w = seat?.desk.worker;
    if (!seat?.session || !w) return null;
    if (w.model === model) return "same";
    w.model = model;
    if (seat.session.summon) {
      // A simulated worker has no real model to change.
      this.changed();
      return "switched";
    }
    if (w.agent === "claude") {
      typeLine(seat.session, `/model ${model || "default"}`);
      this.changed();
      return "switched";
    }
    for (const off of seat.cleanup) off();
    seat.cleanup = [];
    seat.session.dispose();
    const session = this.launch(deskId, w.agent, model, w.leash, seat.workspace?.path ?? this.cwd, w.identity);
    seat.session = session;
    Object.assign(w, { id: session.id, status: session.getStatus(), activity: session.getActivity(), report: null });
    this.dequeue(deskId);
    this.attach(seat, session);
    this.changed();
    return "restarted";
  }

  private attach(seat: Seat, session: IWorkerSession): void {
    const deskId = seat.desk.id;
    seat.cleanup.push(
      session.onOutput((data) => this.onOutput?.(deskId, data)),
      session.onStatus((status, activity) => {
        const w = seat.desk.worker;
        if (w) {
          // Presenting (a report is up) belongs to the review, not to the terminal going quiet.
          if (w.report && status !== "done") return;
          if (status === "idle" && w.status === "working") seat.busyWith = w.activity;
          w.status = status;
          // An empty activity: keep the task's own label ("🎯 Add the README…").
          // (A new task set since then has its own label: only "Free · …" goes back to the old one.)
          w.activity =
            activity ||
            (status === "idle"
              ? `Free · last: ${stripIcon(seat.busyWith ?? w.activity)}`
              : w.activity.startsWith("Free · ")
                ? (seat.busyWith ?? w.activity)
                : w.activity);
        }
        this.changed();
      }),
    );
    // Simulated workers report in-process; subscribe if the backend supports it.
    if (session.onReport) {
      seat.cleanup.push(session.onReport((report) => this.setReport(deskId, report)));
    }
    if (session.onSay) {
      seat.cleanup.push(session.onSay((text) => this.onSaid?.(deskId, "agent", text)));
    }
  }

  fire(deskId: string): boolean {
    const seat = this.seats.find((s) => s.desk.id === deskId);
    // Someone asleep from last time just goes home (nothing's running).
    if (seat?.asleep && !seat.session) {
      seat.asleep = undefined;
      seat.desk.worker = null;
      seat.workspace = null;
      this.changed();
      return true;
    }
    if (!seat || !seat.session) return false;
    for (const off of seat.cleanup) off();
    seat.cleanup = [];
    seat.session.dispose();
    seat.session = null;
    seat.desk.worker = null;
    seat.workspace = null;
    this.dequeue(deskId);
    this.watcher?.forget(deskId);
    this.replies?.forget(deskId);
    this.deleteReportFile(deskId);
    this.stopDrops(seat);
    this.changed();
    return true;
  }

  input(deskId: string, data: string): void {
    this.seats.find((s) => s.desk.id === deskId)?.session?.write(data);
  }

  resize(deskId: string, cols: number, rows: number): void {
    this.seats.find((s) => s.desk.id === deskId)?.session?.resize(cols, rows);
  }

  scrollback(deskId: string): string {
    return this.seats.find((s) => s.desk.id === deskId)?.session?.getScrollback() ?? "";
  }

  // --- presentations ------------------------------------------------------

  /** Attach a fresh report to a worker and line it up to present. */
  setReport(deskId: string, report: Report): void {
    const seat = this.seats.find((s) => s.desk.id === deskId);
    if (!seat || !seat.session || !seat.desk.worker) return;
    seat.desk.worker.report = report;
    seat.desk.worker.status = "presenting";
    seat.desk.worker.activity =
      report.status === "blocked" ? "Waiting to present (blocked)" : report.status === "plan" ? "Waiting to present a plan" : "Waiting to present";
    if (!this.queue.includes(deskId)) this.queue.push(deskId);

    this.onReport?.(this.presentationFor(deskId, report, this.queue.indexOf(deskId)));
    this.changed();
  }

  /** Type an instruction into a worker's terminal (simulated workers act things out themselves). */
  instruct(deskId: string, text: string): void {
    const seat = this.seats.find((s) => s.desk.id === deskId);
    if (seat?.session && !seat.session.summon) typeLine(seat.session, text);
  }

  /** Whether someone's working at a desk (not asleep, not empty). */
  isStaffed(deskId: string): boolean {
    const seat = this.seats.find((s) => s.desk.id === deskId);
    return !!seat?.session && !!seat.desk.worker;
  }

  /** Keep a worker's report out of the line for now (its auditor reviews it first). */
  hold(deskId: string, activity: string): void {
    const seat = this.seats.find((s) => s.desk.id === deskId);
    if (!seat?.desk.worker) return;
    this.dequeue(deskId);
    seat.desk.worker.activity = activity;
    this.changed();
  }

  /** Put a held report back in line for you. */
  release(deskId: string): Presentation | null {
    const seat = this.seats.find((s) => s.desk.id === deskId);
    const report = seat?.desk.worker?.report;
    if (!seat || !report) return null;
    if (!this.queue.includes(deskId)) this.queue.push(deskId);
    seat.desk.worker!.activity = report.status === "blocked" ? "Waiting to present (blocked)" : "Waiting to present";
    this.changed();
    return this.presentationFor(deskId, report, this.queue.indexOf(deskId));
  }

  /** Change a held report before it reaches you (e.g. add the audit's verdict). */
  amendReport(deskId: string, change: (r: Report) => Report): void {
    const w = this.seats.find((s) => s.desk.id === deskId)?.desk.worker;
    if (w?.report) w.report = change(w.report);
  }

  /**
   * A report that isn't for you (an auditor's verdict): take it off the desk
   * without a review, and tell the worker what happens next.
   */
  dismiss(deskId: string, message: string): void {
    const seat = this.seats.find((s) => s.desk.id === deskId);
    if (!seat?.session || !seat.desk.worker) return;
    seat.desk.worker.report = null;
    this.dequeue(deskId);
    this.watcher?.forget(deskId);
    this.deleteReportFile(deskId);
    // A scripted worker would take any line as a new task: it's just free again.
    if (seat.session.summon) {
      seat.desk.worker.status = "idle";
      seat.desk.worker.activity = "Free";
    } else {
      seat.desk.worker.status = "working";
      seat.desk.worker.activity = "Back to it";
      typeLine(seat.session, message);
    }
    this.changed();
  }

  /**
   * Call workers to your office. Each one not already in line stops to put
   * together a progress report and lines up; it presents once the report is
   * in. An empty list rounds up everyone. Returns how many were called.
   */
  roundup(deskIds: string[]): number {
    const wanted = new Set(deskIds);
    let called = 0;
    for (const seat of this.seats) {
      const { session, desk } = seat;
      if (!session || !desk.worker) continue;
      if (wanted.size > 0 && !wanted.has(desk.id)) continue;
      if (this.queue.includes(desk.id)) continue;
      this.queue.push(desk.id);
      desk.worker.report = null;
      desk.worker.status = "presenting";
      desk.worker.activity = "Preparing a progress report";
      if (session.summon) session.summon();
      else {
        typeLine(
          session,
          "[Office hours] Your manager is rounding everyone up for a review. Pause what you're doing and prepare a short progress report: " +
            "write it as JSON to $DOMAIN_REPORT_FILE following .domain/BRIEF.md (title, summary, 3-6 short slides, at = now in ms). Then wait for feedback.",
        );
      }
      called++;
    }
    if (called) this.changed();
    return called;
  }

  /**
   * Brief a desk's worker on a task from a goal. `extra` is appended to the
   * brief (e.g. where a research goal's deck lives).
   */
  assign(deskId: string, goalTitle: string, taskTitle: string, extra = "", why = "", brief?: TaskBrief): boolean {
    const seat = this.seats.find((s) => s.desk.id === deskId);
    if (!seat?.session || !seat.desk.worker) return false;
    if (seat.session.assign) seat.session.assign(taskTitle, brief?.planFirst ?? false);
    else typeLine(seat.session, taskBriefText(goalTitle, taskTitle, why, brief, seat.workspace?.branch) + extra);
    seat.desk.worker.activity = brief?.planFirst ? `🧠 Planning: ${taskTitle}` : `🎯 ${taskTitle}`;
    this.changed();
    return true;
  }

  /** A word in a worker's ear (e.g. its time is up). Simulated workers don't need telling. */
  nudge(deskId: string, text: string): boolean {
    const seat = this.seats.find((s) => s.desk.id === deskId);
    if (!seat?.session || !seat.desk.worker) return false;
    if (!seat.session.summon) typeLine(seat.session, text);
    return true;
  }

  /** A character changed (name, look, voice): update the workers playing it. */
  updateIdentities(team: { id: string; name: string; look: WorkerIdentity["look"]; voice: string }[]): void {
    let changed = false;
    for (const seat of this.seats) {
      const id = seat.desk.worker?.identity;
      if (!id) continue;
      const c = team.find((x) => x.id === id.characterId);
      if (!c) continue;
      seat.desk.worker!.identity = { characterId: c.id, name: c.name, look: c.look, voice: c.voice };
      changed = true;
    }
    if (changed) this.changed();
  }

  /** A desk's own worktree and branch, if it has one. */
  workspaceOf(deskId: string): Workspace | null {
    return this.seats.find((s) => s.desk.id === deskId)?.workspace ?? null;
  }

  /** Where a desk's worker works: its own worktree, or the project folder. */
  workdir(deskId: string): string {
    return this.workspaceOf(deskId)?.path ?? this.cwd;
  }

  /** Attach the check's verdict (or "running") to a worker's report. */
  setCheck(deskId: string, check: CheckResult): void {
    const report = this.seats.find((s) => s.desk.id === deskId)?.desk.worker?.report;
    if (!report) return;
    report.check = check;
    this.changed();
  }

  /** Whether a desk's worker is in line (or preparing to be). */
  inLine(deskId: string): boolean {
    return this.queue.includes(deskId);
  }

  /** What kind of report a desk's worker is presenting, if any. */
  reportStatus(deskId: string): Report["status"] | null {
    return this.seats.find((s) => s.desk.id === deskId)?.desk.worker?.report?.status ?? null;
  }

  /**
   * Give a desk's worker a one-off job outside a task — plan a goal, ship it,
   * fix a deploy. A real agent gets `text` typed into its CLI; a simulated one
   * acts it out and then calls `sim.done` (which writes the file a real agent
   * would have written).
   */
  brief(deskId: string, text: string, activity: string, sim?: { steps: string[]; done: () => void }): boolean {
    const seat = this.seats.find((s) => s.desk.id === deskId);
    if (!seat?.session || !seat.desk.worker) return false;
    if (seat.session.act) seat.session.act(activity, sim?.steps ?? [], () => sim?.done());
    else typeLine(seat.session, text.replace(/\s*\n\s*/g, " "));
    seat.desk.worker.activity = activity;
    if (seat.desk.worker.status === "idle") seat.desk.worker.status = "working";
    this.changed();
    return true;
  }

  /** The worker at a desk, if any (for labels in the loop). */
  workerAt(deskId: string): Worker | null {
    return this.seats.find((s) => s.desk.id === deskId)?.desk.worker ?? null;
  }

  /** How many desks have a worker. */
  workerCount(): number {
    return this.seats.filter((s) => s.session).length;
  }

  /**
   * Something you say to a worker, typed into its CLI: in its review (it
   * answers out loud), or over team chat (it answers in the chat, then carries
   * on). Either way the answer comes back through its reply file. `quiet`
   * leaves it out of the worker's thread (a message to everyone is in #team).
   */
  say(deskId: string, text: string, via: "review" | "chat" | "auto" = "auto", quiet = false): boolean {
    const seat = this.seats.find((s) => s.desk.id === deskId);
    const said = text.trim().slice(0, 4000);
    if (!seat?.session || !said) return false;
    if (!quiet) this.onSaid?.(deskId, "you", said);
    const review = via === "review" || (via === "auto" && !!seat.desk.worker?.report);
    if (seat.session.tell) seat.session.tell(said);
    else if (review) {
      typeLine(
        seat.session,
        `[Office hours] Your manager says: "${said.replace(/\s+/g, " ")}" — answer out loud by writing {"say": "...", "at": <now in ms>} to $DOMAIN_REPLY_FILE (see .domain/BRIEF.md).`,
      );
    } else {
      typeLine(
        seat.session,
        `[Team chat] Your manager says: "${said.replace(/\s+/g, " ")}" — reply in the chat by writing {"say": "...", "at": <now in ms>} to $DOMAIN_REPLY_FILE (see .domain/BRIEF.md), then carry on with what you were doing.`,
      );
    }
    return true;
  }

  /** The lines on a worker's screen now, when its backend can tell (null otherwise). */
  screen(deskId: string): string[] | null {
    return this.seats.find((s) => s.desk.id === deskId)?.session?.screen?.() ?? null;
  }

  /** The worker session at a desk (changes with each hire), for keying its chat. */
  sessionId(deskId: string): string {
    return this.seats.find((s) => s.desk.id === deskId)?.session?.id ?? "none";
  }

  /**
   * Respond to a worker's presentation. `approve` lets it carry on; otherwise
   * `text` is sent back as revision feedback. Either way the report clears and
   * the worker leaves the line and resumes at its desk.
   */
  review(deskId: string, approve: boolean, text?: string, sketch?: string): boolean {
    const seat = this.seats.find((s) => s.desk.id === deskId);
    if (!seat || !seat.session || !seat.desk.worker?.report) return false;

    const feedback = (text ?? "").trim().replace(/\s+/g, " ");
    const sketchPath = sketch ? this.saveSketch(deskId, sketch) : null;
    const board = sketchPath ? ` Whiteboard sketch from the review: ${sketchPath}` : "";
    const plan = seat.desk.worker.report.status === "plan";
    // Approving finished work closes the task: the worker stops and waits for
    // its next one (it doesn't wander on into other work). Approving a
    // decision it was blocked on lets it carry on.
    const blocked = seat.desk.worker.report.status === "blocked";
    const message = plan
      ? approve
        ? `[Review] Plan approved — go ahead and build it.${feedback ? ` Notes: ${feedback}` : ""}${board} When it's done, present it (status "ready").`
        : `[Review] Changes to the plan: ${feedback || "see the whiteboard sketch."}${board} Revise the plan and present it again (status "plan") before building.`
      : approve
        ? blocked
          ? `[Review] Go ahead — carry on with the task.${feedback ? ` Notes: ${feedback}` : ""}${board}`
          : `[Review] Approved — this task is done, nice work.${feedback ? ` Notes: ${feedback}` : ""}${board} Commit anything left over, then stop and wait for your next task. Don't start other work on your own.`
        : `[Review] Changes requested: ${feedback || "see the whiteboard sketch."}${board}`;
    // Hand the decision back into the worker's session as its next turn.
    typeLine(seat.session, message);

    seat.desk.worker.report = null;
    seat.desk.worker.status = "working";
    seat.desk.worker.activity = plan
      ? approve
        ? "Building the approved plan"
        : "Revising the plan"
      : approve
        ? blocked
          ? "Carrying on after your decision"
          : "Wrapping up — approved"
        : "Revising from feedback";
    this.dequeue(deskId);
    this.watcher?.forget(deskId);
    this.deleteReportFile(deskId);
    this.changed();
    return true;
  }

  /**
   * Save a whiteboard PNG data URL where the worker works (its .domain/sketches,
   * which git ignores), so it can open it without asking; returns the path to
   * tell it — relative to its folder.
   */
  private saveSketch(deskId: string, dataUrl: string): string | null {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m || m[1].length > 8 * 1024 * 1024) return null;
    try {
      const name = `review-${deskId}-${Date.now()}.png`;
      const dir = join(this.workdir(deskId), ".domain", "sketches");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), Buffer.from(m[1], "base64"));
      // A copy with the project's own review history.
      mkdirSync(this.reviewsDir, { recursive: true });
      writeFileSync(join(this.reviewsDir, name), Buffer.from(m[1], "base64"));
      return `.domain/sketches/${name}`;
    } catch {
      return null;
    }
  }

  // --- snapshot -----------------------------------------------------------

  snapshot(): OfficeState {
    return {
      desks: this.seats.map((s) => ({
        ...s.desk,
        worker: s.desk.worker ? { ...s.desk.worker } : null,
      })),
      peers: [...this.presences.values()].map((p) => ({ ...p.peer, look: { ...p.peer.look } })),
      presentations: this.buildPresentations(),
    };
  }

  dispose(): void {
    for (const seat of this.seats) {
      for (const off of seat.cleanup) off();
      seat.session?.dispose();
      this.stopDrops(seat);
    }
    this.watcher?.stop();
    this.replies?.stop();
  }

  // --- internals ----------------------------------------------------------

  private buildPresentations(): Presentation[] {
    const out: Presentation[] = [];
    this.queue.forEach((deskId, order) => {
      const seat = this.seats.find((s) => s.desk.id === deskId);
      if (seat?.desk.worker) out.push(this.presentationFor(deskId, seat.desk.worker.report, order));
    });
    return out;
  }

  private presentationFor(deskId: string, report: Report | null, order: number): Presentation {
    const worker = this.seats.find((s) => s.desk.id === deskId)!.desk.worker!;
    return {
      deskId,
      workerId: worker.id,
      agent: worker.agent,
      hiredBy: worker.hiredBy,
      report,
      order: Math.max(0, order),
    };
  }

  private dequeue(deskId: string): void {
    const i = this.queue.indexOf(deskId);
    if (i !== -1) this.queue.splice(i, 1);
  }

  private deleteReportFile(deskId: string): void {
    const seat = this.seats.find((s) => s.desk.id === deskId);
    for (const dir of [this.reportsDir, ...(seat?.drops ? [join(seat.drops.dir, "reports")] : [])]) {
      try {
        rmSync(join(dir, `${deskId}.json`), { force: true });
      } catch {
        /* best effort */
      }
    }
    for (const w of seat?.drops?.watchers ?? []) w.forget(deskId);
  }

  private toWorker(session: IWorkerSession, hiredBy: string, model: string, leash: Leash, branch: string | null, identity: WorkerIdentity | null): Worker {
    return {
      id: session.id,
      agent: session.agent,
      hiredBy,
      status: session.getStatus(),
      activity: session.getActivity(),
      report: null,
      model,
      leash,
      branch,
      identity,
    };
  }

  private changed(): void {
    this.onChange?.();
    this.remember();
  }

  // --- remembering the team between runs ------------------------------------------------

  /** Who's at which desk, written down (a moment after things settle). */
  private remember(): void {
    if (!this.memory || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveMemory();
    }, 400);
    this.saveTimer.unref?.();
  }

  private saveMemory(): void {
    if (!this.memory) return;
    const team: Remembered[] = [];
    for (const s of this.seats) {
      const w = s.desk.worker;
      if (!w) continue;
      team.push(
        s.asleep ?? { deskId: s.desk.id, agent: w.agent, hiredBy: w.hiredBy, model: w.model, leash: w.leash, identity: w.identity, workspace: s.workspace, activity: taskLabel(s.busyWith) ?? taskLabel(w.activity) ?? "" },
      );
    }
    try {
      mkdirSync(dirname(this.memory), { recursive: true });
      writeFileSync(this.memory, JSON.stringify({ team }, null, 2));
    } catch {
      /* best effort */
    }
  }

  /** Last run's team, back at their desks — asleep until woken. */
  private recall(): void {
    if (!this.memory) return;
    let team: Remembered[] = [];
    try {
      team = (JSON.parse(readFileSync(this.memory, "utf8")) as { team?: Remembered[] }).team ?? [];
    } catch {
      return;
    }
    for (const r of team) {
      const seat = this.seats.find((s) => s.desk.id === r.deskId);
      if (!seat || seat.session || !AGENT_LABELS[r.agent]) continue;
      // Its own folder is kept between runs; if it's gone, it works in the project.
      const workspace = r.workspace && existsSync(r.workspace.path) ? r.workspace : null;
      seat.asleep = { ...r, workspace };
      seat.workspace = workspace;
      seat.desk.worker = {
        id: `asleep-${r.deskId}`,
        agent: r.agent,
        hiredBy: r.hiredBy,
        status: "asleep",
        activity: "💤 Asleep — ring the gong to start the day",
        report: null,
        model: r.model,
        leash: r.leash,
        branch: workspace?.branch ?? null,
        identity: r.identity,
      };
    }
  }

  /** Whether anyone's asleep at their desk. */
  get sleeping(): number {
    return this.seats.filter((s) => s.asleep).length;
  }

  /**
   * Wake the remembered workers (one desk, or all): each starts again in its
   * own folder, back in its last conversation, and is told to carry on.
   */
  wake(deskId?: string): number {
    let woken = 0;
    for (const seat of this.seats) {
      const r = seat.asleep;
      if (!r || (deskId && seat.desk.id !== deskId)) continue;
      seat.asleep = undefined;
      const session = this.launch(seat.desk.id, r.agent, r.model, r.leash, seat.workspace?.path ?? this.cwd, r.identity, true);
      seat.session = session;
      seat.desk.worker = this.toWorker(session, r.hiredBy, r.model, r.leash, seat.workspace?.branch ?? null, r.identity);
      seat.desk.worker.activity = "☀️ Waking up…";
      seat.busyWith = r.activity;
      this.attach(seat, session);
      if (!session.summon) {
        const was = r.activity ? ` You were on: "${r.activity.replace(/^\W+/, "")}".` : "";
        typeLine(session, `[Office] Good morning — the office is open again and your manager rang the gong.${was} Pick up where you left off.`);
      }
      woken++;
    }
    if (woken) this.changed();
    return woken;
  }
}

/**
 * What a worker is told when it's put on a task: the goal and the task, what
 * "done" means for it, its time budget, and — for plan-first tasks — to
 * present a plan before touching anything.
 */
export function taskBriefText(goalTitle: string, taskTitle: string, why = "", brief?: TaskBrief, branch?: string | null): string {
  const done = brief?.done.length
    ? brief.done.map((d, i) => `(${i + 1}) ${d}`).join(" ")
    : "the change does what the task says, the project still builds and its tests pass, and nothing unrelated changed.";
  const time = brief?.minutes
    ? ` Time budget: about ${brief.minutes} minutes — ${brief.onTimeUp === "wrapup" ? "when it runs out you'll be asked to stop and present where you are" : "when it runs out you'll get a nudge to wrap up"}.`
    : "";
  const plan = brief?.planFirst
    ? ` Plan first: before changing anything, write your plan as a report to $DOMAIN_REPORT_FILE with status "plan" (title "Plan: …", the approach in the summary, the steps and risks as slides) and wait. Build only once the plan is approved.`
    : "";
  const own = branch ? ` You're on your own branch, ${branch}: commit your work there before you present.` : "";
  return (
    // Said as your manager, through the office: an agent that sees a bare task
    // card can take it for pasted text and stop to ask before starting.
    `[Task from your manager, via the domain office] Goal: "${goalTitle}"${why ? ` (why: ${why})` : ""}. Your task: "${taskTitle}". Done means: ${done}${time}${plan}${own} ` +
    `Start on it now — no need to check with me first. When it's done — or you're blocked on a decision — present it by writing a report to $DOMAIN_REPORT_FILE as described in .domain/BRIEF.md (status "ready" or "blocked"), then wait for the review.`
  );
}

/**
 * Type a line into a worker's terminal and submit it. Enter goes separately a
 * beat later, so agent CLIs that treat a fast burst as a paste still submit.
 */
function typeLine(session: IWorkerSession, text: string): void {
  const send = session.send ? (d: string) => session.send!(d) : (d: string) => session.write(d);
  send(text);
  setTimeout(() => send("\r"), 120);
}

/** An activity without its leading emoji ("🎯 Fix it" → "Fix it"). */
function stripIcon(s: string): string {
  return s.replace(/^(?:Free · last: )?[^\p{L}\p{N}]+\s*/u, "");
}

/** What a worker was on, when its activity names a task ("🎯 Add the README", "🧠 Planning: …") rather than a status. */
function taskLabel(activity: string | undefined): string | null {
  return activity && /^(?:🎯|🧠)/u.test(activity) ? activity : null;
}
