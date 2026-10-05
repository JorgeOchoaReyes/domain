import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lessonsMarkdown, type Lessons } from "./lessons.js";

/**
 * The end-of-day sync. Each worker writes up to three lessons from its own day;
 * then one of them (the lead) merges those, your feedback and what audits
 * found into the team's lessons — short, specific, no duplicates. Every step
 * has a time limit, and if the lead doesn't deliver, nothing's lost: the raw
 * notes are kept as lessons as they are.
 */

export interface SyncOffice {
  /** Workers who can take part (staffed, not asleep or quit). */
  staffed(): string[];
  workdir(deskId: string): string;
  instruct(deskId: string, text: string): void;
  nameOf(deskId: string): string;
}

export interface SyncDeps {
  office: SyncOffice;
  lessons: Lessons;
  /** A line for the history and a toast. */
  note(text: string): void;
  /** Simulated workers can't write files: merge straight away. */
  simulate?: boolean;
  /** Time limits (ms). */
  ownMs?: number;
  mergeMs?: number;
  pollMs?: number;
}

const readLessons = (file: string): string[] | null => {
  try {
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, "utf8")) as { lessons?: unknown };
    return Array.isArray(raw.lessons) ? raw.lessons.filter((x): x is string => typeof x === "string").slice(0, 25) : null;
  } catch {
    return null;
  }
};

export class EodSync {
  private running = false;

  constructor(private deps: SyncDeps) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** Run it. Resolves when it's done (or timed out); false if one is already running or there's nobody. */
  async run(): Promise<boolean> {
    if (this.running) return false;
    const { office, lessons } = this.deps;
    const desks = office.staffed();
    const started = Date.now();
    if (!desks.length || this.deps.simulate) {
      lessons.keepRaw(started);
      this.deps.note(`🌙 End-of-day sync: ${lessons.snapshot.lessons.length} team lessons`);
      return true;
    }
    this.running = true;
    try {
      // 1. Everyone: up to three lessons from their own day.
      const own = new Map<string, string>();
      for (const d of desks) {
        const dir = join(office.workdir(d), ".domain", "sync");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${d}.json`);
        rmSync(file, { force: true });
        own.set(d, file);
        office.instruct(
          d,
          `[EOD sync] It's the end of the day. Look back on your own work today — mistakes, what your manager or an auditor sent back, what worked — and write up to three short, specific lessons for the whole team as JSON {"lessons": ["…"]} to ${file}. Then carry on (or rest if you're done).`,
        );
      }
      this.deps.note(`🌙 End-of-day sync: ${desks.length} worker${desks.length === 1 ? "" : "s"} writing up their day`);
      const gathered = new Map<string, string[]>();
      await this.until(() => {
        for (const [d, f] of own) if (!gathered.has(d)) {
          const l = readLessons(f);
          if (l) gathered.set(d, l);
        }
        return gathered.size === own.size;
      }, this.deps.ownMs ?? 6 * 60_000);
      for (const [d, l] of gathered) for (const text of l) lessons.note({ from: office.nameOf(d), text, kind: "worker" });

      // 2. The lead merges it all into the team's lessons.
      const lead = [...gathered.keys()][0] ?? desks[0];
      const dir = join(office.workdir(lead), ".domain", "sync");
      const today = join(dir, "today.md");
      const merged = join(dir, "merged.json");
      rmSync(merged, { force: true });
      writeFileSync(today, lessonsMarkdown(lessons.snapshot));
      office.instruct(
        lead,
        `[EOD sync] You're running today's sync. ${today} has the team's lessons so far, your manager's feedback, what audits found, and what each teammate learned today. Rewrite it all as the team's lessons: at most 25 short, specific, imperative lines; merge duplicates; drop anything stale or one-off. Write them as JSON {"lessons": ["…"]} to ${merged}.`,
      );
      let result: string[] | null = null;
      await this.until(() => !!(result = readLessons(merged)), this.deps.mergeMs ?? 8 * 60_000);
      if (result && (result as string[]).length) lessons.setLessons(result, Date.now());
      else lessons.keepRaw(Date.now());
      this.deps.note(`🌙 End-of-day sync done${result ? ` — ${office.nameOf(lead)} merged` : ""}: ${lessons.snapshot.lessons.length} team lessons`);
      return true;
    } finally {
      this.running = false;
    }
  }

  private async until(done: () => boolean, ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, this.deps.pollMs ?? 3000));
  }
}
