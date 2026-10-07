import { MAX_ATTACH, MAX_ATTACH_BYTES, type Attachment } from "../../shared/policy.js";
import { esc } from "./modal.js";

/**
 * 📎 Attach notes or files to a task: pick text files from your computer
 * (notes, specs, logs, sample data) and they go with the task — copied into
 * the agent's own folder, so it reads them without asking for access.
 * Text only; binary files and very big ones are left out (and it says so).
 */

export function attachHtml(cls = ""): string {
  return `<div class="attach ${cls}">
    <label class="btn small attach-pick" title="Notes, specs, logs or data from your computer — copied into the agent's folder for it to read">📎 Attach notes / files<input type="file" multiple hidden /></label>
    <span class="attach-list"></span>
  </div>`;
}

/** Wire an attach row; returns what's attached right now. */
export function wireAttach(root: HTMLElement): () => Attachment[] {
  const files: Attachment[] = [];
  const input = root.querySelector<HTMLInputElement>(".attach input[type=file]")!;
  const list = root.querySelector<HTMLElement>(".attach-list")!;
  const render = (note = "") => {
    list.innerHTML =
      files.map((f, i) => `<span class="attach-chip">📄 ${esc(f.name)} <button type="button" data-i="${i}" title="Remove">✕</button></span>`).join("") + (note ? `<span class="attach-note">${esc(note)}</span>` : "");
  };
  list.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
    if (!b) return;
    files.splice(Number(b.dataset.i), 1);
    render();
  });
  input.addEventListener("change", async () => {
    const skipped: string[] = [];
    for (const f of [...(input.files ?? [])]) {
      if (files.length >= MAX_ATTACH) {
        skipped.push(`${f.name} (${MAX_ATTACH} at most)`);
        continue;
      }
      if (f.size > MAX_ATTACH_BYTES) {
        skipped.push(`${f.name} (too big)`);
        continue;
      }
      const text = await f.text();
      if (text.includes("\u0000")) {
        skipped.push(`${f.name} (not text)`);
        continue;
      }
      files.push({ name: f.name, text });
    }
    input.value = "";
    render(skipped.length ? `Left out: ${skipped.join(", ")}` : "");
  });
  return () => [...files];
}
