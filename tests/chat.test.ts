import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatStore, chatModule, screenLines } from "../src/server/chat.ts";
import type { ServerCtx } from "../src/server/ctx.ts";
import type { ChatThread } from "../src/shared/chat.ts";
import type { ServerMessage } from "../src/shared/protocol.ts";

const ws = {} as never;
const client = { id: "c1", name: "Jorge", alive: true, joined: true, role: "host" as const };

function setup() {
  const said: { deskId: string; text: string; via: string; quiet: boolean }[] = [];
  const typed: { deskId: string; data: string }[] = [];
  let threads: ChatThread[] = [];
  const office = {
    onSaid: null as null | ((d: string, f: "agent" | "you", t: string) => void),
    snapshot: () => ({
      desks: [
        { id: "desk-1", label: "Desk 1", worker: { agent: "claude", status: "working", activity: "🎯 Add login", identity: { characterId: "ada", name: "Ada" } } },
        { id: "desk-2", label: "Desk 2", worker: { agent: "codex", status: "idle", activity: "Free", identity: null } },
        { id: "desk-3", label: "Desk 3", worker: null },
      ],
    }),
    sessionId: (d: string) => `s-${d}`,
    say(deskId: string, text: string, via = "auto", quiet = false) {
      said.push({ deskId, text, via, quiet });
      if (!quiet) this.onSaid?.(deskId, "you", text);
      return true;
    },
    input: (deskId: string, data: string) => typed.push({ deskId, data }),
    scrollback: () => "\u001b[2J\u001b[1;1H● Reading src/login.ts\r\n✻ Thinking… (3s)\r\n\r\n────────\r\n● Writing the form\r\n✻ Thinking… (3s)\r\n",
  };
  const ctx = {
    office,
    send: (_ws: unknown, m: ServerMessage) => m.t === "chat" && (threads = m.threads),
    broadcast: (m: ServerMessage) => m.t === "chat" && (threads = m.threads),
  } as unknown as ServerCtx;
  const routes = chatModule(ctx, new ChatStore(null));
  return { routes, office, said, typed, threads: () => threads };
}

test("a message to a worker reaches its terminal as team chat; its answer lands in its thread and in #team", () => {
  const { routes, office, said, threads } = setup();
  routes.chatSend!({ t: "chatSend", to: "desk-1", text: "How's the login going?" } as never, client, ws);
  assert.deepEqual(said, [{ deskId: "desk-1", text: "How's the login going?", via: "chat", quiet: false }]);
  office.onSaid!("desk-1", "agent", "Form's done, wiring sessions now.");
  const ada = threads().find((t) => t.id === "desk-1")!;
  assert.equal(ada.title, "Ada (Claude Code)");
  assert.deepEqual(ada.messages.map((m) => `${m.from}: ${m.text}`), ["you: How's the login going?", "agent: Form's done, wiring sessions now."]);
  assert.equal(threads().find((t) => t.id === "team")!.messages.at(-1)?.who, "Ada (Claude Code)");
  assert.equal(threads().length, 3, "#team and the two staffed desks");
});

test("#team goes to everyone once; terminal mode types straight in", () => {
  const { routes, said, typed, threads } = setup();
  routes.chatSend!({ t: "chatSend", to: "team", text: "Stand-up in 5" } as never, client, ws);
  assert.deepEqual(said.map((s) => [s.deskId, s.quiet]), [["desk-1", true], ["desk-2", true]]);
  assert.equal(threads().find((t) => t.id === "team")!.messages.length, 1);
  routes.chatSend!({ t: "chatSend", to: "desk-2", text: "/model gpt-5", raw: true } as never, client, ws);
  assert.deepEqual(typed, [{ deskId: "desk-2", data: "/model gpt-5\r" }]);
  assert.equal(threads().find((t) => t.id === "desk-2")!.messages.at(-1)?.raw, true);
});

test("what a worker is doing is read off its screen: no codes, blanks, rules or repeats", () => {
  const lines = screenLines("\u001b[2J\u001b[1;1H● Reading src/login.ts\r\n✻ Thinking… (3s)\r\n\r\n────────\r\n● Writing the form\r\n✻ Thinking… (3s)\r\n");
  assert.deepEqual(lines, ["● Reading src/login.ts", "● Writing the form", "✻ Thinking… (3s)"]);
});

test("history is kept: a character's thread follows it, and the store survives a restart", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const file = join(mkdtempSync(join(tmpdir(), "chat-")), "chat.json");
  const a = new ChatStore(file);
  a.add("char:ada", { from: "you", who: "Jorge", text: "hi", at: 1 });
  const b = new ChatStore(file);
  assert.equal(b.get("char:ada")[0].text, "hi");
});
