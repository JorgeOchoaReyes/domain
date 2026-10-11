import type { Routes, ServerCtx } from "./ctx.js";
import { agentsModule } from "./agents.js";
import { chatModule } from "./chat.js";
import { ideasModule } from "./ideas.js";
import { lanModule } from "./lan.js";
import { mcpModule } from "./mcp.js";
import { podsModule } from "./pods.js";
import { projectModule } from "./projects.js";
import { teamModule } from "./team.js";
import { voicesModule } from "./voices.js";

/**
 * The feature modules that plug into the server: each takes the server's
 * context and returns its message handlers.
 */
export const MODULES: ((ctx: ServerCtx) => Routes)[] = [projectModule, teamModule, mcpModule, lanModule, ideasModule, (ctx) => agentsModule(ctx), (ctx) => chatModule(ctx), (ctx) => voicesModule(ctx), (ctx) => podsModule(ctx)];
