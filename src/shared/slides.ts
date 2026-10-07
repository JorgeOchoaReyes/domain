import type { Report } from "./protocol.js";

/**
 * A presentation's slides. A slide is a string: a one-liner (the old way, a
 * single point), or a real slide — a heading on its first line, then bullet
 * lines ("- …"), and optionally a short code block between ``` fences. Two
 * slides come from the office itself, not the worker: what changed (from
 * git, added as the work comes in) and the check's result.
 */

export interface Slide {
  heading: string;
  bullets: string[];
  code: string | null;
}

export const CHANGED_HEADING = "📁 What changed";

export function parseSlide(s: string): Slide {
  const lines = s.replace(/\r/g, "").split("\n");
  const code: string[] = [];
  const bullets: string[] = [];
  let heading = "";
  let inCode = false;
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (/^\s*```/.test(l)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(raw);
      continue;
    }
    const b = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(l);
    if (b) bullets.push(b[1].trim());
    else if (!heading && l.trim()) heading = l.trim().replace(/^#+\s*/, "");
    else if (l.trim()) bullets.push(l.trim());
  }
  // A one-liner is a single point with no heading of its own.
  if (!bullets.length && !code.length) return { heading: "", bullets: heading ? [heading] : [], code: null };
  return { heading, bullets, code: code.length ? code.join("\n").replace(/\s+$/, "") : null };
}

/** What's said aloud for a slide: its heading and points, not its code. */
export function slideSpeech(s: string): string {
  const p = parseSlide(s);
  return [p.heading, ...p.bullets].filter(Boolean).join(". ").replace(/[`*_]/g, "");
}

/**
 * The slides to show for a report: the worker's, and the check's result after
 * them. One-liners in a row become one "Key points" slide with them all as
 * bullets — a slide per sentence is a deck nobody wants to sit through.
 */
export function deckOf(r: Report): string[] {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length === 1) out.push(run[0]);
    else if (run.length) out.push(`Key points\n${run.map((x) => `- ${x}`).join("\n")}`);
    run = [];
  };
  for (const s of r.slides) {
    const p = parseSlide(s);
    if (!p.heading && p.bullets.length === 1 && !p.code) run.push(p.bullets[0]);
    else {
      flush();
      out.push(s);
    }
  }
  flush();
  const c = r.check;
  if (c && c.status !== "running") {
    const tail = c.tail.trim().split("\n").slice(-8).join("\n");
    out.push(
      `${c.status === "pass" ? "✅ Checks pass" : "❌ Checks fail"}\n- \`${c.command}\` ${c.status === "pass" ? "passed" : `exited ${c.exitCode ?? "?"}`} in ${(c.ms / 1000).toFixed(1)} s${tail ? `\n\`\`\`\n${tail}\n\`\`\`` : ""}`,
    );
  }
  return out;
}

/** The "What changed" slide from git's numbers: the biggest changes first. */
export function changedSlide(files: { file: string; added: number; removed: number }[]): string | null {
  if (!files.length) return null;
  const sorted = [...files].sort((a, b) => b.added + b.removed - (a.added + a.removed));
  const add = files.reduce((n, f) => n + f.added, 0);
  const del = files.reduce((n, f) => n + f.removed, 0);
  const lines = sorted.slice(0, 7).map((f) => `- ${f.file}  +${f.added} −${f.removed}`);
  if (sorted.length > 7) lines.push(`- …and ${sorted.length - 7} more`);
  return `${CHANGED_HEADING}: ${files.length} file${files.length === 1 ? "" : "s"}, +${add} −${del}\n${lines.join("\n")}`;
}
