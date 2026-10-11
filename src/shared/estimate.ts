/**
 * Estimates for every job: before a task goes out, how long it'll likely take
 * and what it'll cost — on a cloud model, or free on a local one. A first guess
 * comes from the size of the task (its words, its notes, how much "done" asks
 * for, plan first, an audit); then it's scaled by how long similar tasks really
 * took this team. Each finished task is kept as a sample (guess vs. what it
 * took), so the estimates get better as the team works. Pure: shared by the
 * server (which records them) and the client (the card, laptop and phone).
 */

import { isLocalModel, taskSize, type TaskSize } from "./localModels.js";

export { isLocalModel, type TaskSize };

/** What an estimate is made from: the task, and who's doing it on what. */
export interface EstimateInput {
  title: string;
  notes?: string;
  /** Lines in its definition of done. */
  done?: number;
  /** Files attached for it to read. */
  files?: number;
  planFirst?: boolean;
  /** Another worker audits it before it comes to you. */
  audited?: boolean;
  /** The agent CLI ("claude", "codex", …), or "" when nobody's picked yet. */
  agent?: string;
  /** The model it runs on ("" = the CLI's default). */
  model?: string;
}

export interface Estimate {
  /** The likely time, and a range around it. */
  minutes: number;
  low: number;
  high: number;
  size: TaskSize;
  /** On a model on this computer: free (and private). */
  local: boolean;
  /** Its likely cost in US dollars (0 when local). */
  cost: number;
  /** What it would cost on a cloud model (for local ones: what you're saving). */
  cloudCost: number;
  /** How many finished tasks it learned from, and how many of them were much like this one. */
  history: number;
  similar: number;
  /** Who it was worked out for: the agent and model ("" when not picked yet). */
  agent: string;
  model: string;
}

/** A finished task: what we guessed, and what it really took. Kept so estimates learn. */
export interface EstimateSample {
  title: string;
  size: TaskSize;
  agent: string;
  model: string;
  local: boolean;
  /** The first guess from its size alone (before learning), in minutes. */
  guess: number;
  /** What the estimate said when it went out. */
  est: number;
  /** What it really took, in minutes (from handing out to its last presentation). */
  minutes: number;
  /** Its cost at that rate (0 when local). */
  cost: number;
  at: number;
}

/** How a finished task compared with its estimate. */
export interface Took {
  minutes: number;
  cost: number;
}

/** Samples kept: enough to learn from, small enough to send to every client. */
export const MAX_SAMPLES = 200;

/** The first guess for each size, in minutes. */
export const BASE_MINUTES: Record<TaskSize, number> = { small: 10, medium: 25, large: 55 };

/**
 * What an hour of an agent working costs on a cloud model, in US dollars —
 * rough figures for a coding agent's typical token use, not a bill.
 */
const MODEL_RATES: [RegExp, number][] = [
  [/opus/i, 9],
  [/sonnet/i, 4],
  [/haiku/i, 1.2],
  [/flash|mini|nano/i, 1],
  [/gemini/i, 3],
  [/gpt|codex|\bo\d/i, 4],
];
/** When the model is the CLI's own default. */
const AGENT_RATES: Record<string, number> = { claude: 6, codex: 4, gemini: 3, opencode: 4 };
const DEFAULT_RATE = 5;

/** Dollars an hour of work on this model (0 when it's local). */
export function hourlyRate(agent: string, model: string): number {
  if (isLocalModel(model)) return 0;
  const name = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  for (const [re, rate] of MODEL_RATES) if (re.test(name)) return rate;
  return AGENT_RATES[agent] ?? DEFAULT_RATE;
}

/** A stand-in local model, for "what if it ran on this computer". */
export const ANY_LOCAL = "ollama/local";

const BIGGER: Record<TaskSize, TaskSize> = { small: "medium", medium: "large", large: "large" };

/**
 * How big a task looks, from its words and notes (the same reading that
 * suggests local models), one size up when it also brings files to read,
 * long notes or a long definition of done. Its time budget is left out: the
 * estimate is checked against the budget, so it mustn't come from it.
 */
export function estimateSize(i: EstimateInput): TaskSize {
  const size = taskSize(i.title, 0, i.notes ?? "");
  const extra = Number((i.files ?? 0) > 0) + Number((i.notes ?? "").length > 200) + Number((i.done ?? 0) > 4);
  return extra >= 2 ? BIGGER[size] : size;
}

/** The first guess, from the task's size and terms alone (no history). */
export function firstGuess(i: EstimateInput): number {
  let m = BASE_MINUTES[estimateSize(i)];
  if (i.planFirst) m += 5;
  if (i.audited) m *= 1.3;
  // A model on a laptop runs slower than one in a data centre.
  if (isLocalModel(i.model ?? "")) m *= 1.6;
  return m;
}

const STOP = new Set(["the", "and", "for", "with", "from", "into", "that", "this", "our", "its", "add", "make", "use", "new", "all", "any"]);

/** The words that say what a task is about. */
export function keywords(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w))
      .map((w) => w.replace(/(ing|ed|es|s)$/, "")),
  );
}

/** How alike two titles are: shared words over all words (0–1). */
export function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / (a.size + b.size - both);
}

/** How much a past task says about this one: its title, size and model. */
function weight(s: EstimateSample, words: Set<string>, size: TaskSize, model: string, local: boolean): { w: number; j: number } {
  const j = overlap(words, keywords(s.title));
  let w = 0.2 + 1.5 * j;
  if (s.size === size) w += 0.3;
  if (model && s.model === model) w += 0.4;
  else if (s.local === local) w += 0.2;
  return { w, j };
}

/** How sure the first guess is, before any history (a spread in log terms), and how much it counts. */
const PRIOR_SPREAD = 0.5;
const PRIOR_WEIGHT = 3;

/** Round to what people say: 1-minute steps under 20, then 5s. */
function nice(m: number): number {
  return m < 20 ? Math.max(1, Math.round(m)) : Math.round(m / 5) * 5;
}

function cents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

/**
 * The estimate: the first guess, scaled by how much longer (or shorter) than
 * guessed similar tasks really took this team. Each past task counts by how
 * alike it is (shared words in the title, same size, same model); the guess
 * itself counts as a few tasks that took exactly that, so one odd task can't
 * swing it far.
 */
export function estimateTask(i: EstimateInput, samples: readonly EstimateSample[] = []): Estimate {
  const size = estimateSize(i);
  const model = i.model ?? "";
  const local = isLocalModel(model);
  const guess = firstGuess(i);
  const words = keywords(`${i.title} ${i.notes ?? ""}`);
  let sw = 0;
  let sum = 0;
  let similar = 0;
  const logs: { w: number; r: number }[] = [];
  for (const s of samples.slice(-MAX_SAMPLES)) {
    if (!(s.guess > 0) || !(s.minutes > 0)) continue;
    const { w, j } = weight(s, words, size, model, local);
    const r = Math.log(Math.min(10, Math.max(0.1, s.minutes / s.guess)));
    logs.push({ w, r });
    sw += w;
    sum += w * r;
    if (j >= 0.25) similar++;
  }
  const mean = sum / (PRIOR_WEIGHT + sw);
  const variance = (PRIOR_WEIGHT * (PRIOR_SPREAD ** 2 + mean ** 2) + logs.reduce((a, l) => a + l.w * (l.r - mean) ** 2, 0)) / (PRIOR_WEIGHT + sw);
  const spread = Math.min(1.2, Math.max(0.2, Math.sqrt(variance)));
  const raw = guess * Math.exp(mean);
  const minutes = nice(raw);
  const rate = hourlyRate(i.agent ?? "", model);
  const cloudRate = local ? (AGENT_RATES[i.agent ?? ""] ?? DEFAULT_RATE) : rate;
  return {
    minutes,
    low: nice(raw * Math.exp(-spread)),
    high: Math.max(minutes, nice(raw * Math.exp(spread))),
    size,
    local,
    cost: cents((minutes / 60) * rate),
    cloudCost: cents((minutes / 60) * cloudRate),
    history: logs.length,
    similar,
    agent: i.agent ?? "",
    model,
  };
}

/** A finished task as a sample to learn from. */
export function sampleOf(i: EstimateInput, est: number, minutes: number, at: number): EstimateSample {
  const model = i.model ?? "";
  return {
    title: i.title.slice(0, 160),
    size: estimateSize(i),
    agent: i.agent ?? "",
    model,
    local: isLocalModel(model),
    guess: Math.round(firstGuess(i) * 10) / 10,
    est,
    minutes: Math.round(minutes * 10) / 10,
    cost: cents((minutes / 60) * hourlyRate(i.agent ?? "", model)),
    at,
  };
}

/** "$1.90", "<$0.10", "$12". */
export function costLabel(usd: number): string {
  if (usd <= 0) return "free";
  if (usd < 0.1) return "<$0.10";
  return usd >= 10 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`;
}

/** "~25 min (15–40)", or "~1 h 30 min (…)". */
export function minutesLabel(m: number): string {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** One line for the card and lists: "~25 min (15–40) · ≈ $2.50", or "… · free, local (≈ $2.50 on cloud)". */
export function estimateLabel(e: Estimate, opts: { range?: boolean } = {}): string {
  const time = `~${minutesLabel(e.minutes)}${opts.range === false || e.low === e.high ? "" : ` (${e.low}–${e.high})`}`;
  const cost = e.local ? `free, local${e.cloudCost > 0 ? ` (≈ ${costLabel(e.cloudCost)} on cloud)` : ""}` : `≈ ${costLabel(e.cost)}`;
  return `${time} · ${cost}`;
}

/** Where an estimate came from, in a few words. */
export function basisLabel(e: Estimate): string {
  if (!e.history) return `a ${e.size} task — a first guess; it learns as tasks finish`;
  if (e.similar) return `a ${e.size} task — from ${e.similar} similar one${e.similar === 1 ? "" : "s"} this team finished`;
  return `a ${e.size} task — from ${e.history} task${e.history === 1 ? "" : "s"} this team finished`;
}

/** How a finished task went against its estimate: "took 31 min · est ~25 (+24%)". */
export function tookLabel(took: Took, est: Estimate | null | undefined): string {
  const m = Math.max(1, Math.round(took.minutes));
  const off = est && est.minutes ? Math.round(((took.minutes - est.minutes) / est.minutes) * 100) : null;
  const cost = took.cost > 0 ? ` · ${costLabel(took.cost)}` : "";
  return `took ${minutesLabel(m)}${cost}${est ? ` · est ~${minutesLabel(est.minutes)}${off === null ? "" : ` (${off >= 0 ? "+" : ""}${off}%)`}` : ""}`;
}

export interface Accuracy {
  /** Tasks it was checked against. */
  n: number;
  /** How far off a typical estimate was (the median, as a share of what it took). */
  typicalOff: number;
  /** The same over the older half of them, to show whether it's getting better (null with too few). */
  before: number | null;
}

/** How good the estimates have been lately: the last `last` finished tasks. */
export function estimateAccuracy(samples: readonly EstimateSample[], last = 20): Accuracy {
  const off = (s: EstimateSample) => Math.abs(s.est - s.minutes) / Math.max(1, s.minutes);
  const median = (xs: number[]) => {
    const v = [...xs].sort((a, b) => a - b);
    return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : 0;
  };
  const recent = samples.filter((s) => s.est > 0 && s.minutes > 0).slice(-last);
  const half = Math.floor(recent.length / 2);
  return {
    n: recent.length,
    typicalOff: median(recent.map(off)),
    before: recent.length >= 6 ? median(recent.slice(0, half).map(off)) : null,
  };
}

/** "Estimates are typically 20% off over the last 12 tasks (the older half: 45%)." */
export function accuracyLabel(a: Accuracy): string {
  if (!a.n) return "No finished tasks to check the estimates against yet.";
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return `Estimates are typically ${pct(a.typicalOff)} off over the last ${a.n} task${a.n === 1 ? "" : "s"}${a.before !== null ? ` (the older half: ${pct(a.before)})` : ""}.`;
}

/** The bits of a task its estimate line needs (a GoalTask fits). */
interface TaskLike {
  title: string;
  status: "todo" | "doing" | "review" | "done";
  estimate?: Estimate | null;
  took?: Took | null;
}

/**
 * A task's estimate in one short line, for lists (the laptop, the phone, the
 * Goals window): what it took once done; its estimate while it's being done;
 * and before it goes out, a guess on a cloud model and on a local one.
 */
export function taskEstimateLine(t: TaskLike, samples: readonly EstimateSample[] = []): string {
  if (t.status === "done") return t.took ? `⏱ ${tookLabel(t.took, t.estimate)}` : "";
  if (t.estimate) return `⏳ est ${estimateLabel(t.estimate)}`;
  const cloud = estimateTask({ title: t.title }, samples);
  const local = estimateTask({ title: t.title, model: ANY_LOCAL }, samples);
  return `⏳ ~${minutesLabel(cloud.minutes)} · ≈ ${costLabel(cloud.cost)} on cloud, or ~${minutesLabel(local.minutes)} free on a local model`;
}

/** What's left of a goal: "~1 h 40 min of work left · ≈ $8.50" over its unfinished tasks ("" when none). */
export function remainingLabel(tasks: readonly TaskLike[], samples: readonly EstimateSample[] = []): string {
  const open = tasks.filter((t) => t.status !== "done");
  if (!open.length) return "";
  let minutes = 0;
  let cost = 0;
  for (const t of open) {
    const e = t.estimate ?? estimateTask({ title: t.title }, samples);
    minutes += e.minutes;
    cost += e.cost;
  }
  return `~${minutesLabel(minutes)} of work left · ≈ ${costLabel(cents(cost))}`;
}
