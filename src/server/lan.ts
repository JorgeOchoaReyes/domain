import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { createSocket, type Socket } from "node:dgram";
import { networkInterfaces, hostname, type NetworkInterfaceInfo } from "node:os";
import { basename } from "node:path";
import { randomInt, timingSafeEqual } from "node:crypto";
import { WebSocket } from "ws";
import type { GuestRole, LanOffice, ServerMessage } from "../shared/protocol.js";
import type { Routes, ServerCtx } from "./ctx.js";

/**
 * Local multiplayer: open your office to people on the same network.
 *
 * The office's own listener stays on 127.0.0.1 with its strict local-only
 * checks. Sharing opens a second listener on the LAN (port + 1) that serves
 * the same page and accepts WebSocket connections only with a 6-digit
 * passcode — compared in constant time, with wrong guesses rate-limited per
 * address. Guests join as visitors (walk, watch, read) or teammates (run the
 * work — and type into workers' terminals, which run on this computer), as
 * the host chose; permissions.ts enforces what each may do. While sharing, a
 * small UDP beacon (no passcode in it) lets other domain apps on the network
 * list the office under "Nearby".
 */

export const BEACON_PORT = 8790;
const BEACON_EVERY_MS = 2000;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 60_000;
const COOLDOWN_MS = 60_000;

/** Interface names that are virtual adapters, not the Wi-Fi/Ethernet people share. */
const VIRTUAL = /vethernet|virtualbox|vmware|vboxnet|wsl|docker|hyper-v|loopback|utun|llw|awdl|bridge|veth|zt|tailscale/i;

function privateV4(a: string): boolean {
  return /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
}

/** The addresses people on your network can reach you on (private IPv4, no loopback or virtual adapters). */
export function lanAddresses(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): { address: string; broadcast: string }[] {
  const out: { address: string; broadcast: string; virtual: boolean }[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      if (i.family !== "IPv4" || i.internal || i.address.startsWith("127.") || i.address.startsWith("169.254.")) continue;
      const a = i.address.split(".").map(Number);
      const m = i.netmask.split(".").map(Number);
      const broadcast = a.map((x, k) => (x | (~m[k] & 255)) >>> 0).join(".");
      out.push({ address: i.address, broadcast, virtual: VIRTUAL.test(name) || !privateV4(i.address) });
    }
  }
  // Real adapters first; virtual ones only if there's nothing else.
  const real = out.filter((x) => !x.virtual);
  return (real.length ? real : out).map(({ address, broadcast }) => ({ address, broadcast }));
}

export function newPasscode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Constant-time passcode check. */
export function codeMatches(given: string | null | undefined, code: string): boolean {
  if (typeof given !== "string" || !code) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(code);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Wrong guesses per address: 5 a minute, then a minute's cooldown. */
export class RateLimit {
  private seen = new Map<string, { fails: number; since: number; until: number }>();
  constructor(private now: () => number = Date.now) {}
  blocked(ip: string): boolean {
    const r = this.seen.get(ip);
    return !!r && r.until > this.now();
  }
  fail(ip: string): void {
    const t = this.now();
    const r = this.seen.get(ip) ?? { fails: 0, since: t, until: 0 };
    if (t - r.since > FAIL_WINDOW_MS) Object.assign(r, { fails: 0, since: t });
    r.fails++;
    if (r.fails >= MAX_FAILS) Object.assign(r, { until: t + COOLDOWN_MS, fails: 0, since: t });
    this.seen.set(ip, r);
  }
  ok(ip: string): void {
    this.seen.delete(ip);
  }
}

type GuestReq = IncomingMessage & { domainRole?: GuestRole };

export class LanHost {
  private server: Server | null = null;
  private beacon: Socket | null = null;
  private beaconTimer: NodeJS.Timeout | null = null;
  private code = "";
  private role: GuestRole = "visitor";
  private port = 0;
  private hosts = new Set<string>();
  private guests = new Set<WebSocket>();
  readonly limits = new RateLimit();

  constructor(private ctx: ServerCtx) {
    // Guests arrive through the shared WebSocket server, marked by their role.
    ctx.wss.on("connection", (ws: WebSocket, req: GuestReq) => {
      if (req?.domainRole) this.onGuest(ws, req.domainRole);
      else if (this.server) {
        // A host client (this machine) connecting while sharing: tell it the state.
        setTimeout(() => ctx.send(ws, this.message(true)), 0);
      }
    });
  }

  get on(): boolean {
    return this.server !== null;
  }

  urls(): string[] {
    return this.server ? lanAddresses().map((a) => `http://${a.address}:${this.port}`) : [];
  }

  /** The state, for host clients (with the code) or anyone else (without). */
  message(forHost: boolean): ServerMessage {
    return { t: "lan", on: this.on, urls: this.urls(), code: forHost && this.on ? this.code : null, role: this.role, guests: this.guests.size };
  }

  /** Tell every host client (on this machine) where things stand. Guests never get the code. */
  announce(): void {
    for (const [ws, c] of this.ctx.clients()) if (c.role === "host") this.ctx.send(ws, this.message(true));
  }

  async start(role: GuestRole, port = this.ctx.port + 1): Promise<void> {
    this.role = role;
    if (this.server) {
      // Already sharing: a new role applies to people who join from now on.
      this.announce();
      return;
    }
    this.code = newPasscode();
    const server = createServer((req, res) => void this.onHttp(req, res));
    server.on("upgrade", (req, socket, head) => this.onUpgrade(req as GuestReq, socket, head));
    await new Promise<void>((resolve, reject) => {
      const tryListen = (p: number) => {
        server.once("error", (e: NodeJS.ErrnoException) => {
          if (e.code === "EADDRINUSE" && p !== 0) tryListen(0);
          else reject(e);
        });
        server.listen(p, "0.0.0.0", () => resolve());
      };
      tryListen(port);
    });
    this.port = (server.address() as { port: number }).port;
    this.server = server;
    this.hosts = new Set(lanAddresses().map((a) => `${a.address}:${this.port}`));
    this.startBeacon();
    this.announce();
  }

  stop(): void {
    for (const ws of this.guests) ws.close(4001, "The host stopped sharing");
    this.guests.clear();
    this.server?.close();
    this.server?.closeAllConnections?.();
    this.server = null;
    if (this.beaconTimer) clearInterval(this.beaconTimer);
    this.beaconTimer = null;
    try {
      this.beacon?.close();
    } catch {
      /* already closed */
    }
    this.beacon = null;
    this.code = "";
    this.announce();
  }

  // --- the LAN listener ----------------------------------------------------------

  private ip(req: IncomingMessage): string {
    return req.socket.remoteAddress ?? "?";
  }

  /** The Host header must be one of our LAN addresses (defeats DNS rebinding). */
  private ourHost(host: string | undefined): boolean {
    if (!host) return false;
    // Addresses can change while sharing (Wi-Fi reconnects): refresh lazily.
    if (!this.hosts.has(host)) this.hosts = new Set(lanAddresses().map((a) => `${a.address}:${this.port}`));
    return this.hosts.has(host);
  }

  /** As far as the office's own checks go, a verified guest request looks local (the passcode was the gate). */
  private asLocal(req: IncomingMessage): void {
    req.headers.host = `127.0.0.1:${this.ctx.port}`;
    delete req.headers.origin;
  }

  private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.ourHost(req.headers.host)) {
      res.writeHead(421).end("Misdirected request");
      return;
    }
    // The join card checks a passcode before connecting.
    if ((req.url ?? "").startsWith("/__domain/lan-check")) {
      const ip = this.ip(req);
      const code = new URL(req.url ?? "/", "http://x").searchParams.get("code");
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      if (this.limits.blocked(ip)) {
        res.writeHead(429).end(JSON.stringify({ ok: false, error: "Too many wrong codes. Wait a minute and try again." }));
        return;
      }
      if (!codeMatches(code, this.code)) {
        this.limits.fail(ip);
        res.writeHead(401).end(JSON.stringify({ ok: false, error: "That code isn't right." }));
        return;
      }
      this.limits.ok(ip);
      res.writeHead(200).end(JSON.stringify({ ok: true, role: this.role, host: this.hostName() }));
      return;
    }
    this.asLocal(req);
    await this.ctx.serveStatic(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  }

  private onUpgrade(req: GuestReq, socket: Duplex, head: Buffer): void {
    const refuse = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    const host = req.headers.host;
    const origin = req.headers.origin;
    // The page must be the one we served on this listener.
    if (!this.ourHost(host) || (origin !== undefined && origin !== `http://${host}`)) return refuse("403 Forbidden");
    const ip = this.ip(req);
    if (this.limits.blocked(ip)) return refuse("429 Too Many Requests");
    const code = new URL(req.url ?? "/", "http://x").searchParams.get("code");
    if (!codeMatches(code, this.code)) {
      this.limits.fail(ip);
      return refuse("401 Unauthorized");
    }
    this.limits.ok(ip);
    req.domainRole = this.role;
    this.asLocal(req);
    this.ctx.wss.handleUpgrade(req, socket, head, (ws) => this.ctx.wss.emit("connection", ws, req));
  }

  private onGuest(ws: WebSocket, role: GuestRole): void {
    this.guests.add(ws);
    this.ctx.send(ws, { t: "guest", role, host: this.hostName() });
    ws.on("close", () => {
      this.guests.delete(ws);
      this.announce();
    });
    this.announce();
  }

  /** The host's name: the first person here on this machine, else the computer's name. */
  hostName(): string {
    for (const c of this.ctx.clients().values()) if (c.role === "host" && c.joined && c.name) return c.name;
    return hostname();
  }

  // --- discovery ---------------------------------------------------------------------

  private startBeacon(): void {
    try {
      const sock = createSocket({ type: "udp4", reuseAddr: true });
      sock.on("error", () => {
        /* no network, or blocked: discovery is a nicety */
      });
      sock.bind(0, () => {
        try {
          sock.setBroadcast(true);
        } catch {
          /* unsupported */
        }
      });
      this.beacon = sock;
      const send = () => {
        if (!this.server) return;
        const players = [...this.ctx.clients().values()].filter((c) => c.joined).length;
        for (const a of lanAddresses()) {
          const office: LanOffice = { name: this.hostName(), project: basename(this.ctx.cwd), url: `http://${a.address}:${this.port}`, players };
          const data = Buffer.from(JSON.stringify({ app: "domain", v: 1, ...office }));
          for (const target of new Set([a.broadcast, "255.255.255.255"])) sock.send(data, BEACON_PORT, target, () => {});
        }
      };
      send();
      this.beaconTimer = setInterval(send, BEACON_EVERY_MS);
      this.beaconTimer.unref();
    } catch {
      this.beacon = null;
    }
  }
}

/** Listen for offices' beacons for a moment. Empty when nothing answers (or the network blocks it). */
export function discover(ms = 2500, port = BEACON_PORT, exclude: string[] = []): Promise<LanOffice[]> {
  return new Promise((resolve) => {
    const found = new Map<string, LanOffice>();
    let sock: Socket;
    try {
      sock = createSocket({ type: "udp4", reuseAddr: true });
    } catch {
      resolve([]);
      return;
    }
    const finish = () => {
      try {
        sock.close();
      } catch {
        /* closed */
      }
      resolve([...found.values()].filter((o) => !exclude.includes(o.url)));
    };
    sock.on("error", finish);
    sock.on("message", (buf) => {
      try {
        const o = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
        if (o.app !== "domain" || typeof o.url !== "string" || !/^http:\/\/[\d.]+:\d+$/.test(o.url)) return;
        found.set(o.url, {
          name: String(o.name ?? "").slice(0, 40) || "An office",
          project: String(o.project ?? "").slice(0, 60),
          url: o.url,
          players: typeof o.players === "number" ? o.players : 0,
        });
      } catch {
        /* not ours */
      }
    });
    try {
      sock.bind(port, () => setTimeout(finish, ms).unref());
    } catch {
      finish();
    }
  });
}

/** The module: share the office on the local network, stop, and find others nearby. */
export function lanModule(ctx: ServerCtx): Routes {
  const lan = new LanHost(ctx);
  const hostOnly = (role: string) => role === "host";
  process.once("exit", () => lan.stop());
  return {
    lanStart: (msg, client, ws) => {
      if (!hostOnly(client.role)) return;
      const role: GuestRole = msg.role === "teammate" ? "teammate" : "visitor";
      lan.start(role).catch((e: Error) => {
        ctx.send(ws, { t: "lan", on: false, urls: [], code: null, role, guests: 0 });
        ctx.log.start("agent", "Couldn't open the office to the network").done(false, e.message);
      });
    },
    lanStop: (_msg, client) => {
      if (hostOnly(client.role)) lan.stop();
    },
    lanDiscover: (_msg, _client, ws) => {
      void discover(2500, BEACON_PORT, lan.urls()).then((offices) => ctx.send(ws, { t: "lanOffices", offices }));
    },
  };
}
