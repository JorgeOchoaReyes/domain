import { watch, type FSWatcher } from "node:fs";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

/**
 * Watches a folder for JSON files agents drop, one per desk, named
 * `<deskId>.json`: their reports in `.domain/reports/` and what they say back
 * during a review in `.domain/replies/`. When a file appears or changes it is
 * parsed with `coerce` and, if it is newer than the last one (its `at`
 * advanced), handed to the callback with its desk id.
 *
 * Uses fs.watch with a short polling backstop, since fs.watch misses events on
 * some platforms/filesystems. Reads are debounced per desk so a half-written
 * file is not parsed mid-write.
 */
export class DropWatcher<T extends { at: number }> {
  private watcher: FSWatcher | null = null;
  private poll: NodeJS.Timeout | null = null;
  private debounce = new Map<string, NodeJS.Timeout>();
  private seen = new Map<string, number>(); // deskId -> last `at`

  constructor(
    readonly dir: string,
    private coerce: (raw: unknown) => T | null,
    private onItem: (deskId: string, item: T) => void,
  ) {}

  start(): void {
    mkdirSync(this.dir, { recursive: true });
    try {
      this.watcher = watch(this.dir, (_event, filename) => {
        if (filename) this.queue(basename(filename.toString()));
      });
    } catch {
      this.watcher = null; // fall back to polling only
    }
    // Backstop: rescan every 2s in case a watch event was missed.
    this.poll = setInterval(() => this.scan(), 2000);
    this.poll.unref?.();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.poll) clearInterval(this.poll);
    for (const t of this.debounce.values()) clearTimeout(t);
    this.debounce.clear();
  }

  /** Forget a desk's last-seen file (called when a worker is sent home). */
  forget(deskId: string): void {
    this.seen.delete(deskId);
  }

  private scan(): void {
    let files: string[] = [];
    try {
      files = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const f of files) if (f.endsWith(".json")) this.queue(f);
  }

  private queue(filename: string): void {
    if (!filename.endsWith(".json")) return;
    const existing = this.debounce.get(filename);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.debounce.delete(filename);
      this.read(filename);
    }, 150);
    this.debounce.set(filename, t);
  }

  private read(filename: string): void {
    const deskId = filename.replace(/\.json$/, "");
    const path = join(this.dir, filename);
    if (!existsSync(path)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return; // not valid JSON yet (mid-write) — a later event will retry
    }
    const item = this.coerce(parsed);
    if (!item) return;
    const last = this.seen.get(deskId);
    if (last !== undefined && item.at <= last) return;
    this.seen.set(deskId, item.at);
    this.onItem(deskId, item);
  }
}

/**
 * Write `.domain/BRIEF.md`, the contract a real agent follows to present its
 * work and to talk back during a review. Rewritten on every start so it
 * tracks the office's current contract.
 */
export function writeBrief(domainDir: string): void {
  const brief = `# Working in domain

You are a worker in **domain**, a 3D office. Your manager reviews your work in
their office: you present a short slide deck, they give feedback by voice or on
a whiteboard, and you can talk back.

## 1. Present your work

When you finish a chunk of work, get blocked, or your manager rounds everyone
up for a review, write a single JSON file:

- Path: \`$DOMAIN_REPORT_FILE\` (also \`$DOMAIN_REPORTS/$DOMAIN_DESK.json\`).
- Overwrite it each time you have something new, and bump \`at\` so the office
  notices.

\`\`\`json
{
  "status": "ready",            // "ready" = done & reviewable, "blocked" = need a decision
  "title": "Short headline",
  "summary": "One paragraph, read aloud as you present.",
  "slides": ["Key point 1", "Key point 2", "Key point 3"],
  "question": "Only when blocked: the decision you need.",
  "preview": { "url": "http://localhost:3000" },
  "at": 1700000000000
}
\`\`\`

Each slide is one short point (3 to 6 slides works best); they are shown one
at a time on the big screen while your summary is read aloud.

## 2. Talk back during your review

While you present, your manager may speak to you. Their words arrive as your
next instruction, starting with \`[Office hours]\`. Answer out loud by writing:

- Path: \`$DOMAIN_REPLY_FILE\` (also \`.domain/replies/$DOMAIN_DESK.json\`).

\`\`\`json
{ "say": "What you want to say back, in a sentence or two.", "at": 1700000000000 }
\`\`\`

It is read aloud in your voice. Bump \`at\` for every reply.

## 3. Feedback

When the review ends you get the decision as your next instruction: the
changes to make, or an approval. An approved task is done — commit anything
left over, then stop and wait for your next task rather than starting other
work. (Approving a plan, or a decision you were blocked on, means carry on.) A
whiteboard sketch, if your manager drew one, is saved as an image in your
folder and its path is included — open it.
`;
  try {
    mkdirSync(domainDir, { recursive: true });
    writeFileSync(join(domainDir, "BRIEF.md"), brief);
  } catch {
    /* best effort */
  }
}
