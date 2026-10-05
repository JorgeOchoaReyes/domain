import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Alumnus } from "../shared/alumni.js";

/**
 * Former workers: everyone you let go, kept (on this machine) so you can bring
 * them back — the same agent, model, permissions and character — and with the
 * reason you gave, which the team learns from too.
 */
export const MAX_ALUMNI = 60;

export class Alumni {
  private list: Alumnus[] = [];
  onChange: ((list: Alumnus[]) => void) | null = null;

  constructor(private file: string | null) {
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
        if (Array.isArray(raw)) this.list = raw.filter((a) => a && typeof a.id === "string" && typeof a.agent === "string").slice(0, MAX_ALUMNI);
      } catch {
        /* start over */
      }
    }
  }

  get all(): Alumnus[] {
    return [...this.list];
  }

  get(id: string): Alumnus | undefined {
    return this.list.find((a) => a.id === id);
  }

  add(a: Omit<Alumnus, "id" | "at">): Alumnus {
    const entry: Alumnus = { ...a, id: Math.random().toString(36).slice(2, 10), at: Date.now() };
    this.list = [entry, ...this.list].slice(0, MAX_ALUMNI);
    this.save();
    return entry;
  }

  /** Back at a desk: off the list. */
  remove(id: string): void {
    this.list = this.list.filter((a) => a.id !== id);
    this.save();
  }

  private save(): void {
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(this.file, JSON.stringify(this.list, null, 2));
      } catch {
        /* best effort */
      }
    }
    this.onChange?.(this.all);
  }
}
