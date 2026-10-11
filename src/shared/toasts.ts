/**
 * Quieter toasts: what pops up over the office, and for how long. Every toast
 * has a level — routine news ("note") never pops up, it goes to the inbox's
 * Recent list; the same thing said twice in a few seconds becomes one toast
 * with a ×2; and a burst of everyday toasts is capped (the rest go to Recent),
 * while warnings and errors always get through. Pure, so it's tested on its own.
 */

/**
 * note: routine news — logged, never shown · info: an everyday heads-up, or
 * feedback on what you just did · warn: something needs a look · error:
 * something failed · win: a celebration (achievements, shipping).
 */
export type ToastLevel = "note" | "info" | "warn" | "error" | "win";

export interface ToastDecision {
  /** show: a new toast · merge: bump the one already showing · log: Recent only. */
  action: "show" | "merge" | "log";
  /** What makes two toasts "the same" (see toastKey). */
  key: string;
  /** How many times it's been said while showing (for the ×N). */
  count: number;
  /** How long it stays, in ms. */
  ms: number;
}

export interface ToastGateOptions {
  /** Same text within this long: merged into the toast already up. */
  dedupeMs: number;
  /** At most this many everyday (info) toasts… */
  burst: number;
  /** …within this long; more go to Recent. */
  burstMs: number;
}

export const TOAST_DEFAULTS: ToastGateOptions = { dedupeMs: 8000, burst: 3, burstMs: 10_000 };

/** Two toasts are the same if they only differ in numbers, spacing or case. */
export function toastKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d+(?:[.,:]\d+)*/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

/** How long a toast stays: short by default, longer for warnings and long reads. */
export function toastMs(level: ToastLevel, text: string): number {
  const base = level === "error" ? 6000 : level === "warn" ? 4500 : level === "win" ? 5000 : 2800;
  // About a second more per 15 words beyond the first 10, up to 3 s more.
  const words = text.trim().split(/\s+/).length;
  return base + Math.min(3000, Math.max(0, Math.round(((words - 10) / 15) * 1000)));
}

/**
 * Decides, toast by toast, whether it shows. Keeps the last time each key was
 * shown and the recent everyday toasts; call `decide` with the time.
 */
export class ToastGate {
  private shown = new Map<string, { at: number; until: number; count: number }>();
  private recent: number[] = [];

  constructor(private opts: ToastGateOptions = TOAST_DEFAULTS) {}

  decide(text: string, level: ToastLevel, now: number): ToastDecision {
    const key = toastKey(text);
    const ms = toastMs(level, text);
    if (level === "note") return { action: "log", key, count: 1, ms: 0 };
    const prev = this.shown.get(key);
    if (prev && now - prev.at < this.opts.dedupeMs && now < prev.until) {
      prev.count++;
      prev.at = now;
      prev.until = now + ms;
      return { action: "merge", key, count: prev.count, ms };
    }
    if (level === "info") {
      this.recent = this.recent.filter((t) => now - t < this.opts.burstMs);
      if (this.recent.length >= this.opts.burst) return { action: "log", key, count: 1, ms: 0 };
      this.recent.push(now);
    }
    this.shown.set(key, { at: now, until: now + ms, count: 1 });
    // Forget the old ones now and then.
    if (this.shown.size > 200) for (const [k, v] of this.shown) if (now > v.until + this.opts.dedupeMs) this.shown.delete(k);
    return { action: "show", key, count: 1, ms };
  }
}
