import type { Terminal } from "@xterm/xterm";

/**
 * Terminals copy the moment you select: drag over some text and it's on your
 * clipboard (a little "Copied" says so). And "copy all" for the whole thing.
 */

let note: HTMLElement | null = null;
let noteTimer = 0;

function flash(text: string): void {
  note ??= Object.assign(document.createElement("div"), { className: "term-copied" });
  if (!note.isConnected) document.body.appendChild(note);
  note.textContent = text;
  note.classList.add("show");
  clearTimeout(noteTimer);
  noteTimer = window.setTimeout(() => note?.classList.remove("show"), 1200);
}

export function copyOnSelect(term: Terminal): void {
  let pending = 0;
  term.onSelectionChange(() => {
    clearTimeout(pending);
    // Wait for the drag to settle, then copy what's selected.
    pending = window.setTimeout(() => {
      const text = term.getSelection();
      if (!text.trim()) return;
      void navigator.clipboard.writeText(text).then(
        () => flash(`📋 Copied ${text.length > 60 ? `${text.split("\n").length} line${text.includes("\n") ? "s" : ""}` : `“${text.trim().slice(0, 40)}”`}`),
        () => {},
      );
    }, 250);
  });
}

/** Everything in a terminal (its scrollback too), as text. */
export function allText(term: Terminal): string {
  const b = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? "");
  return lines.join("\n").replace(/\n+$/, "\n");
}

export function copyAll(term: Terminal): void {
  void navigator.clipboard.writeText(term.getSelection() || allText(term)).then(
    () => flash("📋 Copied the terminal"),
    () => flash("Couldn't copy"),
  );
}
