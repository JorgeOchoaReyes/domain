/**
 * A worker that asks you something in plain words and stops — no permission
 * menu, no blocked report, just "Where's the covers app?" at its prompt —
 * looks free to the office. These read its screen for that question.
 */

/** Lines of a CLI's own furniture: its input box, spinners and timers, hints. */
const CHROME = /^([›>│╭╰╮╯─━┃|]|[✻✶✳✢·※*⏵⏸]\s|\? for shortcuts)|auto mode|shift\+tab|esc to interrupt|ctrl\+[a-z] to|for agents$|tokens?\b.*\bleft\b|^\s*\d+%\s+context/i;

/**
 * The question it's left you with, when its last words end in one: the
 * paragraph's sentence that asks, up to 300 characters. Null when its last
 * words aren't a question (it's done, or it's telling you something).
 */
export function askedQuestion(screen: readonly string[]): string | null {
  const lines = screen.map((l) => l.replace(/\s+/g, " ").trim());
  let end = lines.length - 1;
  // Back past the input box, the status lines and blanks, to what it last said.
  while (end >= 0 && (!lines[end] || CHROME.test(lines[end]))) end--;
  if (end < 0 || !lines[end].endsWith("?")) return null;
  // The paragraph it's in (a wrapped sentence spans lines), back to a blank line or a list item.
  let start = end;
  while (start > 0 && start > end - 4 && lines[start - 1] && !CHROME.test(lines[start - 1]) && !/^([-•*]|\d+[.)])\s/.test(lines[start])) start--;
  const para = lines.slice(start, end + 1).join(" ");
  // From the last sentence end before the question, if there's one.
  const cut = Math.max(para.lastIndexOf(". ", para.length - 2), para.lastIndexOf("! ", para.length - 2), para.lastIndexOf(": ", para.length - 2));
  const q = (cut > 0 ? para.slice(cut + 2) : para).replace(/^[●•⏺]\s*/, "").trim();
  if (q.length < 8) return null;
  return q.length <= 300 ? q : `…${q.slice(-299)}`;
}

/** Whether a worker needs your answer: a question on its screen, or one in words it left you. */
export function needsAnswer(w: { status: string; asking?: string } | null | undefined): boolean {
  return !!w && (w.status === "waiting" || !!w.asking);
}
