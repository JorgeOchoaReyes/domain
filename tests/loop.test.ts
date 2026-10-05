import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Progress, type Award } from "../src/server/progress.ts";
import { GoalFiles, loadConfig, parseDeck, parsePlan, parseShipped } from "../src/server/loop.ts";
import { XP, goalStage, stageLabel } from "../src/shared/progress.ts";

test("a goal walks the loop: plan, build, review, ship, shipped", () => {
  const p = new Progress(null);
  const goal = p.createGoal("Ann", "Launch the beta", "", [])!;
  const stage = () => goalStage(p.getGoal(goal.id)!);
  assert.equal(stage(), "plan");

  assert.equal(p.addPlannedTasks(goal.id, ["Login page", "login page!", "Billing", "  "]), 2, "duplicates and blanks are skipped");
  assert.equal(stage(), "build");

  const [login, billing] = p.getGoal(goal.id)!.tasks;
  p.assign("Ann", goal.id, login.id, "desk-1");
  p.reported("desk-1");
  assert.equal(stage(), "review");
  p.reviewed("Ann", "desk-1", true);
  p.setDone("Ann", goal.id, billing.id, true);
  assert.equal(stage(), "ship");

  assert.ok(p.shipped("Ann", goal.id, { url: "https://github.com/x/y/pull/1" }));
  assert.equal(stage(), "shipped");
  assert.equal(p.getGoal(goal.id)!.ship?.url, "https://github.com/x/y/pull/1");
  assert.equal(p.shipped("Ann", goal.id), false, "only ships once");
  assert.equal(stageLabel("ship", "research"), "Present");
});

test("the stand-up sets the goal, tone and intention and starts the session", () => {
  const p = new Progress(null);
  const awards: Award[] = [];
  p.onAward = (a) => awards.push(a);
  const res = p.standup("Ann", {
    goalId: null,
    newGoal: { title: "State of vector DBs", why: "Pick one", tasks: ["Survey"], kind: "research" },
    tone: "explore",
    intention: "  A clear recommendation  ",
    minutes: 25,
  });
  assert.ok(res.started);
  const s = p.snapshot();
  assert.equal(s.goals[0].kind, "research");
  assert.equal(s.session?.goalId, s.goals[0].id);
  assert.equal(s.session?.tone, "explore");
  assert.equal(s.session?.intention, "A clear recommendation");
  assert.ok(awards.some((a) => a.reason === "Held the stand-up" && a.xp === XP.standup));

  // A second stand-up while the session runs still makes its goal, but no new session.
  const again = p.standup("Bo", { goalId: null, newGoal: { title: "Other", why: "", tasks: [], kind: "build" }, tone: "ship", intention: "", minutes: 50 });
  assert.equal(again.started, false);
  assert.equal(p.snapshot().goals.length, 2);
  assert.equal(p.snapshot().session?.tone, "explore");
});

test("nothing gets stuck when a worker is sent home", () => {
  const p = new Progress(null);
  const goal = p.createGoal("Ann", "G", "", ["One"])!;
  p.planning("Ann", goal.id, "desk-2");
  p.assign("Ann", goal.id, goal.tasks[0].id, "desk-2");
  p.unlinkDesk("desk-2");
  const g = p.getGoal(goal.id)!;
  assert.equal(g.planningDesk, null);
  assert.equal(g.tasks[0].status, "todo");

  p.setDone("Ann", goal.id, g.tasks[0].id, true);
  p.shipStarted("Ann", goal.id, "agent", null, "desk-3");
  p.unlinkDesk("desk-3");
  assert.equal(p.getGoal(goal.id)!.ship, null, "back to ready-to-ship");
});

test("a failed deploy keeps its log and can be retried or marked shipped", () => {
  const p = new Progress(null);
  const goal = p.createGoal("Ann", "G", "", ["One"])!;
  p.setDone("Ann", goal.id, goal.tasks[0].id, true);
  p.shipStarted("Ann", goal.id, "deploy", "npm run deploy", null);
  p.shipFailed(goal.id, 1, "boom: missing env");
  assert.equal(p.getGoal(goal.id)!.ship?.status, "failed");
  assert.match(p.getGoal(goal.id)!.ship!.logTail, /missing env/);
  assert.equal(goalStage(p.getGoal(goal.id)!), "ship");
  assert.ok(p.shipStarted("Ann", goal.id, "deploy", "npm run deploy", null));
  assert.ok(p.shipped("Ann", goal.id, { mode: "manual" }));
});

test("plans parse from markdown checklists", () => {
  const md = `# Plan\n\nSome prose.\n\n- [ ] Build the **sign-up** flow\n* [x] Add analytics:\n1. Write the launch post.\n- ok\n`;
  assert.deepEqual(parsePlan(md), ["Build the sign-up flow", "Add analytics", "Write the launch post"]);
});

test("decks parse into slides with bullets, notes and images", () => {
  const md = `# Vector DBs\n\n- Why it matters\n\nNote: opening\n\n---\n\n## Options\n\n- pgvector\n- Qdrant\n![chart](https://example.com/c.png)\nNotes: compare cost\nand speed\n\n---\n\n   \n`;
  const slides = parseDeck(md);
  assert.equal(slides.length, 2);
  assert.deepEqual(slides[0], { title: "Vector DBs", bullets: ["Why it matters"], notes: "opening", image: null });
  assert.equal(slides[1].title, "Options");
  assert.deepEqual(slides[1].bullets, ["pgvector", "Qdrant"]);
  assert.equal(slides[1].image, "https://example.com/c.png");
  assert.equal(slides[1].notes, "compare cost and speed");
});

test("shipped notes and config are read", () => {
  assert.deepEqual(parseShipped("# Shipped\nhttps://github.com/a/b/pull/3\nAdded sign-up"), { url: "https://github.com/a/b/pull/3", note: "Shipped" });
  const dir = mkdtempSync(join(tmpdir(), "domain-loop-"));
  try {
    writeFileSync(
      join(dir, "domain.config.json"),
      JSON.stringify({ preview: "http://localhost:3000", deploy: "npm run deploy", team: { minutes: 20 }, check: "npm test" }),
    );
    assert.deepEqual(loadConfig(dir, {}), { preview: "http://localhost:3000", deploy: "npm run deploy", team: { minutes: 20 }, check: "npm test" });
    assert.equal(loadConfig(dir, { DOMAIN_DEPLOY_CMD: "make ship" }).deploy, "make ship");
    assert.equal(loadConfig(dir, { DOMAIN_CHECK_CMD: "make check" }).check, "make check");
    assert.deepEqual(loadConfig(join(dir, "nope"), {}), { preview: null, deploy: null, team: null, check: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("goal files are read only once they settle", () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-goals-"));
  try {
    const got: string[] = [];
    const files = new GoalFiles(dir, (_id, file, text) => got.push(`${file}:${text}`));
    files.start(() => ["g1"], 60_000);
    files.ensure("g1");
    writeFileSync(files.path("g1", "plan"), "- [ ] A");
    files.scan();
    assert.deepEqual(got, [], "a fresh change waits a scan");
    files.scan();
    assert.deepEqual(got, ["plan:- [ ] A"]);
    files.scan();
    assert.equal(got.length, 1, "read once");
    files.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local models are found on Ollama and LM Studio, named the way agents take them", async () => {
  const { createServer } = await import("node:http");
  const { detectLocalModels } = await import("../src/server/loop.ts");
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/tags") res.end(JSON.stringify({ models: [{ name: "qwen3.6:latest" }, { name: "llama3:latest" }] }));
    else if (req.url === "/v1/models") res.end(JSON.stringify({ data: [{ id: "mistral-7b" }] }));
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const both = await detectLocalModels({ OLLAMA_HOST: `127.0.0.1:${port}`, LMSTUDIO_URL: `http://127.0.0.1:${port}` });
    assert.deepEqual(both, ["ollama/qwen3.6:latest", "ollama/llama3:latest", "lmstudio/mistral-7b"]);
    const none = await detectLocalModels({ OLLAMA_HOST: "127.0.0.1:1", LMSTUDIO_URL: "http://127.0.0.1:1" });
    assert.deepEqual(none, [], "nothing running, nothing offered");
  } finally {
    server.close();
  }
});

test("local models: no tools, no job; no thinking, Codex runs them with reasoning off", async () => {
  const { createServer } = await import("node:http");
  const { detectLocalModels } = await import("../src/server/loop.ts");
  const { launchCommand } = await import("../src/server/workerSession.ts");
  // As a real Ollama lists them.
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/tags") {
      res.end(
        JSON.stringify({
          models: [
            { name: "qwen3.6:latest", capabilities: ["completion", "vision", "tools", "thinking"] },
            { name: "llama3:latest", capabilities: ["completion"] },
            { name: "llama3.1:latest", capabilities: ["completion", "tools"] },
          ],
        }),
      );
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const found = await detectLocalModels({ OLLAMA_HOST: `127.0.0.1:${port}`, LMSTUDIO_URL: "http://127.0.0.1:1" });
    assert.deepEqual(found, ["ollama/qwen3.6:latest", "ollama/llama3.1:latest"], "llama3 can't call tools, so it isn't offered");
    assert.match(launchCommand("codex", "ollama/llama3.1:latest"), /--oss --local-provider ollama --model llama3\.1:latest -c model_reasoning_effort=none/);
    assert.doesNotMatch(launchCommand("codex", "ollama/qwen3.6:latest"), /reasoning_effort/, "a thinking model keeps its reasoning");
  } finally {
    server.close();
  }
});

test("a local model too big for this computer's memory is called out before it hangs", async () => {
  const { LOCAL_MODEL_BYTES, localModelWarning } = await import("../src/server/workerSession.ts");
  const GB = 1024 ** 3;
  LOCAL_MODEL_BYTES.set("ollama/qwen3.6:latest", 24 * GB);
  LOCAL_MODEL_BYTES.set("ollama/llama3.1:latest", 5 * GB);
  // This machine: 15 GB in all, 3 GB free.
  assert.match(localModelWarning("ollama/qwen3.6:latest", 15 * GB, 3 * GB)!, /needs about 24 GB .* has 15 GB .* Pick a smaller model/);
  assert.match(localModelWarning("ollama/llama3.1:latest", 15 * GB, 3 * GB)!, /3 GB is free right now/);
  assert.equal(localModelWarning("ollama/llama3.1:latest", 15 * GB, 9 * GB), null, "fits: no warning");
  assert.equal(localModelWarning("sonnet", 15 * GB, 1 * GB), null, "cloud models aren't local");
});

test("Claude Code on an Ollama model: --model, and pointed at Ollama for that worker only", async () => {
  const { launchCommand, localEnv } = await import("../src/server/workerSession.ts");
  assert.equal(launchCommand("claude", "ollama/qwen3.6:latest", "ask"), "claude --model qwen3.6:latest");
  assert.deepEqual(localEnv("claude", "ollama/qwen3.6:latest", {}), { ANTHROPIC_BASE_URL: "http://127.0.0.1:11434", ANTHROPIC_AUTH_TOKEN: "ollama", ANTHROPIC_API_KEY: "" });
  assert.equal(localEnv("claude", "ollama/x", { OLLAMA_HOST: "0.0.0.0:9999" }).ANTHROPIC_BASE_URL, "http://0.0.0.0:9999");
  assert.deepEqual(localEnv("claude", "sonnet", {}), {}, "a cloud model: your own login");
  assert.deepEqual(localEnv("codex", "ollama/x", {}), {}, "Codex has its own --oss");
});

test("permission levels: each CLI's own flags, and the worker is told", async () => {
  const { launchCommand } = await import("../src/server/workerSession.ts");
  const { taskBriefText } = await import("../src/server/office.ts");
  const want: Record<string, Record<string, string>> = {
    claude: { ask: "claude", auto: "claude --permission-mode acceptEdits", safe: "claude --permission-mode auto", full: "claude --permission-mode bypassPermissions" },
    codex: {
      ask: "codex --sandbox read-only --ask-for-approval on-request",
      auto: "codex --sandbox workspace-write --ask-for-approval on-request",
      safe: "codex --approve-for-me",
      full: "codex --sandbox workspace-write --ask-for-approval never",
    },
    gemini: { ask: "gemini", auto: "gemini --approval-mode auto_edit", safe: "gemini --approval-mode auto_edit", full: "gemini --approval-mode yolo" },
    opencode: { ask: "opencode", auto: "opencode", safe: "opencode", full: "opencode" },
  };
  for (const [agent, levels] of Object.entries(want)) {
    for (const [leash, cmd] of Object.entries(levels)) assert.equal(launchCommand(agent as never, "", leash as never), cmd, `${agent} ${leash}`);
  }
  assert.match(taskBriefText("Goal", "Task", "", undefined, null, "auto"), /Your permissions: edit files in your folder without asking; ask before running commands\./);
  assert.match(taskBriefText("Goal", "Task", "", undefined, null, "full"), /stay inside your own folder/);
});

test("Claude Code on a local model starts lean: none of your global MCP tools", async () => {
  const { leanLocalArgs } = await import("../src/server/workerSession.ts");
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "lean-"));
  const args = leanLocalArgs("claude", "ollama/qwen3:8b", [], dir);
  assert.equal(args[0], "--strict-mcp-config");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, ".domain", "mcp-none.json"), "utf8")), { mcpServers: {} });
  assert.deepEqual(leanLocalArgs("claude", "sonnet", [], dir), [], "a cloud model keeps your tools");
  assert.deepEqual(leanLocalArgs("claude", "ollama/x", ["--mcp-config", "office.json"], dir), [], "the office's own servers, when given, are kept");
});
