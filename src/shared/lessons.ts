/** What the team has learned (see server/lessons.ts). */
export interface LessonNote {
  at: number;
  /** "you", or a worker's name. */
  from: string;
  text: string;
  /** What it was about (a task's title), if anything. */
  about?: string;
  kind: "feedback" | "audit" | "worker";
}

export interface LessonsState {
  /** The distilled lessons: short, imperative, one per line. */
  lessons: string[];
  /** Not yet distilled: today's feedback, findings and workers' notes. */
  notes: LessonNote[];
  /** When the last end-of-day sync finished. */
  syncedAt: number | null;
}
