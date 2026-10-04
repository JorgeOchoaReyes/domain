import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_IDEAS, MAX_SKETCH, coerceIdeaInput, ideaTasks, type Idea } from "../shared/ideas.js";
import { AGENT_LABELS } from "../shared/protocol.js";
import type { Routes, ServerCtx } from "./ctx.js";

/**
 * The idea boards: ideas drawn and written at the office's whiteboards, kept
 * in .domain/ideas (the list in ideas.json, each sketch as <id>.png so agents
 * can open it). An idea can be handed to a worker — it becomes a task on the
 * goal in focus (or a new goal) and the worker is briefed with the notes and
 * the sketch — or turned into a goal of its own, whose tasks are briefed with
 * the idea too.
 */

export class IdeaStore {
  ideas: Idea[] = [];
  private file: string;

  constructor(readonly dir: string) {
    this.file = join(dir, "ideas.json");
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (Array.isArray(raw)) this.ideas = raw.filter((x): x is Idea => !!x && typeof x === "object" && typeof (x as Idea).id === "string").slice(0, MAX_IDEAS);
    } catch {
      /* none yet */
    }
  }

  get(id: string): Idea | undefined {
    return this.ideas.find((i) => i.id === id);
  }

  sketchPath(id: string): string | null {
    const p = join(this.dir, `${id}.png`);
    return existsSync(p) ? p : null;
  }

  /** Add or update an idea; returns it, or null when the board is full or the input is empty. */
  save(raw: unknown, sketch: unknown, by: string): Idea | null {
    const input = coerceIdeaInput(raw);
    if (!input) return null;
    let idea = input.id ? this.get(input.id) : undefined;
    if (!idea) {
      if (this.ideas.length >= MAX_IDEAS) return null;
      idea = { id: randomUUID().slice(0, 8), title: "", text: "", kind: "build", by, at: Date.now(), thumb: null, status: "open" };
      this.ideas.unshift(idea);
    }
    Object.assign(idea, { title: input.title, text: input.text, kind: input.kind, thumb: input.thumb });
    // A sketch replaces the old one; a save without one (the board was wiped) removes it.
    if (typeof sketch === "string") this.writeSketch(idea.id, sketch);
    else if (!input.thumb) rmSync(join(this.dir, `${idea.id}.png`), { force: true });
    this.persist();
    return idea;
  }

  delete(id: string): boolean {
    const i = this.ideas.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.ideas.splice(i, 1);
    rmSync(join(this.dir, `${id}.png`), { force: true });
    this.persist();
    return true;
  }

  /**
   * What a worker is told about an idea: the notes, and the sketch — copied
   * into its own folder (`workdir`/.domain/sketches, which git ignores) so it
   * can open it without asking.
   */
  notes(idea: Idea, workdir: string): string {
    const parts = [` From the idea board: “${idea.title}”.`];
    if (idea.text && idea.text !== idea.title) parts.push(`Notes: ${idea.text.replace(/\s*\n\s*/g, " / ")}`);
    const sketch = this.sketchPath(idea.id);
    if (sketch) {
      try {
        const name = `idea-${idea.id}.png`;
        mkdirSync(join(workdir, ".domain", "sketches"), { recursive: true });
        copyFileSync(sketch, join(workdir, ".domain", "sketches", name));
        parts.push(`Sketch (open it and look): .domain/sketches/${name}`);
      } catch {
        parts.push(`Sketch (open it and look): ${sketch}`);
      }
    }
    return parts.join(" ");
  }

  persist(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.ideas, null, 2));
    } catch {
      /* read-only folder: keep it in memory */
    }
  }

  private writeSketch(id: string, dataUrl: string): void {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m || m[1].length > MAX_SKETCH) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, `${id}.png`), Buffer.from(m[1], "base64"));
    } catch {
      /* best effort */
    }
  }
}

export function ideasModule(ctx: ServerCtx, store = new IdeaStore(join(ctx.cwd, ".domain", "ideas"))): Routes {
  const broadcast = () => ctx.broadcast({ t: "ideas", ideas: store.ideas });
  const idOf = (msg: Record<string, unknown>) => (typeof msg.id === "string" && msg.id.length <= 40 ? msg.id : null);

  // Tasks on a goal that came from an idea are briefed with it.
  ctx.briefNotes.push((goalId, taskId, deskId) => {
    const idea = store.ideas.find((i) => (i.taskId ? i.taskId === taskId : i.goalId === goalId && i.status === "goal"));
    return idea ? store.notes(idea, ctx.office.workdir(deskId)) : "";
  });

  /** The goal an idea's task goes on: the one in focus, else the newest open one, else a new one. */
  const goalFor = (idea: Idea, who: string): string | null => {
    const p = ctx.progress.snapshot();
    const live = (id: string | null | undefined) => (id && p.goals.some((g) => g.id === id && !g.doneAt) ? id : null);
    const found = live(idea.goalId) ?? live(p.session?.goalId) ?? p.goals.find((g) => !g.doneAt)?.id ?? null;
    return found ?? ctx.progress.createGoal(who, idea.title, idea.text.slice(0, 240), [], idea.kind)?.id ?? null;
  };

  /** Hand an idea to the worker at a desk: a task on that goal, briefed with the idea. */
  const handoff = (idea: Idea, deskId: string, who: string, brief: unknown): void => {
    const desk = ctx.office.snapshot().desks.find((d) => d.id === deskId);
    if (!desk?.worker) return;
    const goalId = goalFor(idea, who);
    const taskId = goalId ? ctx.progress.addTask(goalId, idea.title) : null;
    if (!goalId || !taskId) {
      ctx.log.start("agent", `Couldn't hand “${idea.title}” over: its goal is full`, { topic: "ideas" }).done(false);
      return;
    }
    Object.assign(idea, { status: "handed", goalId, taskId, handedTo: { deskId, name: desk.worker.identity?.name ?? `${AGENT_LABELS[desk.worker.agent]} at ${desk.label}` } });
    store.persist();
    ctx.assignTask(who, goalId, taskId, deskId, brief ?? {});
  };

  /** Turn an idea into a goal: the notes' first line is the why, their bullet lines the tasks. */
  const toGoal = (idea: Idea, who: string): void => {
    const goal = ctx.progress.createGoal(who, idea.title, idea.text.split("\n")[0].slice(0, 240), ideaTasks(idea.text), idea.kind);
    if (!goal) {
      ctx.log.start("agent", "Couldn't make it a goal: there are too many goals", { topic: "ideas" }).done(false);
      return;
    }
    Object.assign(idea, { status: "goal", goalId: goal.id, taskId: undefined, handedTo: undefined });
    store.persist();
  };

  return {
    ideasGet: (_msg, _client, ws) => ctx.send(ws, { t: "ideas", ideas: store.ideas }),
    ideaSave: (msg, client) => {
      const idea = store.save(msg.idea, msg.sketch, client.name);
      if (!idea) {
        ctx.log.start("agent", "Couldn't pin the idea: the board is full or it was empty", { topic: "ideas" }).done(false);
        return;
      }
      const then = msg.then && typeof msg.then === "object" ? (msg.then as { handoff?: unknown; goal?: unknown }) : {};
      if (typeof then.handoff === "string") handoff(idea, then.handoff, client.name, {});
      else if (then.goal === true) toGoal(idea, client.name);
      broadcast();
    },
    ideaDelete: (msg) => {
      const id = idOf(msg);
      if (id && store.delete(id)) broadcast();
    },
    ideaHandoff: (msg, client) => {
      const idea = store.get(idOf(msg) ?? "");
      if (!idea || typeof msg.deskId !== "string") return;
      handoff(idea, msg.deskId, client.name, msg.brief);
      broadcast();
    },
    ideaToGoal: (msg, client) => {
      const idea = store.get(idOf(msg) ?? "");
      if (!idea) return;
      toGoal(idea, client.name);
      broadcast();
    },
  };
}
