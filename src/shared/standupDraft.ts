import { isTone, SESSION_LENGTHS, type GoalKind, type ToneId } from "./progress.js";

/**
 * The spoken stand-up: you say what you want done, and Claude outlines the
 * plan like a team lead would — a short summary (read back to you), what done
 * looks like by the end of the day, a goal broken into tasks, and who on your
 * team should take each one and why (from what each is good at, has done and
 * is busy with). The server asks a model (a one-shot `claude -p`); without
 * one, simpleDraft() does it plainly — your sentences as tasks, spread over
 * whoever's free. Either way you see it in the stand-up and change anything
 * — the tasks, who gets them — before the day starts.
 */

/** A worker on the team, as the planner sees it. */
export interface TeamMember {
  deskId: string;
  name: string;
  agent: string;
  model: string;
  status: string;
  /** What it's on right now, if anything. */
  doing: string;
  /** Its standing instructions (a character's persona): what it's for. */
  persona: string;
  /** Tasks it has finished lately. */
  done: string[];
}

/** Who should take a task, and why ("deskId" null: whoever's free). */
export interface Suggestion {
  task: string;
  deskId: string | null;
  why: string;
}

export interface StandupDraft {
  /** Two or three sentences, said back to you. */
  summary: string;
  /** What done looks like by the end of the day, one line each. */
  eod: string[];
  goal: { title: string; why: string; kind: GoalKind; tasks: string[] };
  tone: ToneId;
  minutes: number;
  /** The one line that would make the session a win. */
  intention: string;
  /** Who takes each of the goal's tasks (same order as goal.tasks). */
  assign: Suggestion[];
}

const MAX_TASKS = 12;

/** What the model is asked (it answers with JSON only). */
export function draftPrompt(spoken: string, openGoals: string[], team: TeamMember[] = []): string {
  const roster = team.map((m) => ({
    id: m.deskId,
    name: m.name,
    agent: m.agent,
    ...(m.model ? { model: m.model } : {}),
    status: m.status,
    ...(m.doing ? { busyWith: m.doing } : {}),
    ...(m.persona ? { role: m.persona.slice(0, 200) } : {}),
    ...(m.done.length ? { recentlyDid: m.done.slice(0, 4) } : {}),
  }));
  return [
    "You are the team lead for a team of coding agents. The manager has said what they want done today; outline the plan and say who should take each task.",
    "Reply with ONE JSON object and nothing else, shaped like:",
    '{"summary": "2-3 sentences in second person: the plan and who is on what, upbeat, plain", "eod": ["what done looks like by end of day", "..."], "goal": {"title": "short goal title", "why": "one line", "kind": "build" | "research", "tasks": [{"title": "one concrete task an agent can do alone", "assignee": "a team member id, or null", "why": "a few words: why them"}]}, "tone": "ship" | "focus" | "explore" | "bughunt", "minutes": 60 | 120 | 180 | 240, "intention": "one line: what would make today a win"}',
    "Rules: tasks are independent, concrete, ordered as they should be done, and start with a verb (at most 8); eod has 1-4 items; keep the manager's words where you can; never invent work they didn't mention.",
    team.length
      ? "Assigning: spread the work so people work in parallel; prefer someone free over someone busy; match the task to a role or to what they did recently (continuity); a stronger model for harder work. Use null only if nobody fits."
      : "There's nobody on the team yet: every assignee is null.",
    "Choose tone: bughunt for fixing bugs, explore for research or spikes, ship for getting features out, focus otherwise. Minutes: what they said, else 120.",
    openGoals.length ? `Goals already open (reuse a title if they're talking about one): ${openGoals.map((g) => JSON.stringify(g)).join(", ")}` : "",
    team.length ? `The team: ${JSON.stringify(roster)}` : "",
    "",
    "The stand-up, as they said it:",
    JSON.stringify(spoken),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function list(v: unknown, max: number, len: number): string[] {
  return Array.isArray(v) ? v.map((x) => str(x, len)).filter(Boolean).slice(0, max) : [];
}

/** The closest session length offered. */
export function nearestLength(minutes: number): number {
  return SESSION_LENGTHS.reduce((best, m) => (Math.abs(m - minutes) < Math.abs(best - minutes) ? m : best), SESSION_LENGTHS[0]);
}

/** The model's answer → a draft (null if it isn't one). Tolerates prose or code fences round the JSON. */
export function parseDraft(text: string, spoken: string, team: TeamMember[] = []): StandupDraft | null {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a === -1 || b <= a) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text.slice(a, b + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const g = (o.goal && typeof o.goal === "object" ? o.goal : {}) as Record<string, unknown>;
  // Tasks come as {title, assignee, why} (or plain strings): an assignee must be someone on the team.
  const ids = new Set(team.map((m) => m.deskId));
  const raw = Array.isArray(g.tasks) ? g.tasks.slice(0, MAX_TASKS) : [];
  const picked = raw
    .map((t): Suggestion | null => {
      if (typeof t === "string") return str(t, 200) ? { task: str(t, 200), deskId: null, why: "" } : null;
      if (!t || typeof t !== "object") return null;
      const r = t as Record<string, unknown>;
      const task = str(r.title, 200);
      if (!task) return null;
      const who = typeof r.assignee === "string" && ids.has(r.assignee) ? r.assignee : null;
      return { task, deskId: who, why: who ? str(r.why, 120) : "" };
    })
    .filter((x): x is Suggestion => x !== null);
  const tasks = picked.map((x) => x.task);
  const title = str(g.title, 120);
  if (!title && !tasks.length) return null;
  const fallback = simpleDraft(spoken, team);
  const minutes = typeof o.minutes === "number" && Number.isFinite(o.minutes) ? nearestLength(o.minutes) : fallback.minutes;
  return {
    summary: str(o.summary, 600) || fallback.summary,
    eod: list(o.eod, 6, 200).length ? list(o.eod, 6, 200) : fallback.eod,
    goal: { title: title || fallback.goal.title, why: str(g.why, 300), kind: g.kind === "research" ? "research" : "build", tasks: tasks.length ? tasks : fallback.goal.tasks },
    tone: isTone(o.tone) ? o.tone : fallback.tone,
    minutes,
    intention: str(o.intention, 140) || fallback.intention,
    assign: tasks.length ? picked : fallback.assign,
  };
}

/**
 * No model: spread the tasks over the team — whoever's free first (in turn),
 * then whoever's busy, each task to the next.
 */
export function spreadTasks(tasks: string[], team: TeamMember[]): Suggestion[] {
  const free = team.filter((m) => m.status === "idle" && !m.doing);
  const busy = team.filter((m) => !free.includes(m) && m.status !== "asleep");
  const order = [...free, ...busy];
  return tasks.map((task, i) => {
    const m = order.length ? order[i % order.length] : null;
    return { task, deskId: m?.deskId ?? null, why: m ? (free.includes(m) ? "free now" : `next, after “${m.doing.slice(0, 40)}”`) : "" };
  });
}

/** Filler a sentence starts with that isn't the task itself. */
const FILLER = /^(?:(?:ok(?:ay)?|so|and|also|then|um+|uh+|well|right|first(?:ly)?|second(?:ly)?|third(?:ly)?|next|finally|after that|plus)[\s,]+)+/i;
const LEAD = /^(?:(?:today|this morning|this afternoon)[\s,]+)?(?:i|we)(?:'d| would)? (?:want|need|have|got|'ve got|'m going|are going|plan|hope|'d like|would like)(?: to)? |^(?:let's|lets|let us|i'll|we'll|we should|i should|i want|we want|gotta|need to|want to|going to|trying to) /i;
/** "About three hours": how long, not a task. */
const DURATION = /^(?:for )?(?:about|around|roughly|maybe|like|probably|say)?\s*(?:\d+(?:\.\d+)?|an?|one|two|three|four|half an?)\s+(?:hours?|hrs?|minutes?|mins?)(?: or so)?$/i;
/** The "by end of day" part itself, with its little words, to take out of the line. */
const EOD_PHRASE = /\b(?:(?:by|at|before|for)\s+)?(?:the\s+)?(?:end of (?:the )?day|eod|tonight)\b/gi;
const EOD = /\b(?:end of (?:the )?day|eod|by tonight|by the end|before (?:i|we) (?:leave|log off|stop)|today's done when|done means)\b/i;

const VERBS = /^(add|build|make|fix|write|update|create|remove|delete|refactor|clean|test|ship|deploy|release|document|research|investigate|review|improve|implement|set|move|rename|upgrade|migrate|support|finish|start|draft|design|polish|speed|optimi[sz]e|change|replace|check|run|open|merge|publish|prepare|plan|explore|compare|look|find|get|keep|split|wire|hook|connect|port|bump|tidy|redo|rework|rewrite|translate|configure|install|enable|disable|handle|show|hide|let|allow|stop|use)\b/i;
/** "the login bug fixed" → "Fix the login bug": a done-state at the end becomes the verb. */
const DONE_STATE: [RegExp, string][] = [
  [/^(.*?)\s+(?:fixed|sorted(?: out)?|resolved)$/i, "Fix"],
  [/^(.*?)\s+(?:shipped|released|deployed|live|out)$/i, "Ship"],
  [/^(.*?)\s+(?:added|in(?: place)?)$/i, "Add"],
  [/^(.*?)\s+(?:updated|refreshed)$/i, "Update"],
  [/^(.*?)\s+(?:written|drafted)$/i, "Write"],
  [/^(.*?)\s+(?:done|finished|complete|completed)$/i, "Finish"],
  [/^(.*?)\s+(?:merged)$/i, "Merge"],
  [/^(.*?)\s+(?:cleaned up|tidied(?: up)?)$/i, "Clean up"],
  [/^(.*?)\s+(?:removed|gone)$/i, "Remove"],
  [/^(.*?)\s+(?:tested)$/i, "Test"],
];

/** A task line that starts with what to do. */
export function asTask(clause: string): string {
  const t = clause.trim();
  if (!t || VERBS.test(t)) return t;
  for (const [re, verb] of DONE_STATE) {
    const m = re.exec(t);
    if (m && m[1]) return `${verb} ${m[1].replace(/^(?:the|a|an)\s+/i, (x) => x.toLowerCase())}`;
  }
  if (/^(?:tests?|docs?|documentation|a readme|the readme|notes|a report|a summary|a guide)\b/i.test(t)) return `Write ${t[0].toLowerCase()}${t.slice(1)}`;
  if (/^(?:a|an|the|some|new)\s/i.test(t)) return `Add ${t[0].toLowerCase()}${t.slice(1)}`;
  return t;
}

/** Your sentences, cleaned up into task lines. */
function clauses(spoken: string): string[] {
  return spoken
    .split(/(?<=[.!?])\s+|\s*[;\n]\s*|,?\s+(?:and then|then|after that|also|plus)\s+/i)
    .flatMap((s) => s.split(/,\s+and\s+|,\s+(?=[a-z]+\b)/i))
    .map((s) => s.trim().replace(/[.!?]+$/, ""))
    .map((s) => {
      let t = s;
      for (let i = 0; i < 3; i++) t = t.replace(FILLER, "").replace(LEAD, "").trim();
      return t;
    })
    .filter((s) => s.split(/\s+/).length >= 2 && !DURATION.test(s))
    .map((s) => s[0].toUpperCase() + s.slice(1));
}

function toneOf(text: string): ToneId {
  if (/\b(bug|bugs|crash|fix|broken|error|regression)\b/i.test(text)) return "bughunt";
  if (/\b(research|explore|spike|investigate|compare|prototype|look into)\b/i.test(text)) return "explore";
  if (/\b(ship|release|launch|deploy|deliver|demo|pr\b|pull request)\b/i.test(text)) return "ship";
  return "focus";
}

function minutesOf(text: string): number {
  const h = /\b(\d+(?:\.\d+)?|an?|one|two|three|four)\s+hours?\b/i.exec(text);
  if (h) {
    const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4 };
    const n = words[h[1].toLowerCase()] ?? Number(h[1]);
    if (n > 0) return nearestLength(n * 60);
  }
  const m = /\b(\d+)\s+min(?:ute)?s?\b/i.exec(text);
  if (m) return nearestLength(Number(m[1]));
  return 120;
}

/** No model: a plain plan from your own sentences. */
export function simpleDraft(spoken: string, team: TeamMember[] = []): StandupDraft {
  const text = spoken.replace(/\s+/g, " ").trim();
  const all = clauses(text);
  const eodLines = all
    .filter((c) => EOD.test(c))
    .map((c) =>
      c
        .replace(EOD_PHRASE, " ")
        .replace(/\s+/g, " ")
        .replace(/^[\s,:-]+|[\s,:-]+$/g, "")
        .replace(/^(?:i want|we want|i'd like|have|get)\s+/i, ""),
    )
    .filter((c) => c.split(/\s+/).length >= 2);
  const tasks = all.filter((c) => !EOD.test(c)).slice(0, MAX_TASKS).map(asTask);
  const eod = (eodLines.length ? eodLines : tasks.slice(0, 3)).map((c) => c[0].toUpperCase() + c.slice(1)).slice(0, 4);
  const research = /\b(research|report|compare|investigate|survey|look into)\b/i.test(text) && !/\b(build|implement|fix|add)\b/i.test(text);
  const title = tasks.length === 1 ? tasks[0] : tasks.length ? `Today: ${tasks.slice(0, 2).map((t) => t.toLowerCase()).join(", ")}${tasks.length > 2 ? "…" : ""}` : "Today's goal";
  // Lower-case just the first letter, so names like PR or API stay as they are.
  const lower = (t: string) => (/^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t);
  const listed = tasks.slice(0, 3).map(lower);
  const summary = tasks.length
    ? `Today's plan: ${listed.length > 1 ? `${listed.slice(0, -1).join(", ")} and ${listed.at(-1)}` : listed[0]}${tasks.length > 3 ? `, plus ${tasks.length - 3} more` : ""}.${eod.length ? ` By end of day: ${lower(eod[0])}${eod.length > 1 ? `, and ${eod.length - 1} more` : ""}.` : ""}`
    : "Say a little about what you want done today and I'll turn it into a plan.";
  return {
    summary,
    eod,
    goal: { title: title.slice(0, 120), why: "", kind: research ? "research" : "build", tasks },
    tone: toneOf(text),
    minutes: minutesOf(text),
    intention: (eod[0] ?? tasks[0] ?? "").slice(0, 140),
    assign: spreadTasks(tasks, team),
  };
}

/** What the end-of-day recap says (and reads aloud). */
export function eodRecap(eod: string[], done: string[], open: string[]): string {
  const parts: string[] = [];
  if (done.length) parts.push(`Done today: ${done.slice(0, 5).join("; ")}${done.length > 5 ? `; and ${done.length - 5} more` : ""}.`);
  if (open.length) parts.push(`Still open, carried to tomorrow: ${open.slice(0, 5).join("; ")}${open.length > 5 ? `; and ${open.length - 5} more` : ""}.`);
  else if (done.length) parts.push("Nothing left open — clean finish.");
  if (eod.length) parts.push(`Your end-of-day goals were: ${eod.join("; ")}.`);
  return parts.join(" ") || "No tasks moved this session.";
}
