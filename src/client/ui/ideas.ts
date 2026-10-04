import type { ClientMessage, Desk } from "../../shared/protocol.js";
import type { Idea } from "../../shared/ideas.js";
import type { GoalKind } from "../../shared/progress.js";
import { AGENT_LABELS } from "../../shared/protocol.js";
import { Dictation, sttSupported } from "../voice.js";
import { esc, openModal, type Modal } from "./modal.js";
import { Sketchpad, sketchTools } from "./sketchpad.js";
import "../styles/ideas.css";

/**
 * The idea board: walk up to a whiteboard, sketch and write an idea, then pin
 * it, hand it to a worker (it becomes a task, briefed with your notes and the
 * sketch) or turn it into a goal. Everything pinned is listed underneath and
 * shows on the whiteboards in the office.
 */

export interface IdeaActions {
  send(msg: ClientMessage): void;
  /** The desks, to hand ideas to the staffed ones. */
  desks(): Desk[];
  /** A goal's title, to say where an idea went. */
  goalTitle(id: string): string | null;
  /** Visitors look but don't pin. */
  canEdit(): boolean;
  /** The sketch changed (to mirror it onto the whiteboard in the room). */
  onSketch?(c: HTMLCanvasElement | null): void;
  onVoiceError?(error: string): void;
}

export class IdeaBoard {
  private modal: Modal | null = null;
  private pad: Sketchpad | null = null;
  private dictation: Dictation | null = null;
  private ideas: Idea[] = [];
  /** The idea being edited (null: a new one). */
  private editing: Idea | null = null;
  private kind: GoalKind = "build";
  private el = {} as { title: HTMLInputElement; notes: HTMLTextAreaElement; list: HTMLElement; who: HTMLSelectElement; mic: HTMLButtonElement; count: HTMLElement; error: HTMLElement };

  constructor(private actions: IdeaActions) {}

  get isOpen(): boolean {
    return this.modal !== null;
  }

  open(ideas: Idea[], edit: Idea | null = null): void {
    this.ideas = ideas;
    this.editing = edit;
    this.kind = edit?.kind ?? "build";
    const can = this.actions.canEdit();
    const body = document.createElement("div");
    body.className = "ideas";
    body.innerHTML = `
      <section class="idea-draw">
        <div class="wb">
          <div class="wb-head"><h3>✏️ Sketch it</h3><div class="wb-tools">${sketchTools()}</div></div>
          <canvas class="wb-canvas" width="960" height="560"></canvas>
        </div>
      </section>
      <section class="idea-words">
        <label>What's the idea?<input type="text" class="idea-title" maxlength="100" placeholder="e.g. Dark mode for the dashboard" /></label>
        <label>Notes <span class="opt">— why, what good looks like; lines starting with “-” become tasks</span>
          <div class="notes-row">
            <textarea class="idea-notes" rows="5" maxlength="2000" placeholder="- a toggle in settings&#10;- remember the choice&#10;- match the brand colors"></textarea>
            ${sttSupported() ? `<button class="btn mic idea-mic" title="Dictate">🎤</button>` : ""}
          </div>
        </label>
        <div class="seg idea-kind" role="group" aria-label="Kind">
          <button data-k="build" class="${this.kind === "build" ? "on" : ""}">🛠 Build it</button>
          <button data-k="research" class="${this.kind === "research" ? "on" : ""}">🔎 Research it</button>
        </div>
        <div class="idea-go">
          <button class="btn idea-pin">📌 Pin to the board</button>
          <div class="idea-hand">
            <select class="idea-who" aria-label="Worker"></select>
            <button class="btn good idea-handoff">🤝 Hand it over</button>
          </div>
          <button class="btn idea-goal">🎯 Make it a goal</button>
        </div>
        <p class="idea-error" role="alert"></p>
        <p class="idea-help">Handing it over adds a task to the goal in focus and briefs the worker with your notes and sketch.</p>
      </section>
      <section class="idea-pinned">
        <h4>📌 On the board <span class="idea-count"></span></h4>
        <ul class="idea-list"></ul>
      </section>`;
    if (!can) body.classList.add("read-only");

    this.modal = openModal({
      title: edit ? `Idea board · ${edit.title}` : "Idea board",
      icon: "💡",
      className: "ideas-modal",
      body,
      onClose: () => this.closed(),
    });

    const q = <T extends Element>(s: string) => body.querySelector<T>(s)!;
    this.el = {
      title: q(".idea-title"),
      notes: q(".idea-notes"),
      list: q(".idea-list"),
      who: q(".idea-who"),
      mic: q(".idea-mic"),
      count: q(".idea-count"),
      error: q(".idea-error"),
    };
    this.pad = new Sketchpad(q(".wb-canvas"), q(".wb-tools"), (c) => this.actions.onSketch?.(c));
    if (edit) {
      this.el.title.value = edit.title;
      this.el.notes.value = edit.text;
      if (edit.thumb) this.pad.load(edit.thumb);
      this.pad.dirty = false;
    }
    for (const input of [this.el.title, this.el.notes]) {
      input.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key !== "Escape") e.stopPropagation();
      });
    }
    body.querySelectorAll<HTMLButtonElement>(".idea-kind button").forEach((b) =>
      b.addEventListener("click", () => {
        this.kind = b.dataset.k === "research" ? "research" : "build";
        body.querySelectorAll(".idea-kind button").forEach((x) => x.classList.toggle("on", x === b));
      }),
    );
    if (this.el.mic) {
      this.dictation = new Dictation(
        (text) => (this.el.notes.value = text),
        () => this.el.mic.classList.remove("live"),
        (err) => this.actions.onVoiceError?.(err),
      );
      this.el.mic.addEventListener("click", () => {
        if (this.dictation!.isActive) return this.dictation!.stop();
        this.el.mic.classList.add("live");
        this.dictation!.start(this.el.notes.value);
      });
    }
    q(".idea-pin").addEventListener("click", () => this.save());
    q(".idea-goal").addEventListener("click", () => this.save({ goal: true }));
    q(".idea-handoff").addEventListener("click", () => {
      const deskId = this.el.who.value;
      if (!deskId) return this.fail("Pick a worker to hand it to");
      this.save({ handoff: deskId });
    });
    this.el.list.addEventListener("click", (e) => this.onListClick(e));
    this.fillWorkers();
    this.renderList();
    if (can) setTimeout(() => this.el.title.focus(), 50);
  }

  /** New ideas from the server (someone pinned or handed one off). */
  update(ideas: Idea[]): void {
    this.ideas = ideas;
    if (!this.modal) return;
    this.renderList();
  }

  /** Workers came or went. */
  refreshWorkers(): void {
    if (this.modal) this.fillWorkers();
  }

  close(): void {
    this.modal?.close();
  }

  private save(then?: { handoff?: string; goal?: boolean }): void {
    const title = this.el.title.value.trim();
    const text = this.el.notes.value.trim();
    const pad = this.pad!;
    if (!title && !text && !pad.ink) return this.fail("Write or sketch something first");
    const changed = !this.editing || pad.dirty;
    const msg: ClientMessage = {
      t: "ideaSave",
      idea: { id: this.editing?.id, title, text, kind: this.kind, thumb: changed ? pad.thumb() : (this.editing?.thumb ?? null) },
      ...(changed && pad.ink ? { sketch: pad.png()! } : {}),
      ...(then ? { then } : {}),
    };
    this.actions.send(msg);
    this.close();
  }

  private fail(text: string): void {
    this.el.error.textContent = text;
  }

  private fillWorkers(): void {
    const staffed = this.actions.desks().filter((d) => d.worker);
    const sel = this.el.who;
    const keep = sel.value;
    sel.innerHTML = staffed.length
      ? `<option value="">Hand it to…</option>${staffed
          .map((d) => {
            const w = d.worker!;
            const name = w.identity ? `${w.identity.name} (${AGENT_LABELS[w.agent]})` : AGENT_LABELS[w.agent];
            return `<option value="${esc(d.id)}">${esc(name)} · ${esc(d.label)}${w.status === "idle" ? " · free" : ""}</option>`;
          })
          .join("")}`
      : `<option value="">No workers yet — hire one at a desk</option>`;
    sel.disabled = !staffed.length;
    if (staffed.some((d) => d.id === keep)) sel.value = keep;
  }

  private renderList(): void {
    const can = this.actions.canEdit();
    this.el.count.textContent = this.ideas.length ? `(${this.ideas.length})` : "";
    if (!this.ideas.length) {
      this.el.list.innerHTML = `<li class="idea-empty">Nothing pinned yet. Sketch something above and pin it, or hand it straight to a worker.</li>`;
      return;
    }
    this.el.list.innerHTML = this.ideas
      .map((i) => {
        const where =
          i.status === "handed"
            ? `🤝 With ${esc(i.handedTo?.name ?? "a worker")}`
            : i.status === "goal"
              ? `🎯 Goal${i.goalId && this.actions.goalTitle(i.goalId) ? `: ${esc(this.actions.goalTitle(i.goalId)!)}` : ""}`
              : "📌 On the board";
        return `<li class="idea-card ${i.status}" data-id="${esc(i.id)}">
          ${i.thumb ? `<img src="${i.thumb}" alt="" />` : `<div class="idea-nothumb">💡</div>`}
          <div class="idea-main">
            <b>${esc(i.title)}</b>
            ${i.text && i.text !== i.title ? `<small>${esc(i.text.split("\n")[0].slice(0, 90))}</small>` : ""}
            <span class="idea-chip">${where} · ${i.kind === "research" ? "🔎" : "🛠"} · ${esc(i.by)}</span>
          </div>
          ${can ? `<div class="idea-acts">
            <button class="btn small" data-a="edit" title="Open it on the board">✏️</button>
            ${i.status === "open" ? `<button class="btn small" data-a="goal" title="Make it a goal">🎯</button>` : ""}
            <button class="btn small" data-a="delete" title="Take it down">🗑</button>
          </div>` : ""}
        </li>`;
      })
      .join("");
  }

  private onListClick(e: Event): void {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-a]");
    const id = b?.closest<HTMLElement>("[data-id]")?.dataset.id;
    const idea = id ? this.ideas.find((i) => i.id === id) : undefined;
    if (!b || !idea) return;
    if (b.dataset.a === "edit") {
      const ideas = this.ideas;
      this.close();
      this.open(ideas, idea);
    } else if (b.dataset.a === "goal") this.actions.send({ t: "ideaToGoal", id: idea.id });
    else if (b.dataset.a === "delete") this.actions.send({ t: "ideaDelete", id: idea.id });
  }

  private closed(): void {
    this.dictation?.stop();
    this.modal = null;
    this.pad = null;
    this.actions.onSketch?.(null);
  }
}
