import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { parseClientMessage, type ServerMessage } from "../shared/protocol.js";
import { Office } from "./office.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";

// dist/server/server/index.js -> project root is three levels up.
const here = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = join(here, "..", "..", "client");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const office = new Office({
  cwd: process.env.DOMAIN_CWD || process.cwd(),
  simulate: process.env.DOMAIN_SIMULATE === "1",
});

// ---------------------------------------------------------------------------
// Static file server (serves the built client in production).
// ---------------------------------------------------------------------------

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  // Prevent path traversal: resolve within CLIENT_DIR and verify containment.
  const rel = normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, "");
  let filePath = join(CLIENT_DIR, rel);
  try {
    const info = await stat(filePath).catch(() => null);
    if (!info || info.isDirectory()) filePath = join(CLIENT_DIR, "index.html");
    if (!filePath.startsWith(CLIENT_DIR)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    // SPA fallback: unknown routes get index.html if it exists, else a note.
    try {
      const body = await readFile(join(CLIENT_DIR, "index.html"));
      res.writeHead(200, { "Content-Type": MIME[".html"] }).end(body);
    } catch {
      res
        .writeHead(200, { "Content-Type": MIME[".html"] })
        .end(
          "<h1>domain server</h1><p>No built client found. Run <code>npm run dev</code> for the Vite dev server on :5173, or <code>npm run build</code> first.</p>",
        );
    }
  }
}

const httpServer = createServer((req, res) => {
  void serveStatic(req, res);
});

// ---------------------------------------------------------------------------
// WebSocket layer.
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server: httpServer });
const clients = new Map<WebSocket, { id: string; name: string }>();

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  for (const ws of clients.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// Coalesce office snapshots so a burst of changes becomes one broadcast.
let snapshotScheduled = false;
function scheduleSnapshot(): void {
  if (snapshotScheduled) return;
  snapshotScheduled = true;
  setImmediate(() => {
    snapshotScheduled = false;
    broadcast({ t: "office", office: office.snapshot() });
  });
}

office.onChange = scheduleSnapshot;
office.onOutput = (deskId, data) => broadcast({ t: "output", deskId, data });
office.onReport = (presentation) => broadcast({ t: "report", presentation });

// Presence moves are frequent; broadcast them on a fixed cadence if dirty.
let presenceDirty = false;
const PRESENCE_HZ = 15;
setInterval(() => {
  if (presenceDirty) {
    presenceDirty = false;
    broadcast({ t: "office", office: office.snapshot() });
  }
}, 1000 / PRESENCE_HZ).unref();

wss.on("connection", (ws) => {
  const id = randomUUID();
  clients.set(ws, { id, name: "Guest" });

  ws.on("message", (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const msg = parseClientMessage(parsed);
    if (!msg) return;
    const client = clients.get(ws);
    if (!client) return;

    switch (msg.t) {
      case "join": {
        client.name = String(msg.name || "Guest").slice(0, 24);
        office.addPeer(id, client.name);
        send(ws, { t: "welcome", selfId: id, office: office.snapshot() });
        break;
      }
      case "move": {
        office.movePeer(id, msg.x, msg.z, msg.facing);
        presenceDirty = true;
        break;
      }
      case "hire": {
        if (office.hire(msg.deskId, msg.agent, client.name)) {
          send(ws, { t: "scrollback", deskId: msg.deskId, data: office.scrollback(msg.deskId) });
        }
        break;
      }
      case "fire": {
        office.fire(msg.deskId);
        break;
      }
      case "open": {
        send(ws, { t: "scrollback", deskId: msg.deskId, data: office.scrollback(msg.deskId) });
        break;
      }
      case "input": {
        office.input(msg.deskId, msg.data);
        break;
      }
      case "resize": {
        office.resize(msg.deskId, msg.cols, msg.rows);
        break;
      }
      case "review": {
        office.review(msg.deskId, msg.approve, msg.text);
        break;
      }
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    office.removePeer(id);
  });
  ws.on("error", () => ws.close());
});

/** Resolves to the base URL once the server is accepting connections. */
export const serverReady: Promise<string> = new Promise((resolve) => {
  httpServer.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}`;
    console.log(`domain server listening on ${url}`);
    resolve(url);
  });
});

function shutdown(): void {
  office.dispose();
  for (const ws of clients.keys()) ws.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
