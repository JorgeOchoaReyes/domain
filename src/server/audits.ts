import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Report } from "../shared/protocol.js";

/**
 * Pair workers: a builder and an auditor. When the builder says a task is
 * done (and it passes the check), the work goes to the auditor before it
 * comes to you: the office writes the builder's changes into the auditor's
 * own folder, the auditor reviews them and gives a verdict. Problems go back
 * to the builder; it fixes them and presents again; and round it goes —
 * until the auditor approves, or the rounds run out, or an audit takes too
 * long. Either way you then get one report, with what the audit found.
 *
 * "Along the way" audits also check the builder's checkpoints as it goes
 * (reports titled "Checkpoint: …"): an approved checkpoint sends it on to the
 * next step, issues go back to it — the same rounds limit applies to every
 * send-back, so it can't loop forever.
 */

export interface AuditOffice {
  workdir(deskId: string): string;
  hold(deskId: string, activity: string): void;
  amendReport(deskId: string, change: (r: Report) => Report): void;
  dismiss(deskId: string, message: string): void;
  review(deskId: string, approve: boolean, text?: string): boolean;
  /** Type an instruction into a worker's terminal. */
  instruct(deskId: string, text: string): void;
  isStaffed(deskId: string): boolean;
}

export interface AuditDeps {
  office: AuditOffice;
  /** Your branch in the repo the builder works in (to diff its work against), or null. */
  base(deskId: string): string | null;
  /** A worker's name, for the briefs and the report. */
  nameOf(deskId: string): string;
  /** Hand the builder's report to you (into the line, announced). */
  release(deskId: string): void;
  /** Something worth a line in the history and a toast. */
  note(text: string, deskId: string, kind: "audit"): void;
  /** What an auditor found wrong (for the team's lessons). */
  onFinding?(builder: string, task: string, issues: string): void;
  /** Simulated workers: act out the auditor's verdicts and the builder's fixes. */
  simulate?: { verdict(auditor: string, report: Report, file: string): void; recall(builder: string): void };
  /** How long an audit may take before the work comes to you anyway. */
  maxAuditMs?: number;
  /** Whether this desk has an open task of its own (then its report is its own work, never a verdict). */
  hasOwnTask?(deskId: string): boolean;
}

interface Pair {
  builder: string;
  auditor: string;
  task: string;
  max: number;
  round: number;
  phase: "building" | "auditing";
  since: number;
  /** What each round found. */
  findings: string[];
  /** Also audit checkpoints as it goes, not just the finished work. */
  along: boolean;
  /** Is the audit underway on a checkpoint (vs the finished work)? */
  checkpoint: boolean;
  /** Checkpoints audited so far. */
  checkpoints: number;
  /** Times the work went back to the builder: at the limit, it comes to you as it is. */
  sendBacks: number;
  /**
   * Where the auditor writes its verdict — its own file, not its report: an
   * auditor can have work of its own waiting too, and one report file can't
   * hold both.
   */
  verdictFile: string | null;
}

/** At most this many checkpoints are audited; later ones go straight through. */
export const MAX_CHECKPOINTS = 8;

/** A builder's report that's a checkpoint (along-the-way audits), not the finished work. */
export function isCheckpoint(r: Report): boolean {
  return /^\s*checkpoint\b/i.test(r.title);
}

const DEFAULT_MAX_AUDIT_MS = 25 * 60_000;

function gitOut(cwd: string, args: string[]): Promise<string> {
  return new Promise((done) => execFile("git", args, { cwd, windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => done(err ? "" : String(out))));
}

export class Audits {
  private pairs = new Map<string, Pair>();

  constructor(private deps: AuditDeps) {}

  /** A task handed to a builder with an auditor. */
  start(builder: string, auditor: string, task: string, rounds: number, along = false): boolean {
    if (builder === auditor || !this.deps.office.isStaffed(auditor)) return false;
    this.pairs.set(builder, {
      builder,
      auditor,
      task,
      max: Math.max(1, rounds),
      round: 0,
      phase: "building",
      since: Date.now(),
      findings: [],
      along,
      checkpoint: false,
      checkpoints: 0,
      sendBacks: 0,
      verdictFile: null,
    });
    return true;
  }

  /** Who audits this builder, if anyone. */
  auditorOf(builder: string): string | null {
    return this.pairs.get(builder)?.auditor ?? null;
  }

  /** Whether this desk is auditing someone right now. */
  isAuditing(deskId: string): boolean {
    for (const p of this.pairs.values()) if (p.auditor === deskId && p.phase === "auditing") return true;
    return false;
  }

  /**
   * The builder's finished work (it passed the check): true if its auditor
   * takes it first (then it's held out of the line); false to let it through.
   */
  /** What the builder's desk says while its work is with the auditor. */
  private holdLabel(p: Pair): string {
    const who = this.deps.nameOf(p.auditor);
    return p.checkpoint ? `🔍 Checkpoint ${p.checkpoints} with ${who}` : `🔍 Being audited by ${who} (round ${p.round} of ${p.max})`;
  }

  builderReady(builder: string, report: Report): boolean {
    const p = this.pairs.get(builder);
    if (!p || report.status !== "ready") return false;
    // Presented again mid-audit: it stays with the auditor (the verdict covers it).
    if (p.phase === "auditing") {
      this.deps.office.hold(builder, this.holdLabel(p));
      return true;
    }
    if (!this.deps.office.isStaffed(p.auditor)) {
      this.pairs.delete(builder);
      return false;
    }
    p.checkpoint = p.along && isCheckpoint(report);
    if (p.checkpoint) {
      // Past the checkpoint limit: no audit, straight on to the next step.
      if (p.checkpoints >= MAX_CHECKPOINTS) {
        this.deps.office.dismiss(builder, "[Audit] Checkpoint noted — carry on with the next step.");
        return true;
      }
      p.checkpoints++;
    }
    p.round++;
    p.phase = "auditing";
    p.since = Date.now();
    this.deps.office.hold(builder, this.holdLabel(p));
    void this.briefAuditor(p, report);
    return true;
  }

  /**
   * An auditor's report used as its verdict (if it wrote there instead of its
   * verdict file). Only when it has no work of its own waiting — then its
   * report is its own. True if it was a verdict (then it isn't for you).
   */
  auditorReport(auditor: string, report: Report): boolean {
    const p = [...this.pairs.values()].find((x) => x.auditor === auditor && x.phase === "auditing");
    if (!p) return false;
    // An auditor with work of its own is reporting on that work: its verdict comes in its verdict file.
    const ownWork = [...this.pairs.values()].some((x) => x.builder === auditor) || !!this.deps.hasOwnTask?.(auditor);
    if (ownWork) return false;
    this.deps.office.dismiss(auditor, report.status === "ready" ? "[Audit] Thanks — your approval is on its way to your manager. Carry on." : "[Audit] Thanks — the issues are with the builder now. You'll be asked again when it's fixed.");
    this.verdict(p, report);
    return true;
  }

  /** Verdicts written to their files (call every few seconds). */
  checkVerdicts(): void {
    for (const p of [...this.pairs.values()]) {
      if (p.phase !== "auditing" || !p.verdictFile || !existsSync(p.verdictFile)) continue;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(readFileSync(p.verdictFile, "utf8"));
      } catch {
        continue; // half-written: next time
      }
      rmSync(p.verdictFile, { force: true });
      const slides = Array.isArray(raw.slides) ? raw.slides.filter((x): x is string => typeof x === "string").slice(0, 12) : [];
      const v: Report = { status: raw.status === "ready" ? "ready" : "blocked", title: "Audit", summary: typeof raw.summary === "string" ? raw.summary.slice(0, 2000) : "", slides, at: Date.now() };
      this.deps.office.instruct(p.auditor, v.status === "ready" ? "[Audit] Thanks — your approval is on its way. Carry on with what you were doing." : "[Audit] Thanks — the issues are with the builder now. You'll be asked again when it's fixed.");
      this.verdict(p, v);
    }
  }

  private verdict(p: Pair, report: Report): void {
    const approved = report.status === "ready";
    const issues = [report.summary, ...report.slides].filter(Boolean).join(" · ");
    if (approved && p.checkpoint) {
      // A checkpoint passed: on to the next step (the finished work gets audited too).
      p.findings.push(`Checkpoint ${p.checkpoints}: approved — ${report.summary}`);
      p.phase = "building";
      p.since = Date.now();
      this.deps.note(`${this.deps.nameOf(p.auditor)} approved checkpoint ${p.checkpoints} of “${p.task}”`, p.builder, "audit");
      this.deps.office.dismiss(p.builder, `[Audit] ${this.deps.nameOf(p.auditor)} approved your checkpoint: ${report.summary.replace(/\s+/g, " ").slice(0, 300)} — carry on with the next step.`);
      this.deps.simulate?.recall(p.builder);
      return;
    }
    if (approved) {
      p.findings.push(`Round ${p.round}: approved — ${report.summary}`);
      this.finish(p, `🔍 Audited by ${this.deps.nameOf(p.auditor)}: approved after ${p.round} round${p.round === 1 ? "" : "s"}`);
      return;
    }
    p.findings.push(`${p.checkpoint ? `Checkpoint ${p.checkpoints}` : `Round ${p.round}`}: ${issues}`);
    this.deps.onFinding?.(p.builder, p.task, issues);
    p.sendBacks++;
    if (p.sendBacks >= p.max) {
      this.finish(p, `🔍 Audit stopped after ${p.max} round${p.max === 1 ? "" : "s"} — still open: ${issues}`);
      return;
    }
    // Back to the builder with what the auditor found.
    p.phase = "building";
    p.since = Date.now();
    this.deps.note(`${this.deps.nameOf(p.auditor)} sent “${p.task}” back to ${this.deps.nameOf(p.builder)} (${p.sendBacks} of ${p.max})`, p.builder, "audit");
    this.deps.office.review(
      p.builder,
      false,
      `[Audit] ${this.deps.nameOf(p.auditor)} reviewed your work (round ${p.round} of ${p.max}) and found: ${issues}. Fix these, then present again (status "ready") — it goes back to them before your manager.`,
    );
    this.deps.simulate?.recall(p.builder);
  }

  /** Audits that are taking too long come to you as they are. */
  tick(now = Date.now()): void {
    const limit = this.deps.maxAuditMs ?? DEFAULT_MAX_AUDIT_MS;
    for (const p of [...this.pairs.values()]) {
      if (p.phase === "auditing" && !this.deps.office.isStaffed(p.auditor)) {
        this.finish(p, `🔍 ${this.deps.nameOf(p.auditor)} stopped before finishing the audit (round ${p.round}) — review it yourself`);
      } else if (p.phase === "auditing" && now - p.since > limit) {
        this.deps.office.instruct(p.auditor, "[Audit] Time's up on this audit — your manager will review it directly. Stop the audit and carry on.");
        this.finish(p, `🔍 Audit by ${this.deps.nameOf(p.auditor)} timed out in round ${p.round} — review it yourself`);
      }
    }
  }

  /** A worker left: its pairing ends (as builder or auditor). */
  forget(deskId: string): void {
    for (const [k, p] of this.pairs) if (p.builder === deskId || p.auditor === deskId) this.pairs.delete(k);
  }

  private finish(p: Pair, verdict: string): void {
    this.pairs.delete(p.builder);
    this.deps.office.amendReport(p.builder, (r) => ({ ...r, slides: [...r.slides, verdict, ...p.findings.slice(0, -1).map((f) => `Earlier — ${f}`)].slice(0, 14) }));
    this.deps.note(`${verdict.replace(/^🔍 /, "")} — “${p.task}”`, p.builder, "audit");
    this.deps.release(p.builder);
  }

  /** Write the builder's changes into the auditor's folder and ask for a verdict. */
  private async briefAuditor(p: Pair, report: Report): Promise<void> {
    const builderDir = this.deps.office.workdir(p.builder);
    const base = this.deps.base(p.builder);
    const committed = base ? await gitOut(builderDir, ["diff", `${base}...HEAD`]) : "";
    const uncommitted = await gitOut(builderDir, ["diff", "HEAD"]);
    const diff = `${committed}\n${uncommitted}`.trim() || "(no changes in git — read the builder's summary)";
    const name = `audit-${p.builder}-round${p.round}.md`;
    const dir = join(this.deps.office.workdir(p.auditor), ".domain", "audit");
    p.verdictFile = join(dir, `verdict-${p.builder}-round${p.round}.json`);
    rmSync(p.verdictFile, { force: true });
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, name),
        `# Audit: ${p.task}\n\nBuilder: ${this.deps.nameOf(p.builder)} · round ${p.round} of ${p.max}\n\n## What they say they did\n\n${report.title}\n\n${report.summary}\n\n${report.slides.map((s) => `- ${s}`).join("\n")}\n\n${report.check ? `## The check\n\n\`${report.check.command}\` ${report.check.status}\n\n` : ""}${p.findings.length ? `## Earlier rounds\n\n${p.findings.map((f) => `- ${f}`).join("\n")}\n\n` : ""}## Their changes\n\n\`\`\`diff\n${diff.slice(0, 400_000)}\n\`\`\`\n`,
      );
    } catch {
      /* the brief still says what to do */
    }
    this.deps.office.instruct(
      p.auditor,
      `[Audit] ${p.checkpoint ? `${this.deps.nameOf(p.builder)} reached checkpoint ${p.checkpoints} on “${p.task}” — not finished yet: check the direction and what's there so far.` : `${this.deps.nameOf(p.builder)} says “${p.task}” is done (round ${p.round} of ${p.max}).`} Before your manager sees it, audit it: read .domain/audit/${name} (their summary and the full diff). Check it does what the task asks, that nothing is broken or missing, and that it's clean. Don't change their files. Then write your verdict as JSON to ${p.verdictFile} (not your own report file): {"status": "ready", "summary": "why it's good to go"} — or {"status": "blocked", "summary": "…", "slides": ["one concrete problem per line"]}. Only real problems: if it's good, approve it.`,
    );
    this.deps.simulate?.verdict(p.auditor, report, p.verdictFile);
  }
}
