import { MAX_TEAM, coerceCharacter } from "../shared/team.js";
import type { Routes, ServerCtx } from "./ctx.js";

/**
 * Your team's characters on the server: saving (new or changed) and removing
 * them. Everything a client sends is cleaned with coerceCharacter; names are
 * unique on the team; a character only keeps MCP servers the office has.
 * Hiring a character and its persona in task briefs are wired in index.ts.
 */
export function teamModule(ctx: ServerCtx): Routes {
  const fail = (title: string) => ctx.log.start("agent", title, { topic: "team" }).done(false);

  return {
    characterSave: (msg) => {
      const c = coerceCharacter((msg as { character?: unknown }).character);
      if (!c) {
        fail("Couldn't save the character: it needs a name");
        return;
      }
      const clash = ctx.progress.team.find((x) => x.id !== c.id && x.name.toLowerCase() === c.name.toLowerCase());
      if (clash) {
        fail(`There's already a ${clash.name} on the team`);
        return;
      }
      c.mcp = c.mcp.filter((id) => ctx.progress.mcp.some((m) => m.id === id));
      if (!ctx.progress.saveCharacter(c)) fail(`The team is full (${MAX_TEAM} characters)`);
    },
    characterDelete: (msg) => {
      const id = (msg as { id?: unknown }).id;
      if (typeof id === "string" && id.length <= 40) ctx.progress.deleteCharacter(id);
    },
  };
}
