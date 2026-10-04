import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { LanHost, RateLimit, codeMatches, lanAddresses, newPasscode } from "../src/server/lan.ts";
import { allowed } from "../src/server/permissions.ts";
import type { ClientRec, ServerCtx } from "../src/server/ctx.ts";
import type { ServerMessage } from "../src/shared/protocol.ts";

test("only real network addresses are offered (no loopback, no virtual adapters)", () => {
  const ifaces = {
    lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true, mac: "", cidr: null }],
    "vEthernet (WSL)": [{ address: "172.20.16.1", netmask: "255.255.240.0", family: "IPv4", internal: false, mac: "", cidr: null }],
    "Wi-Fi": [
      { address: "192.168.1.23", netmask: "255.255.255.0", family: "IPv4", internal: false, mac: "", cidr: null },
      { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", internal: false, mac: "", cidr: null, scopeid: 1 },
    ],
  } as unknown as NodeJS.Dict<import("node:os").NetworkInterfaceInfo[]>;
  assert.deepEqual(lanAddresses(ifaces), [{ address: "192.168.1.23", broadcast: "192.168.1.255" }]);
});

test("passcodes are six digits and compared exactly", () => {
  const code = newPasscode();
  assert.match(code, /^\d{6}$/);
  assert.ok(codeMatches(code, code));
  assert.ok(!codeMatches(code.slice(0, 5), code));
  assert.ok(!codeMatches(null, code));
  assert.ok(!codeMatches("ü" + code.slice(1), code), "multi-byte input doesn't throw");
  assert.ok(!codeMatches("", ""), "no code, no entry");
});

test("five wrong guesses in a minute buy a cooldown", () => {
  let now = 0;
  const rl = new RateLimit(() => now);
  for (let i = 0; i < 4; i++) rl.fail("1.2.3.4");
  assert.ok(!rl.blocked("1.2.3.4"));
  rl.fail("1.2.3.4");
  assert.ok(rl.blocked("1.2.3.4"));
  assert.ok(!rl.blocked("5.6.7.8"), "others aren't affected");
  now += 61_000;
  assert.ok(!rl.blocked("1.2.3.4"), "the cooldown ends");
});

/** A tiny stand-in for index.ts: a local listener, roles from req.domainRole, permissions enforced. */
async function office(): Promise<{ ctx: ServerCtx; local: Server; port: number; close(): void }> {
  const clients = new Map<WebSocket, ClientRec>();
  const LOCAL = new Set(["127.0.0.1", "localhost"]);
  const wss = new WebSocketServer({
    noServer: true,
    // Like index.ts: only local Host and Origin get in (the LAN listener makes verified guests look local).
    verifyClient: ({ req, origin }: { req: IncomingMessage; origin: string }) =>
      LOCAL.has((req.headers.host ?? "").replace(/:\d+$/, "")) && (!origin || LOCAL.has(new URL(origin).hostname)),
  });
  const send = (ws: WebSocket, m: ServerMessage) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
  wss.on("connection", (ws: WebSocket, req: IncomingMessage & { domainRole?: ClientRec["role"] }) => {
    const c: ClientRec = { id: String(Math.random()), name: "Ann", alive: true, joined: true, role: req?.domainRole ?? "host" };
    clients.set(ws, c);
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { t: string };
      // Echo what got through, so the test can see what each role may do.
      if (allowed(c.role, msg.t)) ws.send(JSON.stringify({ t: "ack", of: msg.t }));
    });
    ws.on("close", () => clients.delete(ws));
  });
  const local = createServer((_req, res) => res.end("local"));
  local.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req)));
  await new Promise<void>((r) => local.listen(0, "127.0.0.1", () => r()));
  const port = (local.address() as { port: number }).port;
  const ctx = {
    cwd: process.cwd(),
    port,
    simulate: true,
    send,
    broadcast: (m: ServerMessage) => clients.forEach((_c, ws) => send(ws, m)),
    clients: () => clients,
    wss,
    serveStatic: async (req: IncomingMessage, res: import("node:http").ServerResponse) => {
      res.end(`page for ${req.headers.host}`);
    },
    log: { start: () => ({ id: "x", append() {}, done() {} }) },
    relaunch: () => false,
  } as unknown as ServerCtx;
  return {
    ctx,
    local,
    port,
    close: () => {
      for (const ws of clients.keys()) ws.terminate();
      local.close();
    },
  };
}

/** Collect a client's messages; resolve when one matches. */
function inbox(ws: WebSocket) {
  const got: Record<string, unknown>[] = [];
  const waiters: [(m: Record<string, unknown>) => boolean, (m: Record<string, unknown>) => void][] = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw)) as Record<string, unknown>;
    got.push(m);
    for (const w of [...waiters]) if (w[0](m)) {
      waiters.splice(waiters.indexOf(w), 1);
      w[1](m);
    }
  });
  return {
    got,
    next: (pred: (m: Record<string, unknown>) => boolean, ms = 3000) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const hit = got.find(pred);
        if (hit) return resolve(hit);
        const timer = setTimeout(() => reject(new Error("timed out")), ms);
        waiters.push([pred, (m) => (clearTimeout(timer), resolve(m))]);
      }),
  };
}

/** Connect, listening from the very first frame (a server may speak in the same packet as its handshake). */
const open = (url: string, origin?: string) =>
  new Promise<WebSocket & { box: ReturnType<typeof inbox> }>((resolve, reject) => {
    const ws = new WebSocket(url, origin ? { origin } : {}) as WebSocket & { box: ReturnType<typeof inbox> };
    ws.box = inbox(ws);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });

const lanIp = lanAddresses()[0]?.address;

test("guests need the passcode, never see it, and get only what their role allows", { skip: !lanIp && "no LAN address on this machine" }, async () => {
  const o = await office();
  const lan = new LanHost(o.ctx);
  try {
    const host = await open(`ws://127.0.0.1:${o.port}`);
    const hostBox = host.box;
    await lan.start("visitor", 0);
    const state = (await hostBox.next((m) => m.t === "lan" && m.on === true)) as { code: string; urls: string[] };
    assert.match(state.code, /^\d{6}$/, "the host sees the code");
    assert.ok(state.urls.length > 0 && state.urls.every((u) => !u.includes("127.0.0.1")));
    const base = state.urls.find((u) => u.includes(lanIp!))!.replace("http://", "");

    // The page is served on the LAN address (as if local, after the Host check).
    const page = await (await fetch(`http://${base}/`)).text();
    assert.equal(page, `page for 127.0.0.1:${o.port}`);
    // A wrong code, or a foreign page, is turned away.
    const wrong = state.code === "000000" ? "111111" : "000000";
    await assert.rejects(open(`ws://${base}/?code=${wrong}`), /401/);
    await assert.rejects(open(`ws://${base}/?code=${state.code}`, "http://evil.example"), /403/);

    // The right code gets in as a visitor, told its role — and never the code.
    const visitor = await open(`ws://${base}/?code=${state.code}`);
    const vBox = visitor.box;
    const hello = await vBox.next((m) => m.t === "guest");
    assert.equal(hello.role, "visitor");
    visitor.send(JSON.stringify({ t: "move" }));
    visitor.send(JSON.stringify({ t: "hire" }));
    visitor.send(JSON.stringify({ t: "input" }));
    await vBox.next((m) => m.t === "ack" && m.of === "move");
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!vBox.got.some((m) => m.t === "ack" && (m.of === "hire" || m.of === "input")), "a visitor can't run anything");
    // The host hears a guest arrived.
    await hostBox.next((m) => m.t === "lan" && m.guests === 1);

    // Switch to teammates: the next guest can direct workers, but not host-only things.
    await lan.start("teammate");
    const mate = await open(`ws://${base}/?code=${state.code}`);
    const mBox = mate.box;
    assert.equal((await mBox.next((m) => m.t === "guest")).role, "teammate");
    mate.send(JSON.stringify({ t: "hire" }));
    mate.send(JSON.stringify({ t: "lanStart" }));
    mate.send(JSON.stringify({ t: "githubSignIn" }));
    await mBox.next((m) => m.t === "ack" && m.of === "hire");
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!mBox.got.some((m) => m.t === "ack" && (m.of === "lanStart" || m.of === "githubSignIn")));

    for (const m of [...vBox.got, ...mBox.got]) assert.ok(!JSON.stringify(m).includes(state.code), "guests never receive the code");

    // Stopping disconnects guests.
    const closed = new Promise((r) => visitor.once("close", r));
    lan.stop();
    await closed;
    await hostBox.next((m) => m.t === "lan" && m.on === false);
    host.close();
  } finally {
    lan.stop();
    o.close();
  }
});

test("wrong passcodes are rate-limited", { skip: !lanIp && "no LAN address on this machine" }, async () => {
  const o = await office();
  const lan = new LanHost(o.ctx);
  try {
    await lan.start("visitor", 0);
    const base = lan.urls().find((u) => u.includes(lanIp!))!;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await fetch(`${base}/__domain/lan-check?code=999999x`)).status);
    assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
    assert.equal(statuses[5], 429, "then a cooldown");
  } finally {
    lan.stop();
    o.close();
  }
});

test("discovery lists offices from their beacons and ignores anything else", async () => {
  const { discover } = await import("../src/server/lan.ts");
  const { createSocket } = await import("node:dgram");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const found = discover(600, port, ["http://10.0.0.9:8788"]);
  await new Promise((r) => setTimeout(r, 100));
  const s = createSocket("udp4");
  const beacon = (o: unknown) => new Promise((r) => s.send(Buffer.from(JSON.stringify(o)), port, "127.0.0.1", r));
  await beacon({ app: "domain", v: 1, name: "Ann", project: "web", url: "http://192.168.1.23:8788", players: 2 });
  await beacon({ app: "domain", v: 1, name: "Me", project: "x", url: "http://10.0.0.9:8788", players: 1 });
  await beacon({ app: "other", url: "http://192.168.1.50:80" });
  await beacon({ app: "domain", url: "javascript:alert(1)" });
  s.close();
  assert.deepEqual(await found, [{ name: "Ann", project: "web", url: "http://192.168.1.23:8788", players: 2 }]);
});
