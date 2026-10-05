import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_HISTORY, type HistoryEvent } from "../shared/history.js";

/**
 * The office's history, newest first, kept in .domain/history.json. Every
 * new event is handed to `onEvent` (to send to whoever's here).
 */
export class HistoryLog {
  private events: HistoryEvent[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  onEvent: ((e: HistoryEvent) => void) | null = null;

  constructor(private file: string | null) {
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (Array.isArray(raw)) this.events = (raw as HistoryEvent[]).filter((e) => e && typeof e.at === "number" && typeof e.text === "string").slice(0, MAX_HISTORY);
    } catch {
      /* none yet */
    }
  }

  add(e: Omit<HistoryEvent, "at"> & { at?: number }): HistoryEvent {
    const event: HistoryEvent = { ...e, at: e.at ?? Date.now() };
    this.events.unshift(event);
    if (this.events.length > MAX_HISTORY) this.events.length = MAX_HISTORY;
    this.onEvent?.(event);
    this.save();
    return event;
  }

  /** The latest events (newest first). */
  latest(n = 400): HistoryEvent[] {
    return this.events.slice(0, n);
  }

  /** Everything about one worker (by character, or by desk), newest first. */
  of(worker: { characterId?: string; deskId: string }, n = 60): HistoryEvent[] {
    return this.events
      .filter((e) => e.worker && (worker.characterId ? e.worker.characterId === worker.characterId : e.worker.deskId === worker.deskId))
      .slice(0, n);
  }

  private save(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        mkdirSync(dirname(this.file!), { recursive: true });
        writeFileSync(this.file!, JSON.stringify(this.events));
      } catch {
        /* best effort */
      }
    }, 500);
    this.saveTimer.unref?.();
  }
}
