import { LOCAL_NO_THINKING } from "./workerSession.js";
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import type { DeckSlide, Goal } from "../shared/progress.js";
import { spawnPty, type IPty } from "./ptyWorker.js";

/**
 * The agent loop's plumbing on the server: the project's config (preview URL
 * and deploy command), the files workers write for a goal — its plan, its
 * research deck, and a note when it shipped — and running the deploy.
 *
 * Each goal gets a folder, `.domain/goals/<goalId>/`:
 *   plan.md     a markdown checklist; its items become the goal's tasks
 *   deck.md     a research deck, slides separated by `---`
 *   shipped.md  the PR / deploy URL and a line on what shipped
 *   deploy.log  the last deploy's output, for a worker asked to fix it
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface LoopConfig {
  /** The URL the laptop's browser opens first. */
  preview: string | null;
  /** The command "Ship it" runs in the project folder. */
  deploy: string | null;
  /** The team's starting defaults (`"team"` in the file), if given. */
  team: unknown;
  /** The check run on finished work before it's reviewed (e.g. "npm test"). */
  check: string | null;
}

/**
 * Read `domain.config.json` from the project folder, with env overrides
 * (DOMAIN_PREVIEW_URL, DOMAIN_DEPLOY_CMD). Read fresh each time so edits take
 * effect without a restart.
 */
export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): LoopConfig {
  let file: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(readFileSync(join(cwd, "domain.config.json"), "utf8")) as unknown;
    if (raw && typeof raw === "object") file = raw as Record<string, unknown>;
  } catch {
    /* no config, or unreadable */
  }
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const preview = str(env.DOMAIN_PREVIEW_URL, 500) ?? str(file.preview, 500);
  return {
    preview: preview && /^https?:\/\//i.test(preview) ? preview : null,
    deploy: str(env.DOMAIN_DEPLOY_CMD, 1000) ?? str(file.deploy, 1000),
    team: file.team ?? null,
    check: str(env.DOMAIN_CHECK_CMD, 1000) ?? str(file.check, 1000),
  };
}

// ---------------------------------------------------------------------------
// Parsing what workers write
// ---------------------------------------------------------------------------

/**
 * The tasks in a plan: its list items (`- [ ] …`, `* …`, `1. …`), with
 * checkboxes, bold markers and trailing colons stripped. Headings and prose
 * are ignored.
 */
export function parsePlan(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+)$/.exec(line);
    if (!m) continue;
    const t = m[1]
      .replace(/\*\*|__|`/g, "")
      .replace(/\s+/g, " ")
      .replace(/[:.]\s*$/, "")
      .trim();
    if (t.length >= 3) out.push(t.slice(0, 160));
  }
  return out.slice(0, 40);
}

/**
 * Slides from a markdown deck. Slides are separated by a line of `---`; each
 * starts with a `# Title` (any heading level), then bullets (`- …`), plain
 * lines (kept as bullets), an image (`![alt](url)`) and speaker notes on lines
 * after `Note:` / `Notes:`.
 */
export function parseDeck(md: string): DeckSlide[] {
  const chunks = md.replace(/\r\n/g, "\n").split(/^\s*---+\s*$/m);
  const slides: DeckSlide[] = [];
  for (const chunk of chunks) {
    let title = "";
    const bullets: string[] = [];
    const notes: string[] = [];
    let image: string | null = null;
    let inNotes = false;
    for (const raw of chunk.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const note = /^notes?:\s*(.*)$/i.exec(line);
      if (note) {
        inNotes = true;
        if (note[1]) notes.push(note[1]);
        continue;
      }
      if (inNotes) {
        notes.push(line);
        continue;
      }
      const img = /^!\[[^\]]*\]\((\S+?)(?:\s+"[^"]*")?\)$/.exec(line);
      if (img) {
        if (!image && /^https?:\/\//i.test(img[1])) image = img[1].slice(0, 500);
        continue;
      }
      const h = /^#{1,6}\s+(.+)$/.exec(line);
      if (h && !title) {
        title = h[1].trim();
        continue;
      }
      const b = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
      const text = (b ? b[1] : h ? h[1] : line).replace(/\*\*|__/g, "").trim();
      if (text) bullets.push(text.slice(0, 300));
    }
    if (!title && !bullets.length) continue;
    slides.push({
      title: (title || bullets.shift() || "Untitled").replace(/\*\*|__/g, "").slice(0, 140),
      bullets: bullets.slice(0, 10),
      notes: notes.join(" ").slice(0, 2000),
      image,
    });
    if (slides.length >= 40) break;
  }
  return slides;
}

/** The URL and a line of summary from a shipped.md note. */
export function parseShipped(md: string): { url: string | null; note: string } {
  const url = /https?:\/\/[^\s)>\]]+/.exec(md)?.[0] ?? null;
  const note =
    md
      .split(/\r?\n/)
      .map((l) => l.replace(/^#+\s*|^[-*]\s*/, "").trim())
      .find((l) => l && !/^https?:\/\//.test(l)) ?? "";
  return { url, note: note.slice(0, 300) };
}

// ---------------------------------------------------------------------------
// Watching each goal's folder
// ---------------------------------------------------------------------------

export type GoalFile = "plan" | "deck" | "shipped";

/**
 * Polls `.domain/goals/<goalId>/{plan,deck,shipped}.md` for the goals it's
 * told about and hands over a file's contents when it changes. Polling (by
 * mtime and size) is cheap at this scale and behaves the same everywhere.
 */
export class GoalFiles {
  private seen = new Map<string, string>();
  /** A change seen on the last scan, waiting to hold still for one more. */
  private pending = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private goals: () => string[] = () => [];

  constructor(
    readonly root: string,
    private onFile: (goalId: string, file: GoalFile, text: string) => void,
  ) {}

  dir(goalId: string): string {
    return join(this.root, safeId(goalId));
  }

  path(goalId: string, file: GoalFile | "deploy.log"): string {
    return join(this.dir(goalId), file.includes(".") ? file : `${file}.md`);
  }

  /** Make the goal's folder so a worker can write into it. */
  ensure(goalId: string): string {
    const d = this.dir(goalId);
    mkdirSync(d, { recursive: true });
    return d;
  }

  /**
   * Remember what a file holds now, so only later changes count. Called
   * before briefing a worker, so a stale plan from last time isn't re-read.
   */
  mark(goalId: string, file: GoalFile): void {
    this.seen.set(`${goalId}/${file}`, this.stamp(this.path(goalId, file)));
  }

  start(goals: () => string[], everyMs = 800): void {
    this.goals = goals;
    // Whatever is on disk at start-up is already known.
    for (const id of goals()) for (const f of ["plan", "deck", "shipped"] as const) this.mark(id, f);
    this.timer = setInterval(() => this.scan(), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  scan(): void {
    for (const goalId of this.goals()) {
      for (const file of ["plan", "deck", "shipped"] as const) {
        const path = this.path(goalId, file);
        const key = `${goalId}/${file}`;
        const stamp = this.stamp(path);
        const before = this.seen.get(key);
        if (stamp === before) {
          this.pending.delete(key);
          continue;
        }
        if (!stamp) {
          this.seen.set(key, stamp);
          continue;
        }
        // Wait for it to settle: the same stamp on two scans in a row.
        if (this.pending.get(key) !== stamp) {
          this.pending.set(key, stamp);
          continue;
        }
        this.pending.delete(key);
        this.seen.set(key, stamp);
        let text = "";
        try {
          text = readFileSync(path, "utf8").slice(0, 200_000);
        } catch {
          continue;
        }
        this.onFile(goalId, file, text);
      }
    }
  }

  private stamp(path: string): string {
    try {
      const s = statSync(path);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return "";
    }
  }
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "goal";
}

// ---------------------------------------------------------------------------
// Briefs: what a worker is told to do at each step of the loop
// ---------------------------------------------------------------------------

export function planBrief(goal: Goal, planPath: string): string {
  const what =
    goal.kind === "research"
      ? "Break this research goal into 3-8 concrete questions or sections, each one a worker can research and write up as a few slides"
      : "Break this goal into 3-8 concrete tasks, each one a coding agent can finish and present in one sitting";
  return (
    `[Plan] Goal: "${goal.title}"${goal.why ? ` — ${goal.why}` : ""}. ${what}. Look around the project first. ` +
    `Each task: one line, starts with a verb, small enough to finish and review on its own, in the order they should be done. ` +
    `Write them as a markdown checklist, one "- [ ] task" per line, to ${planPath} (create the folder if needed) — the office adds them to the goal automatically. Don't start the work yet.`
  );
}

export function researchBrief(deckPath: string): string {
  return (
    ` This is a research goal: put what you find into the shared slide deck at ${deckPath} — markdown, slides separated by a line with ---, ` +
    `each slide starting "# Title", then "- " bullets (short, concrete, with sources), an optional image as ![](https://…) and optional "Note: " speaker notes. ` +
    `Add or update your own slides and keep everyone else's.`
  );
}

export function shipBrief(goal: Goal, shippedPath: string): string {
  return (
    `[Ship] Every task of "${goal.title}" is approved — ship it. Commit the work on a new branch, push it and open a pull request ` +
    `(or follow this project's usual release process). Then write the PR or deploy URL and one line on what shipped to ${shippedPath}.`
  );
}

export function deckBrief(goal: Goal, deckPath: string, shippedPath: string): string {
  return (
    `[Deliver] Every task of the research goal "${goal.title}" is done — turn the findings into the final deck.` +
    researchBrief(deckPath) +
    ` Open with a title slide and a one-slide summary of the answer, end with recommendations and next steps. When it's finished, write one line on the conclusion to ${shippedPath}.`
  );
}

export function fixDeployBrief(goal: Goal, command: string, exitCode: number | null, logPath: string, shippedPath: string): string {
  return (
    `[Ship] Deploying "${goal.title}" failed: \`${command}\` exited with ${exitCode ?? "an error"}. The full output is in ${logPath}. ` +
    `Find the cause and fix it, check that \`${command}\` passes, then write the deploy URL and one line on the fix to ${shippedPath}.`
  );
}

// ---------------------------------------------------------------------------
// Running the deploy
// ---------------------------------------------------------------------------

const LOG_MAX = 256 * 1024;

/**
 * Runs the configured deploy command in the project folder — in a real
 * terminal when one is available, so tools print their progress and colors —
 * streams its output, and reports how it exited. One at a time.
 */
export class Deployer {
  goalId: string | null = null;
  log = "";
  private pty: IPty | null = null;
  private child: ChildProcess | null = null;

  onOutput: ((goalId: string, data: string) => void) | null = null;
  onExit: ((goalId: string, code: number | null, log: string) => void) | null = null;

  get running(): boolean {
    return this.pty !== null || this.child !== null;
  }

  run(goalId: string, command: string, cwd: string): boolean {
    if (this.running) return false;
    this.goalId = goalId;
    this.log = "";
    this.emit(`\x1b[2m$ ${command}\x1b[0m\r\n`);
    const win = process.platform === "win32";
    const file = win ? (process.env.COMSPEC ?? "cmd.exe") : (process.env.SHELL ?? "/bin/sh");
    const args = win ? ["/d", "/s", "/c", command] : ["-lc", command];
    const env = { ...process.env, DOMAIN_DEPLOY: "1", FORCE_COLOR: "1" };
    try {
      const pty = spawnPty(file, args, { name: "xterm-256color", cols: 120, rows: 30, cwd, env });
      if (pty) {
        this.pty = pty;
        pty.onData((d) => this.emit(d));
        pty.onExit(({ exitCode }) => {
          this.pty = null;
          this.finish(exitCode);
        });
        return true;
      }
    } catch {
      /* fall through to a plain child process */
    }
    try {
      const child = spawnChild(file, args, { cwd, env, windowsVerbatimArguments: win });
      this.child = child;
      child.stdout?.on("data", (b: Buffer) => this.emit(b.toString().replace(/\r?\n/g, "\r\n")));
      child.stderr?.on("data", (b: Buffer) => this.emit(b.toString().replace(/\r?\n/g, "\r\n")));
      child.on("error", (err) => this.emit(`\r\n${err.message}\r\n`));
      child.on("close", (code) => {
        this.child = null;
        this.finish(code);
      });
      return true;
    } catch (err) {
      this.emit(`\r\nCould not start the deploy: ${(err as Error).message}\r\n`);
      this.finish(null);
      return false;
    }
  }

  /** Play a deploy without running anything (DOMAIN_SIMULATE). */
  simulate(goalId: string, title: string): void {
    if (this.running) return;
    this.goalId = goalId;
    this.log = "";
    const steps = [
      "\x1b[2m$ (simulated) npm run deploy\x1b[0m",
      "▸ Installing dependencies… done",
      "▸ Running tests… 42 passed",
      "▸ Building for production… done in 3.1s",
      `▸ Uploading “${title}”… 100%`,
      "\x1b[32m✔ Deployed to https://example.com (simulated)\x1b[0m",
    ];
    // A stand-in so `running` is true while it plays.
    const fake = { kill: () => {} } as unknown as ChildProcess;
    this.child = fake;
    steps.forEach((s, i) =>
      setTimeout(() => {
        if (this.child !== fake) return;
        this.emit(s + "\r\n");
        if (i === steps.length - 1) {
          this.child = null;
          this.finish(0);
        }
      }, 500 + i * 650).unref?.(),
    );
  }

  cancel(): void {
    try {
      this.pty?.kill();
    } catch {
      /* gone */
    }
    try {
      this.child?.kill();
    } catch {
      /* gone */
    }
    if (this.running) {
      this.pty = null;
      this.child = null;
      this.emit("\r\n\x1b[33m▸ deploy stopped\x1b[0m\r\n");
      this.goalId = null;
    }
  }

  private emit(data: string): void {
    this.log += data;
    if (this.log.length > LOG_MAX) this.log = this.log.slice(-LOG_MAX);
    if (this.goalId) this.onOutput?.(this.goalId, data);
  }

  private finish(code: number | null): void {
    const id = this.goalId;
    if (!id) return;
    this.emit(code === 0 ? "\r\n\x1b[32m▸ deploy finished\x1b[0m\r\n" : `\r\n\x1b[31m▸ deploy failed (exit ${code ?? "?"})\x1b[0m\r\n`);
    this.onExit?.(id, code, this.log);
  }
}

/** Save a deploy's log where a worker can read it. */
export function saveLog(path: string, log: string): void {
  try {
    writeFileSync(path, log.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, ""));
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Dev servers on this machine
// ---------------------------------------------------------------------------

export const DEV_PORTS = [3000, 3001, 3002, 4000, 4173, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 8081, 8888] as const;

function listening(port: number, host: string, ms = 350): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(ms, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** Local dev servers that are up, as http://localhost:<port> URLs. */
export async function probeDevServers(exclude: number[]): Promise<string[]> {
  const ports = DEV_PORTS.filter((p) => !exclude.includes(p));
  const up = await Promise.all(ports.map(async (p) => (await listening(p, "127.0.0.1")) || (await listening(p, "::1"))));
  return ports.filter((_, i) => up[i]).map((p) => `http://localhost:${p}`);
}

// ---------------------------------------------------------------------------
// DOMAIN_SIMULATE: what scripted workers "write"
// ---------------------------------------------------------------------------

export function simPlan(goal: Goal): string {
  const items =
    goal.kind === "research"
      ? ["Frame the question and what a good answer looks like", "Survey what already exists", "Compare the top options side by side", "Recommend a direction, with risks"]
      : ["Sketch the approach and the files it touches", "Build the core flow", "Cover it with tests", "Polish the rough edges", "Write the release notes"];
  return `# Plan: ${goal.title}\n\n${items.map((i) => `- [ ] ${i}`).join("\n")}\n`;
}

/** Append a couple of slides for a task to a research deck (simulated workers). */
export function simAppendSlides(path: string, goal: Goal, task: string): void {
  let md = "";
  try {
    md = existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    /* start fresh */
  }
  if (!md.trim()) {
    md = `# ${goal.title}\n\n- ${goal.why || "What we found, and what we recommend"}\n- Prepared by the office's research team\n\nNote: Opening slide.\n`;
  }
  md +=
    `\n---\n\n# ${task}\n\n- The short answer, in one line\n- Three findings that back it up\n- What it means for us\n\nNote: Simulated research for “${task}”.\n` +
    `\n---\n\n## ${task}: the numbers\n\n- Option A — fastest to try\n- Option B — most robust\n- Option C — cheapest to run\n`;
  try {
    writeFileSync(path, md);
  } catch {
    /* best effort */
  }
}

/**
 * Models served on this machine, named the way the agents take them:
 * `ollama/<model>` from Ollama (port 11434) and `lmstudio/<model>` from LM
 * Studio (port 1234). Empty when neither is running. Override the addresses
 * with OLLAMA_HOST / LMSTUDIO_URL.
 */
export async function detectLocalModels(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const get = async (url: string): Promise<unknown> => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };
  const ollamaBase = (env.OLLAMA_HOST ? (/^https?:\/\//.test(env.OLLAMA_HOST) ? env.OLLAMA_HOST : `http://${env.OLLAMA_HOST}`) : "http://127.0.0.1:11434").replace(/\/$/, "");
  const lmBase = (env.LMSTUDIO_URL ?? "http://127.0.0.1:1234").replace(/\/$/, "");
  const [ollama, lm] = await Promise.all([get(`${ollamaBase}/api/tags`), get(`${lmBase}/v1/models`)]);
  const out: string[] = [];
  const o = ollama as { models?: { name?: unknown; capabilities?: unknown }[] } | null;
  for (const m of o?.models ?? []) {
    if (typeof m.name !== "string") continue;
    const caps = Array.isArray(m.capabilities) ? m.capabilities : null;
    // An agent works through tools: a model that can't call them can't do the job.
    if (caps && !caps.includes("tools")) continue;
    if (caps && !caps.includes("thinking")) LOCAL_NO_THINKING.add(`ollama/${m.name}`);
    out.push(`ollama/${m.name}`);
  }
  const l = lm as { data?: { id?: unknown }[] } | null;
  for (const m of l?.data ?? []) if (typeof m.id === "string") out.push(`lmstudio/${m.id}`);
  return out.filter((m) => /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/.test(m)).slice(0, 40);
}
