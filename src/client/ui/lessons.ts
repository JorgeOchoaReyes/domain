import type { LessonsState } from "../../shared/lessons.js";
import type { ClientMessage, ServerMessage } from "../../shared/protocol.js";
import { micButton, wireMic } from "../voice.js";
import { esc, openModal } from "./modal.js";

/**
 * The team's lessons: what they've learned from your feedback and from each
 * other's mistakes (every worker reads them before a task), what's come in
 * since the last end-of-day sync, and the sync itself.
 */

let state: LessonsState = { lessons: [], notes: [], syncedAt: null };
let syncing = false;
let rerender: (() => void) | null = null;

export function ingestLessons(msg: ServerMessage): void {
  if (msg.t !== "lessons") return;
  state = msg.state;
  syncing = msg.syncing;
  rerender?.();
}

/** `canEdit`: teach and forget (not for visitors, who only look). */
export function openLessons(send: (m: ClientMessage) => void, canEdit = true): void {
  send({ t: "lessonsGet" });
  const body = document.createElement("div");
  body.className = "lessons";
  let draft = "";
  const render = () => {
    const typing = document.activeElement === body.querySelector(".ls-teach input");
    const since = state.syncedAt ? `Last synced ${new Date(state.syncedAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "Not synced yet";
    body.innerHTML = `
      <p class="ls-intro">Every worker reads these before it starts a task. Whatever you tell them is learned from — work you send back, and anything you say in chat or at a desk that's a rule (“from now on…”), a correction (“that's wrong”) or praise (“perfect”) lands here the moment you say it; the <b>end-of-day sync</b> has each worker add what it learned, and one of them merges it all into a short list.</p>
      ${canEdit ? `<form class="ls-teach"><input type="text" maxlength="240" placeholder="Teach the team something — e.g. “Always run the tests before presenting”" />${micButton()}<button class="btn primary" type="submit">📚 Teach</button></form>` : ""}
      <section><h4>📚 The team's lessons <span class="as-hint">${esc(since)}</span></h4>
        ${state.lessons.length ? `<ol class="ls-list">${state.lessons.map((l) => `<li>${esc(l)} <button class="ls-x" data-lesson="${esc(l)}" title="Forget this lesson">✕</button></li>`).join("")}</ol>` : `<p class="ls-none">None yet.</p>`}
      </section>
      <section><h4>📝 Since then <span class="as-hint">${state.notes.length} note${state.notes.length === 1 ? "" : "s"} — already in their LESSONS.md</span></h4>
        ${
          state.notes.length
            ? `<ul class="ls-notes">${[...state.notes]
                .reverse()
                .slice(0, 40)
                .map((n) => `<li><b>${n.kind === "feedback" ? (n.from === "you" ? "💬 You" : "💬 " + esc(n.from)) : n.kind === "audit" ? "🔍 " + esc(n.from) : "🤖 " + esc(n.from)}</b>${n.about ? ` on “${esc(n.about)}”` : ""}: ${esc(n.text)} <button class="ls-x" data-note="${n.at}" title="Not a lesson — drop it">✕</button></li>`)
                .join("")}</ul>`
            : `<p class="ls-none">Nothing new.</p>`
        }
      </section>`;
    if (!canEdit) body.querySelectorAll(".ls-x").forEach((b) => b.remove());
    const form = body.querySelector<HTMLFormElement>(".ls-teach");
    const field = form?.querySelector<HTMLInputElement>("input");
    if (form && field) {
    field.value = draft;
    if (typing) field.focus();
    field.addEventListener("input", () => (draft = field.value));
    wireMic(form.querySelector<HTMLButtonElement>(".mic"), field);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = field.value.trim();
      if (text.length < 4) return;
      send({ t: "lessonTeach", text });
      draft = "";
      field.value = "";
    });
    }
    body.querySelectorAll<HTMLButtonElement>(".ls-x").forEach((b) =>
      b.addEventListener("click", () => send(b.dataset.note ? { t: "lessonForget", noteAt: Number(b.dataset.note) } : { t: "lessonForget", lesson: b.dataset.lesson ?? "" })),
    );
    const go = modal.footer?.querySelector<HTMLButtonElement>(".ls-sync");
    if (go) {
      go.disabled = syncing;
      go.textContent = syncing ? "🌙 Syncing…" : "🌙 Run the end-of-day sync";
    }
  };
  const footer = `<span class="grow">Lessons are in .domain/LESSONS.md (and each worker's folder).</span><button class="btn primary ls-sync">🌙 Run the end-of-day sync</button>`;
  const modal = openModal({ title: "Lessons", icon: "📚", className: "lessons-modal", body, footer, onClose: () => (rerender = null) });
  modal.footer?.querySelector(".ls-sync")?.addEventListener("click", () => {
    send({ t: "eodSync" });
    syncing = true;
    render();
  });
  rerender = render;
  render();
}
