import { join } from "node:path";
import { rmSync } from "node:fs";
import type {
  AgentKind,
  Desk,
  OfficeState,
  Peer,
  Presentation,
  Report,
  Worker,
} from "../shared/protocol.js";
import { createWorker, type IWorkerSession } from "./workerSession.js";
import { ReportWatcher } from "./reports.js";

/** How the fixed desks are laid out on the floor. */
const DESK_ROWS = 2;
const DESK_COLS = 3;
const DESK_SPACING_X = 4;
const DESK_SPACING_Z = 5;

interface Seat {
  desk: Desk;
  session: IWorkerSession | null;
  /** Unsubscribe callbacks for the live session's listeners. */
  cleanup: (() => void)[];
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
  private watcher: ReportWatcher | null = null;

  /** Called whenever any snapshot-visible state changes. */
  onChange: (() => void) | null = null;
  /** Called with (deskId, data) when a seated worker produces output. */
  onOutput: ((deskId: string, data: string) => void) | null = null;
  /** Called when a worker drops a new report and joins the presentation line. */
  onReport: ((presentation: Presentation) => void) | null = null;

  private readonly cwd: string;
  private readonly simulate: boolean;
  private readonly reportsDir: string;

  constructor(options: OfficeOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.simulate = options.simulate ?? false;
    this.reportsDir = join(this.cwd, ".domain", "reports");

    let id = 0;
    for (let r = 0; r < DESK_ROWS; r++) {
      for (let c = 0; c < DESK_COLS; c++) {
        const x = (c - (DESK_COLS - 1) / 2) * DESK_SPACING_X;
        const z = (r - (DESK_ROWS - 1) / 2) * DESK_SPACING_Z;
        this.seats.push({
          desk: { id: `desk-${id++}`, x, z, worker: null },
          session: null,
          cleanup: [],
        });
      }
    }

    // Real workers report by writing files; watch for them. Simulated workers
    // emit reports in-process, so no file watching is needed there.
    if (!this.simulate) {
      this.watcher = new ReportWatcher(this.cwd, (deskId, report) =>
        this.setReport(deskId, report),
      );
      this.watcher.start();
    }
  }

  // --- presence -----------------------------------------------------------

  addPeer(id: string, name: string): void {
    this.presences.set(id, {
      peer: { id, name, x: 0, z: 8, facing: Math.PI },
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

  hire(deskId: string, agent: AgentKind, hiredBy: string): boolean {
    const seat = this.seats.find((s) => s.desk.id === deskId);
    if (!seat || seat.session) return false;

    const session = createWorker(agent, {
      cwd: this.cwd,
      simulate: this.simulate,
      deskId,
      reportsDir: this.reportsDir,
    });
    seat.session = session;
    seat.desk.worker = this.toWorker(session, hiredBy);

    seat.cleanup.push(
      session.onOutput((data) => this.onOutput?.(deskId, data)),
      session.onStatus((status, activity) => {
        if (seat.desk.worker) {
          seat.desk.worker.status = status;
          seat.desk.worker.activity = activity;
        }
        this.changed();
      }),
    );
    // Simulated workers report in-process; subscribe if the backend supports it.
    if (session.onReport) {
      seat.cleanup.push(session.onReport((report) => this.setReport(deskId, report)));
    }

    this.changed();
    return true;
  }

  fire(deskId: string): boolean {
    const seat = this.seats.find((s) => s.desk.id === deskId);
    if (!seat || !seat.session) return false;
    for (const off of seat.cleanup) off();
    seat.cleanup = [];
    seat.session.dispose();
    seat.session = null;
    seat.desk.worker = null;
    this.dequeue(deskId);
    this.watcher?.forget(deskId);
    this.deleteReportFile(deskId);
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
      report.status === "blocked" ? "Waiting to present (blocked)" : "Waiting to present";
    if (!this.queue.includes(deskId)) this.queue.push(deskId);

    this.onReport?.(this.presentationFor(deskId, report, this.queue.indexOf(deskId)));
    this.changed();
  }

  /**
   * Respond to a worker's presentation. `approve` lets it carry on; otherwise
   * `text` is sent back as revision feedback. Either way the report clears and
   * the worker leaves the line and resumes at its desk.
   */
  review(deskId: string, approve: boolean, text?: string): boolean {
    const seat = this.seats.find((s) => s.desk.id === deskId);
    if (!seat || !seat.session || !seat.desk.worker?.report) return false;

    const feedback = (text ?? "").trim();
    const message = approve && !feedback ? "Approved — please continue." : feedback || "Please continue.";
    // Hand the decision back into the worker's session as its next turn.
    seat.session.write(message + "\r");

    seat.desk.worker.report = null;
    seat.desk.worker.status = "working";
    seat.desk.worker.activity = approve ? "Continuing after approval" : "Revising from feedback";
    this.dequeue(deskId);
    this.watcher?.forget(deskId);
    this.deleteReportFile(deskId);
    this.changed();
    return true;
  }

  // --- snapshot -----------------------------------------------------------

  snapshot(): OfficeState {
    return {
      desks: this.seats.map((s) => ({
        id: s.desk.id,
        x: s.desk.x,
        z: s.desk.z,
        worker: s.desk.worker ? { ...s.desk.worker } : null,
      })),
      peers: [...this.presences.values()].map((p) => ({ ...p.peer })),
      presentations: this.buildPresentations(),
    };
  }

  dispose(): void {
    for (const seat of this.seats) {
      for (const off of seat.cleanup) off();
      seat.session?.dispose();
    }
    this.watcher?.stop();
  }

  // --- internals ----------------------------------------------------------

  private buildPresentations(): Presentation[] {
    const out: Presentation[] = [];
    this.queue.forEach((deskId, order) => {
      const seat = this.seats.find((s) => s.desk.id === deskId);
      const report = seat?.desk.worker?.report;
      if (seat?.desk.worker && report) out.push(this.presentationFor(deskId, report, order));
    });
    return out;
  }

  private presentationFor(deskId: string, report: Report, order: number): Presentation {
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
    try {
      rmSync(join(this.reportsDir, `${deskId}.json`), { force: true });
    } catch {
      /* best effort */
    }
  }

  private toWorker(session: IWorkerSession, hiredBy: string): Worker {
    return {
      id: session.id,
      agent: session.agent,
      hiredBy,
      status: session.getStatus(),
      activity: session.getActivity(),
      report: null,
    };
  }

  private changed(): void {
    this.onChange?.();
  }
}
