import { watch, type FSWatcher } from "node:fs";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { coerceReport, type Report } from "../shared/protocol.js";

/**
 * Watches `<cwd>/.domain/reports/` for report files an agent drops when it
 * reaches a checkpoint. Each file is named `<deskId>.json`. When one appears
 * or changes, it is parsed and handed to the callback with its desk id.
 *
 * Uses fs.watch with a short polling backstop, since fs.watch misses events on
 * some platforms/filesystems. Reads are debounced per desk so a half-written
 * file is not parsed mid-write.
 */
export class ReportWatcher {
  readonly dir: string;
  private watcher: FSWatcher | null = null;
  private poll: NodeJS.Timeout | null = null;
  private debounce = new Map<string, NodeJS.Timeout>();
  private seen = new Map<string, number>(); // deskId -> last report `at`
  private onReport: (deskId: string, report: Report) => void;

  constructor(cwd: string, onReport: (deskId: string, report: Report) => void) {
    this.dir = join(cwd, ".domain", "reports");
    this.onReport = onReport;
  }

  start(): void {
    mkdirSync(this.dir, { recursive: true });
    this.writeBrief();

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

  /** Forget a desk's last-seen report (called when a worker is sent home). */
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
    const report = coerceReport(parsed);
    if (!report) return;
    // Only fire when the report is new (its `at` advanced).
    const last = this.seen.get(deskId);
    if (last !== undefined && report.at <= last) return;
    this.seen.set(deskId, report.at);
    this.onReport(deskId, report);
  }

  private writeBrief(): void {
    const briefPath = join(this.dir, "..", "BRIEF.md");
    if (existsSync(briefPath)) return;
    const brief = `# How to report in domain

You are a worker in **domain**, a 3D office. When you finish a chunk of work, or
you get blocked and need a decision, present it to your manager by writing a
single JSON file:

- Path: the value of \`$DOMAIN_REPORT_FILE\` (also \`$DOMAIN_REPORTS/$DOMAIN_DESK.json\`).
- Overwrite it each time you have something new to present. Bump \`at\` so the
  office notices it is a new report.

Schema:

\`\`\`json
{
  "status": "ready",            // "ready" = done & reviewable, "blocked" = need a decision
  "title": "Short headline",
  "summary": "One paragraph, read aloud at the presentation.",
  "slides": ["Key point 1", "Key point 2", "Key point 3"],
  "question": "Only when blocked: the decision you need.",
  "preview": { "url": "http://localhost:3000" },
  "at": 1700000000000
}
\`\`\`

After you write the file, keep your session open: your manager will send back
feedback (approval to continue, or changes to make) as your next instruction.
`;
    try {
      writeFileSync(briefPath, brief);
    } catch {
      /* best effort */
    }
  }
}
