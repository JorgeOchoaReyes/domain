import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_TEAM, coerceCharacter, coerceLook, defaultLook, personaBrief } from "../src/shared/team.ts";
import { Progress } from "../src/server/progress.ts";
import { OpLogger } from "../src/server/oplog.ts";
import { Office } from "../src/server/office.ts";
import { teamModule } from "../src/server/team.ts";
import type { ServerCtx } from "../src/server/ctx.ts";

const ws = {} as never;
const client = { id: "c1", name: "Ann", alive: true, joined: true, role: "host" as const };

/** Just enough of the server for the team module. */
function fakeCtx() {
  const progress = new Progress(null);
  const log = new OpLogger();
  const logs: string[] = [];
  log.onEntry = (e) => {
    if (e.status === "error") logs.push(e.title);
  };
  const ctx = { progress, log } as unknown as ServerCtx;
  return { ctx, progress, logs, routes: teamModule(ctx) };
}

test("characters are cleaned: a name is required, looks fall back to the agent's", () => {
  assert.equal(coerceCharacter({ agent: "claude" }), null, "no name, no character");
  assert.equal(coerceCharacter({ name: "   " }), null);
  assert.equal(coerceCharacter("Ada"), null);
  const c = coerceCharacter({
    name: "  Ada   Lovelace  ",
    agent: "codex",
    model: "rm -rf /",
    leash: "yolo",
    persona: "x".repeat(2000),
    look: { color: "red", face: "angry", hat: "crown", accessory: "cape" },
    mcp: ["a", 3, "b"],
  })!;
  assert.equal(c.name, "Ada Lovelace");
  assert.equal(c.agent, "codex");
  assert.equal(c.model, "", "a model that isn't a safe name is dropped");
  assert.equal(c.leash, "ask");
  assert.equal(c.persona.length, 600);
  assert.deepEqual(c.look, { color: defaultLook("codex").color, face: "smile", hat: "crown", accessory: "none" });
  assert.deepEqual(c.mcp, ["a", "b"]);
  assert.equal(coerceCharacter({ name: "Bo", agent: "nope" })!.agent, "claude", "an unknown agent becomes Claude Code");
});

test("looks keep valid choices and lowercase the color", () => {
  assert.deepEqual(coerceLook({ color: "#ABCDEF", face: "cool", hat: "wizard", accessory: "mustache" }, "gemini"), {
    color: "#abcdef",
    face: "cool",
    hat: "wizard",
    accessory: "mustache",
  });
  assert.deepEqual(coerceLook(null, "claude"), defaultLook("claude"));
});

test("a persona goes into every brief, with the character's name", () => {
  assert.match(personaBrief({ name: "Ada", persona: "Tests first.\nSmall commits." }), /You are Ada on this team\. .*Tests first\. Small commits\./);
  assert.equal(personaBrief({ name: "Bo", persona: "" }), " You are Bo on this team.");
});

test("the team module saves, updates and removes characters, and keeps names unique", () => {
  const { progress, logs, routes } = fakeCtx();
  routes.characterSave!({ t: "characterSave", character: { id: "ada", name: "Ada", agent: "claude", mcp: ["ghost"] } } as never, client, ws);
  assert.equal(progress.team.length, 1);
  assert.deepEqual(progress.team[0].mcp, [], "MCP servers the office doesn't have are dropped");

  // Updating keeps when it was made and how often it's been hired.
  progress.characterHired("ada");
  routes.characterSave!({ t: "characterSave", character: { id: "ada", name: "Ada", agent: "codex", persona: "Careful." } } as never, client, ws);
  assert.equal(progress.team.length, 1);
  assert.equal(progress.team[0].agent, "codex");
  assert.equal(progress.team[0].hires, 1);

  routes.characterSave!({ t: "characterSave", character: { id: "other", name: "ada" } } as never, client, ws);
  assert.equal(progress.team.length, 1, "a second Ada isn't added");
  routes.characterSave!({ t: "characterSave", character: { name: "" } } as never, client, ws);
  assert.equal(logs.length, 2, "both failures are logged");

  routes.characterDelete!({ t: "characterDelete", id: "ada" } as never, client, ws);
  assert.equal(progress.team.length, 0);
});

test("the team holds at most MAX_TEAM characters", () => {
  const { progress, logs, routes } = fakeCtx();
  for (let i = 0; i < MAX_TEAM + 2; i++) {
    routes.characterSave!({ t: "characterSave", character: { id: `c${i}`, name: `Bot ${i}` } } as never, client, ws);
  }
  assert.equal(progress.team.length, MAX_TEAM);
  assert.ok(logs.some((l) => /full/.test(l)));
});

test("a hired character's worker carries who it is", () => {
  const office = new Office({ simulate: true });
  const deskId = office.snapshot().desks[0].id;
  const look = { color: "#06d6a0", face: "grin" as const, hat: "crown" as const, accessory: "bowtie" as const };
  assert.ok(office.hire(deskId, "claude", "Ann", "", "ask", false, { characterId: "ada", name: "Ada", look, voice: "" }));
  const w = office.snapshot().desks[0].worker!;
  assert.deepEqual(w.identity, { characterId: "ada", name: "Ada", look, voice: "" });
  // Switching its model keeps who it is.
  office.switchModel(deskId, "opus");
  assert.equal(office.snapshot().desks[0].worker!.identity?.name, "Ada");
  office.dispose();
});
