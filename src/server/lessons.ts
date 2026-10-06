import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LessonNote, LessonsState } from "../shared/lessons.js";

/**
 * What the team has learned. Your feedback (work sent back with notes) and
 * what audits found go in as they happen; every worker reads them in
 * .domain/LESSONS.md (in its own folder too), so they learn from it straight
 * away. At the end of the day a sync distills it all — each worker's own
 * lessons from its day, plus yours — into a short list of the team's lessons.
 */

export type { LessonNote, LessonsState };

export const MAX_LESSONS = 25;
const MAX_NOTES = 120;

/** "From now on…", "never…", "make sure…": a standing rule. */
const RULE = /\b(always|never|from now on|going forward|in the future|next time|every time|each time|make sure|remember to|don'?t ever|please don'?t|do not|don'?t (use|add|do|make|change|touch|put|write|create|leave|forget|ship|push|commit)|stop \w+ing|avoid|prefer|instead|i (want|like|prefer|need|expect)|we (should|need to|want)|you (should|need to|must|have to)|should (always|never|be|have|use))\b/i;
/** "That's wrong", "it's broken", "this needs to change": something to fix. */
const FIX = /\b(wrong|broken|bug(gy)?|doesn'?t work|does not work|not working|isn'?t working|didn'?t work|fail(s|ed|ing)?|incorrect|bad|ugly|messy|a mess|not what i|that'?s not|this isn'?t|why did you|you forgot|forgot|missing|needs? (to )?(change|fix|be|work)|change (this|that|it)|fix (this|that|it)|redo|undo|revert|too (slow|big|small|long|much|many|short)|confus(ing|ed)|weird|not right)\b/i;
/** "Perfect", "love it": what to keep doing. */
const PRAISE = /\b(great|perfect|love (it|this|that)|nice (work|job)|well done|good (job|work|call)|exactly|awesome|excellent|keep (doing|it up)|that'?s (it|right|better))\b/i;

/**
 * Whether something you said is worth learning from: a rule ("from now on…"),
 * a correction ("that's wrong", "this needs to change") or praise ("perfect").
 * A plain question or a hello is not. Rules win over fixes over praise.
 */
export function feedbackKind(text: string): "rule" | "fix" | "praise" | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 8 || t.split(" ").length < 2) return null;
  if (RULE.test(t)) return "rule";
  if (FIX.test(t)) return "fix";
  if (PRAISE.test(t)) return "praise";
  return null;
}

export function lessonsMarkdown(s: LessonsState): string {
  const lines = [
    "# Team lessons",
    "",
    "What this team has learned — from your manager's feedback and from each other's mistakes. Read it before you start a task, and follow it.",
    "",
    ...(s.lessons.length ? s.lessons.map((l) => `- ${l}`) : ["- (Nothing yet — lessons appear here as your manager gives feedback.)"]),
  ];
  if (s.notes.length) {
    lines.push("", "## Recent feedback (not yet distilled — it still applies)", "");
    for (const n of s.notes.slice(-30)) lines.push(`- ${n.from === "you" ? "Your manager" : n.from}${n.about ? ` on “${n.about}”` : ""}: ${n.text}`);
  }
  return lines.join("\n") + "\n";
}

export class Lessons {
  private state: LessonsState = { lessons: [], notes: [], syncedAt: null };
  onChange: ((s: LessonsState) => void) | null = null;

  constructor(
    private file: string | null,
    /** Where LESSONS.md goes: the project's .domain and each worker's own. */
    private targets: () => string[],
  ) {
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<LessonsState>;
        this.state = {
          lessons: Array.isArray(raw.lessons) ? raw.lessons.filter((x): x is string => typeof x === "string").slice(0, MAX_LESSONS) : [],
          notes: Array.isArray(raw.notes) ? raw.notes.filter((n) => n && typeof n.text === "string").slice(-MAX_NOTES) : [],
          syncedAt: typeof raw.syncedAt === "number" ? raw.syncedAt : null,
        };
      } catch {
        /* a broken file: start over */
      }
    }
  }

  get snapshot(): LessonsState {
    return { lessons: [...this.state.lessons], notes: [...this.state.notes], syncedAt: this.state.syncedAt };
  }

  /** Something to learn from, as it happens. */
  note(n: Omit<LessonNote, "at">): void {
    const text = n.text.replace(/\s+/g, " ").trim().slice(0, 400);
    if (text.length < 4) return;
    this.state.notes.push({ ...n, text, at: Date.now() });
    this.state.notes = this.state.notes.slice(-MAX_NOTES);
    this.save();
  }

  /**
   * Something you said to a worker or the team (chat, office hours): kept as
   * feedback when it's a rule, a correction or praise, so every worker learns
   * from it — not just the one you said it to. Saying the same thing to
   * everyone at once counts once. Returns whether it was kept.
   */
  heard(text: string, about?: string): boolean {
    const kind = feedbackKind(text);
    if (!kind) return false;
    const said = text.replace(/\s+/g, " ").trim();
    const recent = this.state.notes.slice(-10).some((n) => n.from === "you" && Date.now() - n.at < 120_000 && n.text.endsWith(said.slice(0, 400)));
    if (recent) return false;
    this.note({ from: "you", text: kind === "praise" ? `Keep doing this — ${said}` : said, about, kind: "feedback" });
    return true;
  }

  /** A lesson you teach the team yourself: straight into the list, no sync needed. */
  teach(text: string): void {
    const line = text.replace(/\s+/g, " ").trim().slice(0, 240);
    if (line.length < 4) return;
    this.state.lessons = [...this.state.lessons.filter((l) => l !== line), line].slice(-MAX_LESSONS);
    this.save();
  }

  /** Take back a lesson (by its line) or a note (by when it came in). */
  forget(what: { lesson?: string; noteAt?: number }): void {
    if (what.lesson !== undefined) this.state.lessons = this.state.lessons.filter((l) => l !== what.lesson);
    if (what.noteAt !== undefined) this.state.notes = this.state.notes.filter((n) => n.at !== what.noteAt);
    this.save();
  }

  /** The sync's result: the team's lessons now (the notes it covered are done). */
  setLessons(lines: string[], coveredUntil = Date.now()): void {
    const clean = [...new Set(lines.map((l) => l.replace(/^[-*\d.\s]+/, "").replace(/\s+/g, " ").trim()).filter((l) => l.length >= 4))];
    this.state.lessons = clean.map((l) => l.slice(0, 240)).slice(0, MAX_LESSONS);
    this.state.notes = this.state.notes.filter((n) => n.at > coveredUntil);
    this.state.syncedAt = Date.now();
    this.save();
  }

  /** No sync result: keep everything (raw notes become lessons as they are). */
  keepRaw(coveredUntil = Date.now()): void {
    const raw = this.state.notes.filter((n) => n.at <= coveredUntil).map((n) => n.text);
    this.setLessons([...this.state.lessons, ...raw], coveredUntil);
  }

  /** LESSONS.md everywhere a worker might look. */
  write(): void {
    const md = lessonsMarkdown(this.state);
    for (const dir of this.targets()) {
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "LESSONS.md"), md);
      } catch {
        /* best effort */
      }
    }
  }

  private save(): void {
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(this.file, JSON.stringify(this.state, null, 2));
      } catch {
        /* best effort */
      }
    }
    this.write();
    this.onChange?.(this.snapshot);
  }
}
