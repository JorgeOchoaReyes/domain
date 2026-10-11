import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebSocket, WebSocketServer } from "ws";
import type { ClientMessage, GuestRole, ServerMessage } from "../shared/protocol.js";
import type { Office } from "./office.js";
import type { Progress } from "./progress.js";
import type { OpLogger } from "./oplog.js";

/**
 * What a feature module gets from the server: the office, the score, the
 * operations log, and ways to talk to clients. Modules (projects and GitHub,
 * the team, MCP, local multiplayer) export a function that takes this and
 * returns their message handlers, so they plug in without editing index.ts.
 */

export type Role = "host" | GuestRole;

export interface ClientRec {
  id: string;
  name: string;
  alive: boolean;
  joined: boolean;
  /** "host" on this machine; a guest's role when they joined over the local network. */
  role: Role;
}

/** Handles one message type. `msg` is untrusted: validate what you use. */
export type Route = (msg: ClientMessage & Record<string, unknown>, client: ClientRec, ws: WebSocket) => void;
export type Routes = Partial<Record<string, Route>>;

export interface ServerCtx {
  /** The project folder workers work in. */
  cwd: string;
  port: number;
  simulate: boolean;
  office: Office;
  progress: Progress;
  log: OpLogger;
  send(ws: WebSocket, msg: ServerMessage): void;
  broadcast(msg: ServerMessage): void;
  clients(): Map<WebSocket, ClientRec>;
  /** The WebSocket server, for accepting connections from another listener (local multiplayer). */
  wss: WebSocketServer;
  /** Serve the client page and its assets (for another listener). */
  serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /**
   * Restart the office on another project folder. In the desktop app it
   * relaunches on it; elsewhere it returns false (restart the server with
   * DOMAIN_CWD set to the folder).
   */
  relaunch(path: string): boolean;
  /** Your GitHub sign-in's token, while signed in (set by the projects module; never stored). */
  githubToken?: () => string | null;
  /**
   * Put the worker at a desk on a task and brief it (switching its model
   * first if the brief asks for one), as handing out a task does.
   */
  assignTask(who: string, goalId: string, taskId: string, deskId: string, brief?: unknown): boolean;
  /** Something you said to a worker (or everyone): the team learns from it if it is feedback. */
  heard?(text: string, deskId: string | undefined, client: ClientRec): void;
  /** A task given to "whoever's free": a worker offers to take it, and you say yes (set by the chat module). */
  offerTask?(goalId: string, taskId: string, title: string, skip?: string[], who?: ClientRec): void;
  /** Whether this person may direct the worker at that desk (theirs, or nobody else's here). */
  mayDirectDesk?(client: ClientRec, deskId: string): boolean;
  /** Why this person may not hire at that desk (it's in someone else's pod, and they're here), or null (set by the pods module). */
  hireRefusal?(client: ClientRec, deskId: string): string | null;
  /** Extra lines for a task's brief (e.g. the idea it came from); modules add to this. */
  briefNotes: ((goalId: string, taskId: string, deskId: string) => string)[];
}
