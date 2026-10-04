import type {
  AgentKind,
  Desk,
  OfficeState,
  Peer,
  Worker,
} from "../shared/protocol.js";
import { createWorker, type IWorkerSession } from "./workerSession.js";

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
 * Authoritative office state: the desks, who is sitting at them, and the
 * people currently connected. The server owns exactly one of these.
 *
 * The office does not know about WebSockets; it emits plain events and lets
 * the networking layer broadcast them. That keeps the room logic testable in
 * isolation.
 */
export class Office {
  private seats: Seat[] = [];
  private presences = new Map<string, Presence>();

  /** Called whenever any snapshot-visible state changes. */
  onChange: (() => void) | null = null;
  /** Called with (deskId, data) when a seated worker produces output. */
  onOutput: ((deskId: string, data: string) => void) | null = null;

  private readonly cwd: string;
  private readonly simulate: boolean;

  constructor(options: OfficeOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.simulate = options.simulate ?? false;
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

    const session = createWorker(agent, { cwd: this.cwd, simulate: this.simulate });
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
    };
  }

  dispose(): void {
    for (const seat of this.seats) {
      for (const off of seat.cleanup) off();
      seat.session?.dispose();
    }
  }

  private toWorker(session: IWorkerSession, hiredBy: string): Worker {
    return {
      id: session.id,
      agent: session.agent,
      hiredBy,
      status: session.getStatus(),
      activity: session.getActivity(),
    };
  }

  private changed(): void {
    this.onChange?.();
  }
}
